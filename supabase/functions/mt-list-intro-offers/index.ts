// Supabase Edge Function: mt-list-intro-offers
// 2026-06-29 — one-shot probe to enumerate MT intro offers across the BBB
// tenant. Output feeds the per-studio intro_offer_id values we need to embed
// MT's native "new customer signup + intro pass purchase" widget on
// /start/[studio] (or wired into existing /trial/[studio]) using:
//
//   <div data-mariana-integrations="/intro-offers/<id>" />
//
// MT Customer v1 API:
//   GET /api/customer/v1/intro_offers/   (lists all intro offers on tenant)
//
// Auth: same OAuth flow as mt-public-classes (MT_OAUTH_ACCESS_TOKEN secret,
// optional refresh via MT_OAUTH_REFRESH_TOKEN + MT_OAUTH_CLIENT_ID).
//
// Response shape we want to surface:
//   {
//     ok: true,
//     count: 8,
//     by_location: {
//       "48717 / Astoria":     [{ id, name, price, location_ids, ... }, ...],
//       "48718 / Bayside":     [...],
//       "48719 / Fresh Meadows": [...],
//       "48720 / Williamsburg":  [...],
//     },
//     raw: <full MT response, for debugging>
//   }
//
// Deploy:
//   supabase functions deploy mt-list-intro-offers --no-verify-jwt \
//     --project-ref uracuwugpxqjfgtuobal
//
// Invoke:
//   curl -X POST \
//     https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mt-list-intro-offers \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//     -H "Content-Type: application/json" -d '{}'

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const MT_TENANT     = 'betterbodybootcamp';
const MT_BASE       = `https://${MT_TENANT}.marianatek.com`;
const MT_TOKEN_URL  = Deno.env.get('MT_OAUTH_TOKEN_URL') || `${MT_BASE}/o/token/`;
const MT_CLIENT_ID  = Deno.env.get('MT_OAUTH_CLIENT_ID')  || '';

const STUDIO_NAMES: Record<string, string> = {
  '48717': 'Astoria',
  '48718': 'Bayside',
  '48719': 'Fresh Meadows',
  '48720': 'Williamsburg',
};

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Try the documented MT customer v1 endpoint first. If it 404s, fall back
  // through a few candidate paths so we surface the real one without needing
  // a redeploy each time.
  const CANDIDATES = [
    '/api/customer/v1/intro_offers/?page_size=100',
    '/api/customer/v1/sale_offerings/?is_intro=true&page_size=100',
    '/api/intro_offers/?page_size=100',
    '/api/customer/v1/sale_offerings/?page_size=100',
  ];

  const probes: any[] = [];
  let chosen: { path: string; data: any } | null = null;

  for (const path of CANDIDATES) {
    const res = await mtGet(path);
    probes.push({ path, status: res.status, ok: res.ok, raw_preview: (res.raw || '').slice(0, 200) });
    if (res.ok && res.data && (Array.isArray(res.data.results) || Array.isArray(res.data))) {
      chosen = { path, data: res.data };
      break;
    }
  }

  if (!chosen) {
    return json({
      ok: false,
      error: 'no MT intro_offers endpoint worked — see probes for what was tried',
      probes,
    }, 502);
  }

  const items: any[] = chosen.data.results ?? chosen.data;

  // Bucket by location id (intro offers usually carry an array of locations
  // they apply to). If MT returns them globally with no location array, we
  // dump them under "ALL".
  const by_location: Record<string, any[]> = {};
  for (const o of items) {
    const locIds: number[] = Array.isArray(o.locations) ? o.locations.map((l: any) => l.id ?? l)
                            : Array.isArray(o.location_ids) ? o.location_ids
                            : [];
    const compact = {
      id:     o.id,
      name:   o.name,
      price:  o.price ?? o.amount ?? o.cost ?? null,
      duration_days: o.duration ?? o.duration_days ?? null,
      class_count:   o.class_count ?? o.classes ?? null,
      is_active:     o.is_active ?? o.active ?? null,
      slug:   o.slug ?? null,
      url:    o.id ? `/intro-offers/${o.id}` : null,
      locations: locIds,
    };
    if (locIds.length === 0) {
      (by_location['ALL'] ||= []).push(compact);
    } else {
      for (const lid of locIds) {
        const label = `${lid} / ${STUDIO_NAMES[String(lid)] || 'unknown'}`;
        (by_location[label] ||= []).push(compact);
      }
    }
  }

  return json({
    ok: true,
    endpoint_used: chosen.path,
    count: items.length,
    by_location,
    probes,
  });
});
