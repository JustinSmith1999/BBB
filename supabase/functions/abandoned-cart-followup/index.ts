/**
 * abandoned-cart-followup — Supabase Edge Function
 *
 * Runs on a schedule (set up in Supabase Dashboard → Edge Functions → Cron).
 * Recommended cadence: every 15 minutes.
 *
 * What it does:
 *   1. Find all trial_signups rows where payment_status='pending' AND
 *      created_at is 1-24 hours old (catches people who started Stripe but
 *      bailed) AND abandoned_email_sent_at IS NULL.
 *   2. For each, send a personalized "you didn't finish — come back" email
 *      via Resend.
 *   3. Mark the row with abandoned_email_sent_at = now so we don't double-send.
 *
 * Required env vars:
 *   SUPABASE_URL                 (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY    (auto-injected)
 *   RESEND_API_KEY               (must be set in Supabase Dashboard → Function Settings)
 *   FROM_EMAIL                   (e.g. "Better Body Bootcamp <hello@betterbodybootcamp.com>")
 *
 * Deploy:
 *   supabase functions deploy abandoned-cart-followup --project-ref uracuwugpxqjfgtuobal
 *
 * One-time DB migration required (see SETUP instructions below the function).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Studio-specific email template settings ──────────────────────────────
// location.id → studio slug. Used to personalize the email.
const LOCATION_TO_STUDIO: Record<string, {
  slug: string;
  name: string;
  shortName: string;
  phone: string;
  address: string;
  city: string;
  zip: string;
  bookingUrl: string;
  studioEmail: string;
}> = {
  "80536b45-df0e-42d1-880c-e9301372e1cf": {
    slug: "williamsburg",
    name: "Better Body Bootcamp Williamsburg",
    shortName: "Williamsburg",
    phone: "(718) 683-1864",
    address: "487 Driggs Ave",
    city: "Brooklyn",
    zip: "11211",
    bookingUrl: "https://betterbodybootcamp.com/trial/williamsburg",
    studioEmail: "williamsburg@betterbodybootcamp.com",
  },
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": {
    slug: "astoria",
    name: "Better Body Bootcamp Astoria",
    shortName: "Astoria",
    phone: "(718) 704-9954",
    address: "31-18 Steinway Street",
    city: "Astoria",
    zip: "11103",
    bookingUrl: "https://betterbodybootcamp.com/trial/astoria",
    studioEmail: "astoria@betterbodybootcamp.com",
  },
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": {
    slug: "bayside",
    name: "Better Body Bootcamp Bayside",
    shortName: "Bayside",
    phone: "(646) 566-8870",
    address: "3447 Bell Blvd",
    city: "Bayside",
    zip: "11361",
    bookingUrl: "https://betterbodybootcamp.com/trial/bayside",
    studioEmail: "bayside@betterbodybootcamp.com",
  },
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": {
    slug: "fresh-meadows",
    name: "Better Body Bootcamp Fresh Meadows",
    shortName: "Fresh Meadows",
    phone: "(646) 566-8207",
    address: "76-46 164th Street",
    city: "Fresh Meadows",
    zip: "11366",
    bookingUrl: "https://betterbodybootcamp.com/trial/fresh-meadows",
    studioEmail: "freshmeadows@betterbodybootcamp.com",
  },
};

const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Better Body Bootcamp <hello@betterbodybootcamp.com>";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

function buildEmail(customerName: string, studio: typeof LOCATION_TO_STUDIO[string]) {
  const firstName = (customerName || "").split(" ")[0] || "there";

  return {
    subject: `Still want those 2 weeks, ${firstName}?`,
    html: `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f5;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden">
        <tr><td style="background:#d63838;padding:32px;text-align:center">
          <h1 style="margin:0;color:#fff;font-size:28px;letter-spacing:1px">YOUR SPOT IS STILL HERE</h1>
          <p style="margin:8px 0 0;color:#fff;font-size:14px;opacity:0.9">${studio.name.toUpperCase()}</p>
        </td></tr>
        <tr><td style="padding:32px">
          <h2 style="margin:0 0 16px;font-size:22px">Hey ${firstName},</h2>
          <p style="margin:0 0 16px;line-height:1.6;font-size:16px">
            You were signing up for the <strong>2-week trial</strong> at ${studio.shortName} and stopped at the payment page. Happens all the time.
          </p>
          <p style="margin:0 0 24px;line-height:1.6;font-size:16px">
            Your spot is still open. <strong>$49 covers two full weeks, every class we run.</strong> No contract, and nobody is going to chase you into a membership after.
          </p>

          <table cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#d63838;border-radius:6px">
            <a href="${studio.bookingUrl}" style="display:inline-block;padding:16px 32px;color:#fff;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:0.5px">FINISH SIGNING UP · $49</a>
          </td></tr></table>

          <p style="margin:32px 0 16px;font-size:15px;line-height:1.6">
            If something made you hesitate, call the desk and ask. A real person picks up.<br>
            <strong>${studio.phone}</strong>
          </p>

          <p style="margin:24px 0 0;line-height:1.6;font-size:14px;color:#666">
            ${studio.address}, ${studio.city}, NY ${studio.zip}<br>
            See you in class,<br>
            Team ${studio.shortName}
          </p>
        </td></tr>
        <tr><td style="background:#fafafa;padding:16px;text-align:center;font-size:11px;color:#888;border-top:1px solid #eee">
          You're receiving this because you started a trial signup at ${studio.shortName}.
          Don't want these emails? Just reply STOP.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>
`,
    text: `Hey ${firstName},

You were signing up for the 2-week trial at ${studio.shortName} and stopped at the payment page. Happens all the time.

Your spot is still open. $49 covers two full weeks, every class we run. No contract, and nobody is going to chase you into a membership after.

Finish signing up: ${studio.bookingUrl}

If something made you hesitate, call the desk and ask. A real person picks up: ${studio.phone}

${studio.address}, ${studio.city}, NY ${studio.zip}
See you in class,
Team ${studio.shortName}`,
  };
}

// Send the abandoned-cart email AND log it to email_log so the attribution
// card can count "paid trials that received an abandoned-cart email earlier."
//
// Tags on the Resend payload let resend-webhook update the delivery state on
// this exact row. The email_log row is the canonical record we query against.
async function sendEmail(
  supabase: ReturnType<typeof createClient>,
  trialId: string,
  studioSlug: string,
  to: string,
  name: string,
  studio: typeof LOCATION_TO_STUDIO[string],
) {
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY not set");
  }
  const tmpl = buildEmail(name, studio);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      reply_to: studio.studioEmail,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
      tags: [
        { name: "send_path",       value: "abandoned_cart_email" },
        { name: "trial_signup_id", value: trialId },
        { name: "studio_slug",     value: studioSlug },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  const body = await res.json();
  // Log the send so the attribution card can find it. The send_path tag is
  // the join key the Funnel Health + attribution RPCs use. Columns match the
  // real email_log schema — no provider/studio_slug top-level fields exist;
  // studio_slug rides along in raw for fallback joins.
  // 2026-06-12 NIGHT — stop lying about email_log writes. The supabase-js
  // client returns errors in {error}, NOT as thrown exceptions. The previous
  // try/catch caught nothing while the real error (e.g. column mismatch or
  // missing INSERT policy) sat in `error` and was discarded. Surface it.
  const logPayload = {
    trial_signup_id: trialId,
    send_path:       "abandoned_cart_email",
    resend_id:       body?.id ?? null,
    from_addr:       FROM_EMAIL,
    to_addrs:        [to],
    subject:         tmpl.subject,
    event_type:      "sent_inline",
    raw:             { source: "abandoned-cart-followup", studio_slug: studioSlug, resend_id: body?.id ?? null },
  };
  const { error: logErr } = await supabase.from("email_log").insert(logPayload);
  if (logErr) {
    console.error("email_log insert FAILED", {
      pg_code:    (logErr as { code?: string }).code,
      pg_message: logErr.message,
      pg_details: (logErr as { details?: string }).details,
      pg_hint:    (logErr as { hint?: string }).hint,
      payload:    logPayload,
    });
    // Don't throw — the Resend send already succeeded and we don't want to
    // re-send next cron tick. But the loud console.error means we'll see
    // the real Postgres error in the function logs instead of silence.
  }
  return body;
}

// ─── Identity helpers — used to dedupe across duplicate signups ───────────
const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
const normPhone = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "");

// Mark every pending, not-yet-emailed signup row for this person (matched by
// exact phone, then exact email) as emailed. Ensures a person who submitted
// the trial form more than once only ever receives ONE abandoned-cart email —
// even if their duplicate rows age in on separate cron runs.
async function markPersonHandled(
  supabase: ReturnType<typeof createClient>,
  row: { email: string | null; phone: string | null },
) {
  const ts = new Date().toISOString();
  if (row.phone) {
    await supabase.from("trial_signups")
      .update({ abandoned_email_sent_at: ts })
      .eq("payment_status", "pending")
      .is("abandoned_email_sent_at", null)
      .eq("phone", row.phone);
  }
  if (row.email) {
    await supabase.from("trial_signups")
      .update({ abandoned_email_sent_at: ts })
      .eq("payment_status", "pending")
      .is("abandoned_email_sent_at", null)
      .eq("email", row.email);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Pending abandoned carts: 10min–14d old, not yet emailed. Oldest first.
    // 2026-06-12: window dropped from 1h → 10min per Justin. Faster touch =
    // higher recovery rate when the lead is still warm. Requires the cron
    // to fire at least every 5 min, which it does via the every-5-min
    // cron-job.org pinger feeding sync-orchestrator.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const { data: candidates, error: queryErr } = await supabase
      .from("trial_signups")
      .select("id, name, email, phone, location_id, created_at")
      .eq("payment_status", "pending")
      .lt("created_at", tenMinAgo)          // older than 10 minutes
      .gt("created_at", fourteenDaysAgo)    // but newer than 14 days (cold-cart cap)
      .is("abandoned_email_sent_at", null)  // not yet emailed
      .order("created_at", { ascending: true })
      .limit(100);

    if (queryErr) {
      console.error("Query error:", queryErr);
      return new Response(
        JSON.stringify({ ok: false, error: queryErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Everyone who has EVER completed a payment — by email and by phone. An
    // abandoned-cart email must never go to someone who already paid, even if
    // they have a separate pending row from filling the trial form twice.
    //
    // TWO SOURCES checked, not one:
    //   1. trial_signups.payment_status = 'completed' (our row's view of truth)
    //   2. stripe_paid_mirror (Stripe's truth — fresher when the webhook
    //      lagged or failed)
    //
    // BACKGROUND: 23 cart-recovery emails went to already-paid customers
    // between May 17 and Jun 2, because trial_signups.payment_status stayed
    // pending for hours after Stripe actually charged the card (webhook
    // gap). Checking the mirror catches everyone the webhook hasn't synced
    // through yet. Belt and suspenders.
    // 2026-09-03 (Justin): a current annual member (stage=member, but no
    // completed PAYMENT row and no Stripe history — desk-sold, MT-billed) got
    // a "finish your $49 trial" email. Two more exclusion sources:
    //   3. anyone whose board stage is already 'member'
    //   4. anyone with a paid membership sale in the MT mirror
    const [paidRowsResult, mirrorResult, memberRowsResult, mtMemberResult] = await Promise.all([
      supabase.from("trial_signups").select("email, phone").eq("payment_status", "completed"),
      supabase.from("stripe_paid_mirror").select("customer_email, customer_phone"),
      supabase.from("trial_signups").select("email, phone").eq("front_desk_stage", "member"),
      supabase.from("mariana_tek_sales").select("customer_email").gt("total_cents", 0)
        .or("item_names.ilike.%membership%,item_names.ilike.%contract%,item_names.ilike.%pif%,item_names.ilike.%month%"),
    ]);

    if (paidRowsResult.error) {
      console.error("Paid-lookup error:", paidRowsResult.error);
      return new Response(
        JSON.stringify({ ok: false, error: paidRowsResult.error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (mirrorResult.error) {
      // Mirror failure isn't fatal — trial_signups is still consulted.
      console.error("Mirror-lookup error (continuing with trial_signups only):", mirrorResult.error.message);
    }

    const paidEmails = new Set<string>();
    const paidPhones = new Set<string>();
    for (const r of paidRowsResult.data ?? []) {
      const e = normEmail(r.email);  if (e) paidEmails.add(e);
      const p = normPhone(r.phone); if (p) paidPhones.add(p);
    }
    for (const m of mirrorResult.data ?? []) {
      const e = normEmail(m.customer_email);  if (e) paidEmails.add(e);
      const p = normPhone(m.customer_phone); if (p) paidPhones.add(p);
    }
    for (const r of memberRowsResult.data ?? []) {
      const e = normEmail(r.email);  if (e) paidEmails.add(e);
      const p = normPhone(r.phone); if (p) paidPhones.add(p);
    }
    for (const r of mtMemberResult.data ?? []) {
      const e = normEmail(r.customer_email); if (e) paidEmails.add(e);
    }
    console.log(
      `Paid-customer guard: ${paidEmails.size} emails + ${paidPhones.size} phones ` +
      `(trial_signups ${paidRowsResult.data?.length ?? 0} + mirror ${mirrorResult.data?.length ?? 0})`
    );

    // Who we've emailed in THIS run — so a person who submitted the form
    // multiple times only ever receives one email.
    const sentEmails = new Set<string>();
    const sentPhones = new Set<string>();

    const results: Array<{ id: string; email: string; ok: boolean; err?: string }> = [];

    for (const row of candidates ?? []) {
      const email = normEmail(row.email);
      const phone = normPhone(row.phone);
      const studio = LOCATION_TO_STUDIO[row.location_id ?? ""];

      // Already a paying customer — never email them.
      if ((email && paidEmails.has(email)) || (phone && paidPhones.has(phone))) {
        results.push({ id: row.id, email: row.email ?? "", ok: false, err: "skipped: already paid" });
        continue;
      }

      // Same person already emailed in this run (duplicate signup). Mark the
      // duplicate row handled so a later run can't email it either.
      if ((email && sentEmails.has(email)) || (phone && sentPhones.has(phone))) {
        await markPersonHandled(supabase, row);
        results.push({ id: row.id, email: row.email ?? "", ok: false, err: "skipped: duplicate signup" });
        continue;
      }

      if (!studio || !row.email) {
        results.push({
          id: row.id,
          email: row.email ?? "",
          ok: false,
          err: !studio ? "unknown location" : "no email",
        });
        continue;
      }

      try {
        await sendEmail(supabase, row.id, studio.slug, row.email, row.name ?? "", studio);
        if (email) sentEmails.add(email);
        if (phone) sentPhones.add(phone);
        // Mark this row AND every other pending row from the same person, so a
        // duplicate signup can never trigger a second email on a later run.
        await markPersonHandled(supabase, row);
        results.push({ id: row.id, email: row.email, ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Send failed for ${row.email}:`, msg);
        results.push({ id: row.id, email: row.email, ok: false, err: msg });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        processed: results.length,
        sent: results.filter(r => r.ok).length,
        skipped: results.filter(r => !r.ok && (r.err ?? "").startsWith("skipped")).length,
        failed: results.filter(r => !r.ok && !(r.err ?? "").startsWith("skipped")).length,
        details: results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Function error:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
