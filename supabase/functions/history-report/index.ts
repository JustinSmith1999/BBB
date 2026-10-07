/**
 * history-report — pre-cutover (MindBody era) numbers, by month, by studio.
 * ═══════════════════════════════════════════════════════════════════════════
 * Justin, 2026-10-05: "How can we get the October to March numbers for Astoria
 * and Williamsburg." That window (Oct 2025 – Mar 2026) sits entirely BEFORE the
 * June 2026 MindBody → Mariana Tek cutover, so none of it is in
 * mariana_tek_sales and almost none of it is in trial_signups (14 rows in the
 * whole six months — the website funnel barely existed yet). It lives, if it
 * lives anywhere, in the legacy mindbody_* tables.
 *
 * ── WHY THIS PROBES BEFORE IT REPORTS ──────────────────────────────────────
 * Anon RLS returns [] for mindbody_sales and mindbody_clients, which is
 * indistinguishable from "the table is empty" when you are reading with the
 * anon key. It could be a full book or it could be nothing. A monthly revenue
 * report built on an unverified table would look authoritative and be wrong,
 * which is worse than no report. So:
 *
 *   {"probe": true}   -> row counts per table per month per studio, nothing else
 *   {}                -> the actual report, but ONLY for sources the probe
 *                        proves are populated; anything thin is returned as
 *                        `insufficient_data` rather than a confident zero.
 *
 * A zero in this output means "we counted zero rows", never "the number is
 * zero". Those are different claims and the caller cannot tell them apart
 * unless we say so, hence `coverage` on every section.
 *
 * ── KNOWN LANDMINE: mindbody_visits looks under-populated ──────────────────
 * Spot-checked 2026-10-05 via the anon key: Oct 2025–Mar 2026 holds 66 visit
 * rows for Astoria and 63 for Williamsburg. Across six months that is ~11 a
 * month, which cannot be real attendance for a bootcamp studio running
 * multiple classes a day. Treat attendance as UNVERIFIED until reconciled
 * against MindBody directly. The probe reports the raw counts so the
 * thinness is visible rather than averaged into something plausible-looking.
 *
 * ── COUNTING ───────────────────────────────────────────────────────────────
 * Every count uses { count: "exact", head: true }. PostgREST silently caps
 * returned ROWS at 1000 (max-rows); a .select() + .length would have quietly
 * reported 1000 for any busy month. That exact bug produced a false "tracking
 * is off" conclusion earlier in this project — do not reintroduce it.
 *
 * Auth: header `x-bbb-secret`. Read-only; this function never writes.
 * Deploy: bbb deploy-fn history-report
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const DEFAULT_SINCE = "2025-10-01";
const DEFAULT_UNTIL = "2026-04-01";   // exclusive
const DEFAULT_STUDIOS = ["astoria", "williamsburg"];

// The cutover. Anything at or after this is Mariana Tek's book; anything
// before is MindBody's. Stated once so the report can label which side of the
// line each month falls on instead of silently blending two systems.
const MT_CUTOVER = "2026-06-01";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sb = () => createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

/** Inclusive-start, exclusive-end month buckets covering [since, until). */
function months(since: string, until: string): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = [];
  const d = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  while (d < end) {
    const from = d.toISOString().slice(0, 10);
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    out.push({ key: from.slice(0, 7), from, to: next.toISOString().slice(0, 10) });
    d.setTime(next.getTime());
  }
  return out;
}

type Db = ReturnType<typeof sb>;

/** Exact count, never a row fetch. Returns -1 if the table/column rejects us. */
async function countRows(
  db: Db, table: string, dateCol: string, from: string, to: string,
  extra?: (q: any) => any,
): Promise<number> {
  let q = db.from(table).select("*", { count: "exact", head: true })
    .gte(dateCol, from).lt(dateCol, to);
  if (extra) q = extra(q);
  const { count, error } = await q;
  if (error) return -1;
  return count ?? 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const since = String(body?.since ?? DEFAULT_SINCE);
  const until = String(body?.until ?? DEFAULT_UNTIL);
  const studios: string[] = Array.isArray(body?.studios) && body.studios.length
    ? body.studios.map((s: unknown) => String(s).toLowerCase())
    : DEFAULT_STUDIOS;
  const probeOnly = body?.probe === true;

  const db = sb();
  const buckets = months(since, until);

  // locations: trial_signups keys on location_id, the mindbody_* tables key on
  // studio_slug. Build the bridge once.
  const { data: locs } = await db.from("locations").select("id, name");
  const slugToLocId = new Map<string, string>();
  for (const l of (locs ?? []) as any[]) {
    slugToLocId.set(String(l.name || "").toLowerCase().replace(/\s+/g, "-"), l.id);
  }

  // ── COVERAGE PROBE ────────────────────────────────────────────────────────
  // Four sources, per studio, per month. -1 means the query itself failed
  // (missing table or column), which is a different problem from zero rows.
  const coverage: Record<string, any> = {};
  for (const studio of studios) {
    const locId = slugToLocId.get(studio) ?? null;
    const perMonth: Record<string, any> = {};
    let tSales = 0, tVisits = 0, tTrials = 0, tMt = 0;

    for (const m of buckets) {
      const [sales, visits, trials, mt] = await Promise.all([
        countRows(db, "mindbody_sales", "sale_date_time", m.from, m.to, (q) => q.eq("studio_slug", studio)),
        countRows(db, "mindbody_visits", "starts_at", m.from, m.to, (q) => q.eq("studio_slug", studio)),
        locId
          ? countRows(db, "trial_signups", "created_at", m.from, m.to, (q) => q.eq("location_id", locId).is("deleted_at", null))
          : Promise.resolve(0),
        countRows(db, "mariana_tek_sales", "sale_date_time", m.from, m.to),
      ]);
      perMonth[m.key] = { mindbody_sales: sales, mindbody_visits: visits, trial_signups: trials, mariana_tek_sales: mt };
      if (sales > 0) tSales += sales;
      if (visits > 0) tVisits += visits;
      if (trials > 0) tTrials += trials;
      if (mt > 0) tMt += mt;
    }

    // clients has no reliable per-studio date column for "joined in month", so
    // report it as a single total rather than inventing a monthly shape.
    const { count: clientTotal } = await db.from("mindbody_clients")
      .select("*", { count: "exact", head: true }).eq("studio_slug", studio);

    coverage[studio] = {
      by_month: perMonth,
      totals: {
        mindbody_sales: tSales,
        mindbody_visits: tVisits,
        trial_signups: tTrials,
        mariana_tek_sales_in_window: tMt,
        mindbody_clients_all_time: clientTotal ?? 0,
      },
      verdict: {
        revenue: tSales > 0 ? `${tSales} sale rows — usable` : "NO ROWS — revenue cannot be reported from this database",
        attendance: tVisits > 0
          ? `${tVisits} visit rows over ${buckets.length} months (~${Math.round(tVisits / buckets.length)}/mo) — sanity-check against MindBody before trusting`
          : "NO ROWS — attendance cannot be reported from this database",
        trials: tTrials > 0 ? `${tTrials} rows` : "NO ROWS (expected — the web funnel post-dates this window)",
      },
    };
  }

  if (probeOnly) {
    return json({
      ok: true, mode: "probe", window: { since, until }, studios,
      note: "A 0 here means we counted zero ROWS, not that the business did zero. -1 means the query failed (missing table or column).",
      cutover: `Mariana Tek took over ${MT_CUTOVER}; this entire window predates it, so mariana_tek_sales is expected to be 0.`,
      coverage,
    });
  }

  // ── REPORT ────────────────────────────────────────────────────────────────
  // Only aggregate what the probe just proved exists. A section with no rows
  // comes back as insufficient_data, never as a confident $0.
  const report: Record<string, any> = {};
  for (const studio of studios) {
    const cov = coverage[studio];
    const locId = slugToLocId.get(studio) ?? null;
    const rows: any[] = [];

    for (const m of buckets) {
      const c = cov.by_month[m.key];
      const month: any = { month: m.key };

      // revenue — paginate past the 1000-row cap rather than trusting one page
      if (c.mindbody_sales > 0) {
        let gross = 0, n = 0, page = 0;
        for (;;) {
          const { data, error } = await db.from("mindbody_sales")
            .select("total_cents")
            .eq("studio_slug", studio)
            .gte("sale_date_time", m.from).lt("sale_date_time", m.to)
            .range(page * 1000, page * 1000 + 999);
          if (error || !data?.length) break;
          for (const r of data as any[]) { gross += Number(r.total_cents || 0); n++; }
          if (data.length < 1000) break;
          page++;
        }
        month.revenue_usd = +(gross / 100).toFixed(2);
        month.sales_count = n;
      } else {
        month.revenue_usd = "insufficient_data";
      }

      // attendance — signed_in is the honest "showed up" signal
      if (c.mindbody_visits > 0) {
        const booked = c.mindbody_visits;
        const attended = await countRows(db, "mindbody_visits", "starts_at", m.from, m.to,
          (q) => q.eq("studio_slug", studio).eq("signed_in", true));
        const noShow = await countRows(db, "mindbody_visits", "starts_at", m.from, m.to,
          (q) => q.eq("studio_slug", studio).eq("signed_in", false).eq("cancelled", false));
        month.booked = booked;
        month.attended = attended < 0 ? "insufficient_data" : attended;
        month.no_show = noShow < 0 ? "insufficient_data" : noShow;
        month.attendance_caveat = "visit table is sparse — verify against MindBody";
      } else {
        month.booked = "insufficient_data";
      }

      // trials from the website (expected to be ~nil this far back)
      month.web_trials = locId ? c.trial_signups : "no_location_row";

      rows.push(month);
    }
    report[studio] = rows;
  }

  return json({
    ok: true, mode: "report", window: { since, until }, studios,
    caveats: [
      "This window predates the Mariana Tek cutover — every figure comes from the legacy MindBody sync, not from MT.",
      "Ad numbers are NOT in here. meta-ad-snapshot caps its window at 90 days; raise that cap to reach Oct 2025.",
      "'insufficient_data' means no rows were found. It is not a zero.",
    ],
    coverage_summary: Object.fromEntries(studios.map((s) => [s, coverage[s].verdict])),
    report,
  });
});
