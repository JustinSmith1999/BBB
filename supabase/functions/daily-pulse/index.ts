/**
 * daily-pulse — READ ONLY. 2026-10-02.
 *
 * The Today / This week / All time tiles on the owner dashboard, for all four
 * studios in one call.
 *
 * WHY THIS REPLACES get_daily_pulse
 * The RPC counted a "paid trial" as any trial_signups row with
 * payment_status='completed' in the window. But mt-orders-sync writes a
 * trial_signups row for every MEMBERSHIP sale too, tagged
 * source_category='direct_membership', with payment_date set to the charge
 * time. Mariana Tek bills the standing member base in a nightly batch at
 * 12:00–12:15 AM ET, so every morning 10–23 existing members' recurring
 * payments landed in the tiles as brand-new $49 trials.
 *
 * Observed 2026-10-02: Fresh Meadows read "6 leads · 6 paid · $294 in ·
 * 11.79x ROAS". Mariana Tek had exactly ONE trial purchase at Fresh Meadows
 * that day (a $49 Two Weeks Trial at 14:15). The other five were members
 * billed at 12:15 AM. Week-to-date was worse: the tile said 19 paid, MT had 3.
 *
 * GROUND TRUTH HERE
 *   paid / revenue — Mariana Tek membership_instances whose membership_name
 *     contains "trial", bucketed by purchase_date in ET. Same definition the
 *     conversion report uses, so the tiles and the report cannot drift.
 *   leads          — trial_signups created in the window, EXCLUDING the
 *     direct_membership rows the sync seeds for members.
 *   spend          — meta_insights_daily, unchanged.
 *
 * The all-time window spans the migration, so it is summed from the system of
 * record on each side: trial_signups for launch (2026-05-15) → cutover, and
 * Mariana Tek from the cutover (2026-06-26) on. Each window says which source
 * produced it in `basis`, so a number on screen can always be traced.
 *
 * Cached in ops_cache for 10 minutes (walking 12 pages of MT takes ~20s).
 * ?fresh=1 forces a recompute.
 *
 * GET/POST → { ok, as_of, cached, studios: { <slug>: {today,thisWeek,allTime} }, network: {...} }
 * Public read (the dashboard calls it with the anon key).
 *
 * Deploy: bbb deploy-fn daily-pulse
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-bbb-secret",
};
const MT_BASE = "https://betterbodybootcamp.marianatek.com";
const MT_ACCEPT = "application/vnd.api+json";
const SLUG: Record<string, string> = {
  "48717": "astoria", "48718": "bayside", "48719": "fresh-meadows", "48720": "williamsburg",
};
const SLUGS = ["astoria", "bayside", "fresh-meadows", "williamsburg"];
const LAUNCH = "2026-05-15";
const CUTOVER = "2026-06-26";
const CACHE_KEY = "daily_pulse_mt";
/** Pre-cutover source_category values that mean "sold in person". */
const PRE_POS = new Set(["in_person", "mb_pos", "walk_in", "walk-in", "mb_direct"]);
const CACHE_MIN = 10;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/** ET calendar date (YYYY-MM-DD) for an instant. en-CA formats as ISO. */
const etDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function mtToken(sb: ReturnType<typeof createClient>): Promise<string | null> {
  const k = Deno.env.get("MT_ADMIN_API_KEY");
  if (k && k.trim()) return k.trim();
  const { data } = await sb.from("mt_oauth").select("access_token").eq("id", "default").maybeSingle();
  return (data as { access_token?: string } | null)?.access_token || null;
}

type Win = { spend_cents: number; signups: number; paid: number; revenue_cents: number };
const zero = (): Win => ({ spend_cents: 0, signups: 0, paid: 0, revenue_cents: 0 });

/**
 * PostgREST caps a response at 1000 rows whether or not you ask it to, and the
 * client returns that truncated page without complaint. A first cut of this
 * function read trial_signups in one shot, silently lost everything past row
 * 1000, and reported 0 leads today — pulling pages is not optional.
 */
async function allRows<T>(
  // deno-lint-ignore no-explicit-any
  build: () => any,
  page = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < 100_000; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";

  if (!fresh) {
    try {
      const { data } = await sb.from("ops_cache").select("payload, updated_at").eq("key", CACHE_KEY).maybeSingle();
      const row = data as { payload: unknown; updated_at: string } | null;
      if (row && Date.now() - Date.parse(row.updated_at) < CACHE_MIN * 60_000) {
        return json({ ...(row.payload as Record<string, unknown>), cached: true, cached_at: row.updated_at });
      }
    } catch { /* no cache table — compute */ }
  }

  const now = new Date();
  const today = etDate(now);
  // Week starts Sunday, matching the RPC the tiles used before. Anchored at
  // noon UTC on the ET date so no DST shift can push it a day either way.
  const anchor = new Date(`${today}T12:00:00Z`);
  const sunday = new Date(anchor);
  sunday.setUTCDate(sunday.getUTCDate() - anchor.getUTCDay());
  const weekStart = sunday.toISOString().slice(0, 10);

  const out: Record<string, {
    today: Win; thisWeek: Win; allTime: Win;
    days: Record<string, { paid: number; leads: number }>;
    paths: Record<string, number>;
  }> = {};
  for (const s of SLUGS) out[s] = { today: zero(), thisWeek: zero(), allTime: zero(), days: {}, paths: {} };
  // How each trial was bought. get_purchase_paths answered this with 208 of
  // 360 in an "Unknown" bucket and labels still naming MindBody four months
  // after the cutover. Mariana Tek names the contract itself: a trial sold
  // through the website is "$49 Two Weeks Trial (Web)", one rung up at the
  // desk or in the app is "$49 Two Weeks Trial" — no guessing needed.
  const addPath = (slug: string, label: string) => {
    out[slug].paths[label] = (out[slug].paths[label] || 0) + 1;
  };
  // Per-ET-day series, so the lead/paid heatmap can be drawn from the same
  // numbers as the tiles. It used get_lead_conversion_heatmap, which counted
  // the member seeds: Astoria read 200 paid trials in 60 days against 106 in
  // the whole run since launch.
  const bump = (slug: string, day: string, field: "paid" | "leads") => {
    const d = (out[slug].days[day] = out[slug].days[day] || { paid: 0, leads: 0 });
    d[field]++;
  };

  // ── PAID + REVENUE · Mariana Tek trial purchases ──────────────────────────
  const token = await mtToken(sb);
  if (!token) return json({ ok: false, error: "no Mariana Tek token" }, 500);

  let page = 1, pages = 1, scanned = 0;
  while (page <= pages && page <= 20) {
    const r = await fetch(`${MT_BASE}/api/membership_instances?ordering=-purchase_date&page_size=200&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: MT_ACCEPT } });
    if (!r.ok) return json({ ok: false, error: `Mariana Tek ${r.status}` }, 502);
    // deno-lint-ignore no-explicit-any
    const j: any = await r.json();
    pages = Number(j?.meta?.pagination?.pages ?? 1);
    page++;
    let oldestOnPage = "9999-12-31";
    for (const m of j?.data ?? []) {
      const a = m.attributes ?? {}, rel = m.relationships ?? {};
      const slug = SLUG[(rel.purchase_location?.data ?? {}).id];
      const pd = a.purchase_date as string | null;
      if (!pd) continue;
      const day = etDate(new Date(pd));
      if (day < oldestOnPage) oldestOnPage = day;
      scanned++;
      if (!slug) continue;
      if (!String(a.membership_name ?? "").toLowerCase().includes("trial")) continue;
      const cents = Math.round(Number(a.renewal_rate ?? 0) * 100) || 4900;
      const b = out[slug];
      if (day >= CUTOVER) {
        bump(slug, day, "paid");
        addPath(slug, /\(web\)/i.test(String(a.membership_name ?? ""))
          ? "Online (website checkout)"
          : "In studio or Mariana Tek app");
      }
      if (day === today)      { b.today.paid++;    b.today.revenue_cents    += cents; }
      if (day >= weekStart)   { b.thisWeek.paid++; b.thisWeek.revenue_cents += cents; }
      if (day >= CUTOVER)     { b.allTime.paid++;  b.allTime.revenue_cents  += cents; }
    }
    // Ordered newest-first: once a whole page predates the cutover we are done.
    if (oldestOnPage < CUTOVER) break;
  }

  // ── PRE-CUTOVER all-time · trial_signups was the system of record then ────
  // Stripe web checkouts + MindBody POS. direct_membership rows are the MT
  // sync's member seeds and never existed before the cutover, but the filter
  // is applied anyway so the predicate reads the same in both branches.
  const { data: locs } = await sb.from("locations").select("id, name");
  const slugOf = new Map<string, string>();
  for (const l of (locs ?? []) as Array<{ id: string; name: string }>) {
    slugOf.set(l.id, l.name.toLowerCase().replace(/\s+/g, "-"));
  }

  const preRows = await allRows<{ location_id: string; payment_date: string; source_category: string | null }>(
    () => sb.from("trial_signups")
      .select("location_id, payment_date, source_category")
      .eq("payment_status", "completed")
      .is("deleted_at", null)
      .gte("payment_date", `${LAUNCH}T00:00:00Z`)
      .lt("payment_date", `${CUTOVER}T04:00:00Z`)
      .order("payment_date", { ascending: true }),
  );
  for (const t of preRows) {
    if (t.source_category === "direct_membership") continue;
    const slug = slugOf.get(t.location_id);
    if (!slug || !out[slug]) continue;
    out[slug].allTime.paid++;
    out[slug].allTime.revenue_cents += 4900;
    bump(slug, etDate(new Date(t.payment_date)), "paid");
    addPath(slug, PRE_POS.has(String(t.source_category ?? ""))
      ? "In studio (pre-cutover, MindBody)"
      : "Online (pre-cutover, Stripe)");
  }

  // ── LEADS · form fills, minus the member seeds ────────────────────────────
  const leadRows = await allRows<{ location_id: string; created_at: string; source_category: string | null }>(
    () => sb.from("trial_signups")
      .select("location_id, created_at, source_category")
      .is("deleted_at", null)
      .gte("created_at", `${LAUNCH}T00:00:00Z`)
      .order("created_at", { ascending: true }),
  );
  for (const t of leadRows) {
    if (t.source_category === "direct_membership") continue;
    const slug = slugOf.get(t.location_id);
    if (!slug || !out[slug]) continue;
    const day = etDate(new Date(t.created_at));
    const b = out[slug];
    if (day === today)    b.today.signups++;
    if (day >= weekStart) b.thisWeek.signups++;
    b.allTime.signups++;
    bump(slug, day, "leads");
  }

  // ── SPEND · unchanged source ──────────────────────────────────────────────
  const spendRows = await allRows<{ studio_slug: string; date_start: string; spend_cents: number }>(
    () => sb.from("meta_insights_daily")
      .select("studio_slug, date_start, spend_cents")
      .gte("date_start", LAUNCH)
      .order("date_start", { ascending: true }),
  );
  for (const s of spendRows) {
    const b = out[s.studio_slug];
    if (!b) continue;
    const c = Number(s.spend_cents || 0);
    if (s.date_start === today)    b.today.spend_cents += c;
    if (s.date_start >= weekStart) b.thisWeek.spend_cents += c;
    b.allTime.spend_cents += c;
  }

  const network = { today: zero(), thisWeek: zero(), allTime: zero() };
  for (const s of SLUGS) {
    for (const w of ["today", "thisWeek", "allTime"] as const) {
      network[w].spend_cents   += out[s][w].spend_cents;
      network[w].signups       += out[s][w].signups;
      network[w].paid          += out[s][w].paid;
      network[w].revenue_cents += out[s][w].revenue_cents;
    }
  }

  const payload = {
    ok: true, read_only: true, as_of: now.toISOString(),
    et_today: today, week_start: weekStart, cutover: CUTOVER, launch: LAUNCH,
    basis: {
      paid: "Mariana Tek membership_instances, membership_name contains 'trial', bucketed by purchase_date in ET; all-time adds pre-cutover trial_signups (Stripe + MindBody POS)",
      paths: "Mariana Tek contract name — '(Web)' = bought on the website, otherwise sold at the desk or in the app; pre-cutover rows split by trial_signups.source_category",
      days: "same trial records as `paid`, bucketed per ET day — drives the heatmap",
      leads: "trial_signups created in window, excluding the direct_membership rows mt-orders-sync seeds for members",
      spend: "meta_insights_daily",
    },
    mt_rows_scanned: scanned,
    studios: out, network,
  };
  try {
    await sb.from("ops_cache").upsert({ key: CACHE_KEY, payload, updated_at: now.toISOString() }, { onConflict: "key" });
  } catch { /* cache optional */ }
  return json({ ...payload, cached: false });
});
