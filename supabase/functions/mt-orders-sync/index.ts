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

async function refreshAccessToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
  const stored = await readStored();
  const refresh = stored.refresh || Deno.env.get('MT_OAUTH_REFRESH_TOKEN');
  if (!refresh || !MT_CLIENT_ID) {
    return { ok: false, error: 'no refresh_token / client_id — reseed the MT token' };
  }
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
  // THE FIX: persist the newly-rotated refresh token so next time it still works.
  await saveStored(parsed.access_token, parsed.refresh_token || refresh, parsed.expires_in || 604800);
  cachedAccessToken = parsed.access_token;
  cachedExpiresAt   = Date.now() + ((parsed.expires_in || 604800) * 1000) - 60_000;
  return { ok: true, token: cachedAccessToken! };
}

async function getAccessToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
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
    new_ancillary:  0,
    new_zero:       0,
    new_other:      0,
    skipped_existing:0,
    sales_upserts:  0,
    trial_inserts:  0,
    errors:         [] as string[],
  };

  const trialEmailsToWelcome: { trial_id: string; email: string; first: string; studio_slug: string }[] = [];

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
      if (ins?.id && email) {
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
          send_owner_sms:      false,  // owner alerts handled separately (opt-in digest)
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

  return json({
    ok: true,
    dry_run: dryRun,
    cursor_before: cursor,
    pages_fetched: page,
    ...summary,
    capi_kickoff,
    welcome_kickoff,
    new_trials_needing_welcome: trialEmailsToWelcome,
  });
});
