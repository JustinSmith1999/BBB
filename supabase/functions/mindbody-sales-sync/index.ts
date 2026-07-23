// Supabase Edge Function: mindbody-sales-sync
//
// Pulls every sale (POS transaction) from MindBody for each BBB studio since
// the May 15 launch. Powers the dashboard's "In-person" revenue card so
// walk-ins, phone signups, packs, and comps actually show up — instead of
// the studios telling us "you're missing our sales."
//
// Uses SourceCredentials header auth (J20 source) which we activated this
// morning. Falls back to anonymous Api-Key auth which returns nothing for
// /sale/sales, so the source creds are required.
//
// POST body:
//   { lookback_days?: number,    // default 30, max 180
//     dry_run?: boolean }
//
// Deploy: supabase functions deploy mindbody-sales-sync --no-verify-jwt

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MB_BASE = 'https://api.mindbodyonline.com/public/v6';

// Same LocationId → studio slug map as mindbody-visits-sync. Keep them in sync.
const STUDIO_MAP: Record<number, string> = {
  1: 'williamsburg',
  2: 'astoria',
  3: 'fresh-meadows',
  6: 'bayside',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

function mbHeaders(): Record<string, string> {
  const apiKey  = Deno.env.get('MINDBODY_API_KEY') ?? '';
  const siteId  = Deno.env.get('MINDBODY_SITE_ID') ?? '';
  const srcName = Deno.env.get('MINDBODY_SOURCE_NAME') ?? '';
  const srcPass = Deno.env.get('MINDBODY_SOURCE_PASSWORD') ?? '';
  if (!apiKey || !siteId) throw new Error('Missing MINDBODY_API_KEY or MINDBODY_SITE_ID env vars');
  if (!srcName || !srcPass) throw new Error('Missing MINDBODY_SOURCE_NAME or MINDBODY_SOURCE_PASSWORD — /sale/sales requires source auth');
  return {
    'Api-Key': apiKey,
    'SiteId':  siteId,
    'SourceCredentials': `${srcName}|${srcPass}`,
  };
}

async function mbGet(path: string): Promise<any> {
  const r = await fetch(`${MB_BASE}${path}`, { headers: mbHeaders() });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`MindBody GET ${path} → HTTP ${r.status}: ${txt}`);
  }
  return r.json();
}

// /sale/sales returns site-wide sales (the LocationId query filter is not
// honored server-side for some endpoints). Pull ONCE per site, paginate by
// Offset, and assign each sale to its studio in-app based on s.LocationId.
async function fetchAllSiteSales(startDate: string, endDate: string): Promise<any[]> {
  const out: any[] = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const q = `StartSaleDateTime=${startDate}T00:00:00` +
              `&EndSaleDateTime=${endDate}T23:59:59` +
              `&Limit=${limit}&Offset=${offset}`;
    const data = await mbGet(`/sale/sales?${q}`);
    const sales = (data?.Sales ?? []) as any[];
    if (!sales.length) break;
    out.push(...sales);
    if (sales.length < limit) break;
    offset += limit;
    if (offset > 10000) break;  // safety stop
  }
  return out;
}

// MindBody Sale objects expose revenue in three different places depending on
// the sale type. Earlier version of this helper returned 0 for paid sales
// because the original Payments-array reduce was being beaten by JS coercion
// quirks; replaced with explicit branch logic + a PurchasedItems fallback so
// memberships, drop-ins, and account-payment sales all roll up correctly.
//
// Source priority:
//   1. Sum PurchasedItems[].TotalAmount (or UnitPrice × Quantity) — the
//      authoritative "items sold for this much" — skipping Returned=true rows.
//      This is the most reliable signal for memberships and packs.
//   2. Sum Payments[].Amount — what was actually collected on the card. Used
//      when PurchasedItems is empty / missing prices.
//   3. Top-level fields (Total/GrandTotal/SaleAmount) — last resort, almost
//      never populated on /sale/sales records.
function extractTotalCents(s: any): number {
  // 1. PurchasedItems sum (skip returned/refunded line items)
  let itemSum = 0;
  if (Array.isArray(s.PurchasedItems)) {
    for (const it of s.PurchasedItems) {
      if (!it || it.Returned === true) continue;
      const ta = Number(it.TotalAmount);
      if (Number.isFinite(ta) && ta > 0) { itemSum += ta; continue; }
      const up = Number(it.UnitPrice);
      const qty = Number(it.Quantity);
      if (Number.isFinite(up) && up > 0 && Number.isFinite(qty) && qty > 0) {
        itemSum += up * qty;
      }
    }
  }
  if (itemSum > 0) return Math.round(itemSum * 100);

  // 2. Payments sum
  let payTotal = 0;
  if (Array.isArray(s.Payments)) {
    for (const p of s.Payments) {
      const n = Number(p?.Amount);
      if (Number.isFinite(n) && n > 0) payTotal += n;
    }
  }
  if (payTotal > 0) return Math.round(payTotal * 100);

  // 3. Top-level candidates
  for (const f of [s.Total, s.GrandTotal, s.SaleAmount, s.AmountTotal, s.Amount]) {
    const n = Number(f);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }
  return 0;
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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

  const result: Record<string, unknown> = {
    window: `${startDate} → ${endDate}`,
    lookback_days: lookbackDays,
    dry_run: dryRun,
    studios: [] as unknown[],
  };

  const allSales: any[] = [];
  const perStudio: Record<string, { studio: string; location_id: number; sales: number; revenue_cents: number }> = {};
  // Pre-seed every studio so the result has a row even with 0 sales.
  for (const [locIdStr, slug] of Object.entries(STUDIO_MAP)) {
    perStudio[slug] = { studio: slug, location_id: Number(locIdStr), sales: 0, revenue_cents: 0 };
  }
  let unrouted = 0;

  try {
    const siteSales = await fetchAllSiteSales(startDate, endDate);
    for (const s of siteSales) {
      const locId = Number(s.LocationId ?? 0);
      const slug = STUDIO_MAP[locId];
      if (!slug) { unrouted++; continue; }  // 98 = online store, etc.
      const totalCents = extractTotalCents(s);
      allSales.push({
        mindbody_sale_id: String(s.Id ?? s.SaleId ?? `${locId}-${s.SaleDateTime ?? ''}`),
        studio_slug: slug,
        location_id: locId,
        sale_date_time: s.SaleDateTime ?? s.SaleTime ?? null,
        customer_mindbody_id: s.ClientId != null ? String(s.ClientId) : null,
        customer_first_name: s.PurchasedBy?.FirstName ?? null,
        customer_last_name:  s.PurchasedBy?.LastName ?? null,
        customer_email:      s.PurchasedBy?.Email ?? null,
        payment_method: (s.Payments ?? [])
          .map((p: any) => p.Method || p.Name || p.Type || '')
          .filter(Boolean).join(', ') || null,
        item_names: (s.PurchasedItems ?? s.Items ?? [])
          .map((it: any) => it.Name || it.Description || '')
          .filter(Boolean).join(' · ') || null,
        item_count: (s.PurchasedItems ?? s.Items ?? []).length,
        total_cents: totalCents,
        raw: s,
        synced_at: new Date().toISOString(),
      });
      perStudio[slug].sales++;
      perStudio[slug].revenue_cents += totalCents;
    }
    (result as any).site_sales_returned = siteSales.length;
    (result as any).unrouted_sales = unrouted;
  } catch (e) {
    (result as any).fetch_error = String((e as Error).message ?? e);
  }

  result.studios = Object.values(perStudio);
  result.total_sales = allSales.length;
  result.total_revenue_cents = allSales.reduce((a, s) => a + Number(s.total_cents || 0), 0);

  if (dryRun) {
    result.dry_run_sample = allSales.slice(0, 3);
    return json(result);
  }

  // Upsert in batches of 500, conflict on mindbody_sale_id.
  if (allSales.length > 0) {
    let upserted = 0;
    for (let i = 0; i < allSales.length; i += 500) {
      const batch = allSales.slice(i, i + 500);
      const { error } = await sb
        .from('mindbody_sales')
        .upsert(batch, { onConflict: 'mindbody_sale_id' });
      if (error) { result.upsert_error = error.message; break; }
      upserted += batch.length;
    }
    result.sales_upserted = upserted;
  }

  return json(result);
});
