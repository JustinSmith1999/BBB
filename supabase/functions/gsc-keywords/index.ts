/**
 * gsc-keywords — every search term BBB appears for, aggregated.
 * ═══════════════════════════════════════════════════════════════════════════
 * READ ONLY. Writes nothing.
 *
 * Built 2026-10-16 (Justin: "what are all the keywords"). gsc-sync pulls
 * Google Search Console into gsc_search_performance, but nothing read it back
 * — a dry run only returns a 5-row sample out of ~8,600 daily rows.
 *
 * This rolls those daily rows up per query: total clicks, total impressions,
 * true CTR, impression-weighted average position, and the page Google most
 * often shows for it.
 *
 * WEIGHTING MATTERS. Averaging the stored `position` column across days gives
 * every day equal weight, so one impression at rank 2 on a quiet Sunday
 * outranks 400 impressions at rank 40. Position here is weighted by
 * impressions, which is how Search Console itself reports it.
 *
 * Body: { "days": 28, "studio": "astoria", "min_impressions": 1,
 *         "limit": 200, "branded": "include" | "exclude" | "only" }
 *
 * Auth: x-bbb-secret.  Deploy: bbb deploy-fn gsc-keywords
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// "Branded" = someone already looking for THIS gym. Those rank first and
// convert best, but they are demand you already had — they tell you nothing
// about reaching anyone new, so they are separable here.
const BRAND = /better\s*body|betterbody|bbb\s*bootcamp/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const days = Math.min(Math.max(Number(body.days ?? 28), 1), 180);
  const studio = body.studio ? String(body.studio).toLowerCase() : null;
  const minImp = Math.max(Number(body.min_impressions ?? 1), 1);
  const limit = Math.min(Math.max(Number(body.limit ?? 200), 1), 2000);
  const branded = String(body.branded ?? "include");

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Paginate — this table holds one row per (date, studio, query, page) and
  // runs to thousands of rows per month.
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb
      .from("gsc_search_performance")
      .select("date,studio_slug,query,page,clicks,impressions,position")
      .gte("date", since)
      .order("date", { ascending: false })
      .range(from, from + 999);
    if (studio) q = q.eq("studio_slug", studio);
    const { data, error } = await q;
    if (error) return json({ ok: false, error: `gsc_search_performance: ${error.message}` }, 502);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
    if (rows.length >= 60000) break;   // sanity stop
  }

  type Agg = {
    query: string; clicks: number; impressions: number;
    posWeighted: number;            // Σ(position × impressions)
    pages: Record<string, number>;  // page -> impressions
    studios: Record<string, number>;
  };
  const byQuery = new Map<string, Agg>();
  for (const r of rows) {
    const k = String(r.query);
    const a = byQuery.get(k) ?? { query: k, clicks: 0, impressions: 0, posWeighted: 0, pages: {}, studios: {} };
    const imp = Number(r.impressions) || 0;
    a.clicks += Number(r.clicks) || 0;
    a.impressions += imp;
    a.posWeighted += (Number(r.position) || 0) * imp;
    a.pages[r.page] = (a.pages[r.page] || 0) + imp;
    a.studios[r.studio_slug] = (a.studios[r.studio_slug] || 0) + imp;
    byQuery.set(k, a);
  }

  let all = [...byQuery.values()]
    .filter((a) => a.impressions >= minImp)
    .map((a) => {
      const topPage = Object.entries(a.pages).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
      const topStudio = Object.entries(a.studios).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
      return {
        query: a.query,
        clicks: a.clicks,
        impressions: a.impressions,
        ctr_pct: a.impressions ? +((a.clicks / a.impressions) * 100).toFixed(1) : 0,
        avg_position: a.impressions ? +(a.posWeighted / a.impressions).toFixed(1) : null,
        branded: BRAND.test(a.query),
        top_page: topPage,
        studio: topStudio,
      };
    });

  if (branded === "exclude") all = all.filter((a) => !a.branded);
  if (branded === "only") all = all.filter((a) => a.branded);

  const byClicks = [...all].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  // The money list: lots of impressions, poor rank, few clicks. These are
  // searches Google already shows BBB for and where a few positions of
  // movement turns nothing into traffic.
  const nearMisses = [...all]
    .filter((a) => a.impressions >= 20 && (a.avg_position ?? 99) > 8 && (a.avg_position ?? 99) <= 40)
    .sort((a, b) => b.impressions - a.impressions);

  const totals = all.reduce(
    (t, a) => ({ clicks: t.clicks + a.clicks, impressions: t.impressions + a.impressions }),
    { clicks: 0, impressions: 0 },
  );
  const brandedTotals = all.filter((a) => a.branded).reduce(
    (t, a) => ({ clicks: t.clicks + a.clicks, impressions: t.impressions + a.impressions }),
    { clicks: 0, impressions: 0 },
  );

  return json({
    ok: true,
    read_only: true,
    window_days: days,
    since,
    studio: studio ?? "all",
    daily_rows_scanned: rows.length,
    unique_queries: all.length,
    totals: {
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr_pct: totals.impressions ? +((totals.clicks / totals.impressions) * 100).toFixed(2) : 0,
      branded_clicks: brandedTotals.clicks,
      non_branded_clicks: totals.clicks - brandedTotals.clicks,
      branded_share_of_clicks_pct: totals.clicks
        ? +((brandedTotals.clicks / totals.clicks) * 100).toFixed(1) : 0,
    },
    how_to_read:
      "avg_position is weighted by impressions, the way Search Console reports it — a flat " +
      "average over days would let one impression at rank 2 outweigh 400 at rank 40. " +
      "branded = someone searching for Better Body by name: demand you already had.",
    near_misses_note:
      "near_misses are searches Google ALREADY shows you for, at rank 9-40, with real " +
      "impression volume. Moving those up is cheaper than ranking for something new.",
    near_misses: nearMisses.slice(0, 40),
    keywords: byClicks.slice(0, limit),
  });
});
