// Supabase Edge Function: mariana-tek-sales-sync
//
// MT equivalent of mindbody-sales-sync. Pulls sales (POS transactions) from
// Mariana Tek for each BBB studio that has been cut over to MT, upserts into
// `mariana_tek_sales` (mirror shape of `mindbody_sales`).
//
// Auth model differs from MindBody:
//   - MT uses a per-studio subdomain + Bearer token (Studio API key OR OAuth2
//     access token). NO SourceCredentials/SiteId triple.
//   - Credentials are stored per-row on the `locations` table alongside the
//     existing mindbody_api_key / mindbody_site_id columns:
//       - mariana_tek_subdomain  → e.g. "bbb-williamsburg" (the {SUBDOMAIN} in
//         https://{SUBDOMAIN}.marianatek.com/api/...)
//       - mariana_tek_api_key    → Studio API key (sent as `Authorization: Bearer ...`)
//   - Studios missing either column are SKIPPED so we can cut over one studio
//     at a time without breaking the others.
//
// POST body:
//   { lookback_days?: number,    // default 30, max 180
//     dry_run?: boolean }
//
// Deploy: supabase functions deploy mariana-tek-sales-sync --no-verify-jwt

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const STUDIO_SLUGS = ['williamsburg', 'astoria', 'fresh-meadows', 'bayside'] as const;
type StudioSlug = typeof STUDIO_SLUGS[number];

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';

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

function mtHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

async function mtGet(subdomain: string, apiKey: string, path: string): Promise<any> {
  const url = `https://${subdomain}.marianatek.com${path}`;
  const r = await fetch(url, { headers: mtHeaders(apiKey) });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`MT GET ${url} → HTTP ${r.status}: ${txt}`);
  }
  return r.json();
}

// ─── TODO: VERIFY ENDPOINT SHAPE BEFORE GO-LIVE ─────────────────────────────
// Docs: https://guides.marianatek.com/api-overview
//
// The exact list-sales endpoint + query param names need to be verified
// against the MT sandbox. Likely candidates (per the docs):
//   GET /api/sales/
//     ?filter[created_after]=YYYY-MM-DD
//     &filter[created_before]=YYYY-MM-DD
//     &page[size]=200
//     &page[number]=N
//
// Justin: once you have a real sandbox response, EDIT THE TWO LINES BELOW
// marked `// EDIT-AT-CUTOVER` to (a) the verified path and (b) the verified
// pagination/response shape. Keep the function shape identical so the
// classifier in mariana-tek-capi-purchase-sync continues to work.
// ────────────────────────────────────────────────────────────────────────────
const MT_SALES_VERIFIED = false;          // EDIT-AT-CUTOVER: flip to true after verifying
const MT_SALES_PATH = '/api/sales/';      // EDIT-AT-CUTOVER: confirm exact path

async function fetchAllSalesForStudio(
  subdomain: string,
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<any[]> {
  if (!MT_SALES_VERIFIED) {
    throw new Error(
      `MT_API endpoint not yet verified — see TODO above MT_SALES_VERIFIED. ` +
      `Confirm GET ${MT_SALES_PATH} shape against https://guides.marianatek.com/api-overview ` +
      `then flip MT_SALES_VERIFIED = true.`
    );
  }
  const out: any[] = [];
  let page = 1;
  const size = 200;
  while (true) {
    const q =
      `?filter[created_after]=${startDate}` +
      `&filter[created_before]=${endDate}` +
      `&page[size]=${size}` +
      `&page[number]=${page}`;
    const data = await mtGet(subdomain, apiKey, `${MT_SALES_PATH}${q}`);
    // EDIT-AT-CUTOVER: confirm response envelope. JSON:API style returns
    // { data: [...], links: { next }, meta: { ... } }. Plain returns { results: [...] }.
    const rows = (data?.data ?? data?.results ?? []) as any[];
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < size) break;
    page += 1;
    if (page > 200) break; // safety cap
  }
  return out;
}

// Extract revenue in cents from a MT sale row. EDIT-AT-CUTOVER once you've
// seen real responses — likely candidates: attributes.total_cents,
// attributes.total, attributes.amount_paid, etc.
function extractTotalCents(s: any): number {
  const a = s?.attributes ?? s ?? {};
  for (const f of [a.total_cents, a.amount_cents, a.grand_total_cents]) {
    const n = Number(f);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  for (const f of [a.total, a.amount, a.grand_total, a.amount_paid]) {
    const n = Number(f);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }
  return 0;
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth: accept BBB_ADMIN_SECRET via x-bbb-secret OR service-role bearer.
  const secret = req.headers.get('x-bbb-secret') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const SR = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ua = req.headers.get('user-agent') ?? '';
  const okAuth = secret === ADMIN_SECRET || (SR && bearer === SR) || ua.startsWith('pg_net/');
  if (!okAuth) return json({ ok: false, error: 'unauthorized' }, 401);

  const body: { lookback_days?: number; dry_run?: boolean } =
    req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const lookbackDays = Math.max(1, Math.min(180, Number(body.lookback_days ?? 30)));
  const dryRun = !!body.dry_run;

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - lookbackDays);
  const startDate = fmtDate(start);
  const endDate   = fmtDate(today);

  // Read per-studio MT creds from `locations`. Skip any studio missing
  // either subdomain or api_key — that studio hasn't been cut over yet.
  const { data: locs, error: locErr } = await sb
    .from('locations')
    .select('id, slug, mariana_tek_subdomain, mariana_tek_api_key')
    .in('slug', STUDIO_SLUGS as unknown as string[]);
  if (locErr) return json({ ok: false, error: `locations lookup: ${locErr.message}` }, 500);

  const result: Record<string, unknown> = {
    ok: true,
    window: `${startDate} → ${endDate}`,
    lookback_days: lookbackDays,
    dry_run: dryRun,
    studios: [] as unknown[],
  };

  const allSales: any[] = [];
  const perStudio: Record<string, { studio: string; status: string; sales: number; revenue_cents: number; error?: string }> = {};

  for (const slug of STUDIO_SLUGS) {
    perStudio[slug] = { studio: slug, status: 'pending', sales: 0, revenue_cents: 0 };
  }

  for (const loc of (locs ?? []) as LocationRow[]) {
    const slug = loc.slug as StudioSlug;
    if (!perStudio[slug]) continue; // unknown slug — defensive
    if (!loc.mariana_tek_subdomain || !loc.mariana_tek_api_key) {
      perStudio[slug].status = 'skipped (no MT creds)';
      continue;
    }
    try {
      const rows = await fetchAllSalesForStudio(
        loc.mariana_tek_subdomain,
        loc.mariana_tek_api_key,
        startDate,
        endDate,
      );
      for (const s of rows) {
        const a = s?.attributes ?? s ?? {};
        const totalCents = extractTotalCents(s);
        const mtSaleId = String(s?.id ?? a?.id ?? `${slug}-${a?.created ?? ''}`);
        // EDIT-AT-CUTOVER: confirm the field names below against a real MT
        // /api/sales/ response. The shapes here are best-guess from the docs.
        allSales.push({
          mt_sale_id: mtSaleId,
          studio_slug: slug,
          location_id: loc.id,
          sale_date_time: a.created ?? a.sale_date_time ?? a.created_at ?? null,
          customer_mt_id: a.user_id != null ? String(a.user_id)
            : (a.customer_id != null ? String(a.customer_id) : null),
          customer_first_name: a.user?.first_name ?? a.customer?.first_name ?? null,
          customer_last_name:  a.user?.last_name  ?? a.customer?.last_name  ?? null,
          customer_email:      a.user?.email      ?? a.customer?.email      ?? null,
          payment_method: Array.isArray(a.payments)
            ? a.payments.map((p: any) => p.method || p.type || '').filter(Boolean).join(', ') || null
            : (a.payment_method ?? null),
          item_names: Array.isArray(a.line_items)
            ? a.line_items.map((it: any) => it.name || it.description || '').filter(Boolean).join(' · ') || null
            : (a.items?.map?.((it: any) => it.name).filter(Boolean).join(' · ') ?? null),
          item_count: Array.isArray(a.line_items) ? a.line_items.length
            : (Array.isArray(a.items) ? a.items.length : 0),
          total_cents: totalCents,
          raw: s,
          synced_at: new Date().toISOString(),
        });
        perStudio[slug].sales++;
        perStudio[slug].revenue_cents += totalCents;
      }
      perStudio[slug].status = 'ok';
    } catch (e) {
      perStudio[slug].status = 'error';
      perStudio[slug].error = String((e as Error).message ?? e);
    }
  }

  result.studios = Object.values(perStudio);
  result.total_sales = allSales.length;
  result.total_revenue_cents = allSales.reduce((a, s) => a + Number(s.total_cents || 0), 0);

  if (dryRun) {
    result.dry_run_sample = allSales.slice(0, 3);
    return json(result);
  }

  if (allSales.length > 0) {
    let upserted = 0;
    for (let i = 0; i < allSales.length; i += 500) {
      const batch = allSales.slice(i, i + 500);
      const { error } = await sb
        .from('mariana_tek_sales')
        .upsert(batch, { onConflict: 'mt_sale_id' });
      if (error) { (result as any).upsert_error = error.message; break; }
      upserted += batch.length;
    }
    result.sales_upserted = upserted;
  }

  return json(result);
});
