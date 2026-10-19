/**
 * weekly-trends — trials, spend and ad-driven share, by week, per studio.
 * ═══════════════════════════════════════════════════════════════════════════
 * READ ONLY. Writes nothing, sends nothing.
 *
 * Built 2026-10-16 (Justin: "trial numbers and ad numbers all gyms including
 * how many came from ads for the last 10 weeks").
 *
 * WHY NOT lead-source-report: that one lists rows and caps them at 60 per
 * studio, which is fine for a few days and silently undercounts over ten
 * weeks. This aggregates with full pagination, so the counts are complete.
 *
 * WEEKS are Monday–Sunday in America/New_York, matching the owner weekly
 * report. The current week is partial and labelled as such; comparing a
 * part-week to full weeks is the easiest way to draw a wrong conclusion.
 *
 * "HOW MANY CAME FROM ADS" — read this carefully, the honest answer has two
 * halves and they disagree for good reasons:
 *
 *   ads_meta_credited   Meta's own attributed purchases for that week, from
 *                       the Graph API. Includes view-through conversions we
 *                       never see. Available for the full ten weeks, but it
 *                       UNDERCOUNTS badly before 2026-10-14, because our CAPI
 *                       was sending most purchases as action_source
 *                       "physical_store" and Meta credits none of those to a
 *                       website ad set.
 *
 *   ads_tagged_on_row   trials whose own row carries utm_content or an fbc
 *                       click id. This is the only per-person truth, and it
 *                       is near-zero before 2026-10-15 because of the
 *                       camelCase/snake_case bug (see lib/utm.ts) — absence
 *                       there is a measurement failure, NOT evidence the
 *                       trial was organic.
 *
 * So: for recent weeks the two converge; for older weeks both are floors, not
 * counts. The report says so per row rather than letting a zero read as fact.
 *
 * Body: { "weeks": 10 }
 * Auth: x-bbb-secret.  Deploy: bbb deploy-fn weekly-trends
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const FB_VERSION = "v19.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const STUDIOS = [
  { slug: "astoria",       name: "Astoria",       adAccount: "act_1367835402069398",  tokenEnv: "META_TOKEN_ASTORIA",       uuid: "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45" },
  { slug: "bayside",       name: "Bayside",       adAccount: "act_4298533693762953",  tokenEnv: "META_TOKEN_BAYSIDE",       uuid: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7" },
  { slug: "fresh-meadows", name: "Fresh Meadows", adAccount: "act_1301162772160251",  tokenEnv: "META_TOKEN_FRESH_MEADOWS", uuid: "6bbbe077-bcc6-4d9d-a10b-7605c1484752" },
  { slug: "williamsburg",  name: "Williamsburg",  adAccount: "act_26739874695621849", tokenEnv: "META_TOKEN_WILLIAMSBURG",  uuid: "80536b45-df0e-42d1-880c-e9301372e1cf" },
];

// Straight memberships and desk/legacy rows are not trials. Counted separately
// so "trials" means trials.
const NON_TRIAL = new Set([
  "direct_membership", "mb_direct", "walk_in", "in_person", "walk-in",
  "mt_direct_member", "legacy_archived",
]);

// The two dates that bound what the history can possibly show.
const CAPI_FIX = "2026-10-14";   // action_source now driven by sales_channel
const TAG_FIX  = "2026-10-15";   // snake_case UTMs + durable fbc went live

/** Monday 00:00 America/New_York for a timestamp, as YYYY-MM-DD. */
function weekStartET(iso: string): string {
  const t = new Date(new Date(iso).getTime() - 4 * 3600 * 1000); // ET ≈ UTC-4
  const dow = (t.getUTCDay() + 6) % 7;                            // Mon = 0
  const mon = new Date(t.getTime() - dow * 86400000);
  return mon.toISOString().slice(0, 10);
}

async function fbGet(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`https://graph.facebook.com/${FB_VERSION}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
const sumActions = (actions: any[] | undefined, types: string[]) =>
  (actions ?? []).reduce((n, a) => (types.includes(a.action_type) ? n + (Number(a.value) || 0) : n), 0);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const weeks = Math.min(Math.max(Number(body.weeks ?? 10), 1), 52);

  const thisMonday = weekStartET(new Date().toISOString());
  const since = new Date(new Date(thisMonday + "T00:00:00Z").getTime() - (weeks - 1) * 7 * 86400000);
  const sinceIso = since.toISOString();
  const sinceDay = sinceIso.slice(0, 10);
  const untilDay = new Date().toISOString().slice(0, 10);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── trials, fully paginated (no silent cap) ───────────────────────────────
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("trial_signups")
      .select("location_id,payment_date,created_at,source_category,utm_content,fbc")
      .gte("payment_date", sinceIso)
      .order("payment_date", { ascending: true })
      .range(from, from + 999);
    if (error) return json({ ok: false, error: `trial_signups: ${error.message}` }, 502);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  type Cell = { trials: number; tagged: number; not_trials: number };
  const grid: Record<string, Record<string, Cell>> = {};   // week -> slug -> cell
  const cell = (w: string, s: string) => {
    grid[w] ||= {};
    grid[w][s] ||= { trials: 0, tagged: 0, not_trials: 0 };
    return grid[w][s];
  };
  const uuidToSlug: Record<string, string> = {};
  for (const s of STUDIOS) uuidToSlug[s.uuid] = s.slug;

  for (const r of rows) {
    const slug = uuidToSlug[r.location_id];
    if (!slug || !r.payment_date) continue;
    const w = weekStartET(r.payment_date);
    const c = cell(w, slug);
    if (NON_TRIAL.has(String(r.source_category || ""))) { c.not_trials++; continue; }
    c.trials++;
    if (r.utm_content || r.fbc) c.tagged++;
  }

  // ── Meta: spend + attributed purchases, weekly, per studio ───────────────
  const metaByWeek: Record<string, Record<string, { spend: number; purchases: number }>> = {};
  const metaErrors: Record<string, string> = {};
  for (const s of STUDIOS) {
    const token = Deno.env.get(s.tokenEnv);
    if (!token) { metaErrors[s.slug] = `missing ${s.tokenEnv}`; continue; }
    try {
      const res = await fbGet(`${s.adAccount}/insights`, token, {
        fields: "spend,actions",
        time_range: JSON.stringify({ since: sinceDay, until: untilDay }),
        time_increment: "7",
        limit: "60",
      });
      for (const row of (res.data || []) as any[]) {
        const w = weekStartET(`${row.date_start}T12:00:00Z`);
        metaByWeek[w] ||= {};
        metaByWeek[w][s.slug] = {
          spend: +(Number(row.spend) || 0).toFixed(2),
          purchases: sumActions(row.actions, ["purchase", "offsite_conversion.fb_pixel_purchase"]),
        };
      }
    } catch (e) {
      metaErrors[s.slug] = String((e as Error).message || e).slice(0, 200);
    }
  }

  // ── assemble, newest week first ──────────────────────────────────────────
  const allWeeks = new Set<string>([...Object.keys(grid), ...Object.keys(metaByWeek)]);
  const ordered = [...allWeeks].sort().reverse().slice(0, weeks);

  const out = ordered.map((w) => {
    const per: Record<string, any> = {};
    let trials = 0, tagged = 0, spend = 0, credited = 0, notTrials = 0;
    for (const s of STUDIOS) {
      const c = grid[w]?.[s.slug] ?? { trials: 0, tagged: 0, not_trials: 0 };
      const m = metaByWeek[w]?.[s.slug] ?? { spend: 0, purchases: 0 };
      per[s.name] = {
        trials: c.trials,
        ads_meta_credited: m.purchases,
        ads_tagged_on_row: c.tagged,
        spend: m.spend,
        cost_per_trial: c.trials > 0 ? +(m.spend / c.trials).toFixed(2) : null,
        memberships_not_trials: c.not_trials,
      };
      trials += c.trials; tagged += c.tagged; spend += m.spend;
      credited += m.purchases; notTrials += c.not_trials;
    }
    const partial = w === thisMonday;
    return {
      week_of: w,
      partial_week: partial || undefined,
      totals: {
        trials,
        spend: +spend.toFixed(2),
        cost_per_trial: trials > 0 ? +(spend / trials).toFixed(2) : null,
        ads_meta_credited: credited,
        ads_tagged_on_row: tagged,
        memberships_not_trials: notTrials,
      },
      attribution_trustworthy: w >= TAG_FIX
        ? "yes — both the CAPI and the row-tagging fixes were live"
        : w >= CAPI_FIX
        ? "partly — CAPI fixed mid-week, row tagging not yet"
        : "NO — both ad columns are floors. CAPI was mislabelling purchases as " +
          "in-store and UTMs never reached the row, so a low number here means " +
          "we could not see the ads working, not that they were not working.",
      studios: per,
    };
  });

  return json({
    ok: true,
    read_only: true,
    weeks,
    since: sinceDay,
    week_definition: "Monday–Sunday, America/New_York",
    meta_errors: Object.keys(metaErrors).length ? metaErrors : undefined,
    how_to_read:
      "trials = paid trials, memberships excluded. ads_meta_credited = Meta's own " +
      "attribution (includes view-through). ads_tagged_on_row = the ad stamped on " +
      "the customer's own row. Before 2026-10-14 both ad columns undercount badly " +
      "for known, fixed bugs — see attribution_trustworthy on each week.",
    weeks_data: out,
  });
});
