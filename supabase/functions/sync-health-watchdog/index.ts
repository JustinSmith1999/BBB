/**
 * sync-health-watchdog — fires SMS to Justin the moment any critical sync
 * goes stale beyond its threshold.
 *
 * What it watches (table + max_age_minutes):
 *   mariana_tek_sales      · 120  · MT sales not synced in 2h → ALERT
 *   stripe_paid_mirror     · 30   · payments not mirrored in 30min → ALERT
 *   meta_insights_daily    · 240  · ad insights not synced in 4h → ALERT
 *
 * 2026-06-28: dropped all 3 MindBody watches (mindbody_sales, mindbody_visits,
 * mindbody_clients) — fully MT post-cutover. Old alerts are noise.
 *
 * Behavior:
 *   1. Query MAX(synced_at) / MAX(imported_at) on each table.
 *   2. If gap > threshold, classify as STALE.
 *   3. Send one SMS to Justin per STALE source — but only if not already
 *      alerted in last 60 minutes (rate-limit so we don't blast him every
 *      5 minutes).
 *
 * Runs from sync-orchestrator every5 tier.
 *
 * Auth: x-bbb-secret OR service-role bearer.
 *
 * Deploy:
 *   supabase functions deploy sync-health-watchdog --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const TWILIO_SID   = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_TOK   = Deno.env.get("TWILIO_AUTH_TOKEN")  || "";
const TWILIO_FROM  = Deno.env.get("TWILIO_FROM_NUMBER") || "+18772860293";
const JUSTIN_PHONE = Deno.env.get("BBB_ALERT_PHONE")    || "+16317086585"; // Justin

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

type Watch = {
  table: string;
  column: string;
  max_age_minutes: number;
  display: string;
};

// 2026-06-28: dropped all 3 MindBody watches — we're fully on Mariana Tek
// post-cutover. Replaced with the MT equivalent so we still get pinged
// when the new pipe goes stale.
const WATCHES: Watch[] = [
  { table: "mariana_tek_sales",   column: "synced_at",   max_age_minutes:  120, display: "Mariana Tek sales" },
  // 2026-09-01: the clients roster silently froze for 7 WEEKS (July 11 ->
  // Sept 1) because nothing watched it. Never again — every table Homebase
  // reads gets a freshness tripwire.
  { table: "mariana_tek_clients", column: "synced_at",   max_age_minutes: 1560, display: "MT customer roster" },
  { table: "mariana_tek_visits",  column: "synced_at",   max_age_minutes:  720, display: "MT visits" },
  { table: "trial_signups",       column: "created_at",  max_age_minutes: 2880, display: "Trial signups (no new rows 2 days)" },
  { table: "sms_messages",        column: "created_at",  max_age_minutes: 2880, display: "SMS gateway" },
  { table: "page_views",          column: "ts",          max_age_minutes:  360, display: "Website analytics beacon" },
  // 2026-07-27: REMOVED the stripe_paid_mirror watch. Every studio moved onto
  // Mariana Tek ~mid-July 2026 (Bayside was the last Stripe holdout), so there
  // are no new Stripe payments to mirror — mirrored_at is now PERMANENTLY older
  // than the 30-min threshold and the watchdog was firing a false "stale" SMS
  // to Justin every hour (24+/day, 3 segments each) about a payment rail that
  // is intentionally retired. Stripe is legacy; nothing to watch here anymore.
  // Re-add only if the studios ever take Stripe payments again.
  // { table: "stripe_paid_mirror",  column: "mirrored_at", max_age_minutes:   30, display: "Stripe paid mirror" },
  { table: "meta_insights_daily", column: "synced_at",   max_age_minutes:  240, display: "Meta ad insights" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json({ ok: false, error: "POST required" }, 405);

  const secret = req.headers.get("x-bbb-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const SR     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (secret !== ADMIN_SECRET && bearer !== SR) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", SR);
  const now = Date.now();
  const results: any[] = [];
  const alertsToFire: { display: string; ageMin?: number; threshold?: number; table: string; body?: string }[] = [];

  for (const w of WATCHES) {
    // Pull the most recent timestamp from this table.
    const { data, error } = await sb
      .from(w.table)
      .select(w.column)
      .order(w.column, { ascending: false })
      .limit(1);
    if (error) {
      results.push({ ...w, status: "query_error", error: error.message });
      continue;
    }
    const latest = data?.[0]?.[w.column];
    if (!latest) {
      results.push({ ...w, status: "empty_table", latest: null });
      continue;
    }
    const ageMs = now - new Date(latest).getTime();
    const ageMin = Math.round(ageMs / 60000);
    const stale = ageMin > w.max_age_minutes;
    results.push({
      ...w, status: stale ? "STALE" : "ok",
      latest, age_minutes: ageMin, threshold: w.max_age_minutes,
    });
    if (stale) {
      alertsToFire.push({ display: w.display, ageMin, threshold: w.max_age_minutes, table: w.table });
    }
  }

  // ── WELCOME-GAP CHECK (2026-07-27) ──────────────────────────────────────
  // The exact silent failure that burned us: a paid trial that got a card but
  // NO welcome text/email. If any paid trial is >30 min old with no welcome on
  // record, the pipeline is dropping people — text Justin NOW. Bounded to the
  // last 6h so we alarm on NEW gaps, not the historical backlog we agreed not
  // to touch. This runs every 5 min (via the orchestrator), so a real gap
  // surfaces within ~35 min instead of days.
  try {
    const sixHrsAgo    = new Date(now - 6 * 3600 * 1000).toISOString();
    const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();
    const { data: gap } = await sb
      .from("trial_signups")
      .select("name, source_category, created_at")
      .eq("payment_status", "completed")
      .is("deleted_at", null)
      .is("welcome_sms_sent_at", null)
      .gt("created_at", sixHrsAgo)
      .lt("created_at", thirtyMinAgo)
      .order("created_at", { ascending: false })
      .limit(50);
    const n = (gap ?? []).length;
    results.push({ check: "welcome_gap", un_welcomed_last_6h: n });
    if (n > 0) {
      const eg = (gap as any[])[0];
      alertsToFire.push({
        display: "Un-welcomed trials",
        table: "trial_signups",
        body:
          `🚨 BBB: ${n} paid trial${n > 1 ? "s" : ""} in the last 6h got a card but NO ` +
          `welcome text/email (e.g. ${eg.name || "?"} · ${eg.source_category || "?"}). ` +
          `The welcome pipeline may be down — check mt-orders-sync + manual-welcome-batch.`,
      });
    }
  } catch (e) {
    results.push({ check: "welcome_gap", error: (e as Error).message });
  }

  // ── MT OAUTH TOKEN EXPIRY (2026-08-05) ──────────────────────────────────
  // The failure that went dark mid-week: MT's OAuth token expires ~weekly, and
  // when it dies the ENTIRE sync goes blind. The staleness watches above only
  // notice ~2h AFTER sales stop flowing — by then you're already behind and
  // scrambling. This checks the token DIRECTLY and warns ~24h BEFORE expiry so
  // you re-seed during business hours (log into MT admin → run the reseed)
  // instead of finding it dark. Self-suppressed to one ping / 6h.
  try {
    const { data: tok } = await sb
      .from("mt_oauth").select("expires_at, refresh_token").eq("id", "default").maybeSingle();
    let tokenBody: string | null = null;
    if (!tok || !tok.refresh_token) {
      tokenBody = `🚨 BBB: the Mariana Tek sync has NO stored login token — sync is/going dark. Log into MT admin and re-seed the mt_oauth row now.`;
    } else if (tok.expires_at) {
      const hrsLeft = (new Date(tok.expires_at).getTime() - now) / 3600000;
      if (hrsLeft <= 0) {
        tokenBody = `🚨 BBB: the Mariana Tek login token EXPIRED — sync is dark, no new trials/sales are landing. Log into MT admin and re-seed the mt_oauth row to restore it.`;
      } else if (hrsLeft <= 24) {
        tokenBody = `⚠️ BBB heads-up: the Mariana Tek login token expires in ~${hrsLeft.toFixed(0)}h. Re-seed it today (MT admin → reseed) so the sync never goes dark. Doing it now beats scrambling later.`;
      }
    }
    results.push({ check: "mt_token", expires_at: tok?.expires_at ?? null, warn: !!tokenBody });
    if (tokenBody) {
      const since6h = new Date(now - 6 * 3600 * 1000).toISOString();
      const { count } = await sb.from("sms_messages").select("*", { count: "exact", head: true })
        .eq("send_path", "sync_watchdog_alert").gte("sent_at", since6h).ilike("body", "%Mariana Tek%token%");
      if ((count ?? 0) === 0) {
        alertsToFire.push({ display: "MT login token", table: "mt_oauth", body: tokenBody });
      }
    }
  } catch (e) {
    results.push({ check: "mt_token", error: (e as Error).message });
  }

  // Rate-limit: don't re-alert in <60 min for the same table.
  const alertsSent: any[] = [];
  for (const a of alertsToFire) {
    const since = new Date(now - 60 * 60 * 1000).toISOString();
    const { count } = await sb
      .from("sms_messages")
      .select("*", { count: "exact", head: true })
      .eq("send_path", "sync_watchdog_alert")
      .gte("sent_at", since)
      .ilike("body", `%${a.display}%`);
    if ((count ?? 0) > 0) {
      alertsSent.push({ ...a, action: "skipped_rate_limit" });
      continue;
    }

    if (!TWILIO_SID || !TWILIO_TOK) {
      alertsSent.push({ ...a, action: "twilio_not_configured" });
      continue;
    }

    const body = a.body ??
      (`🚨 BBB sync alert: "${a.display}" is ${a.ageMin} min stale ` +
      `(threshold ${a.threshold}m). Table: ${a.table}. ` +
      `Last sync was ${((a.ageMin ?? 0)/60).toFixed(1)}h ago. Investigate now.`);

    try {
      const auth = btoa(`${TWILIO_SID}:${TWILIO_TOK}`);
      const form = new URLSearchParams({ From: TWILIO_FROM, To: JUSTIN_PHONE, Body: body });
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() },
      );
      const rb = await resp.json().catch(() => ({}));
      // Log the alert SMS so we can rate-limit it on the next tick.
      await sb.from("sms_messages").insert({
        direction:  "outbound",
        from_phone: TWILIO_FROM,
        to_phone:   JUSTIN_PHONE,
        body,
        sent_at:    new Date().toISOString(),
        send_path:  "sync_watchdog_alert",
        twilio_sid: rb?.sid ?? null,
        status:     resp.ok ? "queued" : "failed",
      });
      alertsSent.push({ ...a, action: resp.ok ? "sms_sent" : "sms_failed", sid: rb?.sid });
    } catch (e) {
      alertsSent.push({ ...a, action: "exception", error: (e as Error).message });
    }
  }

  return json({
    ok: true,
    checked: WATCHES.length,
    stale_count: alertsToFire.length,
    alerts_sent: alertsSent.filter(a => a.action === "sms_sent").length,
    results,
    alerts: alertsSent,
  });
});
