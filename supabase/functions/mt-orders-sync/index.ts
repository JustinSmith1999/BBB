// Supabase Edge Function: mt-orders-sync
// 2026-06-27 — Universal MT orders bridge
// =====================================================================
// Polls Mariana Tek's /api/orders/ endpoint and bridges every order into
// our Supabase tables so the dashboard + /homebase finally have full
// visibility into MT-native purchases (in-app trials, autopay renewals,
// PIF contracts, drop-ins, late-cancel charges, etc).
//
// MT-native = anything NOT placed through our betterbodybootcamp.com
// Stripe Checkout flow. Before this function existed, those purchases
// were 100% invisible to BBB dashboards.
//
// Discovered via /api/orders/ probe on 2026-06-27:
//   Endpoint exists, requires Accept: application/vnd.api+json
//   Returns paginated orders w/ summary (product names), total, location,
//   broker, user, date_placed, status. The included= param can embed
//   the user attributes (email, name, phone) so we don't need a 2nd call.
//
// Order classification rules (heuristic on order.summary):
//   "Two Weeks Trial" / "$49"          → trial_signups (source_category='mt_app')
//                                         + mariana_tek_sales (always)
//   "Membership" / "PIF" / "Contract"  → mariana_tek_sales only
//   "Drop In" / "Late Cancel" / "No Show" / retail / "$0" admin items
//                                       → mariana_tek_sales only (low-noise)
//
// Cursor: max(mt_sale_id::bigint) from mariana_tek_sales. MT order ids
// are monotonically increasing integers per tenant.
//
// Side-effects on NEW $49 trial inserts (only when we just learned about
// them — skipped on backfill upserts that already exist):
//   1. Fire welcome email via send-mt-welcome (TODO if missing — fall back
//      to stripe-webhook's mt_welcome_email path).
//   2. Fire Meta CAPI Purchase event (mt-purchase-capi if it exists, or
//      log to capi_events table for batched dispatch).
//
// Auth (caller → us):
//   x-bbb-secret: <BBB_ADMIN_SECRET>     ad-hoc
//   Authorization: Bearer <SR_KEY>        cron
//   user-agent: pg_net/                   pg_cron
//
// Body (POST):
//   {}                              — incremental from last cursor (default)
//   { full_refresh: true }          — wipe cursor, pull last 30 days
//   { limit: 200 }                  — cap pages (default 10)
//   { dry_run: true }               — show classifications, don't write
//
// Deploy:
//   supabase functions deploy mt-orders-sync --no-verify-jwt \
//     --project-ref uracuwugpxqjfgtuobal

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';
const MT_TENANT    = 'betterbodybootcamp';
const MT_BASE      = `https://${MT_TENANT}.marianatek.com`;

// Studio name → slug + Supabase locations.id lookup is done from DB on
// each invocation so we don't hardcode UUIDs.
const STUDIO_NAME_TO_SLUG: Record<string, string> = {
  'Williamsburg':  'williamsburg',
  'Astoria':       'astoria',
  'Bayside':       'bayside',
  'Fresh Meadows': 'fresh-meadows',
};

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey, x-bbb-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// 2026-07-06: the static MT_OAUTH_ACCESS_TOKEN expires. When it did, this sync
// started returning HTTP 401 while mt-public-classes kept working (it auto-
// refreshes). Same refresh logic here: seed from MT_OAUTH_ACCESS_TOKEN, and on
// a 401 mint a fresh token from MT_OAUTH_REFRESH_TOKEN + client_id via /o/token/.
const MT_TOKEN_URL = Deno.env.get('MT_OAUTH_TOKEN_URL') || `${MT_BASE}/o/token/`;
const MT_CLIENT_ID = Deno.env.get('MT_OAUTH_CLIENT_ID') || '';

let cachedAccessToken: string | null = null;
let cachedExpiresAt: number | null = null;

// ── SELF-RENEWING MT OAUTH (2026-07-23) ──────────────────────────────────────
// The bug: the old code refreshed the access token but threw away the NEW
// refresh_token MT hands back, and re-read the OLD one from an env var every
// time. MT rotates the refresh token on every use, so after one cycle the env
// token was dead -> the whole sync died weekly.
// The fix: tokens live in public.mt_oauth (single row) and the rotated
// refresh_token is PERSISTED on every refresh, so it renews itself indefinitely.
// Env vars are only a one-time bootstrap seed.
const TOKEN_ROW_ID = 'default';
function tokenDb() {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
}
async function readStored(): Promise<{ access?: string; refresh?: string; expMs?: number }> {
  try {
    const { data } = await tokenDb().from('mt_oauth')
      .select('access_token, refresh_token, expires_at').eq('id', TOKEN_ROW_ID).maybeSingle();
    if (!data) return {};
    return { access: data.access_token || undefined, refresh: data.refresh_token || undefined,
             expMs: data.expires_at ? new Date(data.expires_at).getTime() : undefined };
  } catch { return {}; }
}
async function saveStored(access: string, refresh: string, expiresInSec: number): Promise<void> {
  try {
    await tokenDb().from('mt_oauth').upsert({
      id: TOKEN_ROW_ID, access_token: access, refresh_token: refresh,
      expires_at: new Date(Date.now() + (expiresInSec || 604800) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch { /* best-effort */ }
}

async function tryRefresh(refresh: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  const r = await fetch(MT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: MT_CLIENT_ID }),
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, error: `MT token endpoint HTTP ${r.status}: ${text.slice(0, 300)}` };
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: `Bad JSON from token endpoint: ${text.slice(0, 200)}` }; }
  if (!parsed.access_token) return { ok: false, error: 'no access_token in token response' };
  // Persist the newly-rotated refresh token so next time it still works.
  await saveStored(parsed.access_token, parsed.refresh_token || refresh, parsed.expires_in || 604800);
  cachedAccessToken = parsed.access_token;
  cachedExpiresAt   = Date.now() + ((parsed.expires_in || 604800) * 1000) - 60_000;
  return { ok: true, token: cachedAccessToken! };
}

async function refreshAccessToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
  // 2026-07-31: try the STORED (freshest) refresh token first; if that chain is
  // dead (e.g. MT revoked the family when the admin session ended) AND the env
  // seed is a DIFFERENT token (i.e. someone reseeded secrets manually), try the
  // env one once as a fallback. Never blindly use env when it equals the stored
  // token — replaying a consumed rotating token is what poisoned the chain.
  const stored = await readStored();
  const envRefresh = Deno.env.get('MT_OAUTH_REFRESH_TOKEN');
  if (!MT_CLIENT_ID) return { ok: false, error: 'no MT_OAUTH_CLIENT_ID' };
  if (!stored.refresh && !envRefresh) {
    return { ok: false, error: 'no refresh_token anywhere — reseed the mt_oauth row' };
  }
  if (stored.refresh) {
    const first = await tryRefresh(stored.refresh);
    if (first.ok) return first;
    if (envRefresh && envRefresh !== stored.refresh) {
      const second = await tryRefresh(envRefresh);
      if (second.ok) return second;
      return { ok: false, error: `stored refresh failed (${first.error}); env fallback also failed (${second.error}). Reseed the mt_oauth row from a fresh MT admin login.` };
    }
    return { ok: false, error: `${first.error} — reseed the mt_oauth row from a fresh MT admin login.` };
  }
  return await tryRefresh(envRefresh!);
}

async function getAccessToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
  // 2026-08-21: Xplor/MT (Joe M, Partnerships) is issuing a proper Admin API
  // key for server-to-server auth. When MT_ADMIN_API_KEY is set in secrets it
  // wins outright — no OAuth, no refresh rotation, no 7-day expiry. The whole
  // session-token dance below then becomes dead code we can delete after a
  // clean week on the key.
  const adminKey = Deno.env.get('MT_ADMIN_API_KEY');
  if (adminKey && adminKey.trim()) {
    return { ok: true, token: adminKey.trim() };
  }
  if (cachedAccessToken && cachedExpiresAt && Date.now() < cachedExpiresAt) {
    return { ok: true, token: cachedAccessToken };
  }
  const stored = await readStored();
  // Use the stored access token while it's still valid.
  if (stored.access && stored.expMs && Date.now() < stored.expMs - 60_000) {
    cachedAccessToken = stored.access; cachedExpiresAt = stored.expMs;
    return { ok: true, token: cachedAccessToken };
  }
  // First-ever run: bootstrap the store from the env seed once.
  if (!stored.access && !stored.refresh) {
    const seedA = Deno.env.get('MT_OAUTH_ACCESS_TOKEN');
    const seedR = Deno.env.get('MT_OAUTH_REFRESH_TOKEN');
    if (seedA && seedA.trim() && seedR && seedR.trim()) {
      await saveStored(seedA.trim(), seedR.trim(), 604800);
      cachedAccessToken = seedA.trim();
      cachedExpiresAt   = Date.now() + (6 * 24 * 60 * 60 * 1000);
      return { ok: true, token: cachedAccessToken };
    }
  }
  // Stored token expired -> refresh (and persist the rotation).
  return await refreshAccessToken();
}

// Classify a single order by its summary text.
type OrderKind = 'trial' | 'membership' | 'ancillary' | 'zero' | 'other';
function classifyOrder(summary: string, total: number): OrderKind {
  const s = (summary || '').toLowerCase();
  if (total === 0) return 'zero';
  if (s.includes('two weeks trial') || s.includes('$49') || s.includes('week trial')) return 'trial';
  // 2026-09-02: "2 Months Back to School Promo" matched NONE of the membership
  // keywords, fell to 'other', and skipped owner SMS + Homebase entirely —
  // Isabel/Hilda/Effie bought $299s at the Bayside desk and nobody was told.
  // Promo-style paid packages ARE memberships for our purposes.
  if (s.includes('back to school') || s.includes('2 months') || s.includes('two months')) return 'membership';
  if (s.includes('membership') || s.includes(' pif') || s.includes('pif ') || s.includes('contract') || s.includes('month to month')) return 'membership';
  if (s.includes('drop in') || s.includes('late cancel') || s.includes('no show') || s.includes('water') || s.includes('celcius')) return 'ancillary';
  return 'other';
}

function nameParts(full: string | null | undefined): { first: string | null; last: string | null } {
  const t = (full || '').trim();
  if (!t) return { first: null, last: null };
  const parts = t.split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(' ') || null };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // ─── auth ──────────────────────────────────────────────────────────────
  const secret = req.headers.get('x-bbb-secret') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const SR     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ua     = req.headers.get('user-agent') ?? '';
  const okAuth = secret === ADMIN_SECRET || (SR && bearer === SR) || ua.startsWith('pg_net/');
  if (!okAuth) return json({ ok: false, error: 'unauthorized' }, 401);

  const body: {
    full_refresh?: boolean;
    limit?: number;
    dry_run?: boolean;
    skip_welcome?: boolean;
    probe?: boolean;
  } = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  const dryRun = !!body.dry_run;
  // skip_welcome: pull + insert data but DON'T fire the customer/studio welcome
  // emails. Use this for catch-up backfills after a sync outage so days-old
  // trials don't get a surprise batch of late welcome emails. CAPI events still
  // fire (no customer contact, and we want the attribution).
  const skipWelcome = !!body.skip_welcome;
  const maxPages = Math.min(Math.max(body.limit ?? 10, 1), 50);

  const tok0 = await getAccessToken();
  if (!tok0.ok) return json({ ok: false, error: `MT auth: ${tok0.error}` }, 500);
  let token = tok0.token!;

  // ─── PROBE (read-only diagnostic, 2026-07-11) ──────────────────────────────
  // "MT trial signup isn't recording credit card numbers." The normal sync only
  // asks MT for order totals (include=user), so it can't see payment capture.
  // This branch pulls the most recent orders WITH their transactions + payment
  // method and hits the stored-card endpoints, so we can see whether a card is
  // actually taken and/or kept on file. Writes NOTHING. Call: {"probe":true}
  if (body.probe) {
    const mtGet = async (path: string) => {
      const r = await fetch(`${MT_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' },
      });
      const t = await r.text();
      let j: any = null; try { j = JSON.parse(t); } catch { /* keep raw */ }
      return { status: r.status, json: j, raw: j ? undefined : t.slice(0, 400) };
    };
    const out: Record<string, unknown> = { probe: true };
    // Recent orders + everything payment-ish we can include.
    const ord = await mtGet(`/api/orders/?ordering=-id&page_size=6&include=transactions,transactions.stored_payment_method,payment_method,user`);
    out.orders_status = ord.status;
    if (ord.json) {
      out.included_types = [...new Set((ord.json.included || []).map((i: any) => i.type))];
      out.orders = (ord.json.data || []).map((o: any) => ({
        id: o.id,
        total: o.attributes?.total,
        summary: o.attributes?.summary,
        date: o.attributes?.date_placed,
        attr_keys: Object.keys(o.attributes || {}),
        rel_keys: Object.keys(o.relationships || {}),
        has_transactions: !!(o.relationships?.transactions?.data?.length),
        has_payment_method: !!(o.relationships?.payment_method?.data || o.attributes?.payment_method),
      }));
      out.payment_included = (ord.json.included || [])
        .filter((i: any) => /transaction|payment|card/i.test(i.type))
        .slice(0, 6)
        .map((i: any) => ({ type: i.type, attr_keys: Object.keys(i.attributes || {}), attributes: i.attributes }));
    } else {
      out.orders_raw = ord.raw;
    }
    // Do stored-card endpoints even exist / return anything?
    for (const ep of [
      '/api/stored_credit_cards/?page_size=2',
      '/api/credit_cards/?page_size=2',
      '/api/stored_payment_methods/?page_size=2',
      '/api/payment_methods/?page_size=2',
    ]) {
      const rr = await mtGet(ep);
      out[`probe${ep}`] = { status: rr.status, count: rr.json?.data?.length ?? null, sample_keys: rr.json?.data?.[0]?.attributes ? Object.keys(rr.json.data[0].attributes) : (rr.raw || null) };
    }
    return json(out);
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // ─── cursor ────────────────────────────────────────────────────────────
  // MT order ids are monotonically increasing ints; use max(mt_sale_id)
  // from our mirror to bound the sync.
  let cursor = 0;
  if (!body.full_refresh) {
    const { data: maxRow } = await sb
      .from('mariana_tek_sales')
      .select('mt_sale_id')
      .order('mt_sale_id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxRow?.mt_sale_id) cursor = Number(maxRow.mt_sale_id) || 0;
  }

  // ─── locations cache (name → row) ──────────────────────────────────────
  const { data: locs, error: locErr } = await sb
    .from('locations')
    .select('id, name')
    .in('name', Object.keys(STUDIO_NAME_TO_SLUG));
  if (locErr) return json({ ok: false, error: `locations: ${locErr.message}` }, 500);
  const locByName = new Map<string, { id: string; name: string; slug: string }>();
  for (const l of (locs ?? []) as any[]) {
    locByName.set(l.name, { id: l.id, name: l.name, slug: STUDIO_NAME_TO_SLUG[l.name] });
  }

  // ─── fetch MT orders ──────────────────────────────────────────────────
  // Order DESC by id, paginate until we hit cursor (or run out / hit cap).
  const allOrders: any[] = [];
  const userById = new Map<string, any>(); // populated from included[]
  let stopped = false;
  let page = 1;
  while (page <= maxPages && !stopped) {
    const url = `${MT_BASE}/api/orders/?ordering=-id&page_size=100&page=${page}&include=user`;
    let r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' },
    });
    // Seed token expired mid-run → refresh once and retry this page.
    if (r.status === 401) {
      const rr = await refreshAccessToken();
      if (!rr.ok) return json({ ok: false, status: 401, error: `MT 401 and token refresh failed: ${rr.error}` }, 502);
      token = rr.token!;
      r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' },
      });
    }
    const text = await r.text();
    if (!r.ok) {
      return json({ ok: false, status: r.status, error: `MT API ${r.status}: ${text.slice(0,400)}` }, 502);
    }
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return json({ ok: false, error: 'MT returned non-JSON', raw: text.slice(0,400) }, 502); }
    const rows = parsed.data || [];
    for (const inc of (parsed.included || [])) {
      if (inc.type === 'users') userById.set(String(inc.id), inc.attributes || {});
    }
    for (const o of rows) {
      const oid = Number(o.id || 0);
      if (cursor && oid <= cursor) { stopped = true; break; }
      allOrders.push(o);
    }
    if (rows.length < 100) break;
    page++;
  }

  // ─── classify + write ─────────────────────────────────────────────────
  const summary = {
    fetched:        allOrders.length,
    new_trials:     0,
    new_memberships:0,
    membership_lead_flips:0,
    new_ancillary:  0,
    new_zero:       0,
    new_other:      0,
    skipped_existing:0,
    sales_upserts:  0,
    trial_inserts:  0,
    membership_inserts: 0,
    errors:         [] as string[],
  };

  const trialEmailsToWelcome: { trial_id: string; email: string; first: string; studio_slug: string }[] = [];
  // 2026-08-21 (Justin): owners get texted for big purchases too, not just
  // trials. New PAID membership/contract/PIF sales collect here for the
  // owner-SMS kickoff at the bottom (send path 'owner_membership_sms').
  const membershipSalesToNotify: { name: string; items: string; totalCents: number; studio_slug: string; location_id: string | null }[] = [];
  // 2026-09-02: brand-new membership buyers (no prior lead row) get a one-time
  // membership welcome email — correct copy, NOT the "2-week trial" template.
  const membershipWelcomesToSend: { trial_id: string; email: string; first: string; studio_slug: string; items: string; name?: string; phone?: string | null; total_cents?: number }[] = [];

  for (const o of allOrders) {
    const a = o.attributes || {};
    const rels = o.relationships || {};
    const mtSaleId = String(o.id);
    const dateIso  = a.date_placed || null;
    const locName  = a.location || '';
    const loc      = locByName.get(locName);
    const studioSlug = loc?.slug || null;
    const summaryArr = Array.isArray(a.summary) ? a.summary : [];
    const itemNames  = summaryArr.join(' + ');
    const total      = Number(a.total || 0);
    const totalCents = Math.round(total * 100);
    const kind       = classifyOrder(itemNames, total);
    const userRel    = (rels.user?.data) || null;
    const userId     = userRel ? String(userRel.id) : null;
    const userAttr   = userId ? (userById.get(userId) || {}) : {};
    const email      = (userAttr.email || '').trim().toLowerCase() || null;
    const fullName   = userAttr.full_name || `${userAttr.first_name || ''} ${userAttr.last_name || ''}`.trim();
    const np         = nameParts(fullName);
    const phone      = userAttr.phone_number || null;
    const pay        = (a.payment_sources || [])[0]?.label || null;

    switch (kind) {
      case 'trial':       summary.new_trials++; break;
      case 'membership':  summary.new_memberships++; break;
      case 'ancillary':   summary.new_ancillary++; break;
      case 'zero':        summary.new_zero++; break;
      default:            summary.new_other++;
    }

    if (dryRun) continue;

    // 1. Always mirror into mariana_tek_sales
    const { error: salesErr } = await sb.from('mariana_tek_sales').upsert({
      mt_sale_id:          mtSaleId,
      studio_slug:         studioSlug || 'unknown',
      location_id:         loc?.id ?? null,
      sale_date_time:      dateIso,
      customer_mt_id:      userId,
      customer_first_name: np.first,
      customer_last_name:  np.last,
      customer_email:      email,
      payment_method:      pay,
      item_names:          itemNames,
      item_count:          summaryArr.length,
      total_cents:         totalCents,
      raw:                 a,
    }, { onConflict: 'mt_sale_id' });
    if (salesErr) {
      summary.errors.push(`sales upsert ${mtSaleId}: ${salesErr.message}`);
      continue;
    }
    summary.sales_upserts++;

    if (kind === 'membership' && totalCents > 0) {
      // 2026-09-03 FIX (Chris): autopay RENEWALS were alerting owners as "New
      // Membership" every billing night (and could welcome-email longtime
      // members). A sale is a renewal if this email already has an OLDER paid
      // sale of the SAME item in our mirror (>7 days older — same-day retries
      // and split payments still count as the original purchase). Renewals:
      // no owner email, no owner SMS, no customer welcome. New buyers only.
      let isRenewal = false;
      if (email) {
        try {
          const cutoff = new Date(Date.parse(dateIso || new Date().toISOString()) - 7 * 864e5).toISOString();
          const { data: priorSame } = await sb
            .from('mariana_tek_sales')
            .select('mt_sale_id')
            .ilike('customer_email', email)
            .eq('item_names', itemNames)
            .lt('sale_date_time', cutoff)
            .neq('mt_sale_id', mtSaleId)
            .limit(1);
          isRenewal = !!(priorSame && priorSame.length);
        } catch { /* on lookup failure treat as new (fail loud, not silent) */ }
      }
      if (!isRenewal) membershipSalesToNotify.push({
        name: fullName || email || 'Unknown',
        items: itemNames,
        totalCents,
        studio_slug: studioSlug || 'unknown',
        location_id: loc?.id ?? null,
      });

      // 2026-08-21 (Justin): membership buyers whose old lead/trial card was
      // never flipped looked like dead leads forever — 25 real conversions
      // were found deleted off the board as "new_lead". When a membership
      // sale lands, promote any matching non-member trial_signups row to
      // member and restore it to the board so the dashboard counts the win.
      if (email) {
        try {
          const { data: leadRows } = await sb
            .from('trial_signups')
            .select('id, front_desk_stage, deleted_at')
            .eq('email', email)
            .neq('payment_status', 'attribution_only');
          const liveMember = (leadRows ?? []).some(t => t.front_desk_stage === 'member' && !t.deleted_at);
          if (!liveMember && (leadRows ?? []).length > 0) {
            const target = (leadRows ?? []).find(t => !t.deleted_at) ?? (leadRows ?? [])[0];
            await sb.from('trial_signups')
              .update({ front_desk_stage: 'member', deleted_at: null })
              .eq('id', target.id);
            summary.membership_lead_flips = (summary.membership_lead_flips || 0) + 1;
          }
          // 2026-09-02: WALK-IN membership buyers (no prior lead/trial row at
          // all — like the Bayside desk's $299 BTS sales) were invisible to
          // Homebase and the dashboard funnel. Insert them as members, with
          // every drip suppressed (they are not trial leads, no robo-texts),
          // and queue a one-time membership welcome email below.
          if ((leadRows ?? []).length === 0) {
            const { data: byMt } = userId
              ? await sb.from('trial_signups').select('id').eq('mariana_tek_id', String(userId)).limit(1)
              : { data: [] as { id: string }[] };
            if (!byMt || byMt.length === 0) {
              const nowIso = new Date().toISOString();
              const { data: ins, error: insErr } = await sb.from('trial_signups').insert({
                name: fullName || email,
                email,
                phone: phone || null,
                location_id: loc?.id ?? null,
                mariana_tek_id: userId,
                payment_status: 'completed',
                payment_date: dateIso,
                front_desk_stage: 'member',
                source_category: 'direct_membership',
                lead_source: `mt-membership-${studioSlug || 'unknown'}`,
                // suppress the trial drip machinery entirely
                abandoned_email_sent_at: nowIso,
                abandoned_email2_sent_at: nowIso,
                welcome_sms_sent_at: nowIso,
              }).select('id').single();
              if (insErr) {
                summary.errors.push(`member insert ${email}: ${insErr.message}`);
              } else if (ins) {
                summary.membership_inserts = (summary.membership_inserts || 0) + 1;
                // 2026-09-03 (Chris): renewals still get a quiet board row so the
                // member roster is complete, but NO welcome email and NO owner
                // alert — those are for first-time purchases only.
                if (!isRenewal) membershipWelcomesToSend.push({
                  trial_id: ins.id, email, first: np.first || 'there',
                  studio_slug: studioSlug || 'unknown', items: itemNames,
                  name: fullName || email, phone: phone || null,
                  // 2026-09-02 FIX (Justin): a 12-month contract fired an alert
                  // labeled "$299 Back to School" — the templates hardcoded the
                  // promo. Carry the REAL price + whether it's actually BTS.
                  total_cents: totalCents,
                });
              }
            }
          }
        } catch (e) {
          summary.errors.push(`member flip ${email}: ${(e as Error).message}`);
        }
      }
    }

    // 2. For $49 trials, also push to trial_signups (so /homebase sees them)
    if (kind === 'trial' && email && loc?.id) {
      // dedupe: find the latest trial_signups row for this MT user — INCLUDING
      // soft-deleted ones. 2026-07-10 fix: the old `.is('deleted_at', null)`
      // filter hid deleted rows, so a lead the front desk intentionally deleted
      // looked "new" to the sync and got re-inserted on the next run — deletes
      // never stuck. Now we see the deleted row and refuse to resurrect it.
      const { data: existing } = await sb
        .from('trial_signups')
        .select('id, mariana_tek_id, source_category, payment_status, deleted_at')
        .eq('email', email)
        .eq('location_id', loc.id)
        // 2026-07-31: the attribution bridge writes soft-deleted "shadow" rows
        // (payment_status='attribution_only') per buyer email. Without this
        // filter the dedupe matches the shadow (newest row), sees deleted_at,
        // and refuses to link/mark-paid the REAL lead row — which is how
        // Meghan Tillett's winback purchase left her card unlinked. Shadows
        // are CAPI-only artifacts; never let them speak for the person.
        .neq('payment_status', 'attribution_only')
        .order('created_at', { ascending: false })
        .limit(1);
      if (existing && existing.length) {
        const row = existing[0] as any;
        // Respect an intentional delete — NEVER bring a soft-deleted lead back.
        if (row.deleted_at) { summary.skipped_existing++; continue; }
        // Existing LIVE row (form filler now also has an MT order). Defensive
        // upsert: link MT user id AND, if the existing row is still pending,
        // mark it paid using this MT order's date. Catches the rare case where
        // someone fills the BBB trial form but pays in MT directly (skipping our
        // Stripe Checkout) — without this update they'd stay in Abandoned forever.
        const updates: Record<string, unknown> = {};
        if (!row.mariana_tek_id && userId) updates.mariana_tek_id = userId;
        if (row.payment_status !== 'completed') {
          updates.payment_status = 'completed';
          updates.payment_date   = dateIso;
        }
        if (Object.keys(updates).length) {
          await sb.from('trial_signups').update(updates).eq('id', row.id);
        }
        summary.skipped_existing++;
        continue;
      }

      // 2026-07-10 dedup guard on mariana_tek_id. The email+location check above
      // misses the same MT customer arriving under a different email spelling
      // (that's how "Sajiya Afrin" / "sajiya afrin" became two cards for MT id
      // 66400). Before inserting, look up by MT user id across ALL locations —
      // including soft-deleted — and skip if we already have that MT client, so
      // one MT person can never spawn a second trial_signups row.
      if (userId) {
        const { data: byMt } = await sb
          .from('trial_signups')
          .select('id, deleted_at')
          .eq('mariana_tek_id', String(userId))
          .limit(1);
        if (byMt && byMt.length) {
          summary.skipped_existing++;
          continue;
        }
      }

      // 2026-08-19 FIX (Williamsburg trials silently dropped): the ad-attribution
      // bridge writes a soft-deleted shadow row (payment_status='attribution_only')
      // keyed on the buyer's email a few seconds BEFORE the MT sale lands. The
      // dedup SELECT above deliberately EXCLUDES attribution_only rows, so the
      // code never sees the shadow — and the plain INSERT below then collides
      // with it on the (email, location_id) unique constraint and silently fails.
      // The real trial never lands, so no /homebase card and no studio alert.
      // This stranded ~1/3 of Williamsburg trials (Simone Singh, Erin Deasy, etc).
      // Fix: if a shadow already occupies this slot, ADOPT it into the real
      // trial (flip to completed, un-delete, attach the MT id) instead of
      // inserting a colliding new row.
      const { data: shadow } = await sb
        .from('trial_signups')
        .select('id')
        .eq('email', email)
        .eq('location_id', loc.id)
        .eq('payment_status', 'attribution_only')
        .order('created_at', { ascending: false })
        .limit(1);
      if (shadow && shadow.length) {
        const { data: adopted, error: adoptErr } = await sb
          .from('trial_signups')
          .update({
            name:            fullName || 'MT App Customer',
            phone,
            payment_status:  'completed',
            payment_date:    dateIso,
            source_category: 'mt_app',
            mariana_tek_id:  userId,
            deleted_at:      null,
          })
          .eq('id', shadow[0].id)
          .select('id')
          .single();
        if (adoptErr) {
          summary.errors.push(`shadow adopt for ${email}: ${adoptErr.message}`);
          continue;
        }
        summary.trial_inserts++;
        const adoptAgeMs = Date.now() - new Date(dateIso).getTime();
        const adoptRecent = Number.isFinite(adoptAgeMs) && adoptAgeMs < 3 * 3600 * 1000;
        if (adopted?.id && email && adoptRecent) {
          trialEmailsToWelcome.push({
            trial_id:   adopted.id,
            email,
            first:      np.first || 'there',
            studio_slug: studioSlug || 'unknown',
          });
        }
        continue;
      }

      const { data: ins, error: insErr } = await sb.from('trial_signups').insert({
        name:             fullName || 'MT App Customer',
        email,
        phone,
        location_id:      loc.id,
        payment_status:   'completed',
        payment_date:     dateIso,
        source_category:  'mt_app',  // new bucket — purchases originated inside Mariana Tek
        mariana_tek_id:   userId,
        stripe_session_id: null,     // these never touched our Stripe
        // Note: payment_amount, notes, etc. don't exist on prod trial_signups
        // (their migration was never applied). The dollar amount + item names
        // live in mariana_tek_sales row keyed by the same mt_sale_id.
      }).select('id').single();
      if (insErr) {
        summary.errors.push(`trial_signups insert for ${email}: ${insErr.message}`);
        continue;
      }
      summary.trial_inserts++;
      // 2026-07-27 PAST-SEND GUARD: only queue a welcome for trials whose order
      // is genuinely recent (< 3 hours old). A brand-new live purchase is always
      // well inside this window, so real customers still get welcomed instantly.
      // But any catch-up / backfill / re-scan that ingests an older order will
      // put it on the board WITHOUT ever texting or emailing that customer about
      // a trial they bought hours or days ago. A late blast is now impossible.
      const orderAgeMs = Date.now() - new Date(dateIso).getTime();
      const orderIsRecent = Number.isFinite(orderAgeMs) && orderAgeMs < 3 * 3600 * 1000;
      if (ins?.id && email && orderIsRecent) {
        trialEmailsToWelcome.push({
          trial_id:   ins.id,
          email,
          first:      np.first || 'there',
          studio_slug: studioSlug || 'unknown',
        });
      }
    }
  }

  // ─── 3. CAPI fan-out ──────────────────────────────────────────────────
  // Trigger mariana-tek-capi-purchase-sync immediately after we ingest new
  // sales. That function is normally cron-scheduled at 04:20 ET — calling
  // it here makes Purchase events fire within minutes of the MT order
  // instead of 12-18 hours later. Meta's attribution window is generous
  // (7d click / 1d view) so the nightly is fine as a backstop, but
  // real-time is materially better for learning-phase optimization.
  // We only kick it off if there were actual new sales AND not a dry run.
  let capi_kickoff: { status?: number; ok?: boolean; error?: string } | null = null;
  if (!dryRun && summary.sales_upserts > 0) {
    try {
      const capiUrl = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/mariana-tek-capi-purchase-sync`;
      const r = await fetch(capiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bbb-secret': ADMIN_SECRET,
        },
        body: JSON.stringify({ lookback_hours: 6 }),
      });
      capi_kickoff = { status: r.status, ok: r.ok };
      if (!r.ok) {
        const txt = await r.text();
        capi_kickoff.error = txt.slice(0, 200);
      }
    } catch (e) {
      capi_kickoff = { error: `fetch failed: ${(e as Error).message}` };
    }
  }

  // ─── 4. Welcome email queue ───────────────────────────────────────────
  // For NEW mt_app trial_signups rows, fire BBB-branded welcome via the
  // existing manual-welcome-batch function. That path is the same one
  // task #410 used to backfill missed welcomes — it writes to email_log +
  // sms_messages with trial_signup_id so /homebase Comms thread shows it.
  // We pass send_owner_sms=false: owners already get notified by other
  // automation (paid-trials-realtime-monitor) and we don't want to spam
  // their phones every time the cron picks up an MT order.
  let welcome_kickoff: { fired: number; ok: boolean; error?: string; skipped?: boolean } | null = null;
  if (skipWelcome && trialEmailsToWelcome.length > 0) {
    // Data was inserted, but the caller asked us NOT to notify (catch-up backfill).
    welcome_kickoff = { fired: 0, ok: true, skipped: true };
  } else if (!dryRun && trialEmailsToWelcome.length > 0) {
    try {
      const welcomeUrl = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/manual-welcome-batch`;
      const r = await fetch(welcomeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bbb-secret': ADMIN_SECRET,
        },
        body: JSON.stringify({
          trial_ids:           trialEmailsToWelcome.map(t => t.trial_id),
          // 2026-07-22: MT-app trials now get the SAME day-0 welcome as website
          // trials — welcome TEXT + email. Previously SMS was off, so app buyers
          // got no text. manual-welcome-batch skips cleanly when a row has no /
          // invalid phone, so this is safe for the phone-less MT signups too.
          send_customer_sms:   true,
          send_customer_email: true,
          // 2026-07-31 (Justin): owner texts on every new paid trial — but if a
          // catch-up sync lands MANY trials at once (post-outage), don't machine-gun
          // the owners' phones; they'll see the batch on the board/sheets instead.
          send_owner_sms:      trialEmailsToWelcome.length <= 3,
          send_studio_email:   true,
          dry_run:             false,
        }),
      });
      welcome_kickoff = { fired: trialEmailsToWelcome.length, ok: r.ok };
      if (!r.ok) {
        const txt = await r.text();
        welcome_kickoff.error = txt.slice(0, 200);
      }
    } catch (e) {
      welcome_kickoff = { fired: 0, ok: false, error: `fetch failed: ${(e as Error).message}` };
    }
  }

  // ─── 5. Owner SMS for new paid membership sales (2026-08-21, Justin) ──
  // "Carlos should get notified for both trials and large purchases at his
  // gyms." Trials already text every phone in location_owners via
  // manual-welcome-batch; this covers contracts / PIFs / month-to-month.
  // Guards: BBB_SEND_PATHS_ENABLED must contain 'owner_membership_sms';
  // skipped on dry runs and skip_welcome catch-up backfills; max 3 sales
  // per run (same anti-machine-gun rule as trial owner texts). Every
  // attempt logs to sms_messages with send_path='owner_membership_sms'.
  let membership_sms_kickoff: { sent: number; failed: number; skipped?: string } | null = null;
  if (membershipSalesToNotify.length > 0) {
    const paths   = (Deno.env.get('BBB_SEND_PATHS_ENABLED') ?? '').split(',').map((s) => s.trim());
    const twSid   = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
    const twToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
    const twFrom  = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
    if (dryRun) {
      membership_sms_kickoff = { sent: 0, failed: 0, skipped: 'dry_run' };
    } else if (skipWelcome) {
      membership_sms_kickoff = { sent: 0, failed: 0, skipped: 'skip_welcome backfill' };
    } else if (!paths.includes('owner_membership_sms')) {
      membership_sms_kickoff = { sent: 0, failed: 0, skipped: 'path owner_membership_sms not enabled' };
    } else if (membershipSalesToNotify.length > 3) {
      membership_sms_kickoff = { sent: 0, failed: 0, skipped: `${membershipSalesToNotify.length} sales in one run - batch, no texts` };
    } else if (!twSid || !twToken || !twFrom) {
      membership_sms_kickoff = { sent: 0, failed: 0, skipped: 'twilio env missing' };
    } else {
      membership_sms_kickoff = { sent: 0, failed: 0 };
      const { data: ownerRows } = await sb.from('location_owners').select('location_id, owner_name, phone');
      for (const sale of membershipSalesToNotify) {
        const owners = (ownerRows ?? []).filter((o) => o.location_id === sale.location_id && o.phone);
        const studioTitle = sale.studio_slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        const smsBody = `BBB ${studioTitle}: NEW MEMBERSHIP - ${sale.name}, ${sale.items}, $${(sale.totalCents / 100).toFixed(0)} charged today.`;
        for (const o of owners) {
          try {
            const resp = await fetch(
              `https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`,
              {
                method: 'POST',
                headers: {
                  'Authorization': 'Basic ' + btoa(`${twSid}:${twToken}`),
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({ From: twFrom, To: o.phone, Body: smsBody }),
              },
            );
            const j = await resp.json().catch(() => ({} as Record<string, unknown>));
            const ok = resp.ok;
            await sb.from('sms_messages').insert({
              studio_slug:   sale.studio_slug,
              direction:     'outbound',
              from_phone:    twFrom,
              to_phone:      o.phone,
              body:          smsBody,
              twilio_sid:    (j as { sid?: string }).sid ?? null,
              status:        ok ? ((j as { status?: string }).status ?? 'queued') : 'failed',
              error_code:    ok ? null : String((j as { code?: unknown }).code ?? resp.status),
              error_message: ok ? null : String((j as { message?: unknown }).message ?? 'twilio error').slice(0, 200),
              sent_by:       'mt-orders-sync',
              sent_at:       new Date().toISOString(),
              send_path:     'owner_membership_sms',
            });
            if (ok) membership_sms_kickoff.sent++; else membership_sms_kickoff.failed++;
          } catch (e) {
            membership_sms_kickoff.failed++;
            summary.errors.push(`owner membership sms ${sale.studio_slug}: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  // ─── 6. Membership welcome emails (2026-09-02) ───────────────────────
  // One-time branded welcome for brand-new membership buyers (walk-ins like
  // the $299 Back to School desk sales). Only fires for rows THIS run just
  // inserted, so returning members are never re-welcomed. Skipped on dry
  // runs and catch-up backfills. Logs to email_log like every other send.
  let membership_welcome_kickoff: { sent: number; failed: number; skipped?: string } | null = null;
  if (membershipWelcomesToSend.length > 0) {
    const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
    if (dryRun) {
      membership_welcome_kickoff = { sent: 0, failed: 0, skipped: 'dry_run' };
    } else if (skipWelcome) {
      membership_welcome_kickoff = { sent: 0, failed: 0, skipped: 'skip_welcome backfill' };
    } else if (!resendKey) {
      membership_welcome_kickoff = { sent: 0, failed: 0, skipped: 'RESEND_API_KEY missing' };
    } else {
      membership_welcome_kickoff = { sent: 0, failed: 0 };
      // 2026-09-02: branded HTML matching the trial welcome (manual-welcome-
      // batch template): red hero, logo, CTA pill, offer card, and App Store /
      // Google Play buttons. The old plain-text version also glued the booking
      // URL to the next line in some mail clients ("bayside...Or") — real
      // anchor tags fix that.
      const HERO_HEX = '#D83B3B';
      // Studio inbox + owner emails per studio — mirrors stripe-webhook's
      // TRIAL_NOTIFY roster so $299 buyers alert the same people as trials.
      const MEMBER_NOTIFY: Record<string, string[]> = {
        'bayside':       ['carlos@betterbodybootcamp.com', 'bayside@betterbodybootcamp.com'],
        'fresh-meadows': ['carlos@betterbodybootcamp.com', 'freshmeadows@betterbodybootcamp.com'],
        'williamsburg':  ['steve@betterbodybootcamp.com', 'chris@betterbodybootcamp.com', 'williamsburg@betterbodybootcamp.com'],
        'astoria':       ['steve@betterbodybootcamp.com', 'chris@betterbodybootcamp.com', 'astoria@betterbodybootcamp.com'],
      };
      const LOGO_URL = 'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png';
      const APP_IOS = 'https://apps.apple.com/us/app/better-body-studios/id6778182425';
      const APP_PLAY = 'https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp';
      for (const w of membershipWelcomesToSend) {
        const studioTitle = w.studio_slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        const mailbox = `${w.studio_slug.replace(/-/g, '')}@betterbodybootcamp.com`;
        const subject = `Welcome to Better Body ${studioTitle}!`;
        const bookUrl = `https://betterbodybootcamp.com/schedule/${w.studio_slug}`;
        const infoUrl = `https://betterbodybootcamp.com/locations/${w.studio_slug}`;
        const text = `Hi ${w.first},\n\nWelcome to Better Body Bootcamp ${studioTitle}! Your ${w.items} is active and you are all set.\n\nBook your classes: ${bookUrl}\n\nOr grab the Better Body Studios app:\niPhone: ${APP_IOS}\nAndroid: ${APP_PLAY}\n\nEvery class is coach-led, so just show up and we take care of the rest. See you in the room!\n\nThe Better Body ${studioTitle} Team`;
        const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#111;background:#fff">
      <div style="background:${HERO_HEX};color:#fff;padding:26px 28px 24px;text-align:center">
        <img src="${LOGO_URL}" alt="Better Body Bootcamp" width="160" style="max-width:160px;height:auto;margin:0 auto 14px;display:block" />
        <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;opacity:0.85;margin-bottom:8px">${studioTitle}</div>
        <h1 style="margin:0;font-size:28px;font-weight:800;letter-spacing:-0.02em;line-height:1.1;color:#fff">Welcome, ${w.first}.</h1>
      </div>
      <div style="padding:28px">
        <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#222">Welcome to Better Body Bootcamp ${studioTitle}. Your <strong>${w.items}</strong> is active and you are all set.</p>
        <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#444">Every class is coach-led, so just show up and we take care of the rest. Book your <strong>first class today</strong> and lock in the habit.</p>
        <div style="text-align:center;margin:26px 0 20px">
          <a href="${bookUrl}" style="background:${HERO_HEX};color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px;display:inline-block;font-size:15px;letter-spacing:0.01em">Book My First Class →</a>
        </div>
        <div style="text-align:center;margin:0 0 26px">
          <div style="font-size:12px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Or book from your phone</div>
          <a href="${APP_IOS}" style="background:#000;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:999px;display:inline-block;font-size:13px;margin:0 4px 8px"> App Store</a>
          <a href="${APP_PLAY}" style="background:#000;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:999px;display:inline-block;font-size:13px;margin:0 4px 8px">▶ Google Play</a>
        </div>
        <div style="background:#fafafa;border:1px solid #eee;border-radius:12px;padding:18px 20px;margin-bottom:22px">
          <div style="font-size:12px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">What you've got</div>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:4px 0;color:#666;width:140px">Membership</td><td style="padding:4px 0;font-weight:600">${w.items}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Studio</td><td style="padding:4px 0;font-weight:600">${studioTitle}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Access</td><td style="padding:4px 0">Unlimited coach-led classes</td></tr>
          </table>
        </div>
        <div style="font-size:14px;color:#444;line-height:1.55">
          <p style="margin:0 0 10px"><strong>First class tips:</strong> show up 10 minutes early, wear sneakers, bring water. Coach will get you set up.</p>
          <p style="margin:0 0 10px">Questions? Just reply to this email — it goes straight to your studio.</p>
        </div>
        <div style="border-top:1px solid #eee;margin-top:24px;padding-top:18px;font-size:12px;color:#888;text-align:center">
          <a href="${infoUrl}" style="color:#888;text-decoration:underline">Studio info &amp; directions</a>
          &nbsp;·&nbsp; <a href="${bookUrl}" style="color:#888;text-decoration:underline">Class schedule</a>
        </div>
      </div>
    </div>`;
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: `Better Body Bootcamp ${studioTitle} <${mailbox}>`,
              to: [w.email], reply_to: mailbox, subject, html, text,
            }),
          });
          const ok = r.ok;
          try {
            await sb.from('email_log').insert({
              send_path: 'membership_welcome_email',
              to_addrs: [w.email],
              subject,
              status: ok ? 'sent' : 'failed',
            });
          } catch { /* log table variance — never block the send loop */ }
          if (ok) {
            membership_welcome_kickoff.sent++;
            try {
              await sb.from('trial_signups').update({ welcome_email_sent_at: new Date().toISOString() }).eq('id', w.trial_id);
            } catch { /* non-fatal */ }
          } else {
            membership_welcome_kickoff.failed++;
          }
        } catch (e) {
          membership_welcome_kickoff.failed++;
          summary.errors.push(`membership welcome ${w.email}: ${(e as Error).message}`);
        }

        // ── Studio + owner notification (branded internal email) ──────
        const notifyTo = MEMBER_NOTIFY[w.studio_slug] || [];
        if (notifyTo.length) {
          // 2026-09-02 FIX (Justin): a 12-month contract went out labeled
          // "$299 Back to School". Label + price now come from the actual sale.
          const isBts = /back to school|2 month|two month/i.test(w.items || '');
          const priceStr = Number.isFinite(w.total_cents) && (w.total_cents as number) > 0
            ? `$${Math.round((w.total_cents as number) / 100)}` : '';
          const dealLabel = isBts ? `$299 Back to School` : `Membership${priceStr ? ' ' + priceStr : ''}`;
          const nSubject = `💰 New ${dealLabel} — ${w.name || w.email} · ${studioTitle}`;
          const nHtml = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
      <div style="background:${HERO_HEX};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0;margin:-24px -24px 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;opacity:0.9">New Membership · ${studioTitle}</div>
        <h2 style="margin:6px 0 0;font-size:24px;font-weight:800;letter-spacing:-0.02em">${w.name || w.email}</h2>
        <div style="font-size:13px;opacity:0.95;margin-top:4px">${w.items}${priceStr ? ` · ${priceStr}` : ''}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:20px">
        <tr><td style="padding:8px 0;color:#666;width:140px;border-bottom:1px solid #f0f0f0">Name</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f0f0">${w.name || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Email</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><a href="mailto:${w.email}" style="color:#dc2626;text-decoration:none;font-weight:600">${w.email}</a></td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${w.phone ? `<a href="tel:${w.phone}" style="color:#dc2626;text-decoration:none;font-weight:600">${w.phone}</a>` : '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Purchase</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f0f0">${w.items}</td></tr>
        <tr><td style="padding:8px 0;color:#666">Studio</td><td style="padding:8px 0;font-weight:600">${studioTitle}</td></tr>
      </table>
      <div style="margin-top:16px;font-size:12px;color:#888;text-align:center">
        <a href="https://bbbmarketing.netlify.app/?studio=${w.studio_slug}" style="color:#888">Open dashboard</a>
      </div>
    </div>`;
          try {
            const nr = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: `BBB Alerts <${mailbox}>`,
                to: notifyTo, subject: nSubject, html: nHtml,
                text: `New ${dealLabel}: ${w.name || w.email} (${w.email}${w.phone ? ', ' + w.phone : ''}) at ${studioTitle}. ${w.items}.`,
              }),
            });
            try {
              await sb.from('email_log').insert({ send_path: 'membership_owner_email', to_addrs: notifyTo, subject: nSubject, status: nr.ok ? 'sent' : 'failed' });
            } catch { /* non-fatal */ }
          } catch (e) {
            summary.errors.push(`membership owner email ${w.email}: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    cursor_before: cursor,
    pages_fetched: page,
    ...summary,
    capi_kickoff,
    welcome_kickoff,
    membership_sms_kickoff,
    membership_welcome_kickoff,
    new_trials_needing_welcome: trialEmailsToWelcome,
  });
});
