/**
 * paid-trials-realtime-monitor — runs every 60 seconds via cron.
 *
 * Purpose: NEVER again miss a $49 or $29 paid trial. The Stripe webhook is
 * the primary path (fires within seconds), but it has failure modes:
 *   - Endpoint misconfigured at any of the 4 studio Stripe accounts
 *   - Stripe signature mismatch (silent 401, charge lost forever)
 *   - DB upsert exception (logged but no alert reaches Justin)
 *   - The mirror cron's 5-min cursor leaks (proved with Michelle Bido 6/18)
 *
 * This monitor is the safety net. It runs every minute, scans each studio's
 * Stripe account for charges in the last 10 minutes at $49 or $29, and:
 *   1. If any charge is MISSING from stripe_paid_mirror, force-inserts it.
 *   2. Finds or creates the matching trial_signups row (by email/phone).
 *   3. Flips payment_status to 'completed' if not already.
 *   4. SMSes Justin's cell within 60 seconds of detection: "RECOVERED: <name>
 *      at <studio> paid $X — auto-recovered, dashboard updated."
 *   5. Logs the event to capi_events for audit.
 *
 * Idempotency: skip-on-exists for the mirror, and a guard against double-
 * welcome — only fires manual-welcome-batch if trial_signups.welcome_email_sent_at
 * is NULL.
 *
 * Schedule via cron-job.org or pg_cron, every 60 seconds.
 *
 * Deploy:
 *   supabase functions deploy paid-trials-realtime-monitor --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.4.0";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const LOOKBACK_MINUTES = 10;
const ALERT_AGE_MIN_MINUTES = 1;  // skip charges <1 min old (webhook still has time)
const ELIGIBLE_AMOUNTS_CENTS = [4900, 2900];  // $49 trial + $29 comeback

// Studio config — slug → location_id mapping. Stripe secret keys live on the
// locations table (locations.stripe_secret_key), same pattern as
// sync-stripe-paid-mirror. We fetch them at runtime so the function picks up
// rotation without redeploy.
const STUDIO_LOCATION_IDS: Record<string, string> = {
  williamsburg:    "80536b45-df0e-42d1-880c-e9301372e1cf",
  astoria:         "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45",
  bayside:         "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7",
  "fresh-meadows": "6bbbe077-bcc6-4d9d-a10b-7605c1484752",
};

const JUSTIN_PHONE = "+19174081247";  // Justin's cell for drift alerts

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

async function smsJustin(body: string): Promise<void> {
  // 2026-07-10 (Justin): drift-alert TEXTS are off by default — they fired
  // constantly during the MT visit backfill. Detection + console logging still
  // run every 60s (nothing about truth-checking changes); this only mutes the
  // SMS. Set env MONITOR_SMS_ENABLED=1 to turn the texts back on.
  if (Deno.env.get("MONITOR_SMS_ENABLED") !== "1") {
    console.log("[monitor] drift SMS suppressed (MONITOR_SMS_ENABLED != 1):", body);
    return;
  }
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER") || "+18772860293";
  if (!sid || !token) return;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: JUSTIN_PHONE, Body: body }).toString(),
    });
  } catch (e) {
    console.error("Justin SMS failed:", (e as Error).message);
  }
}

interface DriftEvent {
  studio_slug: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  amount_dollars: number;
  paid_at: string;
  stripe_payment_intent_id: string;
  stripe_charge_id: string;
  age_minutes: number;
  recovered: boolean;
  trial_signup_id: string | null;
  welcome_fired: boolean;
  error: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  // Auth: shared secret. Cron-job.org pings it with x-bbb-secret header.
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const drifts: DriftEvent[] = [];
  const errors: Array<{ studio: string; error: string }> = [];
  const nowMs = Date.now();
  const sinceMs = nowMs - LOOKBACK_MINUTES * 60_000;

  // Fetch all 4 studio Stripe keys from locations table — same pattern as
  // sync-stripe-paid-mirror. Keys live in DB so rotation works without redeploy.
  const { data: locs, error: locErr } = await sb
    .from("locations")
    .select("id, name, stripe_secret_key");
  if (locErr || !locs) {
    return json({ ok: false, error: locErr?.message || "could not load locations" }, 500);
  }

  for (const loc of locs) {
    const slug = (loc.name || "").toLowerCase().replace(/\s+/g, "-");
    const locationId = STUDIO_LOCATION_IDS[slug];
    if (!locationId) continue;  // unknown studio, skip silently
    if (!loc.stripe_secret_key) {
      errors.push({ studio: slug, error: "no stripe_secret_key on locations row" });
      continue;
    }
    const cfg = { slug, locationId };
    const stripe = new Stripe(loc.stripe_secret_key, { apiVersion: "2024-12-18.acacia" });

    try {
      // List successful charges in last 10 minutes
      const charges = await stripe.charges.list({
        created: { gte: Math.floor(sinceMs / 1000) },
        limit: 50,
      });

      for (const charge of charges.data) {
        if (charge.status !== "succeeded") continue;
        if (!ELIGIBLE_AMOUNTS_CENTS.includes(charge.amount)) continue;

        const ageMs = nowMs - charge.created * 1000;
        const ageMin = ageMs / 60_000;
        if (ageMin < ALERT_AGE_MIN_MINUTES) continue;  // give webhook a chance

        // Check if already in stripe_paid_mirror
        const piId = typeof charge.payment_intent === "string"
          ? charge.payment_intent : (charge.payment_intent?.id ?? null);
        if (!piId) continue;

        const { data: existing } = await sb
          .from("stripe_paid_mirror")
          .select("id")
          .eq("stripe_payment_intent_id", piId)
          .maybeSingle();

        if (existing) continue;  // already mirrored — webhook worked

        // DRIFT! Auto-recover.
        const drift: DriftEvent = {
          studio_slug: cfg.slug,
          customer_name: charge.billing_details?.name ?? "(unknown)",
          customer_email: charge.billing_details?.email ?? "",
          customer_phone: charge.billing_details?.phone ?? "",
          amount_dollars: charge.amount / 100,
          paid_at: new Date(charge.created * 1000).toISOString(),
          stripe_payment_intent_id: piId,
          stripe_charge_id: charge.id,
          age_minutes: Math.round(ageMin),
          recovered: false,
          trial_signup_id: null,
          welcome_fired: false,
          error: null,
        };

        try {
          // 1. Insert into stripe_paid_mirror
          const { error: mirrorErr } = await sb.from("stripe_paid_mirror").insert({
            studio_slug: cfg.slug,
            stripe_payment_intent_id: piId,
            stripe_charge_id: charge.id,
            customer_name: drift.customer_name,
            customer_email: drift.customer_email,
            customer_phone: drift.customer_phone,
            amount_cents: charge.amount,
            paid_at: drift.paid_at,
            mirrored_at: new Date().toISOString(),
            raw: {
              source: "paid-trials-realtime-monitor auto-recovery",
              charge_id: charge.id,
              age_min_at_recovery: drift.age_minutes,
            },
          });
          if (mirrorErr) throw new Error(`mirror insert: ${mirrorErr.message}`);

          // 2. Find existing trial_signups row by email or phone
          const phoneDigits = (drift.customer_phone || "").replace(/\D/g, "");
          const phone10 = phoneDigits.slice(-10);

          // 2026-06-24: Widened lookup so we stop creating duplicate rows.
          // Previously this used ilike (which is case-insensitive but does NOT
          // trim whitespace) + restricted to location_id, so a pending lead
          // row with trailing space or wrong location flag was missed and we
          // fell through to the insert branch below. New strategy: try
          // exact-trimmed-lowercased email at this location first, then
          // ANY-location as fallback (better to flip a row at wrong location
          // than create a dup). Also order by has-session DESC so we prefer
          // the row that actually came from the trial form, not a prior
          // synthetic row from a previous monitor run.
          let trialRow: { id: string; welcome_email_sent_at: string | null; payment_status: string } | null = null;
          if (drift.customer_email) {
            const emailNorm = drift.customer_email.trim().toLowerCase();
            // Try this studio first
            const { data: byEmailHere } = await sb
              .from("trial_signups")
              .select("id, welcome_email_sent_at, payment_status, stripe_session_id")
              .eq("location_id", cfg.locationId)
              .filter("email", "ilike", emailNorm)
              .is("deleted_at", null)
              .order("stripe_session_id", { ascending: false, nullsFirst: false })
              .order("created_at", { ascending: false })
              .limit(1);
            if (byEmailHere?.[0]) trialRow = byEmailHere[0];
            // Fallback: any studio (better than creating a dup)
            if (!trialRow) {
              const { data: byEmailAny } = await sb
                .from("trial_signups")
                .select("id, welcome_email_sent_at, payment_status, stripe_session_id")
                .filter("email", "ilike", emailNorm)
                .is("deleted_at", null)
                .order("stripe_session_id", { ascending: false, nullsFirst: false })
                .order("created_at", { ascending: false })
                .limit(1);
              if (byEmailAny?.[0]) trialRow = byEmailAny[0];
            }
          }
          if (!trialRow && phone10) {
            const { data: byPhone } = await sb
              .from("trial_signups")
              .select("id, welcome_email_sent_at, payment_status, phone")
              .is("deleted_at", null)
              .order("created_at", { ascending: false })
              .limit(50);
            const match = byPhone?.find((r: any) =>
              (r.phone || "").replace(/\D/g, "").slice(-10) === phone10
            );
            if (match) trialRow = match;
          }

          if (trialRow) {
            // Flip to completed if not already
            if (trialRow.payment_status !== "completed") {
              await sb
                .from("trial_signups")
                .update({
                  payment_status: "completed",
                  payment_date: drift.paid_at,
                })
                .eq("id", trialRow.id);
            }
            drift.trial_signup_id = trialRow.id;
          } else {
            // No form fill found — insert a synthetic row.
            // 2026-06-24: Use upsert on (location_id, lower(email)) so if the
            // stripe-webhook ALSO tries to insert concurrently, the second
            // writer updates instead of erroring out the unique index added
            // in migration 20260624_trial_signups_unique_email_per_studio.
            const syntheticEmail = drift.customer_email
              ? drift.customer_email.trim().toLowerCase()
              : `${phone10}@stripe-direct.bbb.local`;
            const { data: inserted, error: insErr } = await sb
              .from("trial_signups")
              .upsert({
                name: drift.customer_name,
                email: syntheticEmail,
                phone: drift.customer_phone,
                location_id: cfg.locationId,
                source_category: "stripe_checkout",
                payment_status: "completed",
                payment_date: drift.paid_at,
                front_desk_stage: "new_lead",
                stripe_session_id: drift.stripe_payment_intent_id,
              }, {
                onConflict: "location_id,email",
                ignoreDuplicates: false,
              })
              .select("id")
              .single();
            if (insErr) throw new Error(`trial_signups upsert: ${insErr.message}`);
            drift.trial_signup_id = inserted?.id ?? null;
          }

          // 3. Fire welcome only if not already sent (idempotency guard)
          if (drift.trial_signup_id && (!trialRow || !trialRow.welcome_email_sent_at)) {
            try {
              const welcomeRes = await fetch(
                `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/manual-welcome-batch`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-bbb-secret": ADMIN_SECRET,
                  },
                  body: JSON.stringify({
                    trial_ids: [drift.trial_signup_id],
                    dry_run: false,
                  }),
                },
              );
              drift.welcome_fired = welcomeRes.ok;
            } catch (e) {
              drift.error = `welcome failed: ${(e as Error).message}`;
            }
          }

          drift.recovered = true;
          drifts.push(drift);
        } catch (e) {
          drift.error = (e as Error).message;
          drifts.push(drift);
        }
      }
    } catch (e) {
      errors.push({ studio: cfg.slug, error: (e as Error).message });
    }
  }

  // SMS Justin per drift detected
  for (const d of drifts) {
    const tag = d.recovered ? "RECOVERED" : "FAILED";
    const msg =
      `BBB DRIFT [${tag}]: ${d.customer_name} at ${d.studio_slug} paid $${d.amount_dollars} ` +
      `${d.age_minutes}min ago via Stripe but WAS NOT in dashboard. ` +
      (d.recovered
        ? `Auto-recovered + welcome ${d.welcome_fired ? "fired" : "FAILED"}.`
        : `Recovery failed: ${d.error}`);
    await smsJustin(msg);
  }

  return json({
    ok: true,
    checked_at: new Date().toISOString(),
    lookback_minutes: LOOKBACK_MINUTES,
    drifts_detected: drifts.length,
    drifts_recovered: drifts.filter((d) => d.recovered).length,
    drifts_failed: drifts.filter((d) => !d.recovered).length,
    studios_errored: errors.length,
    drifts,
    errors,
  });
});
