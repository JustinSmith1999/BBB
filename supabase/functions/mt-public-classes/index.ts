// Supabase Edge Function: mt-public-classes
// 2026-06-26 v3 — REAL endpoint: /api/customer/v1/classes
// ===============================================================
// Per MT OpenAPI spec (docs.marianatek.com/api/customer/v1/redoc):
//   GET /api/customer/v1/classes
//   Filters that ACTUALLY work: location, min_start_date, max_start_date,
//                               min_datetime, max_datetime, instructor,
//                               classroom, class_type, class_tags, region,
//                               is_live_stream, is_cancelled, ordering.
//   Pagination: page, page_size  (page_size up to 100).
//
// Why v1/v2 of this fn returned 0 sessions:
//   We were hitting /api/class_sessions/ (admin-only, ignores filters
//   silently, returns all 26K future sessions in DESC-id order). That
//   endpoint isn't part of the Customer API spec at all.
//
// Real Class response shape (top-level fields we use):
//   id (str)
//   name (str)                  e.g. "Bayside Fitness/FULL BODY FRIDAY"
//   start_datetime (ISO 8601 UTC)
//   end_datetime  (ISO 8601 UTC)
//   booking_start_datetime
//   capacity (int)
//   available_spot_count (int)
//   is_cancelled (bool)
//   is_remaining_spot_count_public (bool)
//   class_type: { id, name, duration (minutes), duration_formatted, ... }
//   classroom_name (str)
//   instructors: [{ id, name, photo_urls, ... }]
//   location: { id, name, formatted_address, ... }
//   spot_options: { primary_availability, primary_capacity, standby_availability,
//                   standby_capacity, waitlist_availability, waitlist_capacity }
//
// Env:
//   MT_OAUTH_ACCESS_TOKEN  (required) — admin/staff OAuth access token
//   MT_OAUTH_REFRESH_TOKEN (optional) — for auto-refresh
//   MT_OAUTH_CLIENT_ID     (optional) — needed for refresh
//
// POST body: { mt_location_id: 48718, days?: 7 }
//
// Deploy:
//   supabase functions deploy mt-public-classes --no-verify-jwt \
//     --project-ref uracuwugpxqjfgtuobal

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const MT_TENANT = 'betterbodybootcamp';
const MT_BASE   = `https://${MT_TENANT}.marianatek.com`;
const MT_TOKEN_URL = Deno.env.get('MT_OAUTH_TOKEN_URL') || `${MT_BASE}/o/token/`;
const MT_CLIENT_ID = Deno.env.get('MT_OAUTH_CLIENT_ID') || '';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // supabase-js auto-attaches Authorization + apikey + x-client-info; preflight
  // needs all of them allowed or the browser blocks the actual request.
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Max-Age':       '86400',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

let cachedAccessToken: string | null = null;
let cachedExpiresAt:   number | null = null;

function mtHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

async function refreshAccessToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
  const refresh = Deno.env.get('MT_OAUTH_REFRESH_TOKEN');
  if (!refresh || !MT_CLIENT_ID) {
    return { ok: false, error: 'no refresh_token / client_id — paste a fresh MT_OAUTH_ACCESS_TOKEN' };
  }
  const r = await fetch(MT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: MT_CLIENT_ID }),
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, error: `MT token endpoint HTTP ${r.status}: ${text.slice(0, 300)}` };
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: `Bad JSON: ${text.slice(0, 200)}` }; }
  if (!parsed.access_token) return { ok: false, error: 'no access_token in response' };
  cachedAccessToken = parsed.access_token;
  cachedExpiresAt   = Date.now() + ((parsed.expires_in || 3600) * 1000) - 60_000;
  return { ok: true, token: cachedAccessToken! };
}

async function getAccessToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
  if (cachedAccessToken && cachedExpiresAt && Date.now() < cachedExpiresAt) {
    return { ok: true, token: cachedAccessToken };
  }
  const seed = Deno.env.get('MT_OAUTH_ACCESS_TOKEN');
  if (seed) {
    cachedAccessToken = seed;
    cachedExpiresAt   = Date.now() + (6 * 24 * 60 * 60 * 1000);
    return { ok: true, token: cachedAccessToken };
  }
  return await refreshAccessToken();
}

async function mtGet(path: string): Promise<{ ok: boolean; status: number; data: any; raw: string }> {
  const tokRes = await getAccessToken();
  if (!tokRes.ok) return { ok: false, status: 0, data: null, raw: tokRes.error || 'no token' };

  let r = await fetch(`${MT_BASE}${path}`, { headers: mtHeaders(tokRes.token!) });
  let raw = await r.text();
  if (r.status === 401) {
    const rr = await refreshAccessToken();
    if (!rr.ok) return { ok: false, status: 401, data: null, raw: `401 + refresh failed: ${rr.error}` };
    r = await fetch(`${MT_BASE}${path}`, { headers: mtHeaders(rr.token!) });
    raw = await r.text();
  }
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw };
}

// Strip the "<Studio> Fitness/" prefix and Title-Case the class name for display.
// e.g. "Bayside Fitness/FULL BODY FRIDAY" → "Full Body Friday"
function prettifyClassName(rawName: string): string {
  if (!rawName) return 'Class';
  let n = rawName;
  const slash = n.indexOf('/');
  if (slash >= 0) n = n.slice(slash + 1).trim();
  if (n === n.toUpperCase() && /[A-Z]/.test(n)) {
    n = n.split(/\s+/).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  }
  return n;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const mtLocationId = Number(body.mt_location_id);
  if (!mtLocationId) return json({ ok: false, error: 'mt_location_id required' }, 400);
  const days = Math.min(Math.max(Number(body.days) || 7, 1), 14);

  const now      = new Date();
  const endDate  = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // Paginate the real (filtered) endpoint. Each studio: ~10/day × 7d = 70.
  // With page_size=100 that's typically 1 page; cap at 5 to be safe.
  const PAGE_SIZE = 100;
  const MAX_PAGES = 5;
  const items: any[] = [];
  let totalCount = 0;
  let page = 1;
  while (page <= MAX_PAGES) {
    const qs = new URLSearchParams({
      location:        String(mtLocationId),
      min_start_date:  isoDate(now),
      max_start_date:  isoDate(endDate),
      ordering:        'start_datetime',
      page_size:       String(PAGE_SIZE),
      page:            String(page),
    });
    const res = await mtGet(`/api/customer/v1/classes?${qs.toString()}`);
    if (!res.ok) {
      return json({
        ok: false, status: res.status,
        error: `MT API HTTP ${res.status}`,
        raw: (res.raw || '').slice(0, 600),
        hint: res.status === 401
          ? 'OAuth access token expired or invalid. Paste a fresh MT_OAUTH_ACCESS_TOKEN.'
          : null,
      }, 502);
    }
    const pageItems: any[] = res.data?.results ?? [];
    totalCount = Number(res.data?.count ?? 0);
    items.push(...pageItems);
    if (!res.data?.next || pageItems.length < PAGE_SIZE) break;
    page++;
  }

  // Map MT shape → render-ready shape. Drops cancelled classes by default.
  const flat = items
    .filter((c) => !c.is_cancelled)
    .map((c) => {
      const ct       = c.class_type || {};
      const className = prettifyClassName(c.name || ct.name || '');
      const studio    = (c.name || '').split('/')[0]?.trim() || '';
      const so        = c.spot_options || {};
      const capacity  = Number(c.capacity || so.primary_capacity || 0);
      const available = Number(c.available_spot_count || so.primary_availability || 0);
      const standbyCapacity = Number(so.standby_capacity || so.waitlist_capacity || 0);
      const standbyAvail    = Number(so.standby_availability || so.waitlist_availability || 0);
      const isFull       = capacity > 0 && available === 0;
      const waitlistOpen = isFull && standbyCapacity > 0 && standbyAvail > 0;
      const instructorNames = Array.isArray(c.instructors)
        ? c.instructors.map((i: any) => i?.name).filter(Boolean)
        : [];
      const durationMin = Number(ct.duration || 60);

      return {
        id:                String(c.id),
        start_datetime:    c.start_datetime,
        end_datetime:      c.end_datetime,
        duration_min:      durationMin,
        class_name:        className,
        studio_display:    studio,
        instructor_names:  instructorNames,
        location_display:  c.location?.name || null,
        classroom_display: c.classroom_name || c.classroom?.name || null,
        available_count:   available,
        capacity,
        is_full:           isFull,
        waitlist_open:     waitlistOpen,
        waitlist_count:    Math.max(0, standbyCapacity - standbyAvail),
        standby_capacity:  standbyCapacity,
        // Path consumed by the MT Web Integrations widget — when mounted
        // on a <div data-mariana-integrations={path}> the runtime renders
        // the customer-facing schedule iframe and handles auth + booking
        // inline. Correct format (confirmed by leaking the _mt query in a
        // real MT-generated deep link):
        //   /schedule/daily/{class_type_id}?activeDate={YYYY-MM-DD}&locations={loc_id}
        // class_type_id is the PROGRAM id (5897 = Full Body Friday), NOT
        // the region id (48541 was the long-standing red herring).
        class_type_id:     String(ct.id || ''),
        widget_path:       `/schedule/daily/${ct.id || ''}?activeDate=${(c.start_datetime || '').slice(0,10)}&locations=${mtLocationId}`,
        // Legacy alias for older clients that still read direct_book_url.
        direct_book_url:   `/schedule/daily/${ct.id || ''}?activeDate=${(c.start_datetime || '').slice(0,10)}&locations=${mtLocationId}`,
      };
    });

  return json({
    ok: true,
    mt_location_id: mtLocationId,
    days,
    count: flat.length,
    total_in_window: totalCount,
    pages_fetched: page,
    sessions: flat,
  });
});
