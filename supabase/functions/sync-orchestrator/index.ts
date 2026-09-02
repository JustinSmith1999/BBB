/**
 * sync-orchestrator — fans out to every scheduled sync function in parallel.
 *
 * ──────────────── Why this exists ────────────────
 * pg_net's background worker is single-threaded by default and times out
 * silently on HTTP calls that exceed its tight GUC. When pg_cron fires 20+
 * net.http_post() calls in the same minute, the queue backs up and most
 * never complete — pg_cron reports "succeeded" anyway because net.http_post
 * returns the moment it queues, not when the call finishes.
 *
 * This function flips the model. ONE cron call into this URL, then we fan
 * out internally with Promise.all + AbortController timeouts that we
 * actually control. Each downstream function gets ~50s to complete; we move
 * on if it hangs.
 *
 * ──────────────── How to invoke ────────────────
 * POST /functions/v1/sync-orchestrator
 *   { "tier": "every5" | "every10" | "every15" | "hourly" | "all" }
 *
 * Tier maps to which downstream functions get called. The pg_cron migration
 * installs one job per tier — each runs every 5/10/15/60 minutes and pings
 * this orchestrator with the right tier parameter.
 *
 * Each downstream call:
 *   - 50s timeout via AbortController (sane upper bound)
 *   - independent — one failure does not stop the others
 *   - per-call response logged to the response body for /ops visibility
 *
 * Deploy:
 *   supabase functions deploy sync-orchestrator --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const PROJECT = "uracuwugpxqjfgtuobal";
const BASE = `https://${PROJECT}.supabase.co/functions/v1`;

// ──────────────── Tier registry ────────────────
// Each tier lists the downstream functions to call + the body to send.
// Body strings (not jsonb) so it survives a roundtrip via the cron's net.http_post.
const TIERS: Record<string, Array<{ fn: string; body: Record<string, unknown> }>> = {
  every5: [
    { fn: "meta-insights-sync",        body: {} },
    { fn: "sync-stripe-paid-mirror",   body: { since: "2026-05-15" } },
    { fn: "sheet-sync-astoria",        body: {} },
    // 2026-06-12 promoted from every30 → every5 because the every30 tier
    // wasn't firing reliably (only the every-5-min cron-job.org pinger was
    // wired up). Combined with the function's window dropping from 1h →
    // 10min, this means a fresh abandoned cart gets its email at ~T+10min
    // worst case instead of T+60-90min.
    { fn: "abandoned-cart-followup",   body: {} },
    // 2026-06-28: replaced all MindBody syncs (mindbody-sales-sync,
    // mindbody-visits-sync) with the MT equivalent. Post-cutover we don't
    // use MindBody — keeping the calls would just spam errors + alerts.
    { fn: "mt-orders-sync",            body: {} },
    { fn: "sync-health-watchdog",      body: {} },
  ],
  every10: [
    // (mindbody syncs removed 2026-06-28 — MT-only now)
  ],
  every15: [
    // 2026-06-28: dropped mindbody-capi-purchase-sync. MT CAPI fires from
    // mt-orders-sync directly on new mt_app trial signups.
    { fn: "stripe-webhook-heartbeat",    body: {} },
    { fn: "vapi-calls-sync",             body: {} },
  ],
  every30: [
    // 2026-06-28: dropped mindbody-clients-sync — we don't use MindBody.
  ],
  hourly: [
    { fn: "comeback-offer-cron",       body: {} },
    // 2026-07-08: attendance / check-ins. Was scheduled by NOTHING — the only
    // way mariana_tek_visits ever updated was Justin manually running
    // fix-bayside-missing.sh. Now auto-synced hourly so the /homebase
    // "Attended" column self-heals and no manual backfill is needed.
    // 2026-07-10: lookback 2 → 7 days. A 2-day window meant any outage longer
    // than 2 days permanently dropped those check-ins (that's how older
    // attendees got stranded). 7 days is cheap insurance and the parallelized
    // fetch (mapPool) keeps it well under the edge timeout.
    { fn: "mariana-tek-visits-sync",   body: { lookback_days: 7 } },
    // 2026-09-01: clients-sync was written but NEVER deployed or scheduled —
    // the customer roster froze on July 11 and Homebase went stale. Runs the
    // rolling 45-day window every cycle so the roster can never freeze again.
    { fn: "mariana-tek-clients-sync",  body: { max_ids: 2000 } },
    // 2026-09-01: Lead Ads poll — pulls Meta lead-form submissions into
    // trial_signups so the desk sees them on Today within one cycle.
    { fn: "meta-lead-ads",             body: { action: "poll" } },
    // 2026-09-02: MT-based payment verification — heals any 'disputed'
    // mis-stamps and verifies every completed row against Mariana Tek.
    { fn: "mt-verify-payments",        body: { days: 60 } },
  ],
  // "all" = every tier above, for manual full-refresh ad-hoc
  all: [],
};
TIERS.all = [
  ...TIERS.every5, ...TIERS.every10, ...TIERS.every15,
  ...TIERS.every30, ...TIERS.hourly,
];

async function pingOne(
  fn: string,
  body: Record<string, unknown>,
  authBearer: string,
  timeoutMs: number,
): Promise<{ fn: string; ok: boolean; status?: number; ms: number; error?: string; summary?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${fn}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authBearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    // Trim long bodies — we only want the top-level success/failure
    let summary = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text);
      summary = JSON.stringify({
        ok: parsed.ok,
        processed: parsed.processed,
        total_upserts: parsed.total_upserts,
        rows_synced: parsed.rows_synced,
        sent: parsed.sent || parsed.sent_purchase,
        message: parsed.message,
      }).slice(0, 200);
    } catch { /* not JSON — use trimmed text */ }
    return { fn, ok: res.ok, status: res.status, ms: Date.now() - started, summary };
  } catch (e) {
    const err = e as Error;
    return {
      fn,
      ok: false,
      ms: Date.now() - started,
      error: err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json({ ok: false, error: "POST required" }, 405);

  // Auth — same belt+suspenders as other cron-callable functions
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ADMIN = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-bbb-secret") ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  const okAuth =
    secret === ADMIN ||
    (SR && bearer === SR) ||
    ua.startsWith("pg_net/");
  if (!okAuth) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body fine */ }

  const tier = String(body.tier || "every5").trim();
  const jobs = TIERS[tier];
  if (!jobs) return json({ ok: false, error: `unknown tier: ${tier}`, valid: Object.keys(TIERS) }, 400);

  const timeoutMs = Number.isFinite(body.timeout_ms) ? Math.min(60000, Number(body.timeout_ms)) : 50000;
  const overallStart = Date.now();

  // Fan out IN PARALLEL — Promise.all means total wall time = slowest single call
  const results = await Promise.all(
    jobs.map((j) => pingOne(j.fn, j.body, SR, timeoutMs)),
  );

  const okCount = results.filter((r) => r.ok).length;

  return json({
    ok: okCount === results.length,
    tier,
    parallel_dispatch_ms: Date.now() - overallStart,
    succeeded: okCount,
    failed: results.length - okCount,
    results,
  });
});
