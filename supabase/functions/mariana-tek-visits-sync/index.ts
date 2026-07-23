// Supabase Edge Function: mariana-tek-visits-sync
//
// MT equivalent of mindbody-visits-sync. Pulls class reservations (visits)
// from Mariana Tek for every BBB studio that has been cut over, upserts
// into `mariana_tek_visits`.
//
// Auth: per-studio Bearer token + subdomain stored on the `locations` table:
//   - mariana_tek_subdomain
//   - mariana_tek_api_key
// Studios missing either are skipped (one-studio-at-a-time cutover).
//
// POST body (optional):
//   { lookback_days?: number,    // default 2, max 60
//     dry_run?: boolean }
//
// Deploy: supabase functions deploy mariana-tek-visits-sync --no-verify-jwt

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const STUDIO_SLUGS = ['williamsburg', 'astoria', 'fresh-meadows', 'bayside'] as const;

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';

// 2026-07-02: All 4 studios live on ONE MT tenant. Per-studio subdomain/api_key
// were never issued (integrations@marianatek.com never provisioned them), so the
// old locations-table lookup ('locations.slug does not exist') failed before we
// ever hit MT. Match the WORKING create-trial-client pattern instead: single
// tenant subdomain + the shared MT_OAUTH_ACCESS_TOKEN admin token + hardcoded
// per-studio MT location IDs (confirmed live via GET /api/locations/ 2026-06-27).
const MT_TENANT_SUBDOMAIN = 'betterbodybootcamp';
const MT_LOCATION_ID_BY_SLUG: Record<string, string> = {
  'williamsburg':  '48720',
  'astoria':       '48717',
  'fresh-meadows': '48719',
  'bayside':       '48718',
};
// 2026-07-06: the static MT_OAUTH_ACCESS_TOKEN expires (it's a short-lived MT
// OAuth access token). When it did, this sync + mt-orders-sync started 401ing
// ("Authentication credentials were not provided") while mt-public-classes kept
// working — because that function auto-refreshes. Port the same refresh logic:
// seed from MT_OAUTH_ACCESS_TOKEN, and on a 401 mint a fresh token from
// MT_OAUTH_REFRESH_TOKEN + client_id via /o/token/. Never manually 401s again.
const MT_BASE      = `https://${MT_TENANT_SUBDOMAIN}.marianatek.com`;
const MT_TOKEN_URL = Deno.env.get('MT_OAUTH_TOKEN_URL') || `${MT_BASE}/o/token/`;
const MT_CLIENT_ID = Deno.env.get('MT_OAUTH_CLIENT_ID') || '';

let cachedAccessToken: string | null = null;
let cachedExpiresAt: number | null = null;

// SELF-RENEWING MT OAUTH (2026-07-23) — shares the public.mt_oauth store with
// mt-orders-sync so the rotated refresh_token is persisted and never dies.
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
  if (stored.access && stored.expMs && Date.now() < stored.expMs - 60_000) {
    cachedAccessToken = stored.access; cachedExpiresAt = stored.expMs;
    return { ok: true, token: cachedAccessToken };
  }
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
  return await refreshAccessToken();
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey, x-bbb-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

type LocationRow = {
  id: string;
  slug: string;
  mariana_tek_subdomain: string | null;
  mariana_tek_api_key: string | null;
};

function mtHeaders(token: string): Record<string, string> {
  // MT admin API is JSON:API — it rejects Accept: application/json with
  // HTTP 406 "Could not satisfy the request Accept header." Must be the
  // vendor content type (confirmed live against /api/users/ 2026-07-06).
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.api+json',
  };
}

async function mtGet(path: string): Promise<any> {
  const tokRes = await getAccessToken();
  if (!tokRes.ok) throw new Error(`MT auth failed: ${tokRes.error}`);
  const url = `${MT_BASE}${path}`;
  let r = await fetch(url, { headers: mtHeaders(tokRes.token!) });
  // Seed token expired → mint a fresh one from the refresh token and retry once.
  if (r.status === 401) {
    const rr = await refreshAccessToken();
    if (!rr.ok) throw new Error(`MT GET ${url} → 401 and token refresh failed: ${rr.error}`);
    r = await fetch(url, { headers: mtHeaders(rr.token!) });
  }
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`MT GET ${url} → HTTP ${r.status}: ${txt}`);
  }
  return r.json();
}

// ─── TODO: VERIFY ENDPOINT SHAPE BEFORE GO-LIVE ─────────────────────────────
// Docs: https://guides.marianatek.com/api-overview
//
// Two candidate strategies — verify which one MT actually supports:
//   (a) Direct list:
//       GET /api/reservations/
//         ?filter[class_start_after]=YYYY-MM-DD
//         &filter[class_start_before]=YYYY-MM-DD
//         &page[size]=200
//   (b) Per-class drill-down:
//       1. GET /api/classes/?filter[start_after]=...&filter[start_before]=...
//       2. For each class id: GET /api/classes/{id}/reservations/
//
// Justin: once you have a real sandbox response, EDIT the `// EDIT-AT-CUTOVER`
// lines below. Strategy (a) is implemented as the default; flip MT_VISITS_VERIFIED
// to true and confirm MT_VISITS_PATH once verified.
// ────────────────────────────────────────────────────────────────────────────
// 2026-07-02: flipped ON. This was left false since the 6/27 cutover, which
// meant fetchVisitsForStudio() threw on every call and mariana_tek_visits
// stayed empty — so /homebase has shown ZERO attendance since MindBody froze
// on 6/29 (front-desk "they don't realize people already came in" complaints).
// /api/reservations/ is MT's standard admin check-in endpoint (same admin API
// base as the working /api/sales/ sync). Verify the live response shape with a
// dry_run invoke BEFORE trusting writes (the field mapping below is defensive
// and skips rows without a valid mt_visit_id, so a bad shape can't corrupt data).
const MT_VISITS_VERIFIED = true;             // 2026-07-02: enabled (was false since cutover)
const MT_VISITS_PATH = '/api/reservations/'; // MT admin check-in endpoint

// Customer API speaks plain application/json and — unlike the JSON:API admin
// endpoints, which silently ignore every filter except filter[id] — it ACTUALLY
// honors location + date filters. Verified live 2026-07-07.
async function mtGetJson(path: string): Promise<any> {
  const tokRes = await getAccessToken();
  if (!tokRes.ok) throw new Error(`MT auth failed: ${tokRes.error}`);
  const url = `${MT_BASE}${path}`;
  const hdr = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: 'application/json' });
  let r = await fetch(url, { headers: hdr(tokRes.token!) });
  if (r.status === 401) {
    const rr = await refreshAccessToken();
    if (!rr.ok) throw new Error(`MT GET ${url} → 401 and token refresh failed: ${rr.error}`);
    r = await fetch(url, { headers: hdr(rr.token!) });
  }
  if (!r.ok) throw new Error(`MT GET ${url} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const MT_CLASSES_PATH = '/api/customer/v1/classes';

// Bounded-concurrency map. The old sync fetched class-session rosters ONE AT A
// TIME (a sequential await per class), so a 60–90 day window = hundreds of
// serial round-trips and the 150s edge idle timeout. Running a small pool of
// requests in parallel cuts wall-time ~Nx while staying gentle on MT.
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      await fn(items[cur]);
    }
  });
  await Promise.all(workers);
}

// Attendance, the way MT actually exposes it (verified 2026-07-07):
//   1. GET /api/customer/v1/classes?location=&min_start_date=&max_start_date=  → session ids + start
//   2. GET /api/class_sessions/{id}  → relationships.reservations (the roster ids)
//   3. GET /api/reservations?filter[id]=a,b,c  → each carries user + check_in_date
// A present check_in_date (status "check in") is the real "they walked in" signal.
async function fetchVisitsForStudio(
  mtLocationId: string,
  slug: string,
  startDate: string,
  endDate: string,
): Promise<any[]> {
  // ── 1. list class sessions in the window (customer endpoint filters correctly) ──
  const sessions: Array<{ id: string; start: string | null }> = [];
  for (let page = 1; page <= 20; page++) {
    const qs = new URLSearchParams({
      location: String(mtLocationId),
      min_start_date: startDate,
      max_start_date: endDate,
      ordering: '-start_datetime',
      page_size: '100',
      page: String(page),
    });
    const res = await mtGetJson(`${MT_CLASSES_PATH}?${qs.toString()}`);
    const arr = (res?.results ?? res?.data ?? []) as any[];
    for (const c of arr) {
      const id = String(c?.id ?? c?.class_session_id ?? '');
      const start = c?.start_datetime ?? c?.attributes?.start_datetime ?? null;
      if (id) sessions.push({ id, start });
    }
    if (arr.length < 100) break;
  }

  // ── 2. per session, pull the roster's reservation ids (+ authoritative start) ──
  const resMeta = new Map<string, { sessionId: string; start: string | null }>();
  await mapPool(sessions, 8, async (s) => {
    const cs = await mtGet(`/api/class_sessions/${s.id}`);
    const rids = (cs?.data?.relationships?.reservations?.data ?? []) as any[];
    const start = cs?.data?.attributes?.start_datetime ?? s.start;
    for (const r of rids) resMeta.set(String(r.id), { sessionId: s.id, start });
  });

  // ── 3. batch-fetch the reservations (filter[id] IS honored) → build visit rows ──
  const ids = [...resMeta.keys()];
  const out: any[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  await mapPool(chunks, 6, async (chunk) => {
    const rv = await mtGet(`/api/reservations?filter[id]=${chunk.join(',')}&page[size]=50`);
    for (const r of (rv?.data ?? []) as any[]) {
      const a = r?.attributes ?? {};
      const meta = resMeta.get(String(r.id)) ?? { sessionId: null as any, start: null };
      const userId = r?.relationships?.user?.data?.id
        ?? r?.relationships?.booked_on_behalf_of_user?.data?.id ?? null;
      out.push({
        mt_visit_id: String(r.id),
        studio_slug: slug,
        mt_client_id: userId != null ? String(userId) : null,
        mt_class_id: meta.sessionId != null ? String(meta.sessionId) : null,
        starts_at: meta.start ?? null,
        signed_in: !!a.check_in_date,        // real check-in timestamp = they showed up
        status: a.status ?? null,            // "check in" | "pending" | ...
        raw: r,
        synced_at: new Date().toISOString(),
      });
    }
  });
  return out;
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const secret = req.headers.get('x-bbb-secret') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const SR = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ua = req.headers.get('user-agent') ?? '';
  const okAuth = secret === ADMIN_SECRET || (SR && bearer === SR) || ua.startsWith('pg_net/');
  if (!okAuth) return json({ ok: false, error: 'unauthorized' }, 401);

  const body: { lookback_days?: number; dry_run?: boolean; studio?: string } =
    req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const lookbackDays = Math.max(1, Math.min(120, Number(body.lookback_days ?? 2)));
  const dryRun = !!body.dry_run;
  // Optional single-studio filter. A 60–120 day pull across ALL FOUR studios in
  // one request blows the 150s edge idle limit; syncing ONE studio per call keeps
  // each request small. Accepts a slug ("astoria") or a loose name ("Fresh
  // Meadows" → "fresh-meadows"). Omit to sync every studio (short windows only).
  const studioFilter = body.studio
    ? String(body.studio).trim().toLowerCase().replace(/\s+/g, '-')
    : null;

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - lookbackDays);
  const startDate = fmtDate(start);
  const endDate   = fmtDate(today);

  // 2026-07-02: no more locations-table lookup (it has no `slug` column and no
  // per-studio MT creds). Shared tenant subdomain + hardcoded per-studio location
  // IDs + auto-refreshing OAuth token (getAccessToken handles seed + refresh).
  const tokCheck = await getAccessToken();
  if (!tokCheck.ok) {
    return json({ ok: false, error: `MT auth: ${tokCheck.error}` }, 500);
  }

  const result: Record<string, unknown> = {
    ok: true,
    window: `${startDate} → ${endDate}`,
    lookback_days: lookbackDays,
    dry_run: dryRun,
    studios: [] as unknown[],
  };

  const slugsToRun = studioFilter ? STUDIO_SLUGS.filter((s) => s === studioFilter) : STUDIO_SLUGS;
  if (studioFilter && slugsToRun.length === 0) {
    return json({ ok: false, error: `unknown studio "${body.studio}". Use one of: ${STUDIO_SLUGS.join(', ')}` }, 400);
  }

  const perStudio: Record<string, { studio: string; status: string; visits: number; error?: string }> = {};
  for (const slug of slugsToRun) {
    perStudio[slug] = { studio: slug, status: 'pending', visits: 0 };
  }

  const allVisits: any[] = [];

  for (const slug of slugsToRun) {
    const mtLocationId = MT_LOCATION_ID_BY_SLUG[slug];
    if (!mtLocationId) {
      perStudio[slug].status = 'skipped (no MT location id)';
      continue;
    }
    try {
      const visits = await fetchVisitsForStudio(
        mtLocationId,
        slug,
        startDate,
        endDate,
      );
      allVisits.push(...visits);
      perStudio[slug].visits = visits.length;
      perStudio[slug].status = 'ok';
    } catch (e) {
      perStudio[slug].status = 'error';
      perStudio[slug].error = String((e as Error).message ?? e);
    }
  }

  result.studios = Object.values(perStudio);
  result.total_visits = allVisits.length;

  if (dryRun) {
    (result as any).dry_run_sample = allVisits.slice(0, 2);
    return json(result);
  }

  if (allVisits.length > 0) {
    // Dedupe by mt_visit_id — MT can occasionally return dupes.
    const dedup = new Map<string, any>();
    for (const v of allVisits) {
      if (v.mt_visit_id) dedup.set(v.mt_visit_id, v);
    }
    const toUpsert = Array.from(dedup.values());
    let upserted = 0;
    for (let i = 0; i < toUpsert.length; i += 500) {
      const batch = toUpsert.slice(i, i + 500);
      const { error } = await sb
        .from('mariana_tek_visits')
        .upsert(batch, { onConflict: 'mt_visit_id' });
      if (error) { (result as any).upsert_error = error.message; break; }
      upserted += batch.length;
    }
    result.visits_upserted = upserted;
  }

  return json(result);
});
