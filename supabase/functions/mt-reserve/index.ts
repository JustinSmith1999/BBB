// Supabase Edge Function: mt-reserve
// 2026-06-26 Phase 3 scaffold — in-page MT reservation.
// =====================================================================
// Flow when fully wired:
//   1. Customer clicks "Reserve" on NativeClassList.
//   2. React calls this fn with { class_session_id, user_access_token }.
//   3. We POST /api/reservations/ to MT with the CUSTOMER'S OAuth token
//      (not admin) → MT books them in.
//   4. Return reservation status to React.
//
// Phase 3 BLOCKER: requires public OAuth client ID/secret from MT dev
// portal (developers.marianatek.com/organizations/559/) so the React side
// can run the user-facing OAuth dance and get the customer's per-account
// access token. Without it we can only deep-link customers to MT's own
// reserve page (see Phase 2.5 below).
//
// PHASE 2.5 (current, no creds needed): if called WITHOUT a user token,
// returns a reserve URL the React side can window.open() — MT handles auth
// on its end, then redirects back to our success page. Worse UX than full
// in-page, but works today.
//
// Env:
//   MT_OAUTH_ACCESS_TOKEN   — admin token, used for verifying class_session
//                             exists + capacity check before redirecting
//   MT_OAUTH_REFRESH_TOKEN  — optional, for auto-refresh
//   MT_OAUTH_CLIENT_ID      — optional, needed for refresh + Phase 3
//
// POST body (Phase 3):
//   { class_session_id: "123", user_access_token: "...", redirect_to?: "..." }
// POST body (Phase 2.5):
//   { class_session_id: "123", redirect_to?: "https://betterbodybootcamp.com/booked" }
//
// Deploy:
//   supabase functions deploy mt-reserve --no-verify-jwt \
//     --project-ref uracuwugpxqjfgtuobal

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const MT_TENANT = 'betterbodybootcamp';
const MT_BASE   = `https://${MT_TENANT}.marianatek.com`;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Max-Age':       '86400',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function adminMtGet(path: string): Promise<{ ok: boolean; status: number; data: any; raw: string }> {
  const tok = Deno.env.get('MT_OAUTH_ACCESS_TOKEN');
  if (!tok) return { ok: false, status: 0, data: null, raw: 'MT_OAUTH_ACCESS_TOKEN not set' };
  const r = await fetch(`${MT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.api+json' },
  });
  const raw = await r.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw };
}

async function postReservationWithUserToken(classSessionId: string, userToken: string) {
  const body = {
    data: {
      type: 'reservation',
      attributes: { /* MT figures out user from token */ },
      relationships: {
        class_session: { data: { type: 'class_session', id: String(classSessionId) } },
      },
    },
  };
  const r = await fetch(`${MT_BASE}/api/reservations/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/vnd.api+json',
      Accept:         'application/vnd.api+json',
    },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const classSessionId = String(body.class_session_id || '');
  if (!classSessionId) return json({ ok: false, error: 'class_session_id required' }, 400);

  // Verify the session exists + has spots (admin-side check).
  const check = await adminMtGet(`/api/class_sessions/${classSessionId}/`);
  if (!check.ok) {
    return json({
      ok: false, status: check.status,
      error: `MT class_session lookup failed (${check.status})`,
      raw: check.raw.slice(0, 300),
    }, 502);
  }
  const attrs    = check.data?.data?.attributes ?? {};
  const capacity = Number(attrs.capacity || 0);
  const open     = Array.isArray(attrs.available_spots) ? attrs.available_spots.length : 0;
  const waitlist = capacity > 0 && open === 0 && Number(attrs.standby_capacity || 0) > 0;
  const isFull   = capacity > 0 && open === 0 && !waitlist;

  if (isFull) return json({ ok: false, error: 'Class is full and waitlist is closed', state: 'full' }, 409);

  // ─── Phase 3: full in-page reservation ────────────────────────────────
  if (body.user_access_token) {
    const res = await postReservationWithUserToken(classSessionId, String(body.user_access_token));
    if (!res.ok) {
      return json({
        ok: false, status: res.status,
        error: `MT reservation POST failed (${res.status})`,
        raw: res.raw.slice(0, 400),
      }, res.status === 401 ? 401 : 502);
    }
    return json({
      ok: true, mode: 'in_page', state: waitlist ? 'waitlisted' : 'booked',
      reservation_id: res.data?.data?.id || null,
      class_session_id: classSessionId,
    });
  }

  // ─── Phase 2.5 fallback: redirect URL ─────────────────────────────────
  // No user token yet — return MT's own reserve URL. React side will
  // window.open() this. Customer signs in (or is already signed in) on MT,
  // confirms booking, then MT redirects back.
  const redirectTo = body.redirect_to ? `?redirect_to=${encodeURIComponent(String(body.redirect_to))}` : '';
  return json({
    ok: true,
    mode: 'redirect',
    state: waitlist ? 'waitlist_available' : 'spots_open',
    reserve_url: `${MT_BASE}/class_sessions/${classSessionId}${redirectTo}`,
    capacity, open_spots: open, waitlist_open: waitlist,
  });
});
