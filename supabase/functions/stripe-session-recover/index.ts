/**
 * stripe-session-recover — quiet recovery of pending-but-actually-paid trials.
 *
 * Built for the scenario where a customer completed Stripe Checkout but the
 * webhook didn't flip trial_signups to completed (gap between Stripe session
 * completion and our DB state).
 *
 * Takes a list of trial_signup IDs OR scans all `pending` rows with a
 * `stripe_session_id` from the last N days. For each:
 *   1. Looks up the Stripe Checkout Session directly
 *   2. If session.payment_status === 'paid' (or 'no_payment_required' for $0)
 *      AND session.status === 'complete':
 *      - Flip trial_signups.payment_status to 'completed'
 *      - Set payment_date to session created/completed timestamp
 *      - Set source_category to 'stripe_checkout' if null
 *   3. Returns list of recovered IDs so the caller can fire manual-welcome-batch
 *      (with owner alerts suppressed if owners shouldn't know).
 *
 * Owner alerts are NOT fired by this function. Quiet by design.
 *
 * REQUEST:
 *   POST { trial_ids: [...] }                     // explicit list
 *   POST { scan: true, days: 14 }                 // sweep recent pending+session
 *   POST { trial_ids: [...], dry_run: true }      // preview without writes
 *
 * AUTH: x-bbb-secret
 *
 * DEPLOY:
 *   supabase functions deploy stripe-session-recover --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.4.0";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await req.json().catch(() => ({})) as {
    trial_ids?: string[];
    scan?: boolean;
    days?: number;
    dry_run?: boolean;
  };
  const dryRun = body.dry_run === true;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Build candidate list
  let candidates: any[] = [];
  if (body.trial_ids?.length) {
    const { data, error } = await sb
      .from("trial_signups")
      .select("id, name, email, location_id, payment_status, stripe_session_id, source_category, locations:location_id(name, stripe_secret_key)")
      .in("id", body.trial_ids);
    if (error) return json({ ok: false, error: error.message }, 500);
    candidates = data ?? [];
  } else if (body.scan) {
    const days = Math.max(1, Math.min(60, body.days ?? 14));
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const { data, error } = await sb
      .from("trial_signups")
      .select("id, name, email, location_id, payment_status, stripe_session_id, source_category, locations:location_id(name, stripe_secret_key)")
      .eq("payment_status", "pending")
      .not("stripe_session_id", "is", null)
      .gte("created_at", since)
      .is("deleted_at", null);
    if (error) return json({ ok: false, error: error.message }, 500);
    candidates = data ?? [];
  } else {
    return json({ ok: false, error: "pass trial_ids or scan:true" }, 400);
  }

  const results: any[] = [];
  let recovered = 0;
  let alreadyPaid = 0;
  let stillUnpaid = 0;
  let errored = 0;

  for (const row of candidates) {
    const out: any = {
      id: row.id,
      name: row.name,
      studio: row.locations?.name,
      payment_status_before: row.payment_status,
      stripe_session_id: row.stripe_session_id,
    };

    // Skip if already completed
    if (row.payment_status !== "pending") {
      out.skipped = "not pending";
      alreadyPaid++;
      results.push(out);
      continue;
    }

    // Skip if no session id (shouldn't happen in scan mode but defensive)
    if (!row.stripe_session_id || !row.stripe_session_id.startsWith("cs_")) {
      out.skipped = "no checkout session id";
      results.push(out);
      continue;
    }

    // Get studio Stripe key
    const stripeKey = row.locations?.stripe_secret_key;
    if (!stripeKey) {
      out.error = "no stripe_secret_key for studio";
      errored++;
      results.push(out);
      continue;
    }

    try {
      const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });
      const session = await stripe.checkout.sessions.retrieve(row.stripe_session_id);
      out.stripe_status = session.status;
      out.stripe_payment_status = session.payment_status;
      out.amount_total = session.amount_total;
      out.customer_email = session.customer_details?.email ?? null;

      const isPaid = session.payment_status === "paid"
        || session.payment_status === "no_payment_required";
      const isComplete = session.status === "complete";

      if (!isPaid || !isComplete) {
        out.action = "no action — session not paid/complete";
        stillUnpaid++;
        results.push(out);
        continue;
      }

      // RECOVER: flip the row AND upsert the mirror so dashboard SSOT stays
      // consistent. (paid-trials-realtime-monitor does the same pattern.)
      const paidAt = new Date(((session.created ?? 0) * 1000) || Date.now()).toISOString();
      const piId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);
      const amountCents = session.amount_total ?? 0;
      const studioSlug = (row.locations?.name || "").toLowerCase().replace(/\s+/g, "-");

      if (dryRun) {
        out.action = "WOULD recover (dry run)";
        out.would_set = {
          trial_signups: { payment_status: "completed", payment_date: paidAt },
          stripe_paid_mirror_upsert: piId
            ? { stripe_payment_intent_id: piId, amount_cents: amountCents, studio_slug: studioSlug }
            : null,
        };
      } else {
        // 1. Flip trial_signups
        const update: any = { payment_status: "completed", payment_date: paidAt };
        if (!row.source_category) update.source_category = "stripe_checkout";
        const { error: upErr } = await sb.from("trial_signups").update(update).eq("id", row.id);
        if (upErr) {
          out.error = "trial_signups update failed: " + upErr.message;
          errored++;
          results.push(out);
          continue;
        }

        // 2. Upsert stripe_paid_mirror so SSOT counts stay consistent. Skip if
        // no payment intent ID (rare — would mean a $0 session).
        let mirrorStatus = "skipped (no payment_intent)";
        if (piId) {
          // Check first to avoid duplicate-key error on the unique index
          const { data: existing } = await sb
            .from("stripe_paid_mirror")
            .select("id")
            .eq("stripe_payment_intent_id", piId)
            .maybeSingle();
          if (existing) {
            mirrorStatus = "already_in_mirror";
          } else {
            const { error: mirErr } = await sb.from("stripe_paid_mirror").insert({
              studio_slug: studioSlug,
              stripe_payment_intent_id: piId,
              stripe_charge_id: null,  // we don't fetch the charge object here
              customer_name: row.name ?? session.customer_details?.name ?? null,
              customer_email: row.email ?? session.customer_details?.email ?? null,
              customer_phone: session.customer_details?.phone ?? null,
              amount_cents: amountCents,
              paid_at: paidAt,
              mirrored_at: new Date().toISOString(),
              raw: {
                source: "stripe-session-recover",
                stripe_session_id: row.stripe_session_id,
                recovered_trial_signup_id: row.id,
              },
            });
            mirrorStatus = mirErr ? `mirror insert failed: ${mirErr.message}` : "inserted";
          }
        }

        out.action = "RECOVERED";
        out.payment_date = paidAt;
        out.mirror = mirrorStatus;
        recovered++;
      }
    } catch (e: any) {
      out.error = `stripe lookup failed: ${e.message ?? String(e)}`;
      errored++;
    }
    results.push(out);
  }

  // List of newly-recovered IDs so caller can fire welcomes
  const recoveredIds = results
    .filter((r) => r.action === "RECOVERED")
    .map((r) => r.id);

  return json({
    ok: true,
    dry_run: dryRun,
    candidates_checked: candidates.length,
    recovered,
    already_paid: alreadyPaid,
    still_unpaid: stillUnpaid,
    errored,
    recovered_trial_ids: recoveredIds,
    results,
  });
});
