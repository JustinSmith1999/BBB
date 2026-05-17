import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, stripe-signature",
};

// Per-studio routing for paid-trial staff notifications
const TRIAL_NOTIFY: Record<string, string[]> = {
  "bayside": ["carlos@betterbodybootcamp.com"],
  "fresh-meadows": ["carlos@betterbodybootcamp.com"],
  "williamsburg": ["steve@betterbodybootcamp.com", "chris@betterbodybootcamp.com"],
  "astoria": ["steve@betterbodybootcamp.com", "chris@betterbodybootcamp.com"],
};

async function sendTrialEmail(studioSlug: string, trial: {
  name: string; email: string; phone: string;
  address: string; city: string; zip_code: string;
  stripe_session_id: string; payment_date: string;
}) {
  const recipients = TRIAL_NOTIFY[studioSlug];
  if (!recipients || recipients.length === 0) {
    console.log(`No trial notify recipients for studio: ${studioSlug}`);
    return;
  }
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.error("RESEND_API_KEY not set; skipping trial notification email");
    return;
  }
  const studioName = studioSlug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const subject = `New $49 Trial Purchase · ${trial.name} · ${studioName}`;
  const addr = [trial.address, trial.city, trial.zip_code].filter(Boolean).join(", ");
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
      <h2 style="margin:0 0 4px;font-size:20px;letter-spacing:-0.01em">New $49 Trial Purchase</h2>
      <div style="color:#666;font-size:13px;margin-bottom:20px">${studioName} · ${new Date(trial.payment_date).toLocaleString("en-US",{timeZone:"America/New_York"})}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#666;width:110px">Name</td><td style="padding:6px 0;font-weight:600">${trial.name || "—"}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0"><a href="mailto:${trial.email}" style="color:#0066cc;text-decoration:none">${trial.email}</a></td></tr>
        <tr><td style="padding:6px 0;color:#666">Phone</td><td style="padding:6px 0"><a href="tel:${trial.phone}" style="color:#0066cc;text-decoration:none">${trial.phone || "—"}</a></td></tr>
        <tr><td style="padding:6px 0;color:#666">Address</td><td style="padding:6px 0">${addr || "—"}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Stripe</td><td style="padding:6px 0;font-family:ui-monospace,monospace;font-size:12px;color:#666">${trial.stripe_session_id}</td></tr>
      </table>
      <p style="font-size:13px;color:#666;margin:24px 0 0">Reach out today to book their first class.</p>
    </div>
  `;
  const text = `New $49 Trial Purchase · ${studioName}\n\n${trial.name}\n${trial.email}\n${trial.phone}\n${addr}\n\nPaid: ${trial.payment_date}\nStripe: ${trial.stripe_session_id}`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "BBB Trials <trials@betterbodybootcamp.com>",
        to: recipients,
        subject,
        html,
        text,
        reply_to: trial.email || undefined,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error(`Resend send failed (${r.status}):`, body.slice(0, 400));
    } else {
      const body = await r.json();
      console.log(`Trial notify sent to ${recipients.join(", ")} for ${studioSlug}:`, body.id);
    }
  } catch (e) {
    console.error("Resend send exception:", e);
  }
}

// Normalize a user-typed phone to E.164 (US default). Returns null if unusable.
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length >= 8 && raw.trim().startsWith("+")) return "+" + digits;
  return null;
}

async function sendTrialWelcomeSms(
  studioSlug: string,
  studioName: string,
  trial: { name: string; phone: string },
  supabase: any,
  trialSignupId: string,
) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) {
    console.error("Twilio secrets missing; skipping welcome SMS");
    return;
  }
  const to = toE164(trial.phone);
  if (!to) {
    console.error(`Welcome SMS skipped — unparseable phone: ${trial.phone}`);
    return;
  }
  const firstName = (trial.name || "").trim().split(/\s+/)[0] || "there";
  const studioUrl = `https://betterbodybootcamp.com/locations/${studioSlug}`;
  // Single 160-char SMS segment when possible.
  const body =
    `Hi ${firstName}! Welcome to Better Body Bootcamp ${studioName}. ` +
    `Your 2-week trial is live — book your first class here: ${studioUrl} ` +
    `Reply with any questions, we're here to help. - BBB`;

  const auth = "Basic " + btoa(`${sid}:${token}`);
  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
      },
    );
    const respBody = await r.json();
    if (!r.ok) {
      const msg = respBody?.message || `HTTP ${r.status}`;
      console.error(`Welcome SMS failed for ${to}: ${msg}`);
      await supabase
        .from("trial_signups")
        .update({ welcome_sms_error: String(msg).slice(0, 500) })
        .eq("id", trialSignupId);
    } else {
      console.log(`Welcome SMS sent to ${to} (sid=${respBody?.sid})`);
      await supabase
        .from("trial_signups")
        .update({
          welcome_sms_sent_at: new Date().toISOString(),
          welcome_sms_error: null,
        })
        .eq("id", trialSignupId);
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error("Welcome SMS exception:", msg);
    await supabase
      .from("trial_signups")
      .update({ welcome_sms_error: msg.slice(0, 500) })
      .eq("id", trialSignupId);
  }
}

async function sendToGoHighLevel(
  webhookUrl: string,
  apiKey: string | null,
  trialData: any,
  trialSignupId: string,
  supabase: any,
  retryCount = 0
) {
  const maxRetries = 3;
  const payload = {
    eventType: "trial_signup_completed",
    customer: {
      name: trialData.name,
      email: trialData.email,
      phone: trialData.phone,
      address: trialData.address,
      city: trialData.city,
      zipCode: trialData.zip_code,
      country: trialData.country,
    },
    metadata: {
      locationId: trialData.location_id,
      stripeSessionId: trialData.stripe_session_id,
      paymentStatus: trialData.payment_status,
      paymentDate: trialData.payment_date,
      newsletterOptedIn: trialData.newsletter_opted_in,
      trialSignupId: trialSignupId,
    },
    timestamp: new Date().toISOString(),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    console.log(`Sending to GoHighLevel (attempt ${retryCount + 1}):`, webhookUrl);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`GoHighLevel webhook failed with status: ${response.status}`);
    }

    const responseText = await response.text();
    console.log("GoHighLevel webhook success:", responseText);

    await supabase
      .from("trial_signups")
      .update({
        gohighlevel_sent: true,
        gohighlevel_sent_at: new Date().toISOString(),
        gohighlevel_error: null,
      })
      .eq("id", trialSignupId);

    return true;
  } catch (error) {
    console.error(`GoHighLevel webhook error (attempt ${retryCount + 1}):`, error);

    if (retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000;
      console.log(`Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendToGoHighLevel(webhookUrl, apiKey, trialData, trialSignupId, supabase, retryCount + 1);
    }

    await supabase
      .from("trial_signups")
      .update({
        gohighlevel_sent: false,
        gohighlevel_error: error.message || "Unknown error",
        gohighlevel_retry_count: retryCount + 1,
      })
      .eq("id", trialSignupId);

    throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const signature = req.headers.get("stripe-signature");
    const body = await req.text();

    let event: Stripe.Event;
    let locationId: string | undefined;

    const parsedBody = JSON.parse(body);
    const sessionData = parsedBody?.data?.object;
    locationId = sessionData?.metadata?.locationId;

    if (!locationId) {
      console.log("No locationId in webhook payload - acknowledging event:", parsedBody.type);
      return new Response(
        JSON.stringify({ received: true, note: "No locationId found" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: location, error: locationError } = await supabase
      .from("locations")
      .select("stripe_secret_key, stripe_webhook_secret, gohighlevel_webhook_url, gohighlevel_api_key")
      .eq("id", locationId)
      .maybeSingle();

    if (locationError || !location) {
      console.log("Location not found:", locationId, "- acknowledging event");
      return new Response(
        JSON.stringify({ received: true, note: "Location not found" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!location.stripe_secret_key) {
      console.log("Stripe credentials not configured for location:", locationId, "- acknowledging event");
      return new Response(
        JSON.stringify({ received: true, note: "Stripe credentials not configured" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const stripe = new Stripe(location.stripe_secret_key, {
      apiVersion: "2024-12-18.acacia",
    });

    if (location.stripe_webhook_secret && signature) {
      try {
        event = stripe.webhooks.constructEvent(
          body,
          signature,
          location.stripe_webhook_secret
        );
      } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return new Response(
          JSON.stringify({ received: true, note: "Invalid signature" }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    } else {
      event = parsedBody;
    }

    console.log("Received Stripe event:", event.type, "for location:", locationId);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = session.metadata || {};

      const trialData = {
        name: metadata.customerName || "",
        email: session.customer_email || metadata.email || "",
        phone: metadata.customerPhone || "",
        address: metadata.address || "",
        city: metadata.city || "",
        zip_code: metadata.zipCode || "",
        country: metadata.country || "US",
        newsletter_opted_in: metadata.newsletter === "true",
        location_id: metadata.locationId || null,
        stripe_session_id: session.id,
        payment_status: "completed",
        payment_date: new Date().toISOString(),
      };

      // First try to UPDATE the pending row created by create-trial-checkout
      // (matched by stripe_session_id). Falls back to INSERT if no pending
      // row exists (handles external Stripe checkouts).
      const { data: updated, error: updateError } = await supabase
        .from("trial_signups")
        .update({
          payment_status: "completed",
          payment_date: trialData.payment_date,
          name: trialData.name || undefined,
          email: trialData.email || undefined,
          phone: trialData.phone || undefined,
          address: trialData.address || undefined,
          city: trialData.city || undefined,
          zip_code: trialData.zip_code || undefined,
          newsletter_opted_in: trialData.newsletter_opted_in,
        })
        .eq("stripe_session_id", session.id)
        .select();

      let data = updated;
      let dbError = updateError;

      if (!dbError && (!data || data.length === 0)) {
        const { data: inserted, error: insertError } = await supabase
          .from("trial_signups")
          .insert([trialData])
          .select();
        data = inserted;
        dbError = insertError;
      }

      if (dbError) {
        console.error("Database error:", dbError);
        return new Response(
          JSON.stringify({
            received: true,
            note: "Database error logged",
            error: dbError.message,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      console.log("Trial signup saved:", data);

      // ─── Mirror to BBB ERP leads table ───────────────────────────────────
      // Lead was inserted into `leads` with stage='pending_checkout' when the
      // form submitted. Now that the trial is paid, flip stage='converted' so
      // the dashboard's per-studio "trials purchased" metric and win-back
      // automation both see the up-to-date status.
      let studioSlug = "";
      try {
        const { data: locRow } = await supabase
          .from("locations")
          .select("name")
          .eq("id", metadata.locationId)
          .maybeSingle();
        studioSlug = (locRow?.name ?? "").toLowerCase().replace(/\s+/g, "-");
        if (trialData.email) {
          const { error: leadErr } = await supabase
            .from("leads")
            .update({
              stage: "converted",
              studio_slug: studioSlug || null,
              last_touch_at: new Date().toISOString(),
            })
            .eq("email", trialData.email);
          if (leadErr) console.error("lead convert update failed:", leadErr.message);
        }
      } catch (e) {
        console.error("lead convert exception:", e);
      }

      // ─── Fire off staff notification email via Resend ────────────────────
      // Routes to per-studio recipients defined in TRIAL_NOTIFY at top of file.
      try {
        await sendTrialEmail(studioSlug, trialData);
      } catch (e) {
        console.error("trial notify email exception:", e);
      }

      // ─── Welcome SMS to the new trial member via Twilio ──────────────────
      // Friendly intro + per-studio booking link. Logs delivery on the row.
      if (data && data[0]) {
        try {
          const studioName = (location?.name as string) ||
            studioSlug
              .split("-")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" ");
          await sendTrialWelcomeSms(
            studioSlug,
            studioName,
            { name: trialData.name, phone: trialData.phone },
            supabase,
            data[0].id,
          );
        } catch (e) {
          console.error("welcome SMS exception:", e);
        }
      }

      if (data && data[0] && location.gohighlevel_webhook_url) {
        const trialSignupId = data[0].id;

        (async () => {
          try {
            await sendToGoHighLevel(
              location.gohighlevel_webhook_url,
              location.gohighlevel_api_key,
              trialData,
              trialSignupId,
              supabase
            );
          } catch (ghlError) {
            console.error("GoHighLevel webhook error (non-blocking):", ghlError);
          }
        })();
      }
    }

    return new Response(
      JSON.stringify({ received: true }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(
      JSON.stringify({
        received: true,
        note: "Error logged",
        error: error.message || "Internal server error",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
