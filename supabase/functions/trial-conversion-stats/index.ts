/**
 * trial-conversion-stats — READ ONLY. 2026-10-02.
 *
 * One definition of trial → member, for the owner dashboard.
 *
 * WHY THIS EXISTS
 * The dashboard used to count trials from trial_signups rows and treat someone
 * as converted only when a staff member had dragged their Homebase card to
 * "member". Both halves were wrong:
 *   • trial_signups misses website trials that never got a row (Stripe took the
 *     money, nothing landed in the table), so September showed 11 paid trials
 *     across four studios when Bayside + Fresh Meadows alone did about 30.
 *   • front_desk_stage is a manual flag. A member nobody dragged looked like a
 *     non-conversion, so the rate swung 6% → 63% → 27% month to month.
 *
 * Ground truth instead: Mariana Tek membership records. A trial is a purchase
 * of a membership whose name contains "trial". It converted if that person
 * later bought ANY non-trial membership at ANY studio. Anyone still inside
 * their two weeks is reported separately and excluded from the rate — they
 * haven't had the chance to convert yet.
 *
 * Also returns the two numbers the owners actually ask for first:
 *   members_now  — people holding a paid membership today (trials excluded)
 *   trials_total — every trial Mariana Tek has a record of
 * and the same pair measured SINCE THE CUTOVER, which is the period that
 * matters to them and the only one where trial and membership live on the
 * same record in one system.
 *
 * Result is cached in ops_cache for 30 minutes — walking 12 pages of the
 * Mariana Tek API takes ~24s, far too slow for a card at the top of the page.
 * ?fresh=1 forces a recompute.
 *
 * GET/POST → { ok, as_of, cached, studios: {...}, overall: {...} }
 * Public read (the dashboard calls it with the anon key).
 *
 * Deploy: bbb deploy-fn trial-conversion-stats
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
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function mtToken(sb: ReturnType<typeof createClient>): Promise<string | null> {
  const k = Deno.env.get("MT_ADMIN_API_KEY");
  if (k && k.trim()) return k.trim();
  const { data } = await sb.from("mt_oauth").select("access_token").eq("id", "default").maybeSingle();
  return (data as { access_token?: string } | null)?.access_token || null;
}

type Inst = { slug: string; uid: string; name: string; pd: string; end: string | null; cancel: string | null };

const CUTOVER = "2026-06-26";
const CACHE_KEY = "trial_conversion_stats";
const CACHE_MIN = 30;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";

  if (!fresh) {
    try {
      const { data } = await sb.from("ops_cache").select("payload, updated_at").eq("key", CACHE_KEY).maybeSingle();
      const row = data as { payload: any; updated_at: string } | null;
      if (row && Date.now() - Date.parse(row.updated_at) < CACHE_MIN * 60_000) {
        return json({ ...row.payload, cached: true, cached_at: row.updated_at });
      }
    } catch { /* no cache table yet — just compute */ }
  }

  const token = await mtToken(sb);
  if (!token) return json({ ok: false, error: "no Mariana Tek token" }, 500);

  // ── pull every membership instance ────────────────────────────────────────
  // Mariana Tek returns links: null — pagination lives in meta.pagination with a
  // ?page= parameter. Following links.next silently read page 1 only, which made
  // Bayside look like 10 trials instead of 35. Walk the page count instead.
  const inst: Inst[] = [];
  let page = 1, pages = 1;
  while (page <= pages && page <= 60) {
    const r: Response = await fetch(`${MT_BASE}/api/membership_instances?page_size=200&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: MT_ACCEPT } });
    if (!r.ok) return json({ ok: false, error: `Mariana Tek ${r.status}` }, 502);
    const j: any = await r.json();
    pages = Number(j?.meta?.pagination?.pages ?? 1);
    page++;
    for (const m of j?.data ?? []) {
      const a = m.attributes ?? {}, rel = m.relationships ?? {};
      const slug = SLUG[(rel.purchase_location?.data ?? {}).id];
      const uid = (rel.user?.data ?? {}).id;
      if (!slug || !uid) continue;
      inst.push({
        slug, uid,
        name: a.membership_name ?? "",
        pd: (a.purchase_date ?? "").slice(0, 10),
        end: (a.calculated_end_datetime ?? a.end_date ?? null),
        cancel: a.cancellation_datetime ?? null,
      });
    }
  }

  const isTrial = (n: string) => n.toLowerCase().includes("trial");
  const now = new Date().toISOString();

  // every non-trial purchase per person, earliest first — conversion at ANY studio
  const paid: Record<string, string> = {};
  for (const i of inst) {
    if (isTrial(i.name) || !i.pd) continue;
    if (!paid[i.uid] || i.pd < paid[i.uid]) paid[i.uid] = i.pd;
  }
  // first trial per person per studio
  const firstTrial: Record<string, Inst> = {};
  for (const i of inst) {
    if (!isTrial(i.name) || !i.pd) continue;
    const k = `${i.uid}|${i.slug}`;
    if (!firstTrial[k] || i.pd < firstTrial[k].pd) firstTrial[k] = i;
  }

  // members today — a paid membership in force right now, trials excluded
  const liveMembers: Record<string, Set<string>> = {};
  for (const i of inst) {
    if (isTrial(i.name)) continue;
    if (i.cancel && i.cancel <= now) continue;
    if (i.end && i.end <= now) continue;
    if (!i.pd || i.pd > now.slice(0, 10)) continue;
    (liveMembers[i.slug] = liveMembers[i.slug] || new Set()).add(i.uid);
  }

  const out: Record<string, any> = {};
  for (const k of Object.keys(firstTrial)) {
    const t = firstTrial[k];
    const mo = t.pd.slice(0, 7);
    const s = (out[t.slug] = out[t.slug] || { months: {}, totals: { trials: 0, still: 0, ended: 0, converted: 0 } });
    const b = (s.months[mo] = s.months[mo] || { trials: 0, still: 0, ended: 0, converted: 0 });
    const endsAt = t.cancel || t.end;
    const stillIn = !!endsAt && !t.cancel && endsAt > now;
    const converted = !!paid[t.uid] && paid[t.uid] > t.pd;
    b.trials++; s.totals.trials++;
    if (stillIn) { b.still++; s.totals.still++; }
    else {
      b.ended++; s.totals.ended++;
      if (converted) { b.converted++; s.totals.converted++; }
    }
    if (t.pd >= CUTOVER) {
      const c = (s.since_cutover = s.since_cutover || { trials: 0, still: 0, ended: 0, converted: 0 });
      c.trials++;
      if (stillIn) c.still++;
      else { c.ended++; if (converted) c.converted++; }
    }
  }
  const overall = { members_now: 0, trials_total: 0, trials_since_cutover: 0, ended_since_cutover: 0, converted_since_cutover: 0 };
  for (const [slug, s] of Object.entries(out) as any[]) {
    for (const m of Object.values(s.months) as any[]) m.rate = m.ended ? Math.round((m.converted / m.ended) * 100) : null;
    s.totals.rate = s.totals.ended ? Math.round((s.totals.converted / s.totals.ended) * 100) : null;
    s.members_now = (liveMembers[slug] || new Set()).size;
    s.since_cutover = s.since_cutover || { trials: 0, still: 0, ended: 0, converted: 0 };
    s.since_cutover.rate = s.since_cutover.ended
      ? Math.round((s.since_cutover.converted / s.since_cutover.ended) * 100) : null;
    overall.members_now += s.members_now;
    overall.trials_total += s.totals.trials;
    overall.trials_since_cutover += s.since_cutover.trials;
    overall.ended_since_cutover += s.since_cutover.ended;
    overall.converted_since_cutover += s.since_cutover.converted;
  }
  for (const slug of Object.keys(liveMembers)) {
    if (!out[slug]) { out[slug] = { months: {}, totals: { trials: 0, still: 0, ended: 0, converted: 0, rate: null },
      since_cutover: { trials: 0, still: 0, ended: 0, converted: 0, rate: null }, members_now: liveMembers[slug].size };
      overall.members_now += liveMembers[slug].size; }
  }
  (overall as any).rate_since_cutover = overall.ended_since_cutover
    ? Math.round((overall.converted_since_cutover / overall.ended_since_cutover) * 100) : null;

  const payload = {
    ok: true, as_of: now, read_only: true, cutover: CUTOVER,
    definition: "trial = membership whose name contains 'trial'; converted = any later non-trial membership at any studio; people still inside their trial are excluded from the rate; members_now = a paid membership in force today, trials excluded",
    overall, studios: out,
  };
  try {
    await sb.from("ops_cache").upsert({ key: CACHE_KEY, payload, updated_at: now }, { onConflict: "key" });
  } catch { /* cache table optional */ }
  return json({ ...payload, cached: false });
});
