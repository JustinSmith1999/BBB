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
      heroHex: "#b45309", // amber-700 (matches comeback page badge)
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

async function sendTrialEmail(studioSlug: string, variant: Variant, trial: {
  name: string; email: string; phone: string;
  address: string; city: string; zip_code: string;
  country?: string; newsletter_opted_in?: boolean;
  stripe_session_id: string; payment_date: string;
}) {
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
            note: "All 4 notifications queued. QA_OVERRIDE intercepts to Justin only.",
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
