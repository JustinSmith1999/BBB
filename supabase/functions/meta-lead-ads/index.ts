// Supabase Edge Function: meta-lead-ads (2026-09-01)
//
// The Lead Ads pipeline: instead of asking cold Instagram traffic for a $49
// card-in-hand checkout, the ad collects name + phone inside Meta's native
// 2-tap form. Leads land in trial_signups (source_category 'meta_lead') and
// surface on Homebase's Today list for the desk — the part of this business
// that actually closes — to call within minutes.
//
// Actions (POST, x-bbb-secret):
//   { action: "create_form", studio, name?, greeting?, thank_you? }
//     → creates a leadgen form on the studio's FB page. Returns form_id.
//   { action: "launch", studio, form_id, source_ad_id, daily_budget_cents,
//     message?, dry_run? }
//     → creates an OUTCOME_LEADS campaign + adset (targeting copied from the
//       source ad's adset) + ad (source ad's video + SIGN_UP → lead form).
//   { action: "poll", studios?: [..] }
//     → pulls new leads from every known form, upserts trial_signups.
//       Registered in sync-orchestrator so it runs on every cycle.
//   { action: "pause_adset", studio, adset_id }   // switch off the old click adsets
//
// Env: META_TOKEN_<STUDIO> (same per-studio tokens the other ad fns use).
// Deploy: supabase functions deploy meta-lead-ads --no-verify-jwt

// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FB = 'v19.0';
const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';
const TOKENS: Record<string, string> = {
  williamsburg: 'META_TOKEN_WILLIAMSBURG', astoria: 'META_TOKEN_ASTORIA',
  bayside: 'META_TOKEN_BAYSIDE', 'fresh-meadows': 'META_TOKEN_FRESH_MEADOWS',
};
const ACCOUNTS: Record<string, string> = {
  williamsburg: 'act_26739874695621849', astoria: 'act_1367835402069398',
  bayside: 'act_4298533693762953', 'fresh-meadows': 'act_1301162772160251',
};
const LOC_IDS: Record<string, string> = {
  astoria: 'dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45',
  bayside: '5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7',
  'fresh-meadows': '6bbbe077-bcc6-4d9d-a10b-7605c1484752',
  williamsburg: '80536b45-df0e-42d1-880c-e9301372e1cf',
};
const STUDIO_LABEL: Record<string, string> = {
  astoria: 'Astoria', bayside: 'Bayside', 'fresh-meadows': 'Fresh Meadows', williamsburg: 'Williamsburg',
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-bbb-secret, Authorization, Apikey',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function fbGet(path: string, token: string, params: Record<string, string> = {}) {
  const u = new URL(`https://graph.facebook.com/${FB}/${path}`);
  u.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString());
  const b = await r.json();
  if (!r.ok) throw new Error(`GET ${path}: ${JSON.stringify(b).slice(0, 300)}`);
  return b;
}
async function fbPost(path: string, token: string, fields: Record<string, string>) {
  const form = new URLSearchParams({ access_token: token, ...fields });
  const r = await fetch(`https://graph.facebook.com/${FB}/${path}`, { method: 'POST', body: form });
  const b = await r.json();
  if (!r.ok) throw new Error(`POST ${path}: ${JSON.stringify(b).slice(0, 300)}`);
  return b;
}
async function pageFor(account: string, token: string, wantPageId?: string): Promise<{ pageId: string; pageToken: string }> {
  // The ad account's promoted page. /me/accounts lists pages + page tokens.
  // 2026-09-01: some tokens manage MULTIPLE pages and [0] was the wrong one
  // (form created on a page the ad account can't advertise for). Callers can
  // now pin the exact page id — pass the page the studio's ads actually use.
  const me = await fbGet('me/accounts', token, { fields: 'id,name,access_token' });
  const pages = me.data ?? [];
  const page = wantPageId ? pages.find((p: any) => p.id === wantPageId) : pages[0];
  if (!page) throw new Error(wantPageId
    ? `page ${wantPageId} not on this token (has: ${pages.map((p: any) => p.id + ' ' + p.name).join(', ')})`
    : 'no page on this token — check META_TOKEN_* permissions');
  return { pageId: page.id, pageToken: page.access_token || token };
}
function normPhone(p: string): string | null {
  const d = (p || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  const secretOk = req.headers.get('x-bbb-secret') === ADMIN_SECRET;
  const hasAuth = (req.headers.get('Authorization') || '').length > 0;
  if (!secretOk && !hasAuth) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const action = String(body.action || '');
  const studio = String(body.studio || '');
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  const tokenFor = (slug: string) => Deno.env.get(TOKENS[slug] ?? '') ?? '';

  try {
    // ── create_form ───────────────────────────────────────────────────────
    if (action === 'create_form') {
      const token = tokenFor(studio);
      if (!token) return json({ ok: false, error: `no token for ${studio}` }, 400);
      const { pageId, pageToken } = await pageFor(ACCOUNTS[studio], token, body.page_id ? String(body.page_id) : undefined);
      const label = STUDIO_LABEL[studio];
      const form = await fbPost(`${pageId}/leadgen_forms`, pageToken, {
        name: body.name || `BBB ${label} - $49 Trial Leads (2026-09)`,
        questions: JSON.stringify([{ type: 'FULL_NAME' }, { type: 'PHONE' }]),
        privacy_policy: JSON.stringify({ url: 'https://betterbodybootcamp.com/privacy' }),
        follow_up_action_url: `https://betterbodybootcamp.com/locations/${studio}`,
        context_card: JSON.stringify({
          title: (body.greeting || `2 weeks unlimited for $49 at BBB ${label}`).slice(0, 60),
          style: 'LIST_STYLE',
          content: ['Real coaches, real community', 'All levels welcome', 'We will text you to set up your first class'],
          button_text: 'Hold my spot',
        }),
        thank_you_page: JSON.stringify({
          title: body.thank_you || 'You are in!',
          body: `The Better Body ${label} team will text you shortly to set up your two weeks.`,
          button_type: 'VIEW_WEBSITE',
          button_text: 'See the studio',
          website_url: `https://betterbodybootcamp.com/locations/${studio}`,
        }),
      });
      // Remember the form so poll() can find it with zero config.
      await sb.from('project_log').insert({
        category: 'meta_lead_form', status: 'open',
        detail: JSON.stringify({ studio, form_id: form.id, page_id: pageId, created: new Date().toISOString() }),
      }).then(({ error }) => { if (error) console.error('form log failed:', error.message); });
      return json({ ok: true, studio, form_id: form.id, page_id: pageId });
    }

    // ── launch ───────────────────────────────────────────────────────────
    if (action === 'launch') {
      const token = tokenFor(studio);
      const account = ACCOUNTS[studio];
      if (!token || !account) return json({ ok: false, error: `unconfigured studio ${studio}` }, 400);
      const formId = String(body.form_id || '');
      const srcAdId = String(body.source_ad_id || '');
      const budget = Number(body.daily_budget_cents) || 3000;
      if (!formId || !srcAdId) return json({ ok: false, error: 'form_id and source_ad_id required' }, 400);

      // Source ad → creative video + page; source adset → targeting.
      const srcAd = await fbGet(srcAdId, token, { fields: 'adset_id,creative{object_story_spec}' });
      const oss = srcAd?.creative?.object_story_spec ?? {};
      const videoId = oss?.video_data?.video_id;
      const pageId = oss?.page_id;
      const imageUrl = oss?.video_data?.image_url;
      if (!videoId || !pageId) return json({ ok: false, error: 'source ad has no video/page to reuse' }, 400);
      const srcAdset = await fbGet(String(srcAd.adset_id), token, { fields: 'targeting' });

      const label = STUDIO_LABEL[studio];
      const message = body.message ||
        `2 weeks of unlimited classes at Better Body ${label} for $49. Real coaches, real community, all levels. Want us to hold you a spot? Tap below and we will text you to set it up.`;

      const plan = { campaign: `BBB ${label} - Lead Gen (2026-09)`, budget_usd: budget / 100, video_id: videoId, form_id: formId };
      if (body.dry_run) return json({ ok: true, dry_run: true, plan, targeting: srcAdset.targeting });

      // Idempotent: reuse tonight's campaign if a retry already created it.
      let camp: any = null;
      try {
        const existing = await fbGet(`${account}/campaigns`, token, { fields: 'id,name', limit: '50' });
        camp = (existing.data ?? []).find((c: any) => c.name === plan.campaign) ?? null;
      } catch (_e) { /* fall through to create */ }
      if (!camp) {
        camp = await fbPost(`${account}/campaigns`, token, {
          name: plan.campaign, objective: 'OUTCOME_LEADS', status: 'ACTIVE',
          special_ad_categories: JSON.stringify([]),
          // Required by newer Graph API versions (subcode 4834011).
          is_adset_budget_sharing_enabled: 'false',
        });
      }
      const adset = await fbPost(`${account}/adsets`, token, {
        name: `BBB ${label} - Lead Gen Adset`, campaign_id: camp.id, status: 'ACTIVE',
        daily_budget: String(budget), billing_event: 'IMPRESSIONS',
        optimization_goal: 'LEAD_GENERATION',
        // Subcode 2490487: a bid strategy is mandatory for lead-gen adsets.
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        destination_type: 'ON_AD',
        promoted_object: JSON.stringify({ page_id: pageId }),
        targeting: JSON.stringify(srcAdset.targeting ?? {}),
      });
      const creative = await fbPost(`${account}/adcreatives`, token, {
        name: `BBB ${label} - Lead Gen Creative`,
        object_story_spec: JSON.stringify({
          page_id: pageId,
          video_data: {
            video_id: videoId,
            ...(imageUrl ? { image_url: imageUrl } : {}),
            message,
            call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: formId } },
          },
        }),
      });
      const ad = await fbPost(`${account}/ads`, token, {
        name: `BBB ${label} - Lead Gen Ad`, adset_id: adset.id,
        creative: JSON.stringify({ creative_id: creative.id }), status: 'ACTIVE',
      });
      return json({ ok: true, campaign_id: camp.id, adset_id: adset.id, ad_id: ad.id });
    }

    // ── pause_adset (switch off the old click campaigns) ─────────────────
    if (action === 'pause_adset') {
      const token = tokenFor(studio);
      await fbPost(String(body.adset_id), token, { status: 'PAUSED' });
      return json({ ok: true, paused: body.adset_id });
    }

    // ── poll — pull new leads into trial_signups ─────────────────────────
    if (action === 'poll') {
      const { data: forms } = await sb.from('project_log')
        .select('detail').eq('category', 'meta_lead_form');
      const results: any[] = [];
      let inserted = 0;
      for (const row of forms ?? []) {
        let meta: any = {};
        try { meta = JSON.parse(row.detail); } catch { continue; }
        const token = tokenFor(meta.studio);
        if (!token) continue;
        try {
          const leads = await fbGet(`${meta.form_id}/leads`, token,
            { fields: 'created_time,field_data', limit: '100' });
          for (const lead of leads.data ?? []) {
            const fields: Record<string, string> = {};
            for (const f of lead.field_data ?? []) fields[f.name] = (f.values ?? [])[0] ?? '';
            const name = fields.full_name || fields.FULL_NAME || 'Meta lead';
            const phone = normPhone(fields.phone_number || fields.PHONE || '');
            if (!phone) continue;
            // Dedupe on phone: skip anyone already in the funnel.
            const { data: existing } = await sb.from('trial_signups')
              .select('id').eq('phone', phone).limit(1);
            if (existing && existing.length) continue;
            const { error } = await sb.from('trial_signups').insert({
              name, phone, email: null,
              location_id: LOC_IDS[meta.studio],
              payment_status: 'pending', front_desk_stage: 'new_lead',
              source_category: 'meta_lead', lead_source: `meta-lead-${meta.studio}`,
              created_at: lead.created_time,
              // No robo-drips for ad leads — the desk calls them personally.
              abandoned_email_sent_at: new Date().toISOString(),
            });
            if (!error) inserted++;
            else if (!/duplicate/i.test(error.message)) console.error('lead insert:', error.message);
          }
          results.push({ studio: meta.studio, form: meta.form_id, fetched: (leads.data ?? []).length });
        } catch (e) {
          results.push({ studio: meta.studio, form: meta.form_id, error: String(e).slice(0, 200) });
        }
      }
      return json({ ok: true, inserted, forms: results });
    }

    return json({ ok: false, error: `unknown action '${action}'` }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 500) }, 500);
  }
});
