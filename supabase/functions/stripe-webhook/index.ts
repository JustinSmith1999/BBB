import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, stripe-signature",
};

// Per-studio routing for paid-trial staff notifications.
// Owners + the per-studio shared mailbox so any front-desk staff sees it too.
const TRIAL_NOTIFY: Record<string, string[]> = {
  "bayside": [
    "carlos@betterbodybootcamp.com",
    "bayside@betterbodybootcamp.com",
  ],
  "fresh-meadows": [
    "carlos@betterbodybootcamp.com",
    "freshmeadows@betterbodybootcamp.com",
  ],
  "williamsburg": [
    "steve@betterbodybootcamp.com",
    "chris@betterbodybootcamp.com",
    "williamsburg@betterbodybootcamp.com",
  ],
  "astoria": [
    "steve@betterbodybootcamp.com",
    "chris@betterbodybootcamp.com",
    "astoria@betterbodybootcamp.com",
  ],
};

// Per-studio cell numbers for staff SMS pings on new paid signups.
// Empty arrays = SMS notify skipped for that studio. Drop E.164 numbers in to
// enable (e.g. "+16315551234"). Front-desk + owner cells go here.
const TRIAL_NOTIFY_PHONES: Record<string, string[]> = {
  "bayside": [],
  "fresh-meadows": [],
  "williamsburg": [],
  "astoria": [],
};

// QA MODE — while Justin vets the full notification suite (trial + comeback,
// staff + customer, email + SMS), every outbound message redirects to these
// addresses. Real recipients (gym inboxes, customer email, customer phone)
// get nothing. The QA copy keeps the would-be recipient in the subject + body
// banner + log so Justin can verify routing before flipping live.
//
// To go live (after approval): set both fields to null.
const QA_OVERRIDE: { email: string | null; phone: string | null } = {
  email: "Justin@J20solutions.com",
  phone: "+16317086585", // Justin's cell
};

// Per-studio sender mailboxes. Resend accepts any address @betterbodybootcamp
// .com because the parent domain is verified — no per-address setup needed.
// Customer-facing confirmation emails come FROM this so replies are personal
// and the mailbox stays the single source of truth per gym.
function studioMailbox(studioSlug: string): string {
  // bayside-foo-bar → baysidefoobar — matches the actual inboxes
  return `${studioSlug.replace(/-/g, "")}@betterbodybootcamp.com`;
}

type Variant = "trial" | "special";

// Variant config: subject lines, customer-facing copy, dollar amount, etc.
// Both $49 trial and $129 comeback share the same checkout path — this just
// flips the labels so the right thing reaches the right inbox/phone.
function variantConfig(variant: Variant) {
  if (variant === "special") {
    return {
      label: "Comeback Offer",
      shortLabel: "Comeback",
      durationLabel: "30 Days",
      priceLabel: "$129",
      headerEmoji: "🔥",
      staffSubject: "🔥 New $129 Comeback Purchase",
      customerSubject: "You're in — your 30-day comeback at Better Body Bootcamp",
      smsIntro: "Welcome back to Better Body Bootcamp",
      smsBody: (firstName: string, studioName: string, studioUrl: string) =>
        `Hi ${firstName}! Welcome back to Better Body Bootcamp ${studioName}. ` +
        `Your 30-day comeback is live — book your first class here: ${studioUrl} ` +
        `So glad to see you again. - BBB`,
      heroHex: "#dc2626", // red-600 (match BBB brand across all variants)
    };
  }
  return {
    label: "Trial",
    shortLabel: "Trial",
    durationLabel: "2 Weeks",
    priceLabel: "$49",
    headerEmoji: "🎉",
    staffSubject: "🎉 New $49 Trial Purchase",
    customerSubject: "You're in — your 2-week trial at Better Body Bootcamp",
    smsIntro: "Welcome to Better Body Bootcamp",
    smsBody: (firstName: string, studioName: string, studioUrl: string) =>
      `Hi ${firstName}! Welcome to Better Body Bootcamp ${studioName}. ` +
      `Your 2-week trial is live — book your first class here: ${studioUrl} ` +
      `Reply with any questions, we're here to help. - BBB`,
    heroHex: "#dc2626", // red-600
  };
}

// ─── Meta Conversions API — server-side Purchase event ──────────────────────
// The browser pixel only ever fires PageView, Lead and InitiateCheckout — it
// never fires Purchase. So Meta records zero conversions, and the dashboard's
// CPP / Funnel% / "Paid Trials" all read zero for every studio. This sends the
// Purchase event server-side the moment Stripe confirms payment: more reliable
// than a browser pixel (can't be ad-blocked, can't be missed on redirect).

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Meta requires PII normalized (trim + lowercase) then SHA-256 hashed.
async function hashPII(raw: string | undefined | null): Promise<string | null> {
  const v = (raw ?? "").trim().toLowerCase();
  return v ? await sha256Hex(v) : null;
}

async function sendMetaPurchaseEvent(
  supabase: ReturnType<typeof createClient>,
  studioSlug: string,
  variant: Variant,
  customer: { name: string; email: string; phone: string },
  stripeSessionId: string,
  valueUsd: number,
  fbp: string,
  fbc: string,
): Promise<void> {
  // Pixel ID + access token live on the studio's meta_accounts row — the same
  // credentials meta-insights-sync uses to read insights.
  const { data: acct, error } = await supabase
    .from("meta_accounts")
    .select("pixel_id, access_token, api_version")
    .eq("studio_slug", studioSlug)
    .maybeSingle();
  if (error || !acct?.pixel_id || !acct?.access_token) {
    console.log(`Meta CAPI skipped for ${studioSlug}: no pixel_id / access_token on file`);
    return;
  }

  // Normalize + hash PII per the CAPI spec. Phone = digits only, no '+'.
  const parts = (customer.name || "").trim().split(/\s+/);
  const firstName = parts[0] || "";
  const lastName = parts.slice(1).join(" ");
  const phoneDigits = (customer.phone || "").replace(/\D/g, "");

  const userData: Record<string, string[] | string> = {};
  const em = await hashPII(customer.email);  if (em) userData.em = [em];
  const ph = await hashPII(phoneDigits);     if (ph) userData.ph = [ph];
  const fn = await hashPII(firstName);       if (fn) userData.fn = [fn];
  const ln = await hashPII(lastName);        if (ln) userData.ln = [ln];
  // fbp / fbc go in PLAIN (not hashed, not arrays) — Meta's strongest signal
  // for matching this server-side Purchase to the ad click that drove it.
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const apiVersion = acct.api_version || "v19.0";
  const body = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000),
      // Stable event_id so a Stripe webhook retry can't double-count, and so
      // Meta can dedupe against any future browser-side Purchase event.
      event_id: `trial_${stripeSessionId}`,
      action_source: "website",
      event_source_url: `https://betterbodybootcamp.com/${variant === "special" ? "special" : "trial"}/${studioSlug}`,
      user_data: userData,
      custom_data: {
        currency: "USD",
        value: valueUsd,
        content_name: variant === "special" ? "30-Day Comeback" : "2-Week Trial",
      },
    }],
    // access_token in the body (not the URL) so it never lands in a request log.
    access_token: acct.access_token,
  };

  const res = await fetch(
    `https://graph.facebook.com/${apiVersion}/${acct.pixel_id}/events`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const respText = await res.text();
  if (!res.ok) {
    console.error(`Meta CAPI Purchase FAILED for ${studioSlug}: HTTP ${res.status} ${respText.slice(0, 300)}`);
  } else {
    console.log(`Meta CAPI Purchase sent for ${studioSlug} ($${valueUsd}): ${respText.slice(0, 200)}`);
  }
}

async function sendTrialEmail(studioSlug: string, variant: Variant, trial: {
  name: string; email: string; phone: string;
  address: string; city: string; zip_code: string;
  country?: string; newsletter_opted_in?: boolean;
  stripe_session_id: string; payment_date: string;
}) {
  // ── Backfill / replay guard ──────────────────────────────────────────
  // 2026-05-31: a Stripe webhook replay sent 13 owner emails at once for
  // historical paid trials (May 15–29). Owners thought 13 new customers had
  // signed up. If the payment is more than 24h old, this is almost certainly
  // a replay or backfill — log it loud and skip the owner notification. Real
  // new-paid-trial emails are <30s after payment.
  try {
    const ageMs = Date.now() - new Date(trial.payment_date).getTime();
    if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) {
      console.warn(`sendTrialEmail SKIPPED — payment_date is ${Math.round(ageMs / 3600000)}h old (replay/backfill suspected). studio=${studioSlug} session=${trial.stripe_session_id}`);
      return;
    }
  } catch (e) {
    console.warn(`sendTrialEmail age check failed (continuing): ${(e as Error).message}`);
  }
  const realRecipients = TRIAL_NOTIFY[studioSlug];
  if (!realRecipients || realRecipients.length === 0) {
    console.log(`No trial notify recipients for studio: ${studioSlug}`);
    return;
  }
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.error("RESEND_API_KEY not set; skipping trial notification email");
    return;
  }
  // QA gate — route to Justin's inbox instead of the actual staff list
  const recipients = QA_OVERRIDE.email ? [QA_OVERRIDE.email] : realRecipients;
  const staffOverrideNotice = QA_OVERRIDE.email
    ? `[QA REDIRECT] This staff alert would have gone to: ${realRecipients.join(", ")}`
    : null;
  const cfg = variantConfig(variant);
  const studioName = studioSlug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const subject = `${cfg.staffSubject} · ${trial.name || "(no name)"} · ${studioName}`;
  const addr = [trial.address, trial.city, trial.zip_code, trial.country].filter(Boolean).join(", ");
  const paidLocal = new Date(trial.payment_date).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const stripeDashUrl = `https://dashboard.stripe.com/payments?text=${encodeURIComponent(trial.stripe_session_id)}`;
  const leadDashUrl = `https://bbbmarketing.netlify.app/?studio=${studioSlug}`;
  const newsletter = trial.newsletter_opted_in ? "Yes ✓" : "No";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
      <div style="background:${cfg.heroHex};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0;margin:-24px -24px 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;opacity:0.9">New ${cfg.priceLabel} ${cfg.label} · ${studioName}</div>
        <h2 style="margin:6px 0 0;font-size:24px;font-weight:800;letter-spacing:-0.02em">${trial.name || "(no name provided)"}</h2>
        <div style="font-size:13px;opacity:0.95;margin-top:4px">${paidLocal}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:20px">
        <tr><td style="padding:8px 0;color:#666;width:140px;border-bottom:1px solid #f0f0f0">Name</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f0f0">${trial.name || "—"}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Email</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><a href="mailto:${trial.email}" style="color:#dc2626;text-decoration:none;font-weight:600">${trial.email || "—"}</a></td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><a href="tel:${trial.phone}" style="color:#dc2626;text-decoration:none;font-weight:600">${trial.phone || "—"}</a></td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Address</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${addr || "(not collected)"}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Studio</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${studioName}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Paid</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${paidLocal}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Source</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">betterbodybootcamp.com/${variant === "special" ? "special" : "trial"}/${studioSlug}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Offer</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${cfg.priceLabel} · ${cfg.durationLabel}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Newsletter opt-in</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${newsletter}</td></tr>
        <tr><td style="padding:8px 0;color:#666">Stripe session</td><td style="padding:8px 0;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:#666;word-break:break-all"><a href="${stripeDashUrl}" style="color:#666;text-decoration:underline">${trial.stripe_session_id}</a></td></tr>
      </table>
      <div style="margin-top:24px;padding:16px;background:#fef3c7;border-radius:8px;border-left:4px solid #d97706">
        <div style="font-size:13px;color:#92400e;font-weight:700;margin-bottom:4px">📞 NEXT STEP</div>
        <div style="font-size:14px;color:#111;line-height:1.5">Call <strong>${trial.name || "the customer"}</strong> at <a href="tel:${trial.phone}" style="color:#dc2626;text-decoration:none;font-weight:600">${trial.phone || ""}</a> today to book their first class. First-class shows are the #1 predictor of trial → monthly conversion.</div>
      </div>
      <div style="margin-top:20px;font-size:12px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:16px">
        BBB Trial Automation · <a href="${leadDashUrl}" style="color:#999">View in dashboard</a>
      </div>
    </div>
  `;
  const text = `${cfg.headerEmoji} NEW ${cfg.priceLabel} ${cfg.label.toUpperCase()} · ${studioName}

${trial.name || "(no name)"}
Email: ${trial.email || "—"}
Phone: ${trial.phone || "—"}
Address: ${addr || "(not collected)"}
Newsletter: ${newsletter}

Paid: ${paidLocal}
Source: betterbodybootcamp.com/${variant === "special" ? "special" : "trial"}/${studioSlug}
Offer: ${cfg.priceLabel} · ${cfg.durationLabel}
Stripe session: ${trial.stripe_session_id}

📞 Call ${trial.phone || "the customer"} today to book their first class.`;
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
        subject: staffOverrideNotice ? `[QA] ${subject}` : subject,
        html: staffOverrideNotice
          ? `<div style="font-family:ui-monospace,SFMono-Regular,monospace;background:#fff7e6;color:#7c4a03;padding:10px 14px;border-radius:6px;font-size:12px;margin:0 auto 16px;max-width:600px">${staffOverrideNotice}</div>${html}`
          : html,
        text: staffOverrideNotice ? `${staffOverrideNotice}\n\n${text}` : text,
        reply_to: trial.email || undefined,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error(`Resend send failed (${r.status}):`, body.slice(0, 400));
    } else {
      const body = await r.json();
      console.log(
        `Trial notify sent to ${recipients.join(", ")} for ${studioSlug}` +
          (staffOverrideNotice ? ` (QA redirect — would have gone to ${realRecipients.join(", ")})` : "") +
          `:`,
        body.id,
      );
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
  variant: Variant,
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
  // Comeback ($129) welcome SMS is disabled per Justin's request (May 27 2026).
  // Email still goes out; just no auto-text on the comeback variant.
  if (variant === "special") {
    console.log(`Welcome SMS skipped — comeback variant disabled (trialSignupId=${trialSignupId})`);
    return;
  }
  const realTo = toE164(trial.phone);
  if (!realTo && !QA_OVERRIDE.phone) {
    console.error(`Welcome SMS skipped — unparseable phone: ${trial.phone}`);
    return;
  }
  // QA override — send to Justin's cell instead of the real customer
  const to = QA_OVERRIDE.phone || realTo!;
  const smsOverridePrefix = QA_OVERRIDE.phone && QA_OVERRIDE.phone !== realTo
    ? `[QA→${realTo ?? "no#"}] `
    : "";
  const firstName = (trial.name || "").trim().split(/\s+/)[0] || "there";
  const studioUrl = `https://betterbodybootcamp.com/schedule/${studioSlug}`;
  const cfg = variantConfig(variant);
  // Single 160-char SMS segment when possible.
  const body = smsOverridePrefix + cfg.smsBody(firstName, studioName, studioUrl);

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
          welcome_sms_sid: respBody?.sid ?? null,
          welcome_sms_last_status: respBody?.status ?? "queued",
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

// ─── Owner notifications ──────────────────────────────────────────────────
// On every paid trial, text every owner of that studio so they can welcome
// the new customer personally. Owner phones live in `location_owners`;
// many studios have multiple owners (Astoria/Williamsburg = Chris + Steve).
// One SMS per owner per signup. Failures are logged, never block anything.
async function notifyOwnersOfSignup(
  locationId: string | null,
  studioName: string,
  variant: Variant,
  trial: { name: string; email: string; phone: string; payment_date?: string },
  supabase: any,
) {
  if (!locationId) return;
  // ── Backfill / replay guard (matches sendTrialEmail) ─────────────────
  // 2026-05-31: lock down owner SMS from any payment older than 24h. A real
  // new paid trial fires within seconds of payment; anything older = replay.
  try {
    if (trial.payment_date) {
      const ageMs = Date.now() - new Date(trial.payment_date).getTime();
      if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) {
        console.warn(`notifyOwnersOfSignup SKIPPED — payment_date is ${Math.round(ageMs / 3600000)}h old (replay/backfill suspected). studio=${studioName}`);
        return;
      }
    }
  } catch (e) {
    console.warn(`notifyOwnersOfSignup age check failed (continuing): ${(e as Error).message}`);
  }
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) {
    console.error("Twilio secrets missing; skipping owner notification SMS");
    return;
  }
  const { data: owners, error } = await supabase
    .from("location_owners")
    .select("owner_name, phone")
    .eq("location_id", locationId)
    .eq("notify_signups", true);
  if (error) { console.error("location_owners lookup failed:", error.message); return; }
  if (!owners || !owners.length) return;

  const priceLabel = variant === "special" ? "$129 comeback" : "$49 trial";
  // Compact, scannable. Phone is tappable on iOS — owners can call from preview.
  const body = `New ${priceLabel} signup · ${studioName}\n` +
               `${trial.name || "(no name)"}\n` +
               `${trial.phone || ""}\n` +
               `${trial.email || ""}`.trimEnd();
  const auth = "Basic " + btoa(`${sid}:${token}`);

  for (const owner of owners) {
    const to = toE164(owner.phone);
    if (!to) { console.error(`Owner notification skipped — bad phone for ${owner.owner_name}: ${owner.phone}`); continue; }
    // QA override: if QA_OVERRIDE.phone is set, redirect all owner texts to
    // that single number too, prefixed with who it was originally for.
    const realTo = to;
    const sendTo = QA_OVERRIDE.phone || realTo;
    const bodyOut = QA_OVERRIDE.phone && QA_OVERRIDE.phone !== realTo
      ? `[QA→${owner.owner_name} ${realTo}] ${body}`
      : body;
    try {
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ From: from, To: sendTo, Body: bodyOut }).toString(),
        },
      );
      const respBody = await r.json();
      if (!r.ok) {
        console.error(`Owner SMS to ${owner.owner_name} (${sendTo}) failed: ${respBody?.message || r.status}`);
      } else {
        console.log(`Owner SMS sent to ${owner.owner_name} (${sendTo}) sid=${respBody?.sid}`);
      }
    } catch (e) {
      console.error(`Owner SMS exception for ${owner.owner_name}:`, (e as Error).message);
    }
  }
}

// Send a branded confirmation email to the customer who just paid. Stripe
// already sends a receipt, but this is the BBB-voiced "you're in, here's
// what's next" email — booking link, what to bring, who to text.
async function sendCustomerConfirmationEmail(
  studioSlug: string,
  studioName: string,
  variant: Variant,
  trial: { name: string; email: string; phone: string },
) {
  if (!trial.email) {
    console.log("Customer confirmation email skipped — no email on record");
    return;
  }
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.error("RESEND_API_KEY not set; skipping customer confirmation email");
    return;
  }
  const cfg = variantConfig(variant);
  const firstName = (trial.name || "").trim().split(/\s+/)[0] || "there";
  const scheduleUrl = `https://betterbodybootcamp.com/schedule/${studioSlug}`;
  const studioInfoUrl = `https://betterbodybootcamp.com/locations/${studioSlug}`;
  const studioMail = studioMailbox(studioSlug);
  const intro = variant === "special"
    ? `Welcome back to Better Body Bootcamp ${studioName}. Your 30-day comeback is locked in.`
    : `Welcome to Better Body Bootcamp ${studioName}. Your 2-week trial is locked in.`;
  const greeting = variant === "special" ? `Welcome back, ${firstName}` : `You're in, ${firstName}`;

  // QA override — route ALL customer confirmations (trial + comeback) to
  // Justin while we vet the flow. Trial and comeback both intercepted.
  const realRecipient = trial.email;
  const recipient = QA_OVERRIDE.email || realRecipient;
  const overrideNotice = QA_OVERRIDE.email && realRecipient !== recipient
    ? `[QA REDIRECT] This customer ${variant === "special" ? "welcome-back" : "welcome"} email would have gone to ${realRecipient}.`
    : null;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#111;background:#fff">
      <div style="background:${cfg.heroHex};color:#fff;padding:28px 28px 24px;text-align:center">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;opacity:0.85;margin-bottom:8px">Better Body Bootcamp · ${studioName}</div>
        <h1 style="margin:0;font-size:28px;font-weight:800;letter-spacing:-0.02em;line-height:1.1">${greeting}.</h1>
      </div>
      <div style="padding:28px">
        <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#222">${intro}</p>
        <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#444">You'll get the most out of this if you book your <strong>first class today</strong>. The schedule updates live — pick a time that fits and we'll see you on the floor.</p>
        <div style="text-align:center;margin:26px 0 28px">
          <a href="${scheduleUrl}" style="background:${cfg.heroHex};color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px;display:inline-block;font-size:15px;letter-spacing:0.01em">Book My First Class →</a>
        </div>
        <div style="background:#fafafa;border:1px solid #eee;border-radius:12px;padding:18px 20px;margin-bottom:22px">
          <div style="font-size:12px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">What you've got</div>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:4px 0;color:#666;width:140px">Offer</td><td style="padding:4px 0;font-weight:600">${cfg.priceLabel} · ${cfg.durationLabel}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Studio</td><td style="padding:4px 0;font-weight:600">${studioName}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Access</td><td style="padding:4px 0">Unlimited classes for the full window</td></tr>
          </table>
        </div>
        <div style="font-size:14px;color:#444;line-height:1.55">
          <p style="margin:0 0 10px"><strong>First class tips:</strong> show up 10 minutes early, wear sneakers, bring water. Coach will get you set up.</p>
          <p style="margin:0 0 10px">Questions? Just reply to this email — it goes straight to your studio.</p>
        </div>
        <div style="border-top:1px solid #eee;margin-top:24px;padding-top:18px;font-size:12px;color:#888;text-align:center">
          <a href="${studioInfoUrl}" style="color:#888;text-decoration:underline">Studio info & directions</a>
          &nbsp;·&nbsp; <a href="${scheduleUrl}" style="color:#888;text-decoration:underline">Class schedule</a>
        </div>
      </div>
    </div>
  `;
  const text = `${greeting}.

${intro}

Book your first class today — schedule updates live:
${scheduleUrl}

What you've got:
- Offer: ${cfg.priceLabel} · ${cfg.durationLabel}
- Studio: ${studioName}
- Access: Unlimited classes for the full window

Tips: show up 10 minutes early, wear sneakers, bring water.

Questions? Reply to this email and it goes straight to your studio.

— Better Body Bootcamp`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // FROM the studio's own mailbox so the customer sees a personal,
        // gym-branded sender. Resend accepts any @betterbodybootcamp.com
        // address because the parent domain is verified.
        from: `Better Body Bootcamp ${studioName} <${studioMail}>`,
        to: [recipient],
        subject: overrideNotice ? `${cfg.customerSubject} [QA TEST]` : cfg.customerSubject,
        html: overrideNotice
          ? `<div style="font-family:ui-monospace,SFMono-Regular,monospace;background:#fff7e6;color:#7c4a03;padding:10px 14px;border-radius:6px;font-size:12px;margin:0 auto 16px;max-width:560px">${overrideNotice}</div>${html}`
          : html,
        text: overrideNotice ? `${overrideNotice}\n\n${text}` : text,
        reply_to: studioMail,
      }),
    });
    if (!r.ok) {
      console.error(`Customer confirmation email failed (${r.status}):`, (await r.text()).slice(0, 400));
    } else {
      const body = await r.json();
      console.log(
        `Customer confirmation email sent to ${recipient}` +
          (overrideNotice ? ` (QA redirect — original: ${realRecipient})` : "") +
          `:`,
        body.id,
      );
    }
  } catch (e) {
    console.error("Customer confirmation email exception:", e);
  }
}

// Ping front-desk / owner cells with a one-liner so they don't have to babysit
// inbox. No-ops cleanly when TRIAL_NOTIFY_PHONES[studio] is empty.
async function sendStaffSms(
  studioSlug: string,
  studioName: string,
  variant: Variant,
  trial: { name: string; phone: string; email: string },
) {
  const realPhones = TRIAL_NOTIFY_PHONES[studioSlug] || [];
  // QA override — bypass the per-studio map and send the staff ping to Justin
  // so he can vet the copy. Once approved, fill in TRIAL_NOTIFY_PHONES.
  const phones = QA_OVERRIDE.phone ? [QA_OVERRIDE.phone] : realPhones;
  if (phones.length === 0) return;
  const staffSmsOverridePrefix = QA_OVERRIDE.phone
    ? `[QA] (would ping ${realPhones.join(", ") || "no#"}) `
    : "";
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) {
    console.error("Twilio secrets missing; skipping staff SMS");
    return;
  }
  const cfg = variantConfig(variant);
  const customerLine = trial.name || trial.email || trial.phone || "(unknown)";
  const body = staffSmsOverridePrefix +
    `${cfg.headerEmoji} New ${cfg.priceLabel} ${cfg.shortLabel} at ${studioName}: ` +
    `${customerLine}${trial.phone ? ` · ${trial.phone}` : ""}. ` +
    `Call today to book class 1. - BBB`;
  const auth = "Basic " + btoa(`${sid}:${token}`);
  for (const to of phones) {
    const e164 = toE164(to);
    if (!e164) {
      console.error(`Staff SMS skipped — unparseable phone: ${to}`);
      continue;
    }
    try {
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ From: from, To: e164, Body: body }).toString(),
        },
      );
      const resp = await r.json();
      if (!r.ok) {
        console.error(`Staff SMS failed for ${e164}: ${resp?.message || `HTTP ${r.status}`}`);
      } else {
        console.log(`Staff SMS sent to ${e164} (sid=${resp?.sid})`);
      }
    } catch (e) {
      console.error("Staff SMS exception:", e);
    }
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

    // ─── Test mode — fire a sample trial-purchase email without Stripe ────
    // Auth: must present SUPABASE_SERVICE_ROLE_KEY as bearer.
    // POST { "test_trial_email": "astoria" | "bayside" | "fresh-meadows" | "williamsburg" }
    let parsedTest: any = null;
    try { parsedTest = JSON.parse(body); } catch {}

    // ─── Admin: audit Stripe vs Supabase trial_signups ───────────────────
    // For every location's Stripe account, lists every PAID Checkout Session
    // since 2026-05-15 and reports any that don't have a matching
    // trial_signups row (by stripe_session_id, with email fallback).
    // POST { "stripe_audit": true }
    // Auth: x-bbb-secret OR service-role bearer.
    if (parsedTest?.stripe_audit) {
      const SHARED_SECRET = Deno.env.get("FUNCTION_SHARED_SECRET") ?? "";
      const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const presentedSecret = req.headers.get("x-bbb-secret") ?? "";
      const presentedBearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const authed =
        (SHARED_SECRET && presentedSecret === SHARED_SECRET) ||
        (SERVICE_ROLE && presentedBearer === SERVICE_ROLE);
      if (!authed) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      const { data: locations } = await supabase
        .from("locations")
        .select("id, name, stripe_secret_key");
      const since = new Date("2026-05-15T00:00:00Z").getTime() / 1000;
      const studios: any[] = [];
      const allMissing: any[] = [];
      for (const loc of (locations ?? [])) {
        const sk = loc.stripe_secret_key;
        if (!sk) { studios.push({ studio: loc.name, error: "no stripe_secret_key" }); continue; }
        try {
          const stripe = new Stripe(sk, { apiVersion: "2024-12-18.acacia" });
          // Pull paid sessions in 100-item pages.
          const sessions: any[] = [];
          let starting_after: string | undefined = undefined;
          for (let page = 0; page < 10; page++) {
            const list = await stripe.checkout.sessions.list({
              limit: 100,
              created: { gte: since },
              starting_after,
            } as any);
            sessions.push(...list.data);
            if (!list.has_more) break;
            starting_after = list.data[list.data.length - 1]?.id;
            if (!starting_after) break;
          }
          // Only PAID + completed sessions.
          const paid = sessions.filter((s: any) => s.payment_status === "paid" || s.status === "complete");
          // Compare against trial_signups.stripe_session_id
          const sessionIds = paid.map((s: any) => s.id);
          const emails = paid.map((s: any) => (s.customer_details?.email || s.customer_email || "").toLowerCase().trim()).filter(Boolean);
          const { data: tsBySession } = await supabase
            .from("trial_signups")
            .select("stripe_session_id, email")
            .in("stripe_session_id", sessionIds);
          const { data: tsByEmail } = await supabase
            .from("trial_signups")
            .select("email, stripe_session_id, payment_status")
            .in("email", emails)
            .eq("payment_status", "completed");
          const haveSession = new Set((tsBySession || []).map((r: any) => r.stripe_session_id));
          const haveEmailPaid = new Set((tsByEmail || []).map((r: any) => (r.email || "").toLowerCase().trim()));
          const missing = paid.filter((s: any) => {
            const e = (s.customer_details?.email || s.customer_email || "").toLowerCase().trim();
            return !haveSession.has(s.id) && (!e || !haveEmailPaid.has(e));
          }).map((s: any) => ({
            stripe_session_id: s.id,
            created: new Date(s.created * 1000).toISOString(),
            amount_total: s.amount_total,
            email: s.customer_details?.email || s.customer_email || null,
            name: s.customer_details?.name || null,
            phone: s.customer_details?.phone || null,
            payment_intent: s.payment_intent,
          }));
          studios.push({
            studio: loc.name,
            paid_sessions_in_stripe: paid.length,
            matched_by_session_id: haveSession.size,
            matched_by_email_fallback: paid.length - haveSession.size - missing.length,
            missing_in_supabase: missing.length,
            missing_rows: missing,
          });
          for (const m of missing) allMissing.push({ studio: loc.name, ...m });
        } catch (e) {
          studios.push({ studio: loc.name, error: (e as Error).message });
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        since: "2026-05-15",
        total_missing: allMissing.length,
        studios,
        all_missing_flat: allMissing,
      }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── Admin: one-shot backfill — insert trial_signups rows for every $49
    // PaymentIntent since launch that doesn't yet have a row. Targets the
    // 14 historical repeat-buyer + Payment-Link customers identified by the
    // stripe_audit_full. Idempotent — checks by PI id before inserting.
    // POST { "stripe_backfill_legacy_pl": true }
    //   { dry_run?: boolean }   default false
    if (parsedTest?.stripe_backfill_legacy_pl) {
      const SHARED_SECRET = Deno.env.get("FUNCTION_SHARED_SECRET") ?? "";
      const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const presentedSecret = req.headers.get("x-bbb-secret") ?? "";
      const presentedBearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const authed =
        (SHARED_SECRET && presentedSecret === SHARED_SECRET) ||
        (SERVICE_ROLE && presentedBearer === SERVICE_ROLE);
      if (!authed) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      const dryRun = !!parsedTest?.dry_run;
      const { data: locations } = await supabase
        .from("locations")
        .select("id, name, stripe_secret_key");
      const since = new Date("2026-05-15T00:00:00Z").getTime() / 1000;
      const studios: any[] = [];
      const inserted: any[] = [];
      const skipped: any[] = [];

      for (const loc of (locations ?? [])) {
        const sk = loc.stripe_secret_key;
        if (!sk) { studios.push({ studio: loc.name, error: "no stripe_secret_key" }); continue; }
        try {
          const stripe = new Stripe(sk, { apiVersion: "2024-12-18.acacia" });

          // 1. List paid checkout sessions in window — their PI ids are
          //    OWNED by the Checkout flow and shouldn't be backfilled.
          const ownedByCheckout = new Set<string>();
          {
            let starting_after: string | undefined = undefined;
            for (let page = 0; page < 10; page++) {
              const list = await stripe.checkout.sessions.list({
                limit: 100,
                created: { gte: since },
                starting_after,
              } as any);
              for (const s of list.data) {
                if ((s.payment_status === "paid" || s.status === "complete") && s.payment_intent) {
                  ownedByCheckout.add(s.payment_intent as string);
                }
              }
              if (!list.has_more) break;
              starting_after = list.data[list.data.length - 1]?.id;
              if (!starting_after) break;
            }
          }

          // 2. List succeeded $49 PIs in window
          const succeededPIs: any[] = [];
          {
            let starting_after: string | undefined = undefined;
            for (let page = 0; page < 20; page++) {
              const list = await stripe.paymentIntents.list({
                limit: 100,
                created: { gte: since },
                starting_after,
                expand: ["data.latest_charge", "data.customer"],
              } as any);
              for (const p of list.data) {
                if (p.status === "succeeded" && Number(p.amount) === 4900) {
                  succeededPIs.push(p);
                }
              }
              if (!list.has_more) break;
              starting_after = list.data[list.data.length - 1]?.id;
              if (!starting_after) break;
            }
          }

          // 3. For each PI NOT owned by Checkout, see if trial_signups already
          //    has a row keyed on its id. If not, insert.
          const studioInserted: any[] = [];
          const studioSkipped: any[] = [];
          for (const pi of succeededPIs) {
            if (ownedByCheckout.has(pi.id)) {
              studioSkipped.push({ pi: pi.id, reason: "owned_by_checkout" });
              continue;
            }
            if ((pi as any).invoice) {
              studioSkipped.push({ pi: pi.id, reason: "subscription_invoice" });
              continue;
            }
            const { data: existing } = await supabase
              .from("trial_signups")
              .select("id")
              .eq("stripe_session_id", pi.id)
              .maybeSingle();
            if (existing) {
              studioSkipped.push({ pi: pi.id, reason: "already_in_supabase", row: existing.id });
              continue;
            }
            const ch  = (pi.latest_charge as any) || null;
            const cust = (pi.customer && typeof pi.customer === "object") ? pi.customer as any : null;
            const email = (ch?.billing_details?.email || pi.receipt_email || cust?.email || null)?.toLowerCase().trim() || null;
            const name  = ch?.billing_details?.name  || cust?.name  || null;
            const phone = ch?.billing_details?.phone || cust?.phone || null;
            const row = {
              name: name || "",
              email: email || "",
              phone: phone || "",
              location_id: loc.id,
              stripe_session_id: pi.id,
              payment_status: "completed",
              payment_date: new Date(pi.created * 1000).toISOString(),
              source_category: "legacy_archived",
            };
            if (dryRun) {
              studioInserted.push({ pi: pi.id, would_insert: row });
              continue;
            }
            const { data: insertedRow, error: insErr } = await supabase
              .from("trial_signups")
              .insert([row])
              .select("id, name, email")
              .single();
            if (insErr) {
              studioSkipped.push({ pi: pi.id, reason: "insert_error", error: insErr.message });
            } else {
              studioInserted.push({ pi: pi.id, row_id: insertedRow.id, name: insertedRow.name, email: insertedRow.email });
            }
          }
          studios.push({
            studio: loc.name,
            total_pis: succeededPIs.length,
            owned_by_checkout: ownedByCheckout.size,
            inserted: studioInserted.length,
            skipped: studioSkipped.length,
            inserted_rows: studioInserted,
            skipped_rows: studioSkipped,
          });
          inserted.push(...studioInserted.map((x) => ({ studio: loc.name, ...x })));
          skipped.push(...studioSkipped.map((x) => ({ studio: loc.name, ...x })));
        } catch (e) {
          studios.push({ studio: loc.name, error: (e as Error).message });
        }
      }

      return new Response(JSON.stringify({
        ok: true,
        dry_run: dryRun,
        total_inserted: inserted.length,
        total_skipped: skipped.length,
        studios,
      }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── Admin: FULL audit — every successful payment in Stripe since launch
    // The standard stripe_audit only walks checkout.sessions. This walks
    // payment_intents.list too, so Payment-Link / raw API / Pancham-era
    // payments that bypassed Checkout still show up. Dedupes by PI id
    // (a session's payment_intent is the same PI that lists from PIs.list).
    // Match against trial_signups by: stripe_session_id, payment_intent id,
    // and email (case-insensitive) as a fallback.
    // POST { "stripe_audit_full": true }
    if (parsedTest?.stripe_audit_full) {
      const SHARED_SECRET = Deno.env.get("FUNCTION_SHARED_SECRET") ?? "";
      const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const presentedSecret = req.headers.get("x-bbb-secret") ?? "";
      const presentedBearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const authed =
        (SHARED_SECRET && presentedSecret === SHARED_SECRET) ||
        (SERVICE_ROLE && presentedBearer === SERVICE_ROLE);
      if (!authed) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      const { data: locations } = await supabase
        .from("locations")
        .select("id, name, stripe_secret_key");
      const since = new Date("2026-05-15T00:00:00Z").getTime() / 1000;
      // Only flag the $49 trial — other charges (memberships, packs, drop-ins
      // from MindBody) live in Stripe too but aren't expected in trial_signups.
      // Optional override: POST { stripe_audit_full: true, amount_cents: 0 }
      // to see every successful payment regardless of amount.
      const onlyAmount = parsedTest?.amount_cents !== undefined ? Number(parsedTest.amount_cents) : 4900;
      const studios: any[] = [];
      const allMissing: any[] = [];
      for (const loc of (locations ?? [])) {
        const sk = loc.stripe_secret_key;
        if (!sk) { studios.push({ studio: loc.name, error: "no stripe_secret_key" }); continue; }
        try {
          const stripe = new Stripe(sk, { apiVersion: "2024-12-18.acacia" });

          // 1. Paid checkout sessions (and the PI they wrap)
          const sessions: any[] = [];
          {
            let starting_after: string | undefined = undefined;
            for (let page = 0; page < 10; page++) {
              const list = await stripe.checkout.sessions.list({
                limit: 100,
                created: { gte: since },
                starting_after,
              } as any);
              sessions.push(...list.data);
              if (!list.has_more) break;
              starting_after = list.data[list.data.length - 1]?.id;
              if (!starting_after) break;
            }
          }
          const paidSessions = sessions.filter((s: any) => s.payment_status === "paid" || s.status === "complete");
          const sessionPI = new Set<string>(paidSessions.map((s: any) => s.payment_intent).filter(Boolean));

          // 2. All payment_intents in the window (succeeded only). Expand both
          //    latest_charge AND customer so we have every fallback for
          //    email/name/phone — billing_details, receipt_email, customer
          //    record. Stripe Link / Apple Pay often leave billing_details
          //    empty but the customer record has the email.
          const intents: any[] = [];
          {
            let starting_after: string | undefined = undefined;
            for (let page = 0; page < 20; page++) {
              const list = await stripe.paymentIntents.list({
                limit: 100,
                created: { gte: since },
                starting_after,
                expand: ['data.latest_charge', 'data.customer'],
              } as any);
              intents.push(...list.data);
              if (!list.has_more) break;
              starting_after = list.data[list.data.length - 1]?.id;
              if (!starting_after) break;
            }
          }
          const succeededPIs = intents.filter((p: any) => p.status === "succeeded");

          // 3. Combine into a single "successful payment" list, deduped by PI.
          //    Checkout-session payments take priority (they have customer email).
          type PayRow = {
            id: string;             // the stripe payment_intent id (canonical)
            created: number;
            amount_cents: number;
            email: string | null;
            name: string | null;
            phone: string | null;
            source: 'checkout' | 'payment_intent';
            session_id: string | null;
          };
          const byPI = new Map<string, PayRow>();
          for (const s of paidSessions) {
            const piId = s.payment_intent as string | null;
            if (!piId) continue;
            byPI.set(piId, {
              id: piId,
              created: s.created,
              amount_cents: Number(s.amount_total || 0),
              email: (s.customer_details?.email || s.customer_email || null)?.toLowerCase().trim() || null,
              name:  s.customer_details?.name || null,
              phone: s.customer_details?.phone || null,
              source: 'checkout',
              session_id: s.id,
            });
          }
          for (const p of succeededPIs) {
            if (byPI.has(p.id)) continue;
            // Cascade of fallbacks: charge billing_details → receipt_email →
            // customer record. Stripe Link / Apple Pay / saved-card flows
            // skip billing_details, but the Customer object always has email.
            const ch  = p.charges?.data?.[0] || (p.latest_charge as any) || null;
            const cust = (p.customer && typeof p.customer === 'object') ? p.customer : null;
            const email = (
              ch?.billing_details?.email ||
              p.receipt_email ||
              cust?.email ||
              null
            )?.toLowerCase().trim() || null;
            const name  = ch?.billing_details?.name  || cust?.name  || null;
            const phone = ch?.billing_details?.phone || cust?.phone || null;
            byPI.set(p.id, {
              id: p.id,
              created: p.created,
              amount_cents: Number(p.amount || 0),
              email,
              name,
              phone,
              source: 'payment_intent',
              session_id: null,
            });
          }

          // 4. Filter to the trial price (or all if amount_cents=0 override).
          const candidates = Array.from(byPI.values())
            .filter(r => onlyAmount === 0 || r.amount_cents === onlyAmount);

          // 5. Match against trial_signups via stripe_session_id, the raw
          //    PI string stored there (some legacy rows have pi_ in that
          //    column), and email fallback.
          const sessionIds = candidates.map(r => r.session_id).filter(Boolean) as string[];
          const piIds      = candidates.map(r => r.id);
          const emails     = candidates.map(r => r.email).filter(Boolean) as string[];
          const { data: tsBySession } = await supabase
            .from("trial_signups")
            .select("stripe_session_id, email")
            .or(`stripe_session_id.in.(${[...sessionIds, ...piIds].map(x => `"${x}"`).join(",")})`)
            .limit(2000);
          const { data: tsByEmail } = await supabase
            .from("trial_signups")
            .select("email, stripe_session_id")
            .in("email", emails)
            .eq("payment_status", "completed");
          const haveSession  = new Set((tsBySession || []).map((r: any) => r.stripe_session_id));
          const haveEmailPaid = new Set((tsByEmail || []).map((r: any) => (r.email || "").toLowerCase().trim()));

          const missing = candidates.filter(r => {
            const sessionHit = (r.session_id && haveSession.has(r.session_id)) || haveSession.has(r.id);
            const emailHit   = !!r.email && haveEmailPaid.has(r.email);
            return !sessionHit && !emailHit;
          }).map(r => ({
            payment_intent: r.id,
            session_id: r.session_id,
            source: r.source,
            created: new Date(r.created * 1000).toISOString(),
            amount_cents: r.amount_cents,
            email: r.email,
            name:  r.name,
            phone: r.phone,
          }));

          // Pass { show_matched: true } to dump every candidate PI grouped by
          // email — fastest way to spot if the same customer was charged twice
          // (the 2:1 Stripe:Supabase ratio investigation).
          const groupedByEmail: Record<string, any[]> = {};
          if (parsedTest?.show_matched) {
            for (const r of candidates) {
              const k = r.email || `(no-email-${r.id.slice(0, 8)})`;
              (groupedByEmail[k] ||= []).push({
                pi: r.id, source: r.source, created: new Date(r.created * 1000).toISOString(), name: r.name,
              });
            }
          }
          const duplicates = Object.entries(groupedByEmail)
            .filter(([_, arr]) => arr.length > 1)
            .map(([email, arr]) => ({ email, count: arr.length, charges: arr }))
            .sort((a, b) => b.count - a.count);

          studios.push({
            studio: loc.name,
            stripe_checkout_paid:        paidSessions.length,
            stripe_succeeded_intents:    succeededPIs.length,
            unique_payments_after_dedupe: byPI.size,
            candidates_for_diff:         candidates.length,
            distinct_emails:             Object.keys(groupedByEmail).length || undefined,
            duplicate_charge_customers:  duplicates.length || undefined,
            duplicate_charges:           parsedTest?.show_matched ? duplicates : undefined,
            amount_filter_cents:         onlyAmount,
            missing_in_supabase:         missing.length,
            missing_rows:                missing,
          });
          for (const m of missing) allMissing.push({ studio: loc.name, ...m });
        } catch (e) {
          studios.push({ studio: loc.name, error: (e as Error).message });
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        since: "2026-05-15",
        amount_filter_cents: onlyAmount,
        note: onlyAmount === 4900
          ? "Filtering to the $49 trial only. Pass {amount_cents:0} to see ALL successful payments."
          : `Filtering to ${onlyAmount}¢ payments.`,
        total_missing: allMissing.length,
        studios,
        all_missing_flat: allMissing,
      }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── Admin: REVERSE audit — Supabase paid rows that Stripe doesn't know
    // For every trial_signups row marked completed since launch, ask the
    // location's current Stripe account whether the session_id resolves.
    // Returns rows split into: confirmed | null_session | not_in_stripe.
    // POST { "stripe_audit_reverse": true }
    if (parsedTest?.stripe_audit_reverse) {
      const SHARED_SECRET = Deno.env.get("FUNCTION_SHARED_SECRET") ?? "";
      const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const presentedSecret = req.headers.get("x-bbb-secret") ?? "";
      const presentedBearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const authed =
        (SHARED_SECRET && presentedSecret === SHARED_SECRET) ||
        (SERVICE_ROLE && presentedBearer === SERVICE_ROLE);
      if (!authed) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      const { data: locations } = await supabase
        .from("locations")
        .select("id, name, stripe_secret_key");
      const locMap: Record<string, { name: string; key: string | null }> = {};
      for (const l of (locations ?? [])) locMap[l.id] = { name: l.name, key: l.stripe_secret_key };

      const { data: rows } = await supabase
        .from("trial_signups")
        .select("id, name, email, phone, payment_date, payment_status, stripe_session_id, location_id, created_at, utm_source, utm_content, front_desk_stage, front_desk_note")
        .eq("payment_status", "completed")
        .gte("created_at", "2026-05-15")
        .order("payment_date", { ascending: false });

      // Pre-fetch MindBody-side data once: map emails → client_id + visit count.
      // The visit query is studio-scoped at lookup time so a person who's a
      // client at studio A but never visited B doesn't get false credit.
      const allEmails = (rows ?? []).map((r: any) => (r.email || "").toLowerCase().trim()).filter(Boolean);
      const { data: mbClients } = await supabase
        .from("mindbody_clients")
        .select("mindbody_id, email, first_name, last_name, status, member_since")
        .in("email", allEmails);
      const mbByEmail: Record<string, any> = {};
      for (const c of (mbClients ?? [])) {
        const k = (c.email || "").toLowerCase().trim();
        if (k) mbByEmail[k] = c;
      }
      const mbIds = (mbClients ?? []).map((c: any) => c.mindbody_id);
      const { data: mbVisits } = await supabase
        .from("mindbody_visits")
        .select("mindbody_client_id, studio_slug, starts_at, signed_in")
        .in("mindbody_client_id", mbIds);
      const visitsByClient: Record<string, { total: number; last: string | null; signed_in: number }> = {};
      for (const v of (mbVisits ?? [])) {
        const k = v.mindbody_client_id;
        if (!visitsByClient[k]) visitsByClient[k] = { total: 0, last: null, signed_in: 0 };
        visitsByClient[k].total++;
        if (v.signed_in) visitsByClient[k].signed_in++;
        if (!visitsByClient[k].last || (v.starts_at && v.starts_at > visitsByClient[k].last!)) visitsByClient[k].last = v.starts_at;
      }

      const out: any = { confirmed: [], null_session: [], not_in_stripe: [], errors: [] };
      for (const r of (rows ?? [])) {
        const loc = locMap[r.location_id];
        const emailKey = (r.email || "").toLowerCase().trim();
        const mb = mbByEmail[emailKey];
        const v = mb ? visitsByClient[mb.mindbody_id] : null;
        const baseEntry = {
          id: r.id,
          name: r.name,
          email: r.email,
          phone: r.phone,
          studio: loc?.name || "?",
          paid_date: r.payment_date,
          signed_up: r.created_at,
          // Where they came from
          utm_source: r.utm_source || null,
          utm_content: r.utm_content || null,
          front_desk_stage: r.front_desk_stage || null,
          front_desk_note: r.front_desk_note || null,
          // MindBody side
          in_mindbody: !!mb,
          mindbody_status: mb?.status || null,
          mindbody_member_since: mb?.member_since || null,
          visit_count: v?.signed_in || 0,
          last_visit_at: v?.last || null,
        };
        if (!r.stripe_session_id) {
          out.null_session.push({ ...baseEntry, stripe_state: "NO_SESSION_ID" });
          continue;
        }
        if (!loc?.key) {
          out.errors.push({ ...baseEntry, error: "location missing stripe_secret_key" });
          continue;
        }
        try {
          const stripe = new Stripe(loc.key, { apiVersion: "2024-12-18.acacia" });
          // Our `stripe_session_id` column historically stored two different
          // things depending on which flow the customer used:
          //   - cs_live_... or cs_test_...  → real Stripe Checkout Session
          //   - pi_...                      → PaymentIntent (Payment Links,
          //                                    direct charges, batch imports)
          // Try the right one based on the prefix.
          const sid = r.stripe_session_id as string;
          let confirmed = false;
          let amount: number | null = null;
          let stripeKind: string | null = null;
          let stripeStatus: string | null = null;
          if (sid.startsWith("cs_")) {
            const s = await stripe.checkout.sessions.retrieve(sid);
            stripeKind = "checkout_session";
            stripeStatus = s.payment_status ?? s.status ?? null;
            if (s && (s.payment_status === "paid" || s.status === "complete")) {
              confirmed = true;
              amount = s.amount_total ?? null;
            }
          } else if (sid.startsWith("pi_")) {
            const pi = await stripe.paymentIntents.retrieve(sid);
            stripeKind = "payment_intent";
            stripeStatus = pi.status ?? null;
            if (pi && pi.status === "succeeded") {
              confirmed = true;
              amount = pi.amount ?? null;
            }
          } else {
            // Some legacy / manual ids (e.g. "manual-henessey-...")
            stripeKind = "unknown_id_format";
          }
          if (confirmed) {
            out.confirmed.push({ ...baseEntry, stripe_state: "PAID_IN_STRIPE", stripe_kind: stripeKind, stripe_amount_cents: amount });
          } else if (stripeKind === "unknown_id_format") {
            out.not_in_stripe.push({ ...baseEntry, stripe_state: "MANUAL_IMPORT_NOT_IN_STRIPE", stripe_kind: stripeKind });
          } else {
            out.not_in_stripe.push({ ...baseEntry, stripe_state: `STRIPE_STATUS_${(stripeStatus || "unknown").toUpperCase()}`, stripe_kind: stripeKind });
          }
        } catch (e) {
          out.not_in_stripe.push({ ...baseEntry, stripe_state: "STRIPE_NOT_FOUND", stripe_error: (e as Error).message.slice(0, 120) });
        }
      }
      const summary = {
        total_paid_in_supabase: (rows ?? []).length,
        confirmed_in_stripe: out.confirmed.length,
        no_stripe_session_id: out.null_session.length,
        not_in_stripe: out.not_in_stripe.length,
        errors: out.errors.length,
      };
      // Sub-summaries — how many of the phantom rows are real MindBody customers?
      const stripeMissing = [...out.null_session, ...out.not_in_stripe];
      const phantomBreakdown = {
        total_phantom: stripeMissing.length,
        in_mindbody: stripeMissing.filter((r: any) => r.in_mindbody).length,
        in_mindbody_with_visits: stripeMissing.filter((r: any) => r.in_mindbody && (r.visit_count || 0) > 0).length,
        ghost_no_mb_no_visits: stripeMissing.filter((r: any) => !r.in_mindbody).length,
      };
      return new Response(JSON.stringify({ ok: true, summary, phantomBreakdown, ...out }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (parsedTest?.test_trial_email) {
      const presentedBearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (!serviceRole || presentedBearer !== serviceRole) {
        return new Response(
          JSON.stringify({ ok: false, error: "unauthorized — provide service-role bearer for test mode" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const studioSlug = String(parsedTest.test_trial_email).toLowerCase();
      // Optional: { variant: 'trial' | 'special' } — defaults to 'trial' for
      // back-compat. Use 'special' to preview the $129 comeback emails.
      const testVariant: Variant = parsedTest.variant === "special" ? "special" : "trial";
      const sample = {
        name: "Test - Justin",
        email: "Justin@j20solutions.com",
        phone: "(631) 708-6585",
        address: "123 Test Avenue",
        city: "New York",
        zip_code: "10001",
        country: "US",
        newsletter_opted_in: true,
        stripe_session_id: "cs_test_SAMPLE_" + Date.now(),
        payment_date: new Date().toISOString(),
      };
      const studioName = studioSlug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      const testSupabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      // Direct Twilio probe — bypass our abstraction so we see the raw error
      // (TF not verified, 10DLC unregistered, bad From number, etc.)
      async function probeTwilio(): Promise<Record<string, unknown>> {
        const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
        const token = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
        const from = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
        const to = QA_OVERRIDE.phone ?? "+16317086585";
        const result: Record<string, unknown> = {
          twilio_sid_present: !!sid,
          twilio_sid_prefix: sid.slice(0, 6),
          twilio_token_present: !!token,
          twilio_from: from || "(unset)",
          to,
        };
        if (!sid || !token || !from) {
          result.error = "Missing one of: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER";
          return result;
        }
        try {
          const r = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
            {
              method: "POST",
              headers: {
                Authorization: "Basic " + btoa(`${sid}:${token}`),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                From: from,
                To: to,
                Body: `[QA probe ${testVariant}] BBB SMS test from stripe-webhook. If you got this, Twilio path is healthy.`,
              }).toString(),
            },
          );
          const json = await r.json().catch(() => ({}));
          result.http_status = r.status;
          result.queued_response = {
            sid: (json as any)?.sid ?? null,
            status: (json as any)?.status ?? null,
            error_code: (json as any)?.error_code ?? null,
            error_message: (json as any)?.error_message ?? null,
          };
          const sid_msg = (json as any)?.sid;
          if (sid_msg) {
            // Wait 6s for Twilio to actually attempt delivery, then GET the
            // message back to read the FINAL status + delivery error (30032
            // = TF unverified, 30034 = 10DLC unregistered, etc.)
            await new Promise((res) => setTimeout(res, 6000));
            try {
              const f = await fetch(
                `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${sid_msg}.json`,
                { headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) } },
              );
              const followup = await f.json().catch(() => ({}));
              result.delivery_check = {
                http_status: f.status,
                status: (followup as any)?.status ?? null,
                error_code: (followup as any)?.error_code ?? null,
                error_message: (followup as any)?.error_message ?? null,
                date_sent: (followup as any)?.date_sent ?? null,
                date_updated: (followup as any)?.date_updated ?? null,
                price: (followup as any)?.price ?? null,
              };
            } catch (e) {
              result.delivery_check_exception = (e as Error).message;
            }
          }
        } catch (e) {
          result.fetch_exception = (e as Error).message;
        }
        // Inspect what's already on the account so we know what to build.
        try {
          const cpr = await fetch(
            "https://trusthub.twilio.com/v1/CustomerProfiles",
            { headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) } },
          );
          const cpjson = await cpr.json().catch(() => ({}));
          const profiles = ((cpjson as any)?.results ?? []);
          result.customer_profiles = await Promise.all(profiles.map(async (p: any) => {
            const out: any = {
              sid: p.sid,
              friendly_name: p.friendly_name,
              status: p.status,
              policy_sid: p.policy_sid,
            };
            // For each profile, fetch its entity assignments + bound items
            // so we can see what business info (EIN, address, rep) is on file.
            try {
              const ea = await fetch(
                `https://trusthub.twilio.com/v1/CustomerProfiles/${p.sid}/EntityAssignments`,
                { headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) } },
              );
              const eajson = await ea.json().catch(() => ({}));
              const assignments = (eajson as any)?.results ?? [];
              out.entity_assignments = await Promise.all(assignments.map(async (a: any) => {
                const item: any = { sid: a.sid, object_sid: a.object_sid };
                // Fetch the bound item (could be EndUser or SupportingDocument)
                if (a.object_sid?.startsWith("IT")) {
                  try {
                    const eu = await fetch(
                      `https://trusthub.twilio.com/v1/EndUsers/${a.object_sid}`,
                      { headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) } },
                    );
                    const euj = await eu.json().catch(() => ({}));
                    item.type = "EndUser";
                    item.friendly_name = (euj as any)?.friendly_name;
                    item.end_user_type = (euj as any)?.type;
                    item.attributes = (euj as any)?.attributes;
                  } catch (_) {}
                } else if (a.object_sid?.startsWith("RD")) {
                  try {
                    const sd = await fetch(
                      `https://trusthub.twilio.com/v1/SupportingDocuments/${a.object_sid}`,
                      { headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) } },
                    );
                    const sdj = await sd.json().catch(() => ({}));
                    item.type = "SupportingDocument";
                    item.friendly_name = (sdj as any)?.friendly_name;
                    item.doc_type = (sdj as any)?.type;
                    item.attributes = (sdj as any)?.attributes;
                    item.status = (sdj as any)?.status;
                  } catch (_) {}
                }
                return item;
              }));
            } catch (e) {
              out.entity_assignments_error = (e as Error).message;
            }
            return out;
          }));
        } catch (e) {
          result.customer_profiles_exception = (e as Error).message;
        }
        try {
          const br = await fetch(
            "https://messaging.twilio.com/v1/a2p/BrandRegistrations",
            { headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) } },
          );
          const bjson = await br.json().catch(() => ({}));
          result.a2p_brand_registrations = ((bjson as any)?.results ?? []).map((b: any) => ({
            sid: b.sid,
            status: b.status,
            brand_score: b.brand_score,
            customer_profile_bundle_sid: b.customer_profile_bundle_sid,
            a2p_profile_bundle_sid: b.a2p_profile_bundle_sid,
            brand_type: b.brand_type,
            failure_reason: b.failure_reason,
            date_created: b.date_created,
          }));
        } catch (e) {
          result.a2p_brand_exception = (e as Error).message;
        }
        try {
          const sr = await fetch(
            "https://messaging.twilio.com/v1/Services",
            { headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) } },
          );
          const sjson = await sr.json().catch(() => ({}));
          result.messaging_services = ((sjson as any)?.services ?? []).map((s: any) => ({
            sid: s.sid,
            friendly_name: s.friendly_name,
            use_case: s.use_case,
          }));
        } catch (e) {
          result.messaging_services_exception = (e as Error).message;
        }
        // ALSO fetch the Toll-Free verification status for this account so we
        // can see exactly where the submission is in Twilio's queue (and read
        // the rejection reason if it was rejected).
        try {
          const tfr = await fetch(
            "https://messaging.twilio.com/v1/Tollfree/Verifications",
            { headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) } },
          );
          const tfjson = await tfr.json().catch(() => ({}));
          const verifications = (tfjson as any)?.verifications ?? [];
          result.tf_verification_status = {
            http_status: tfr.status,
            count: verifications.length,
            list: verifications.map((v: any) => ({
              sid: v.sid,
              status: v.status,                 // PENDING_REVIEW / IN_REVIEW / TWILIO_APPROVED / TWILIO_REJECTED
              business_name: v.business_name,
              tollfree_phone_number_sid: v.tollfree_phone_number_sid,
              rejection_reason: v.rejection_reason,
              date_created: v.date_created,
              date_updated: v.date_updated,
              external_reference_id: v.external_reference_id,
              use_case_categories: v.use_case_categories,
              opt_in_type: v.opt_in_type,
              message_volume: v.message_volume,
            })),
          };
        } catch (e) {
          result.tf_verification_exception = (e as Error).message;
        }
        return result;
      }

      try {
        // Fire all 4 notifications. QA_OVERRIDE intercepts every one to Justin's
        // email + cell so nothing actually reaches gyms or customers.
        await sendTrialEmail(studioSlug, testVariant, sample);
        await sendCustomerConfirmationEmail(
          studioSlug,
          studioName,
          testVariant,
          { name: sample.name, email: sample.email, phone: sample.phone },
        );
        await sendStaffSms(studioSlug, studioName, testVariant, {
          name: sample.name, phone: sample.phone, email: sample.email,
        });
        await sendTrialWelcomeSms(
          studioSlug,
          studioName,
          testVariant,
          { name: sample.name, phone: sample.phone },
          testSupabase,
          // Fake UUID — .update() will silently no-op on no match
          "00000000-0000-0000-0000-000000000000",
        );
        const twilioDiag = await probeTwilio();
        return new Response(
          JSON.stringify({
            ok: true,
            mode: "test",
            studio: studioSlug,
            variant: testVariant,
            qa_override: QA_OVERRIDE,
            would_have_emailed_staff: TRIAL_NOTIFY[studioSlug] ?? [],
            would_have_emailed_customer: sample.email,
            would_have_texted_customer: sample.phone,
            would_have_texted_staff: TRIAL_NOTIFY_PHONES[studioSlug] ?? [],
            actually_sent_to: {
              email: QA_OVERRIDE.email,
              phone: QA_OVERRIDE.phone,
            },
            twilio_probe: twilioDiag,
            note: "Emails + SMS fired. twilio_probe shows raw Twilio API response so we can see why SMS may be silently dropping.",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ ok: false, mode: "test", studio: studioSlug, error: (e as Error).message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

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
      .select("stripe_secret_key, stripe_webhook_secret, gohighlevel_webhook_url, gohighlevel_api_key, name")
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

    // ─── STRICT signature verification (Fix #1) ─────────────────────────
    // Previously this fell through to parsedBody when either the secret or the
    // signature header was missing, allowing forged checkout.session.completed
    // events to trigger emails/SMS/lead conversions. Now we reject loudly.
    if (!location.stripe_webhook_secret) {
      console.error("BLOCKED: location.stripe_webhook_secret is NULL for locationId", locationId);
      return new Response(
        JSON.stringify({
          received: false,
          error: "stripe_webhook_secret not configured for this location — refusing to process unsigned event",
          locationId,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!signature) {
      console.error("BLOCKED: missing stripe-signature header for locationId", locationId);
      return new Response(
        JSON.stringify({ received: false, error: "missing stripe-signature header" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    try {
      event = stripe.webhooks.constructEvent(
        body,
        signature,
        location.stripe_webhook_secret,
      );
    } catch (err) {
      console.error("BLOCKED: webhook signature verification failed for locationId", locationId, (err as Error).message);
      return new Response(
        JSON.stringify({ received: false, error: "invalid signature" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Received Stripe event:", event.type, "for location:", locationId);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = session.metadata || {};

      // Variant flows through Checkout metadata. 'special' = $129 comeback,
      // everything else (including missing) defaults to the $49 trial path.
      const variant: Variant = metadata.priceVariant === "special" ? "special" : "trial";

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
        // UTM tags — used only by the fallback INSERT below. The normal path
        // UPDATEs the pending row, which already carries UTMs from checkout.
        utm_source: metadata.utm_source || null,
        utm_medium: metadata.utm_medium || null,
        utm_campaign: metadata.utm_campaign || null,
        utm_content: metadata.utm_content || null,
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
        studioSlug = (location?.name ?? locRow?.name ?? "").toLowerCase().replace(/\s+/g, "-");
        if (trialData.email && studioSlug) {
          // Fix #6: scope by studio_slug so multi-studio leads don't cross-flip
          const { error: leadErr } = await supabase
            .from("leads")
            .update({
              stage: "converted",
              studio_slug: studioSlug,
              last_touch_at: new Date().toISOString(),
            })
            .eq("email", trialData.email)
            .eq("studio_slug", studioSlug);
          if (leadErr) console.error("lead convert update failed:", leadErr.message);
        }
      } catch (e) {
        console.error("lead convert exception:", e);
      }

      const studioName = (location?.name as string) ||
        studioSlug
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");

      // ─── Staff email via Resend (variant-aware copy + subject) ───────────
      try {
        await sendTrialEmail(studioSlug, variant, trialData);
      } catch (e) {
        console.error("trial notify email exception:", e);
      }

      // ─── Customer confirmation email via Resend ──────────────────────────
      // Branded "you're in / welcome back" with booking CTA and tips. Stripe's
      // receipt is plain — this is the BBB-voiced one.
      try {
        await sendCustomerConfirmationEmail(
          studioSlug,
          studioName,
          variant,
          { name: trialData.name, email: trialData.email, phone: trialData.phone },
        );
      } catch (e) {
        console.error("customer confirmation email exception:", e);
      }

      // ─── Meta Conversions API — server-side Purchase event ───────────────
      // Reports the conversion to Meta so the dashboard's CPP / Funnel% / Paid
      // Trials stop reading zero. Uses the real amount Stripe charged.
      try {
        const purchaseValue = session.amount_total
          ? session.amount_total / 100
          : (variant === "special" ? 129 : 49);
        await sendMetaPurchaseEvent(
          supabase,
          studioSlug,
          variant,
          { name: trialData.name, email: trialData.email, phone: trialData.phone },
          session.id,
          purchaseValue,
          metadata.fbp || "",
          metadata.fbc || "",
        );
      } catch (e) {
        console.error("Meta CAPI purchase exception:", e);
      }

      // ─── Staff SMS pings via Twilio (no-op if no numbers configured) ─────
      try {
        await sendStaffSms(studioSlug, studioName, variant, {
          name: trialData.name,
          phone: trialData.phone,
          email: trialData.email,
        });
      } catch (e) {
        console.error("staff SMS exception:", e);
      }

      // ─── Welcome SMS to the new customer via Twilio (variant-aware) ──────
      // Friendly intro + per-studio booking link. Logs delivery on the row.
      if (data && data[0]) {
        try {
          await sendTrialWelcomeSms(
            studioSlug,
            studioName,
            variant,
            { name: trialData.name, phone: trialData.phone },
            supabase,
            data[0].id,
          );
        } catch (e) {
          console.error("welcome SMS exception:", e);
        }
      }

      // ─── Owner notification SMS — one per owner of this studio ─────────
      // Carlos gets Bayside + Fresh Meadows. Chris + Steve each get a copy
      // on Astoria + Williamsburg. List lives in public.location_owners.
      try {
        await notifyOwnersOfSignup(
          locationId,
          studioName,
          variant,
          { name: trialData.name, email: trialData.email, phone: trialData.phone, payment_date: trialData.payment_date },
          supabase,
        );
      } catch (e) {
        console.error("owner notification SMS exception:", e);
      }

      if (data && data[0] && location.gohighlevel_webhook_url) {
        const trialSignupId = data[0].id;
        // Fix #10: wrap in EdgeRuntime.waitUntil so the runtime doesn't tear
        // down the function before the async work completes.
        const ghlTask = (async () => {
          try {
            await sendToGoHighLevel(
              location.gohighlevel_webhook_url,
              location.gohighlevel_api_key,
              trialData,
              trialSignupId,
              supabase,
            );
          } catch (ghlError) {
            console.error("GoHighLevel webhook error (non-blocking):", ghlError);
          }
        })();
        // @ts-ignore — EdgeRuntime is provided by Supabase edge runtime
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
          // @ts-ignore
          EdgeRuntime.waitUntil(ghlTask);
        } else {
          // Local dev fallback — await directly so dev tests don't lose the task
          await ghlTask;
        }
      }
    }

    // ─── payment_intent.succeeded — covers raw Payment Link / API flows ──
    // Legacy Stripe Payment Links and direct PaymentIntent API charges don't
    // fire checkout.session.completed. We want those $49 trials in the
    // dashboard too. Key rules:
    //   1. Only act on $49 payments (skip memberships, packs, etc.)
    //   2. Skip if the PI already belongs to a Checkout Session — the
    //      session.completed handler above will deal with it.
    //   3. Skip if we already wrote a trial_signups row keyed on this PI id
    //      (idempotent — Stripe may resend webhooks).
    //   4. Insert a fresh row per PI so returning customers get counted
    //      every time they pay, never silently merged into an old row.
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      const amount = Number(pi.amount || 0);
      if (amount !== 4900) {
        // Not the $49 trial — log and ignore. Memberships and packs land
        // here too; they shouldn't create trial_signups rows.
        console.log(`PI ${pi.id} succeeded for ${amount}¢ — not a trial, skipping`);
      } else if (pi.invoice || (pi as any).checkout_session) {
        // Part of a subscription invoice or a Checkout Session — already
        // handled elsewhere (or doesn't belong in trial_signups).
        console.log(`PI ${pi.id} belongs to invoice/checkout — skipping (already handled)`);
      } else {
        // Idempotency check — have we already written a row keyed on this PI?
        // We store the PI id in stripe_session_id for these rows so the
        // existing audit/dedupe logic finds them.
        const { data: existing } = await supabase
          .from("trial_signups")
          .select("id")
          .eq("stripe_session_id", pi.id)
          .maybeSingle();
        if (existing) {
          console.log(`PI ${pi.id} already has trial_signups row ${existing.id} — skipping`);
        } else {
          // Pull customer details — same cascade the audit uses.
          let email: string | null = null;
          let name:  string | null = null;
          let phone: string | null = null;
          try {
            const expanded = await stripe.paymentIntents.retrieve(pi.id, {
              expand: ["latest_charge", "customer"],
            });
            const ch  = (expanded.latest_charge as any) || null;
            const cust = (expanded.customer && typeof expanded.customer === "object") ? expanded.customer as any : null;
            email = (ch?.billing_details?.email || expanded.receipt_email || cust?.email || null)?.toLowerCase().trim() || null;
            name  = ch?.billing_details?.name  || cust?.name  || null;
            phone = ch?.billing_details?.phone || cust?.phone || null;
          } catch (e) {
            console.error("PI expand failed:", (e as Error).message);
          }
          const { data: inserted, error: piInsertErr } = await supabase
            .from("trial_signups")
            .insert([{
              name: name || "",
              email: email || "",
              phone: phone || "",
              location_id: locationId,
              stripe_session_id: pi.id,  // PI id stored here so audit dedupes
              payment_status: "completed",
              payment_date: new Date(pi.created * 1000).toISOString(),
              source_category: "legacy_archived",  // tag so dashboard can include/exclude
            }])
            .select();
          if (piInsertErr) {
            console.error("PI insert failed:", piInsertErr.message);
          } else {
            console.log(`Inserted trial_signups for PI ${pi.id}:`, inserted?.[0]?.id);
          }
        }
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
