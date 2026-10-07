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
//   { action: "audit", studios?: [..] }
//     → read-only. Lists every lead form on every studio page straight from
//       Meta, with its leads_count, and flags the ones `poll` has never heard
//       of. Those are the forms whose submissions nobody is collecting.
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

    // ── audit — every lead form on every studio page, and whether we have
    // its leads. Added 2026-10-07 after `poll` reported forms:[] while Meta
    // was reporting 23 leads for the week. `poll` only ever sees forms THIS
    // function created, because it reads them out of project_log. A form
    // built by hand in Ads Manager is invisible to it, and its submissions
    // sit on Facebook forever. This action asks Meta directly instead.
    // Read-only: it inserts nothing.
    if (action === 'audit') {
      const slugs: string[] = Array.isArray(body.studios) && body.studios.length
        ? body.studios : Object.keys(TOKENS);
      const { data: known } = await sb.from('project_log')
        .select('detail').eq('category', 'meta_lead_form');
      const registered = new Set<string>();
      for (const row of known ?? []) {
        try { registered.add(String(JSON.parse(row.detail).form_id)); } catch { /* skip */ }
      }
      const out: any[] = [];
      for (const slug of slugs) {
        const token = tokenFor(slug);
        if (!token) { out.push({ studio: slug, error: 'no token' }); continue; }
        try {
          const me = await fbGet('me/accounts', token, { fields: 'id,name,access_token', limit: '50' });
          const pages: any[] = [];
          for (const p of me.data ?? []) {
            const pt = p.access_token || token;
            let forms: any[] = [];
            try {
              const f = await fbGet(`${p.id}/leadgen_forms`, pt,
                { fields: 'id,name,status,leads_count,created_time', limit: '100' });
              forms = f.data ?? [];
            } catch (e) { forms = [{ error: String((e as Error).message).slice(0, 200) }]; }
            pages.push({
              page_id: p.id,
              page_name: p.name,
              forms: forms.map((fm: any) => ({
                form_id: fm.id,
                name: fm.name,
                status: fm.status,
                leads_on_meta: fm.leads_count ?? null,
                created: fm.created_time,
                // the whole point: is the poller even aware this form exists?
                known_to_poller: registered.has(String(fm.id)),
              })),
            });
          }
          // with_leads: read the submissions themselves, still WITHOUT writing
          // anything. We want to know how old they are and whether the person
          // already reached us some other way before deciding to import.
          if (body.with_leads) {
            for (const p of pages) {
              const pt = (me.data ?? []).find((x: any) => x.id === p.page_id)?.access_token || token;
              for (const fm of p.forms) {
                if (!fm.form_id || !(Number(fm.leads_on_meta) > 0)) continue;
                try {
                  const got = await fbGet(`${fm.form_id}/leads`, pt,
                    { fields: 'created_time,field_data', limit: '200' });
                  const rows = got.data ?? [];
                  const phones: string[] = [];
                  const byDay: Record<string, number> = {};
                  for (const lead of rows) {
                    const d = String(lead.created_time || '').slice(0, 10);
                    byDay[d] = (byDay[d] || 0) + 1;
                    const f2: Record<string, string> = {};
                    for (const fd of lead.field_data ?? []) f2[fd.name] = (fd.values ?? [])[0] ?? '';
                    const ph = normPhone(f2.phone_number || f2.PHONE || '');
                    if (ph) phones.push(ph);
                  }
                  // already in trial_signups by phone?
                  let already = 0;
                  if (phones.length) {
                    const { data: hit } = await sb.from('trial_signups')
                      .select('phone').in('phone', phones);
                    already = new Set((hit ?? []).map((r: any) => r.phone)).size;
                  }
                  fm.leads_fetched = rows.length;
                  fm.by_day = byDay;
                  fm.oldest = Object.keys(byDay).sort()[0] ?? null;
                  fm.newest = Object.keys(byDay).sort().slice(-1)[0] ?? null;
                  fm.already_in_trial_signups = already;
                  fm.genuinely_new = phones.length - already;
                } catch (e) {
                  fm.leads_error = String((e as Error).message).slice(0, 200);
                }
              }
            }
          }
          const all = pages.flatMap((p) => p.forms).filter((f: any) => f.form_id);
          out.push({
            studio: slug,
            pages,
            forms_total: all.length,
            forms_unknown_to_poller: all.filter((f: any) => !f.known_to_poller).length,
            leads_sitting_on_meta_unpolled: all
              .filter((f: any) => !f.known_to_poller)
              .reduce((t: number, f: any) => t + (Number(f.leads_on_meta) || 0), 0),
          });
        } catch (e) {
          out.push({ studio: slug, error: String((e as Error).message).slice(0, 300) });
        }
      }
      return json({
        ok: true,
        note: 'leads_sitting_on_meta_unpolled = submissions on forms the poller has never seen. Nothing was inserted.',
        studios: out,
        total_unpolled: out.reduce((t, s) => t + (s.leads_sitting_on_meta_unpolled || 0), 0),
      });
    }

    // ── import_leads — the manual way in, when the API door is shut ───────
    // 2026-10-07. The Astoria form held 62 submissions the poller could never
    // reach: leads_retrieval is refused because the page is owned by a
    // business portfolio nobody on hand can administer. Meta's own Leads
    // Center CSV export needs no API permission at all, so the leads come in
    // that way until the ownership mess is sorted.
    //
    // Same insert shape as `poll`, deliberately — same source_category, same
    // dedupe, same silence — so a row imported by hand is indistinguishable
    // from one the poller would have written, and nothing double-counts when
    // the API path eventually opens.
    //
    // SILENT. abandoned_email_sent_at is stamped on insert and email is left
    // null. Every automated sender keys on one or the other, so none of them
    // can reach these people. Some of them filled the form five weeks ago; an
    // automated "you left something behind" text today would be worse than
    // silence. The desk calls them.
    //
    // { action:"import_leads", studio, leads:[{name,phone,created_time}], dry_run? }
    if (action === 'import_leads') {
      if (!LOC_IDS[studio]) return json({ ok: false, error: `unconfigured studio '${studio}'` }, 400);
      const incoming: any[] = Array.isArray(body.leads) ? body.leads : [];
      if (!incoming.length) return json({ ok: false, error: 'leads[] required' }, 400);
      const dryRun = body.dry_run === true;

      let inserted = 0, skippedExisting = 0, skippedBadPhone = 0, failed = 0;
      const seen = new Set<string>();
      const problems: any[] = [];

      for (const raw of incoming) {
        const phone = normPhone(String(raw.phone || ''));
        if (!phone) { skippedBadPhone++; continue; }
        if (seen.has(phone)) { skippedExisting++; continue; }   // dupe inside the file
        seen.add(phone);

        const { data: existing } = await sb.from('trial_signups')
          .select('id, payment_status').eq('phone', phone).limit(1);
        if (existing && existing.length) { skippedExisting++; continue; }

        if (dryRun) { inserted++; continue; }

        // email is NOT NULL on trial_signups, and a Meta lead form that asks
        // only for name + phone never gives us one. @no-email.bbb.local is the
        // convention already in use (stripe-payment-audit writes it,
        // funnel-recovery filters it out) and the domain does not resolve.
        const { error } = await sb.from('trial_signups').insert({
          name: String(raw.name || '').trim() || 'Meta lead',
          phone,
          email: `meta-${phone.replace(/\D/g, '')}@no-email.bbb.local`,
          location_id: LOC_IDS[studio],
          payment_status: 'pending',
          front_desk_stage: 'new_lead',
          source_category: 'meta_lead',
          lead_source: `meta-lead-${studio}`,
          // Keep the real submission date. These are weeks old and the desk
          // needs to see that when it calls, not a fake "today".
          created_at: raw.created_time || new Date().toISOString(),
          abandoned_email_sent_at: new Date().toISOString(),
        });
        if (error) { failed++; problems.push(String(error.message).slice(0, 120)); }
        else inserted++;
      }

      return json({
        ok: true, action: 'import_leads', studio, dry_run: dryRun,
        received: incoming.length,
        [dryRun ? 'would_insert' : 'inserted']: inserted,
        skipped_already_in_funnel: skippedExisting,
        skipped_unusable_phone: skippedBadPhone,
        failed, problems: problems.slice(0, 5),
        note: 'Silent import: email withheld and abandoned_email_sent_at stamped, so no automated email or SMS can reach these rows. They appear in Homebase under New Lead.',
      });
    }

    // ── destinations — where is every live ad actually sending people? ────
    // 2026-10-07. The $49 trial lead forms created on Sep 1 for Williamsburg,
    // Bayside and Fresh Meadows have zero submissions five weeks on, while
    // Astoria's holds 62. A form with no submissions is not a collection
    // problem, so the question is what the ads point at instead.
    //
    // Read-only. For every non-archived campaign: its objective, each adset's
    // destination_type and promoted_object (which carries the lead form id for
    // a real lead ad), and each ad's actual call-to-action link. The lead_form
    // column is the answer: null on a campaign that calls itself Lead Gen
    // means the traffic is going somewhere else.
    // { action:"destinations", studios?: [...] }
    if (action === 'destinations') {
      const slugs: string[] = Array.isArray(body.studios) && body.studios.length
        ? body.studios.filter((s: string) => TOKENS[s])
        : Object.keys(TOKENS);
      const out: any[] = [];
      for (const slug of slugs) {
        const token = tokenFor(slug);
        if (!token) { out.push({ studio: slug, error: 'no token' }); continue; }
        try {
          const res = await fbGet(`${ACCOUNTS[slug]}/campaigns`, token, {
            fields: 'id,name,objective,effective_status,' +
              'adsets.limit(25){id,name,effective_status,destination_type,promoted_object,' +
              'ads.limit(10){id,name,effective_status,creative{object_story_spec,asset_feed_spec,effective_object_story_id}}}',
            limit: '50',
            filtering: JSON.stringify([{ field: 'campaign.effective_status', operator: 'IN',
              value: ['ACTIVE', 'PAUSED', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS'] }]),
          });
          const camps = (res.data ?? []).map((c: any) => ({
            campaign: c.name, id: c.id, objective: c.objective, status: c.effective_status,
            adsets: (c.adsets?.data ?? []).map((a: any) => {
              // promoted_object.lead_gen_form_id is the only authoritative
              // "this adset feeds that form" link Meta exposes.
              const formId = a.promoted_object?.lead_gen_form_id ?? null;
              const links: string[] = [];
              for (const ad of a.ads?.data ?? []) {
                const spec = ad.creative?.object_story_spec ?? {};
                const cta = spec.link_data?.call_to_action ?? spec.video_data?.call_to_action ?? {};
                const l = cta.value?.link || cta.value?.lead_gen_form_id ||
                          spec.link_data?.link || spec.video_data?.link || null;
                if (l && !links.includes(String(l))) links.push(String(l));
                const afs = ad.creative?.asset_feed_spec?.link_urls ?? [];
                for (const u of afs) if (u.website_url && !links.includes(u.website_url)) links.push(u.website_url);
              }
              return {
                adset: a.name, id: a.id, status: a.effective_status,
                destination_type: a.destination_type ?? null,
                lead_form: formId,
                promoted_page: a.promoted_object?.page_id ?? null,
                ad_destinations: links,
                ads: (a.ads?.data ?? []).length,
              };
            }),
          }));
          out.push({ studio: slug, account: ACCOUNTS[slug], campaigns: camps });
        } catch (e) {
          out.push({ studio: slug, error: String((e as Error).message).slice(0, 300) });
        }
      }
      return json({
        ok: true, action: 'destinations', wrote: false, studios: out,
        note: 'lead_form null on a lead-gen campaign = the adset is not feeding any instant form. ad_destinations shows where the ad actually sends people instead.',
      });
    }

    // ── peek — can we actually READ the lead data? ────────────────────────
    // 2026-10-07. audit reports leads_on_meta from the form's leads_count
    // field, which a plain ads token can see. Reading the SUBMISSIONS is a
    // different permission (leads_retrieval) and has been failing. So before
    // writing 62 strangers into trial_signups, establish that the data is
    // reachable at all and that it parses into a name and a usable phone.
    //
    // Writes nothing. Redacts by default: you get the shape, the parse result
    // and whether each lead is already in the funnel, not a contact list.
    // { action:"peek", studio, form_id, limit?, reveal? }
    if (action === 'peek') {
      const token = tokenFor(studio);
      if (!token) return json({ ok: false, error: `no token for studio '${studio}'` }, 400);
      const formId = String(body.form_id || '').trim();
      if (!formId) return json({ ok: false, error: 'form_id required' }, 400);
      const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 50);
      const reveal = body.reveal === true;

      let leads: any;
      try {
        leads = await fbGet(`${formId}/leads`, token, { fields: 'created_time,field_data', limit: String(limit) });
      } catch (e) {
        // This is the answer we are looking for when the permission is missing.
        return json({
          ok: false, stage: 'read_leads', form_id: formId, studio,
          error: String((e as Error).message).slice(0, 400),
          hint: 'If this mentions leads_retrieval or permissions, the fix is in Meta Business Settings → Integrations → Leads Access (grant the system user / app Lead Access on the page). No code change will get past it.',
        }, 200);
      }

      const rows = leads.data ?? [];
      const sample: any[] = [];
      let parsable = 0, already = 0;
      for (const lead of rows) {
        const fields: Record<string, string> = {};
        for (const f of lead.field_data ?? []) fields[f.name] = (f.values ?? [])[0] ?? '';
        const name = fields.full_name || fields.FULL_NAME || '';
        const phone = normPhone(fields.phone_number || fields.PHONE || '');
        if (phone) parsable++;
        let inFunnel = false;
        if (phone) {
          const { data: ex } = await sb.from('trial_signups').select('id').eq('phone', phone).limit(1);
          inFunnel = !!(ex && ex.length);
          if (inFunnel) already++;
        }
        sample.push({
          created_time: lead.created_time,
          field_names: Object.keys(fields),
          parsed_name: reveal ? name : (name ? name.slice(0, 1) + '***' : null),
          parsed_phone: reveal ? phone : (phone ? '***' + phone.slice(-4) : null),
          phone_usable: !!phone,
          already_in_funnel: inFunnel,
        });
      }
      return json({
        ok: true, action: 'peek', wrote: false, studio, form_id: formId,
        fetched: rows.length, phone_usable: parsable,
        already_in_funnel: already, would_insert: parsable - already,
        sample,
        note: 'Nothing was written. would_insert is what a real poll would add after phone dedupe.',
      });
    }

    // ── poll — pull new leads into trial_signups ─────────────────────────
    // 2026-10-07: added form_ids + dry_run. The poller only ever looked at
    // forms recorded in project_log by create_form, so the 33 forms that
    // already existed on the four pages were invisible to it — including the
    // Astoria form holding 62 submissions. form_ids lets us collect a known
    // form without having to back-fill project_log first.
    if (action === 'poll') {
      const dryRun = body.dry_run === true;
      const explicit: Array<{ studio: string; form_id: string }> =
        Array.isArray(body.form_ids)
          ? body.form_ids.map((f: any) => typeof f === 'string'
              ? { studio, form_id: f }
              : { studio: String(f.studio || studio), form_id: String(f.form_id || '') })
            .filter((f: any) => f.form_id && TOKENS[f.studio])
          : [];

      const { data: forms } = explicit.length
        ? { data: explicit.map(f => ({ detail: JSON.stringify(f) })) }
        : await sb.from('project_log')
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
            if (dryRun) { inserted++; continue; }   // count only, write nothing
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
      return json({
        ok: true,
        dry_run: dryRun,
        [dryRun ? 'would_insert' : 'inserted']: inserted,
        source: explicit.length ? 'form_ids (explicit)' : 'project_log',
        forms: results,
      });
    }

    return json({ ok: false, error: `unknown action '${action}'` }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 500) }, 500);
  }
});
