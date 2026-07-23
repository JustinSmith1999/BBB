// Supabase Edge Function: mt-customer-auth
// 2026-06-26 — Local customer login against MT's OAuth password grant.
// =====================================================================
// Flow:
//   1. Customer enters email + password in BBB site's booking modal.
//   2. We POST to MT's /o/token/ with grant_type=password + the public
//      OAuth client_id we extracted from the live widget JS.
//   3. MT returns { access_token, refresh_token, expires_in }.
//   4. React stores the access_token in localStorage and uses it to
//      POST reservations directly to /api/customer/v1/me/reservations.
//
// Why a proxy instead of calling MT directly from the browser?
//   - Adds CORS so a JS fetch from betterbodybootcamp.com works.
//   - Keeps the client_id out of the React bundle (still constant, but
//     not handed to every visitor on first page load).
//   - Lets us shape error messages cleanly.
//
// Deploy:
//   supabase functions deploy mt-customer-auth --no-verify-jwt \
//     --project-ref uracuwugpxqjfgtuobal

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const MT_TENANT = 'betterbodybootcamp';
const MT_BASE   = `https://${MT_TENANT}.marianatek.com`;
// Public OAuth client_id extracted from the MT Web Integrations runtime
// at betterbodybootcamp.marianaiframes.com/js. This is the same client
// the MT widget uses when customers sign in inside the iframe.
const MT_PUBLIC_CLIENT_ID =
  Deno.env.get('MT_PUBLIC_CLIENT_ID') || 'sbLziNCoF5HcOhkSV6zRL8O7betwd3mDDIQbWZa3';

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

  const email    = String(body.email    || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return json({ ok: false, error: 'email + password required' }, 400);

  const params = new URLSearchParams({
    grant_type: 'password',
    username:   email,
    password,
    client_id:  MT_PUBLIC_CLIENT_ID,
  });

  const r = await fetch(`${MT_BASE}/o/token/`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!r.ok) {
    // MT returns { error: "invalid_grant" } for wrong creds, plus various
    // other shapes for other failure modes — surface what we can.
    const code = data?.error || 'login_failed';
    const friendly =
      code === 'invalid_grant' ? "That email + password didn't match an account."
      : code === 'invalid_client' ? 'Login is mis-configured. Please contact the studio.'
      : `Login failed (${code}).`;
    return json({ ok: false, error: friendly, code, status: r.status }, r.status === 401 ? 401 : 400);
  }

  if (!data?.access_token) return json({ ok: false, error: 'no access_token in response' }, 502);

  return json({
    ok:            true,
    access_token:  data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in:    Number(data.expires_in || 3600),
    token_type:    data.token_type || 'Bearer',
    scope:         data.scope || null,
  });
});
