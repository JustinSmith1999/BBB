// Diagnostic: query MindBody for sales + clients on demand.
// POST { studio_slug, since? (YYYY-MM-DD), search_name? } with service-role bearer.
// Returns the raw MB /sale/sales response + /client/clients SearchText match.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const MB_BASE = 'https://api.mindbodyonline.com/public/v6';
const STUDIO_TO_MB_LOC: Record<string, number> = {
  williamsburg: 1, astoria: 2, 'fresh-meadows': 3, bayside: 6,
};

let cachedToken: { token: string; issuedAt: number } | null = null;
async function getToken(): Promise<string> {
  if (cachedToken && (Date.now() - cachedToken.issuedAt) < 12 * 3600 * 1000) {
    return cachedToken.token;
  }
  const apiKey = Deno.env.get('MINDBODY_API_KEY') ?? '';
  const siteId = Deno.env.get('MINDBODY_SITE_ID') ?? '';
  const user = Deno.env.get('MINDBODY_STAFF_USER') ?? Deno.env.get('MINDBODY_STAFF_USERNAME') ?? '';
  const pass = Deno.env.get('MINDBODY_STAFF_PASS') ?? Deno.env.get('MINDBODY_STAFF_PASSWORD') ?? '';
  const r = await fetch(`${MB_BASE}/usertoken/issue`, {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'SiteId': siteId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: user, Password: pass }),
  });
  const body = await r.json();
  if (!body?.AccessToken) throw new Error(`token failed: ${JSON.stringify(body).slice(0, 300)}`);
  cachedToken = { token: body.AccessToken, issuedAt: Date.now() };
  return cachedToken.token;
}

async function mbGet(path: string): Promise<any> {
  const token = await getToken();
  const apiKey = Deno.env.get('MINDBODY_API_KEY') ?? '';
  const siteId = Deno.env.get('MINDBODY_SITE_ID') ?? '';
  const r = await fetch(`${MB_BASE}${path}`, {
    headers: { 'Api-Key': apiKey, 'SiteId': siteId, 'Authorization': token },
  });
  const text = await r.text();
  try { return { http_status: r.status, body: JSON.parse(text) }; }
  catch { return { http_status: r.status, body: text }; }
}

serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const auth = req.headers.get('authorization') || '';
  const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!sr || !auth.includes(sr.slice(-20))) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const studioSlug = String(body.studio_slug || 'astoria').toLowerCase();
    const since = String(body.since || new Date().toISOString().slice(0, 10));
    const searchName = body.search_name ? String(body.search_name) : null;
    const mbLoc = STUDIO_TO_MB_LOC[studioSlug];
    if (!mbLoc) throw new Error(`unknown studio_slug: ${studioSlug}`);

    // Sales for the studio for the date range
    const salesRes = await mbGet(
      `/sale/sales?LocationId=${mbLoc}&StartSaleDateTime=${since}T00:00:00&EndSaleDateTime=${since}T23:59:59&Limit=100`
    );

    // Client search if requested
    let clientRes: any = null;
    if (searchName) {
      clientRes = await mbGet(`/client/clients?SearchText=${encodeURIComponent(searchName)}&Limit=10`);
    }

    return new Response(JSON.stringify({
      ok: true,
      studio: studioSlug,
      mb_location_id: mbLoc,
      since,
      sales: salesRes,
      client_search: clientRes,
    }, null, 2), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
