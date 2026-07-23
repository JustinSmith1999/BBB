// ─────────────────────────────────────────────────────────────────────────────
// netlify-analytics-sync — pulls Netlify Web Analytics data for the BBB site
// and upserts it into four sibling tables (daily, pages, sources, countries).
//
// Calls Netlify's analytics REST API per day for the last N days (default 30).
// Idempotent — re-syncing yesterday just refreshes the row.
//
// SECRETS REQUIRED (in Supabase Edge Function env):
//   NETLIFY_API_TOKEN  — Personal Access Token from app.netlify.com
//   NETLIFY_SITE_ID    — 705bda8a-404a-4869-b973-20741de103be (bbbmarketing)
//
// Run modes:
//   GET / POST {}              → sync last 30 days
//   POST { "days": N }         → sync last N days
//   POST { "since": "YYYY-MM-DD" } → sync from that date forward
//
// Deploy:
//   supabase functions deploy netlify-analytics-sync --no-verify-jwt
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NETLIFY_API = "https://api.netlify.com/api/v1";
const TOKEN  = Deno.env.get("NETLIFY_API_TOKEN") || "";
const SITE   = Deno.env.get("NETLIFY_SITE_ID")  || "";

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function netlifyGet(path: string): Promise<any> {
  const r = await fetch(`${NETLIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) {
    throw new Error(`Netlify ${path} → ${r.status} ${await r.text().then(s => s.slice(0,200))}`);
  }
  return r.json();
}

// Netlify timeseries endpoints return { data: [{start, end, count}] } with
// start/end in epoch milliseconds. Convert to (date, count) tuples.
function tsToDailyRows(json: any, valueKey: string): Array<{ date: string; value: number }> {
  const rows = (json?.data || []) as Array<{ start: number; end: number; count: number }>;
  return rows
    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.count))
    .map(r => ({ date: new Date(r.start).toISOString().slice(0, 10), value: r.count }));
}

// Ranking endpoints return { data: [{resource, count}] } for the WHOLE window.
// We attribute everything to the LAST day of the window, since Netlify doesn't
// expose per-day rankings. (Cheap + simple — re-running tomorrow refreshes
// the snapshot.)
function rankingToRows(json: any, keyName: string): Array<{ key: string; value: number }> {
  const rows = (json?.data || []) as Array<any>;
  return rows
    .filter(r => r?.[keyName] != null && Number.isFinite(r?.count))
    .map(r => ({ key: String(r[keyName]), value: Number(r.count) }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: cors });
  }

  if (!TOKEN || !SITE) {
    return new Response(JSON.stringify({
      ok: false,
      error: "NETLIFY_API_TOKEN and NETLIFY_SITE_ID required as Supabase secrets",
    }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Parse body
  let body: any = {};
  try { body = req.method === "POST" ? await req.json().catch(() => ({})) : {}; }
  catch { body = {}; }

  const days = Number.isFinite(body.days) ? Number(body.days) : 30;
  const since = body.since
    ? new Date(body.since + "T00:00:00Z")
    : new Date(Date.now() - days * 86400000);
  const until = new Date(); // now
  const fromIso = dateOnly(since);
  const toIso   = dateOnly(until);

  const t0 = Date.now();
  const result: any = { ok: true, from: fromIso, to: toIso, fetched: {}, upserted: {} };

  try {
    // 1. PAGEVIEWS (timeseries — one row per day)
    const pvJson = await netlifyGet(
      `/sites/${SITE}/analytics/pageviews?from=${fromIso}&to=${toIso}&resolution=day&timezone=America%2FNew_York`
    );
    const pvDaily = tsToDailyRows(pvJson, "count");
    result.fetched.pageviews_days = pvDaily.length;

    // 2. UNIQUE VISITORS (timeseries)
    const uvJson = await netlifyGet(
      `/sites/${SITE}/analytics/visitors?from=${fromIso}&to=${toIso}&resolution=day&timezone=America%2FNew_York`
    );
    const uvDaily = tsToDailyRows(uvJson, "count");
    result.fetched.visitors_days = uvDaily.length;

    // Merge into one row per date
    const dailyByDate = new Map<string, { date: string; pageviews: number; unique_visitors: number }>();
    for (const r of pvDaily) {
      dailyByDate.set(r.date, { date: r.date, pageviews: r.value, unique_visitors: 0 });
    }
    for (const r of uvDaily) {
      const existing = dailyByDate.get(r.date) ?? { date: r.date, pageviews: 0, unique_visitors: 0 };
      existing.unique_visitors = r.value;
      dailyByDate.set(r.date, existing);
    }
    const dailyRows = Array.from(dailyByDate.values()).map(r => ({ ...r, synced_at: new Date().toISOString() }));
    if (dailyRows.length) {
      const { error } = await supabase.from("netlify_analytics_daily").upsert(dailyRows, { onConflict: "date" });
      if (error) throw error;
      result.upserted.daily = dailyRows.length;
    }

    // 3. TOP PAGES (ranking — snapshot for the window, attributed to toIso)
    const pagesJson = await netlifyGet(
      `/sites/${SITE}/analytics/ranking/pages?from=${fromIso}&to=${toIso}&limit=50&timezone=America%2FNew_York`
    );
    const pageRows = rankingToRows(pagesJson, "resource").map(r => ({
      date: toIso, path: r.key, pageviews: r.value, synced_at: new Date().toISOString(),
    }));
    if (pageRows.length) {
      const { error } = await supabase.from("netlify_analytics_pages").upsert(pageRows, { onConflict: "date,path" });
      if (error) throw error;
      result.upserted.pages = pageRows.length;
    }

    // 4. TOP SOURCES
    const srcJson = await netlifyGet(
      `/sites/${SITE}/analytics/ranking/sources?from=${fromIso}&to=${toIso}&limit=50&timezone=America%2FNew_York`
    );
    const srcRows = rankingToRows(srcJson, "resource").map(r => ({
      date: toIso, source: r.key, referrals: r.value, synced_at: new Date().toISOString(),
    }));
    if (srcRows.length) {
      const { error } = await supabase.from("netlify_analytics_sources").upsert(srcRows, { onConflict: "date,source" });
      if (error) throw error;
      result.upserted.sources = srcRows.length;
    }

    // 5. TOP COUNTRIES
    const ctyJson = await netlifyGet(
      `/sites/${SITE}/analytics/ranking/countries?from=${fromIso}&to=${toIso}&limit=25&timezone=America%2FNew_York`
    );
    const ctyRows = rankingToRows(ctyJson, "resource").map(r => ({
      date: toIso, country: r.key, pageviews: r.value, synced_at: new Date().toISOString(),
    }));
    if (ctyRows.length) {
      const { error } = await supabase.from("netlify_analytics_countries").upsert(ctyRows, { onConflict: "date,country" });
      if (error) throw error;
      result.upserted.countries = ctyRows.length;
    }

    result.elapsed_ms = Date.now() - t0;
    return new Response(JSON.stringify(result, null, 2), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: (e as Error).message,
      partial: result,
    }, null, 2), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
