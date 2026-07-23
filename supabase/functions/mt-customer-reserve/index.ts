// Supabase Edge Function: mt-customer-reserve
// 2026-06-26 — Books a class for the signed-in customer.
// =====================================================================
// Flow:
//   1. React passes { customer_access_token, class_session_id }.
//   2. We POST to /api/customer/v1/me/reservations using the customer's
//      Bearer token (NOT the admin token).
//   3. Returns the reservation id + status, or a friendly error.
//
// Spec for the request body (per the OpenAPI schema we downloaded earlier):
//   {
//     "class_session_id": "30265",
//     "spot_id":          null,        // optional, for spot-selection rooms
//     "class_session_payment_option_id": null  // optional, e.g. trial pass
//   }
//
// Some MT tenants reject reservations that need a payment option chosen;
// in that case the customer needs to go through buy flow first (e.g. the
// $49 trial). We pass the payment_option_id if React provides one.
//
// Deploy:
//   supabase functions deploy mt-customer-reserve --no-verify-jwt \
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const customerToken = String(body.customer_access_token || '');
  const classId       = String(body.class_session_id     || '');
  const paymentOpt    = body.class_session_payment_option_id ? String(body.class_session_payment_option_id) : null;
  const spotId        = body.spot_id ? String(body.spot_id) : null;

  if (!customerToken) return json({ ok: false, error: 'customer_access_token required' }, 400);
  if (!classId)       return json({ ok: false, error: 'class_session_id required'      }, 400);

  // First: pull the class detail so we can surface human errors (full,
  // out-of-window, etc.) before MT throws an opaque 4xx at us.
  const checkRes = await fetch(`${MT_BASE}/api/customer/v1/classes/${classId}/`, {
    headers: { Authorization: `Bearer ${customerToken}`, Accept: 'application/json' },
  });
  if (!checkRes.ok) {
    return json({
      ok: false,
      error: checkRes.status === 401
        ? 'Your session expired — please sign in again.'
        : `Couldn't look up that class (${checkRes.status}).`,
      status: checkRes.status,
    }, checkRes.status === 401 ? 401 : 502);
  }

  // POST the reservation. The Customer API accepts plain JSON here
  // (NOT JSON:API envelope) per /me/reservations spec.
  const reserveBody: any = { class_session_id: classId };
  if (paymentOpt) reserveBody.class_session_payment_option_id = paymentOpt;
  if (spotId)     reserveBody.spot_id = spotId;

  const r = await fetch(`${MT_BASE}/api/customer/v1/me/reservations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${customerToken}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify(reserveBody),
  });
  const raw = await r.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}

  if (!r.ok) {
    // MT validation errors are usually shaped like:
    //   { "non_field_errors": ["..."] } OR { "detail": "..." }
    const detail =
      (Array.isArray(data?.non_field_errors) && data.non_field_errors[0]) ||
      data?.detail ||
      data?.error  ||
      `Reserve failed (${r.status})`;
    // Map common cases to friendlier copy
    let friendly = String(detail);
    if (/payment option/i.test(friendly))
      friendly = "You'll need to pick or buy a class pack first. Tap 'Get the BBB app' below.";
    else if (/full|capacity|spots/i.test(friendly))
      friendly = "That class is full. Try the waitlist or another time.";
    else if (/already reserved/i.test(friendly))
      friendly = "You're already on the list for this class.";
    return json({ ok: false, error: friendly, status: r.status, raw: raw.slice(0, 500) }, r.status === 401 ? 401 : 400);
  }

  return json({
    ok:             true,
    reservation_id: data?.id || data?.data?.id || null,
    state:          data?.state || data?.status || 'booked',
    class_session_id: classId,
  });
});
