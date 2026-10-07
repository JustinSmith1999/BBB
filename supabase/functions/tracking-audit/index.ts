/**
 * tracking-audit · what are we actually tracking, and who can we actually reach
 * ═══════════════════════════════════════════════════════════════════════════
 * READ ONLY. Writes nothing, sends nothing. Built 2026-10-05 to answer two
 * questions that kept coming up as guesses:
 *
 *   1. "We should be looking at WAY more than 140 people."
 *      → section `universe`: every table that holds a human, counted, with the
 *        contactable subset separated from the anonymous one.
 *
 *   2. "We need to track EVERY open, every click, EVERYTHING."
 *      → section `email` / `sms`: every event type we have ever recorded,
 *        split by send_path, plus the orphan rate (rows we cannot attribute to
 *        a person) and whether open/click events appear at all.
 *
 * THE KEY DIAGNOSTIC is `email.tracking_enabled`. Resend only emits
 * email.opened / email.clicked if open+click tracking is switched on for the
 * domain. If those counts are zero while delivered is large, tracking is OFF
 * at Resend and no amount of code fixes it — it is a dashboard toggle. That
 * distinction is the difference between "unwired" and "impossible", and we
 * have been assuming the former.
 *
 * ORPHAN RATE matters because email_log.trial_signup_id is only populated when
 * the sender attaches Resend tags. winback-blast inserts into email_log
 * directly with no tags, so its sends can never be tied to a person. Any
 * send_path with a high orphan rate is a sender that needs fixing.
 *
 * Invoke (header: x-bbb-secret):
 *   {}                        -> everything
 *   { "section": "email" }    -> just the email breakdown
 *   { "days": 90 }            -> limit event scans to a window (default: all)
 *
 * Deploy: bbb deploy-fn tracking-audit
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Every table that holds a person, or an event about one.
const TABLES = [
  "trial_signups", "leads", "email_log", "sms_messages", "capi_events",
  "mariana_tek_sales", "mariana_tek_clients", "mindbody_clients", "mindbody_sales",
  "stripe_paid_mirror", "winback_sends", "lapsed_winback_sends", "run_club_signups",
  "quo_task_loaded", "quo_outreach_loaded", "booking_codes", "locations",
];

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);

/**
 * Page through a table to the end.
 *
 * PostgREST caps every response at the project's max-rows (1000 here) and
 * SILENTLY IGNORES a larger .limit(). The first version of this audit called
 * .limit(100000) on email_log, got exactly 1000 rows back, and reported "zero
 * opens, zero clicks" — which looked like Resend tracking being switched off
 * but was really just the oldest 1000 rows. Any count built on a single
 * un-paged select is wrong the moment a table passes 1000 rows, and every
 * table in this audit is past that.
 */
async function fetchAll(
  sb: any, table: string, columns: string, orderCol = "created_at",
  tweak?: (q: any) => any,
): Promise<{ rows: any[]; error: { message: string } | null }> {
  const rows: any[] = [];
  for (let from = 0; from < 500000; from += 1000) {
    let q = sb.from(table).select(columns).order(orderCol, { ascending: true }).range(from, from + 999);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) return { rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return { rows, error: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const only = body?.section ? String(body.section) : null;
  const days = Number(body?.days) || 0;
  const since = days ? new Date(Date.now() - days * 864e5).toISOString() : null;

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const out: Record<string, unknown> = { ok: true, generated_at: new Date().toISOString(), window_days: days || "all" };

  const want = (s: string) => !only || only === s;

  // ── table inventory ───────────────────────────────────────────────────────
  if (want("tables")) {
    const inv: Record<string, unknown> = {};
    for (const t of TABLES) {
      const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
      inv[t] = error ? { missing_or_denied: error.message } : { rows: count ?? 0 };
    }
    out.tables = inv;
  }

  // ── EMAIL: every event, every send_path, orphan rate ──────────────────────
  if (want("email")) {
    // 2026-10-05 — MUST paginate. PostgREST caps a response at max-rows (1000
    // on this project) and silently ignores a larger .limit(). The first run of
    // this audit reported "1000 rows, zero opens, zero clicks" and I nearly
    // concluded Resend tracking was off — it was just the first 1000 rows by
    // insertion order, covering Aug 19 to Sep 17 only. Always page to the end.
    const pageRows: any[] = [];
    let error: { message: string } | null = null;
    for (let from = 0; from < 200000; from += 1000) {
      let q = sb.from("email_log")
        .select("event_type, send_path, trial_signup_id, created_at")
        .order("created_at", { ascending: true })
        .range(from, from + 999);
      if (since) q = q.gte("created_at", since);
      const { data: page, error: pErr } = await q;
      if (pErr) { error = pErr; break; }
      pageRows.push(...(page ?? []));
      if (!page || page.length < 1000) break;   // last page
    }
    const rows = pageRows;
    if (error) {
      out.email = { error: error.message };
    } else {
      const byEvent: Record<string, number> = {};
      const byPath: Record<string, { total: number; orphan: number; events: Record<string, number> }> = {};
      let orphan = 0, oldest = "", newest = "";
      for (const r of (rows ?? []) as any[]) {
        const ev = String(r.event_type ?? "unknown");
        const sp = String(r.send_path ?? "(no send_path)");
        byEvent[ev] = (byEvent[ev] ?? 0) + 1;
        byPath[sp] ??= { total: 0, orphan: 0, events: {} };
        byPath[sp].total++;
        byPath[sp].events[ev] = (byPath[sp].events[ev] ?? 0) + 1;
        if (!r.trial_signup_id) { orphan++; byPath[sp].orphan++; }
        const c = String(r.created_at ?? "");
        if (c && (!oldest || c < oldest)) oldest = c;
        if (c && (!newest || c > newest)) newest = c;
      }
      const total = (rows ?? []).length;
      const opened = byEvent["email.opened"] ?? byEvent["opened"] ?? 0;
      const clicked = byEvent["email.clicked"] ?? byEvent["clicked"] ?? 0;
      const delivered = byEvent["email.delivered"] ?? byEvent["delivered"] ?? 0;

      // Senders ranked by how badly they break attribution.
      const worst = Object.entries(byPath)
        .filter(([, v]) => v.total >= 5)
        .map(([k, v]) => ({ send_path: k, rows: v.total, orphan_pct: pct(v.orphan, v.total) }))
        .sort((a, b) => b.orphan_pct - a.orphan_pct || b.rows - a.rows)
        .slice(0, 15);

      out.email = {
        total_rows: total,
        date_range: { oldest, newest },
        by_event_type: byEvent,
        orphaned_rows: orphan,
        orphan_pct: pct(orphan, total),
        // THE question: is open/click tracking actually on at Resend?
        tracking_enabled: {
          opens_recorded: opened,
          clicks_recorded: clicked,
          delivered_recorded: delivered,
          verdict:
            delivered === 0 ? "cannot tell — no delivered events recorded either"
            : opened === 0 && clicked === 0
              ? "OFF at Resend — delivered events land but zero opens and zero clicks. This is a dashboard toggle, not a code fix."
            : opened > 0 && clicked === 0
              ? "opens only — click tracking appears to be off at Resend"
              : "on — opens and clicks are both being recorded",
          caveat: "Apple Mail Privacy Protection pre-fetches tracking pixels, so opens over-report. Clicks are reliable; a zero is trustworthy, a positive is not.",
        },
        worst_attributed_senders: worst,
        by_send_path: byPath,
      };
    }
  }

  // ── SMS ───────────────────────────────────────────────────────────────────
  if (want("sms")) {
    const { rows, error } = await fetchAll(
      sb, "sms_messages", "send_path, status, direction, created_at", "created_at",
      (q: any) => (since ? q.gte("created_at", since) : q));
    if (error) {
      out.sms = { error: error.message };
    } else {
      const byPath: Record<string, number> = {}, byStatus: Record<string, number> = {}, byDir: Record<string, number> = {};
      for (const r of (rows ?? []) as any[]) {
        byPath[String(r.send_path ?? "(none)")] = (byPath[String(r.send_path ?? "(none)")] ?? 0) + 1;
        byStatus[String(r.status ?? "(none)")] = (byStatus[String(r.status ?? "(none)")] ?? 0) + 1;
        byDir[String(r.direction ?? "(none)")] = (byDir[String(r.direction ?? "(none)")] ?? 0) + 1;
      }
      out.sms = { total_rows: (rows ?? []).length, by_send_path: byPath, by_status: byStatus, by_direction: byDir };
    }
  }

  // ── UNIVERSE: who can we actually reach ───────────────────────────────────
  if (want("universe")) {
    const { data: locs } = await sb.from("locations").select("id, name");
    const slugOf = (n: string) => String(n ?? "").toLowerCase().replace(/\s+/g, "-");
    const locById = new Map<string, string>();
    for (const l of (locs ?? []) as any[]) locById.set(l.id, slugOf(l.name));

    const { rows: ts } = await fetchAll(
      sb, "trial_signups",
      "id, email, phone, location_id, payment_status, created_at, deleted_at, opted_out_at, front_desk_stage",
      "created_at");

    const perStudio: Record<string, any> = {};
    let noEmail = 0, noPhone = 0, deleted = 0, optedOut = 0;
    const emailSet = new Set<string>();
    for (const r of (ts ?? []) as any[]) {
      const slug = locById.get(r.location_id) ?? "(no location)";
      perStudio[slug] ??= { total: 0, paid: 0, unpaid: 0, deleted: 0, opted_out: 0, stage_member: 0, by_status: {} };
      const p = perStudio[slug];
      p.total++;
      const st = String(r.payment_status ?? "unpaid");
      p.by_status[st] = (p.by_status[st] ?? 0) + 1;
      if (r.deleted_at) { p.deleted++; deleted++; }
      if (r.opted_out_at) { p.opted_out++; optedOut++; }
      if (String(r.front_desk_stage ?? "").toLowerCase() === "member") p.stage_member++;
      if (st === "completed") p.paid++; else if (!r.deleted_at) p.unpaid++;
      if (!r.email) noEmail++; else emailSet.add(String(r.email).toLowerCase().trim());
      if (!r.phone) noPhone++;
    }

    // leads: the separate contact-form / schedule-request pool. Overlap with
    // trial_signups is what decides whether this is new reach or double counting.
    const { rows: leads, error: lErr } = await fetchAll(
      sb, "leads", "email, phone, source, studio_slug", "created_at");
    let leadsNew = 0, leadsTotal = 0;
    const leadsBySource: Record<string, number> = {};
    if (!lErr) {
      for (const l of (leads ?? []) as any[]) {
        leadsTotal++;
        leadsBySource[String(l.source ?? "(none)")] = (leadsBySource[String(l.source ?? "(none)")] ?? 0) + 1;
        const e = String(l.email ?? "").toLowerCase().trim();
        if (e && !emailSet.has(e)) leadsNew++;
      }
    }

    // capi_events = pageviews. Anonymous: we can count them, we cannot email them.
    const { count: pageviews } = await sb.from("capi_events").select("*", { count: "exact", head: true });

    out.universe = {
      trial_signups: {
        total: ts.length,
        distinct_emails: emailSet.size,
        missing_email: noEmail, missing_phone: noPhone,
        deleted, opted_out: optedOut,
        per_studio: perStudio,
      },
      leads_table: lErr ? { error: lErr.message } : {
        total: leadsTotal,
        not_already_in_trial_signups: leadsNew,
        note: "this is the only genuinely NEW contactable reach outside trial_signups",
        by_source: leadsBySource,
      },
      anonymous: {
        capi_events_rows: pageviews ?? 0,
        note: "pageviews and ad events. Large, but no contact details — countable, not emailable.",
      },
    };
  }

  // ── ATTRIBUTION: did the ads actually cause the paid trials? ──────────────
  // Added 2026-10-05 after I claimed "$2,216 produced 207 paid trials, $10.70
  // each" — which was wrong. Those 207 happened in the same fortnight as the
  // spend; that is not the same as the spend causing them. Meta itself claims
  // only 2. The honest answer needs paid trials split by the channel each
  // customer actually arrived through.
  //
  // get_unified_attribution already does exactly that (utm_source on
  // trial_signups, joined to meta_insights_daily spend) but is granted to
  // authenticated only, which is correct — it is revenue data and must not be
  // anon-readable. So we call it here behind the admin secret using the
  // service role, rather than loosening the grant.
  if (want("attribution")) {
    const since = new Date(Date.now() - (days || 30) * 864e5).toISOString().slice(0, 10);
    const { data, error } = await sb.rpc("get_unified_attribution", {
      p_studio: body?.studio ? String(body.studio) : null,
      p_since: since,
    });
    out.attribution = error ? { error: error.message } : {
      since,
      note: "paid = paid trials credited to that channel by utm_source. cac_usd is only meaningful for paid channels, where spend is known.",
      channels: data,
    };
  }

  return json(out);
});
