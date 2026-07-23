/**
 * sync-stripe-paid-mirror — keep stripe_paid_mirror in sync with Stripe.
 *
 * For each studio's Stripe account, pull the last N hours of $49 succeeded
 * PaymentIntents and upsert them into stripe_paid_mirror. The dashboard
 * reads from the mirror as the canonical truth for paid trial counts.
 *
 * Idempotent: on conflict (stripe_payment_intent_id) → update mirrored_at.
 *
 * Schedule: every 5 min via pg_cron AND on-demand after every stripe-webhook.
 *
 * Defaults:
 *   ?hours=N   lookback window (default 24h)
 *   ?since=YYYY-MM-DD  override lower bound (used for one-time full backfill)
 *
 * Env: per-studio Stripe secret keys live on locations.stripe_secret_key.
 * Auth: x-bbb-secret header or service-role bearer (called by cron).
 *
 * Deploy: supabase functions deploy sync-stripe-paid-mirror --no-verify-jwt
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.4.0";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
// 2026-06-12 — used to be hardcoded to 4900 ($49 trial) which SILENTLY dropped
// every $29 comeback payment and $129 special-comeback payment. Customers were
// paying in Stripe but the mirror — and therefore the dashboard — showed
// nothing. Now allow-list every offer amount and tag the variant on the row.
const TARGET_AMOUNTS_CENTS = new Set<number>([
  2900,   // $29   · 1-week comeback (the bug that triggered this fix)
  4900,   // $49   · 2-week standard trial
  12900,  // $129  · 30-day special comeback (legacy)
]);
function variantForAmount(amt: number): string {
  if (amt === 2900)  return "comeback";
  if (amt === 12900) return "special";
  if (amt === 4900)  return "trial";
  return "unknown";
}
const ANCHOR_DATE = "2026-05-15"; // launch — never look earlier than this

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret, Authorization",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Allow either the secret header OR a service-role JWT (cron calls).
  const secret = req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret");
  const auth   = req.headers.get("authorization") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (secret !== ADMIN_SECRET && !auth.includes(serviceRole.slice(-20))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const hours = Math.max(1, Math.min(720, Number(url.searchParams.get("hours") || "24")));
  const sinceParam = url.searchParams.get("since");
  const sinceDate = sinceParam || ANCHOR_DATE;
  const cutoffUnix = Math.max(
    Math.floor(new Date(sinceDate + "T00:00:00-04:00").getTime() / 1000),
    Math.floor((Date.now() - hours * 3600 * 1000) / 1000),
  );

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Pull every studio's Stripe key + slug
  const { data: locs, error: locErr } = await sb
    .from("locations")
    .select("id, name, stripe_secret_key");
  if (locErr || !locs) return json({ ok: false, error: locErr?.message || "no locations" }, 500);

  const results: any[] = [];
  let totalUpserts = 0;

  for (const loc of locs) {
    const studioSlug = (loc.name || "").toLowerCase().replace(/\s+/g, "-");
    if (!loc.stripe_secret_key) {
      results.push({ studio: studioSlug, skipped: "no_stripe_key" });
      continue;
    }
    const stripe = new Stripe(loc.stripe_secret_key, { apiVersion: "2024-12-18.acacia" });

    // Walk PaymentIntents pages until we're before cutoffUnix or run out.
    let starting_after: string | undefined;
    let pages = 0;
    let scanned = 0;
    let matched = 0;
    let upserted = 0;
    try {
      while (pages < 10) { // safety
        pages++;
        // Use `created: { gte: cutoffUnix }` to filter by PI creation, but
        // expand `latest_charge` so we can grab the actual charge success time
        // (NOT pi.created, which is when the customer started checkout — those
        // can be hours or days apart for Stripe Checkout sessions, leading to
        // wrong-day attribution on the daily pulse tile).
        const list = await stripe.paymentIntents.list({
          limit: 100,
          created: { gte: cutoffUnix },
          expand: ["data.latest_charge"],
          ...(starting_after ? { starting_after } : {}),
        });
        scanned += list.data.length;
        for (const pi of list.data) {
          if (!TARGET_AMOUNTS_CENTS.has(pi.amount)) continue;
          if (pi.status !== "succeeded") continue;
          matched++;
          const variant = variantForAmount(pi.amount);
          // Pull customer email/name/phone if not on PI itself
          let email = pi.receipt_email || null;
          let name: string | null = null;
          let phone: string | null = null;
          let stripeCustomerId: string | null = null;
          try {
            if (pi.customer && typeof pi.customer === "string") {
              stripeCustomerId = pi.customer;
              const cust = await stripe.customers.retrieve(pi.customer);
              if (cust && !(cust as any).deleted) {
                email = email || ((cust as any).email ?? null);
                name = (cust as any).name ?? null;
                phone = (cust as any).phone ?? null;
              }
            }
          } catch { /* swallow */ }

          // Resolve the latest Charge object — modern Stripe API exposes it
          // via `latest_charge` (which we expanded above). Falls back to the
          // legacy `charges.data[0]` shape, then a final retrieve, then null.
          let latestCharge: any = null;
          try {
            const lc: any = (pi as any).latest_charge;
            if (lc && typeof lc === "object") {
              latestCharge = lc;
            } else if (typeof lc === "string") {
              latestCharge = await stripe.charges.retrieve(lc);
            } else {
              const legacy = (pi as any).charges?.data || [];
              latestCharge = legacy[0] ?? null;
            }
          } catch { /* swallow */ }
          const chargeId: string | null = latestCharge?.id ?? null;

          // paid_at = charge.created (= the succeeded-at moment in Stripe).
          // Fallback to pi.created only if the charge isn't resolvable.
          const paidAtUnix: number =
            (latestCharge?.created as number | undefined) ?? pi.created;

          const row = {
            stripe_payment_intent_id: pi.id,
            studio_slug:    studioSlug,
            location_id:    loc.id,
            amount_cents:   pi.amount,
            currency:       pi.currency,
            paid_at:        new Date(paidAtUnix * 1000).toISOString(),
            customer_email: email,
            customer_name:  name,
            customer_phone: phone,
            stripe_customer_id: stripeCustomerId,
            stripe_charge_id: chargeId,
            // raw carries variant (trial/comeback/special) so the dashboard
            // can break out paid trials by offer if we want to later. Lives
            // inside raw to avoid a schema migration on this hotfix.
            raw: { status: pi.status, metadata: pi.metadata, variant },
            mirrored_at: new Date().toISOString(),
          };

          const { error } = await sb
            .from("stripe_paid_mirror")
            .upsert(row, { onConflict: "stripe_payment_intent_id" });
          if (!error) upserted++;
        }
        if (!list.has_more) break;
        starting_after = list.data[list.data.length - 1]?.id;
        if (!starting_after) break;
      }
      results.push({ studio: studioSlug, pages, scanned, matched, upserted });
      totalUpserts += upserted;
    } catch (e) {
      results.push({ studio: studioSlug, error: (e as Error).message });
    }
  }

  // 2026-06-19 — heartbeat write so sync-health-watchdog can distinguish
  // "sync hasn't run" from "sync ran with 0 charges to mirror" (false STALE
  // alerts on slow business days when no $49/$29 trial sold).
  //
  // Approach: upsert a sentinel row with stripe_payment_intent_id = 'sync_heartbeat'.
  // Watchdog reads stripe_paid_mirror.mirrored_at MAX which will always reflect
  // the most recent sync run regardless of whether real charges came in.
  try {
    await supabase.from("stripe_paid_mirror").upsert({
      stripe_payment_intent_id: "sync_heartbeat",
      stripe_charge_id: "sync_heartbeat",
      studio_slug: "system",
      amount_cents: 0,
      currency: "usd",
      paid_at: "2026-05-15T00:00:00Z",
      customer_email: "heartbeat@bbb.system",
      customer_name: "SYNC HEARTBEAT — DO NOT DISPLAY",
      raw: {
        status: "heartbeat",
        last_run_at: new Date().toISOString(),
        last_total_upserts: totalUpserts,
      },
      mirrored_at: new Date().toISOString(),
    }, { onConflict: "stripe_payment_intent_id" });
  } catch (_e) {
    // best-effort, do not fail the sync
  }

  return json({
    ok: true,
    lookback_hours: hours,
    since: sinceDate,
    total_upserts: totalUpserts,
    per_studio: results,
    completed_at: new Date().toISOString(),
  });
});
