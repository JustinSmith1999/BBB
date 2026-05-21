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
    subject: `${firstName}, your $49 trial is one click away`,
    html: `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f5;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden">
        <tr><td style="background:#d63838;padding:32px;text-align:center">
          <h1 style="margin:0;color:#fff;font-size:28px;letter-spacing:1px">YOU'RE ALMOST IN</h1>
          <p style="margin:8px 0 0;color:#fff;font-size:14px;opacity:0.9">${studio.name.toUpperCase()}</p>
        </td></tr>
        <tr><td style="padding:32px">
          <h2 style="margin:0 0 16px;font-size:22px">Hey ${firstName} 👋</h2>
          <p style="margin:0 0 16px;line-height:1.6;font-size:16px">
            You started signing up for our <strong>2-week unlimited trial</strong> at ${studio.shortName} — but didn't finish at checkout.
          </p>
          <p style="margin:0 0 24px;line-height:1.6;font-size:16px">
            <strong>$49 gets you 14 days of unlimited classes.</strong> No long contract, no pressure. Most people who finish the trial stay because they actually feel the results.
          </p>

          <table cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#d63838;border-radius:6px">
            <a href="${studio.bookingUrl}" style="display:inline-block;padding:16px 32px;color:#fff;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:0.5px">FINISH YOUR TRIAL · $49</a>
          </td></tr></table>

          <p style="margin:32px 0 16px;font-size:15px;line-height:1.6">
            Have questions before you decide? Call us — we actually answer the phone.<br>
            <strong>${studio.phone}</strong>
          </p>

          <p style="margin:24px 0 0;line-height:1.6;font-size:14px;color:#666">
            ${studio.address}, ${studio.city}, NY ${studio.zip}<br>
            See you on the floor.<br>
            — Team ${studio.shortName}
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

You started signing up for our 2-week unlimited trial at ${studio.shortName} but didn't finish at checkout.

$49 gets you 14 days of unlimited classes. No long contract, no pressure.

Finish your trial: ${studio.bookingUrl}

Questions? Call us at ${studio.phone} — we actually answer.

${studio.address}, ${studio.city}, NY ${studio.zip}
— Team ${studio.shortName}`,
  };
}

async function sendEmail(to: string, name: string, studio: typeof LOCATION_TO_STUDIO[string]) {
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
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  return await res.json();
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

    // Pending abandoned carts: 1h–14d old, not yet emailed. Oldest first, so if
    // someone filled the form more than once we act on their first attempt.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const { data: candidates, error: queryErr } = await supabase
      .from("trial_signups")
      .select("id, name, email, phone, location_id, created_at")
      .eq("payment_status", "pending")
      .lt("created_at", oneHourAgo)         // older than 1 hour
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
    const { data: paidRows, error: paidErr } = await supabase
      .from("trial_signups")
      .select("email, phone")
      .eq("payment_status", "completed");

    if (paidErr) {
      console.error("Paid-lookup error:", paidErr);
      return new Response(
        JSON.stringify({ ok: false, error: paidErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const paidEmails = new Set((paidRows ?? []).map(r => normEmail(r.email)).filter(Boolean));
    const paidPhones = new Set((paidRows ?? []).map(r => normPhone(r.phone)).filter(Boolean));

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
        await sendEmail(row.email, row.name ?? "", studio);
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
