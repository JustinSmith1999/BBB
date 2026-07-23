/**
 * stripe-payment-audit - hourly defensive sweep.
 *
 * For each studio's Stripe account:
 *   1. Pull last 100 PaymentIntents
 *   2. Filter to $49 succeeded
 *   3. Check if each is already in trial_signups (by email OR stripe_session_id)
 *   4. For any missing, call handle-paid-trial to process it
 *
 * This is the safety net. Even if the realtime webhook misses something
 * (because of a Stripe outage, network issue, manual flow, etc.), this
 * cron picks it up within an hour.
 *
 * Recommended cron: every 30 minutes.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.4.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SLUG_BY_LOCATION_ID: Record<string,string> = {
  "80536b45-df0e-42d1-880c-e9301372e1cf": "williamsburg",
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": "astoria",
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": "bayside",
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": "fresh-meadows",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Cutoff defaults to last 72h (the normal cron run). Pass ?days=N or
    // ?hours=N to widen the lookback — used for one-shot backfills.
    const url = new URL(req.url);
    const daysParam = Number(url.searchParams.get("days"));
    const hoursParam = Number(url.searchParams.get("hours"));
    const dryRun = url.searchParams.get("dry_run") === "true";
    // 2026-06-01: DEFAULT FLIPPED TO TRUE after the 2026-05-31 owner-spam
    // incident. Calling this manually with `days=N` was firing N "New $49 Trial"
    // owner emails per recovered orphan. Now silent by default — recovered rows
    // get inserted into trial_signups, no emails or CAPI events fire. Opt back
    // in explicitly with ?skip_emails=false on the rare manual re-send case.
    const skipEmails = (url.searchParams.get("skip_emails") ?? "true") !== "false";
    let lookbackHours = 72;
    if (Number.isFinite(daysParam) && daysParam > 0) lookbackHours = daysParam * 24;
    else if (Number.isFinite(hoursParam) && hoursParam > 0) lookbackHours = hoursParam;
    const cutoffMs = Date.now() - lookbackHours * 3600 * 1000;
    const cutoffUnix = Math.floor(cutoffMs / 1000);

    // Pull known emails + stripe_ids from trial_signups. Look back at least
    // as far as the requested window + a 7-day buffer so we don't re-insert
    // payments that already exist in older trial_signups rows.
    const knownLookbackMs = Math.max(72 * 3600 * 1000, lookbackHours * 3600 * 1000) + 7 * 86400 * 1000;
    const { data: knownRows } = await supabase
      .from("trial_signups")
      .select("email,stripe_session_id,payment_status")
      .gte("created_at", new Date(Date.now() - knownLookbackMs).toISOString())
      .limit(5000);

    // CRITICAL: only treat a payment as "already handled" if the matching
    // trial_signups row is payment_status='completed'. Earlier versions of
    // this audit treated ANY row presence as handled, so customers stuck at
    // 'pending' (webhook fired but UPDATE didn't promote them) silently
    // accumulated forever. Now pending rows are re-processed through
    // handle-paid-trial, which idempotently promotes them.
    const knownEmails = new Set<string>();
    const knownIds = new Set<string>();
    for (const r of (knownRows || [])) {
      if (r.payment_status !== "completed") continue;
      if (r.email) knownEmails.add(String(r.email).toLowerCase());
      if (r.stripe_session_id) knownIds.add(String(r.stripe_session_id).toLowerCase());
    }

    // Pull all studio Stripe keys
    const { data: locs } = await supabase.from("locations").select("id,name,stripe_secret_key");

    const results: any[] = [];
    let missingCount = 0;

    for (const L of (locs || [])) {
      const slug = SLUG_BY_LOCATION_ID[L.id];
      if (!slug || !L.stripe_secret_key) continue;
      const stripe = new Stripe(L.stripe_secret_key, { apiVersion: "2024-12-18.acacia" });

      // List recent payment intents. Stripe API allows 100 per page; we
      // page through up to 5 pages = 500 PIs to cover long lookback windows.
      let startAfter: string | undefined;
      for (let page = 0; page < 5; page++) {
        const listArgs: any = { limit: 100, created: { gte: cutoffUnix } };
        if (startAfter) listArgs.starting_after = startAfter;
        const pis = await stripe.paymentIntents.list(listArgs);
        for (const p of pis.data) {
          if (p.status !== "succeeded" || p.amount !== 4900) continue;
          if (knownIds.has(p.id.toLowerCase())) continue;
          const charge = (p as any).latest_charge ? await stripe.charges.retrieve(typeof (p as any).latest_charge === "string" ? (p as any).latest_charge : (p as any).latest_charge.id) : null;
          const email = (charge?.billing_details?.email || p.receipt_email || "").toLowerCase();
          if (email && knownEmails.has(email)) continue;

          missingCount++;
          const name = charge?.billing_details?.name || null;
          const phone = charge?.billing_details?.phone || null;
          const paidIso = new Date((p.created || 0) * 1000).toISOString();
          if (dryRun) {
            results.push({ studio: slug, pi: p.id, dry_run: true, email, name, phone, paid: paidIso });
            continue;
          }
          if (skipEmails) {
            // Silent backfill: insert directly into trial_signups, marking
            // day1_email_sent_at so the Day 1 backstop cron doesn't fire on
            // these historical rows. The Day 2 cron filters by 36-60h
            // payment_date window so won't pick up rows older than that.
            const nowIso = new Date().toISOString();
            // Both name and email are NOT NULL on trial_signups. Old payment-link
            // transactions often have neither from Stripe. Use safe fallbacks:
            //   - name: email local part, else "(backfill)"
            //   - email: synthetic placeholder using the PI id, so the row is
            //     traceable but will never collide with a real customer or
            //     accidentally get emailed (no real domain).
            const safeName = name || (email ? email.split("@")[0] : null) || "(backfill)";
            const safeEmail = email || `backfill-${p.id}@no-email.bbb.local`;
            const insertRow: Record<string, any> = {
              name: safeName,
              email: safeEmail,
              phone,
              location_id: L.id,
              payment_status: "completed",
              payment_date: paidIso,
              stripe_session_id: p.id,
              newsletter_opted_in: false,
              day1_email_sent_at: nowIso,
            };
            const { error: insErr } = await supabase.from("trial_signups").insert(insertRow);
            if (insErr) {
              results.push({ studio: slug, pi: p.id, ok: false, action: "silent_insert", error: insErr.message, paid: paidIso });
            } else {
              results.push({ studio: slug, pi: p.id, ok: true, action: "silent_insert", email, name, paid: paidIso });
            }
            continue;
          }
          try {
            const callRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/handle-paid-trial`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
              },
              body: JSON.stringify({ stripe_id: p.id, studio_slug: slug }),
            });
            const body = await callRes.json();
            results.push({ studio: slug, pi: p.id, ok: !!body.ok, captured: body.captured, error: body.error, paid: paidIso });
          } catch (e) {
            results.push({ studio: slug, pi: p.id, ok: false, error: String(e), paid: paidIso });
          }
        }
        if (!pis.has_more || pis.data.length === 0) break;
        startAfter = pis.data[pis.data.length - 1].id;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      mode: dryRun ? "DRY RUN" : (skipEmails ? "LIVE (silent — no emails)" : "LIVE (with emails + CAPI)"),
      lookback_hours: lookbackHours,
      lookback_days: +(lookbackHours / 24).toFixed(1),
      skip_emails: skipEmails,
      missing_found: missingCount,
      processed: results.length,
      inserted_ok: results.filter((r: any) => r.ok).length,
      failed: results.filter((r: any) => r.ok === false).length,
      details: results,
    }, null, 2), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("stripe-payment-audit error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
