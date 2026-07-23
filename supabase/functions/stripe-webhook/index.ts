import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Pinned EXACT — do NOT use ^ or ~. A 17.x point release on 6/1/2026 hardened
// the Node-only sync constructEvent path, which silently broke our webhook for
// 4 days. Auto-upgrade on the Stripe SDK is forbidden in this repo.
import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, stripe-signature",
};

// ─────────────────────────────────────────────────────────────────────────────
// SEND-PATH ALLOWLIST (2026-06-01 — Justin's seatbelt rule)
//
// Every customer-facing or owner-facing send goes through this gate. The env
// var BBB_SEND_PATHS_ENABLED is a comma-separated list of path names. A path
// only fires if its name appears in the list. New send paths default to OFF.
//
// To turn a path on: Supabase Dashboard → Edge Functions → stripe-webhook →
//   Settings → Edit BBB_SEND_PATHS_ENABLED, add the name, save. No deploy.
//
// Current paths (these names are the ONLY contract — don't rename without
// updating the env var):
//   stripe_owner_email           → sendTrialEmail        (paid trial → studio inbox)
//   stripe_owner_sms             → notifyOwnersOfSignup  (paid trial → owner cell)
//   stripe_customer_welcome_email→ sendCustomerConfirmationEmail (paid trial → customer)
//   stripe_customer_welcome_sms  → sendTrialWelcomeSms   (paid trial → customer)
//
// If the env var is missing, the default-on set is the bare minimum Justin
// approved: customer welcome email + owner SMS. Everything else is off.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_ENABLED_PATHS = "stripe_owner_sms,stripe_customer_welcome_email";
function isSendPathEnabled(pathName: string): boolean {
  const raw = Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? DEFAULT_ENABLED_PATHS;
  const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return set.has(pathName);
}

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

// QA MODE — DISABLED 2026-06-02 by Justin after Funnel Health dashboard
// proved 65 of 69 paid customers ($3,185 in revenue) got no welcome since
// May 15 launch. The dual gate (BBB_SMS_AUTO_SEND_ENABLED + per-path
// BBB_SEND_PATHS_ENABLED) is the only protection now. Both must be set
// correctly for any send to leave the server.
//
// To return to QA mode (e.g. testing changes): set email/phone to a
// known-safe address/number again.
const QA_OVERRIDE: { email: string | null; phone: string | null } = {
  email: null,
  phone: null,
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
  // 2026-06-05: client_ip_address + client_user_agent are critical Meta CAPI
  // match-quality signals. Without them, Meta receives the event (HTTP 200)
  // but can't tie it back to an ad click, so the conversion goes unattributed.
  // Bayside symptom: $372 spend / 8 days / 0 attributed purchases despite
  // real paid trials. Captured at form-fill time and stored on trial_signups.
  clientIp: string,
  clientUserAgent: string,
): Promise<void> {
  // ── Permanent monitoring helper ──────────────────────────────────────────
  // Justin called out the recurring "CAPI silently broken for weeks" pattern.
  // Every attempt — success OR failure — now writes a row to capi_events so
  // the failure mode "nobody reads the function logs" is gone. Best-effort;
  // logging itself never blocks the webhook.
  const eventId = `trial_${stripeSessionId}`;
  const logAttempt = async (fields: {
    ok: boolean;
    pixel_id?: string | null;
    http_status?: number | null;
    meta_event_id?: string | null;
    error?: string | null;
    raw?: unknown;
  }) => {
    try {
      await supabase.from("capi_events").insert({
        studio_slug: studioSlug,
        pixel_id: fields.pixel_id ?? null,
        event_name: "Purchase",
        event_id: eventId,
        value_usd: valueUsd,
        ok: fields.ok,
        http_status: fields.http_status ?? null,
        meta_event_id: fields.meta_event_id ?? null,
        error: fields.error ?? null,
        raw: fields.raw ? (fields.raw as Record<string, unknown>) : null,
      });
    } catch (e) {
      console.error("capi_events insert failed:", (e as Error).message);
    }
  };

  // Pixel ID + access token live on the studio's meta_accounts row — the same
  // credentials meta-insights-sync uses to read insights.
  const { data: acct, error } = await supabase
    .from("meta_accounts")
    .select("pixel_id, access_token, api_version")
    .eq("studio_slug", studioSlug)
    .maybeSingle();
  if (error || !acct?.pixel_id || !acct?.access_token) {
    const reason = error
      ? `meta_accounts lookup error: ${error.message}`
      : !acct
      ? "no meta_accounts row for studio"
      : !acct.pixel_id
      ? "meta_accounts.pixel_id is NULL — run 20260601_populate_meta_pixel_ids.sql"
      : "meta_accounts.access_token is NULL/empty";
    console.log(`Meta CAPI skipped for ${studioSlug}: ${reason}`);
    await logAttempt({ ok: false, error: reason, pixel_id: acct?.pixel_id ?? null });
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
  // client_ip_address + client_user_agent: PLAIN, single string (not array).
  // These complete the browser fingerprint so Meta can link the server event
  // to the actual ad-click session. Without these the match score floors out
  // around 4-5/10 and Meta declines attribution — the Bayside symptom.
  // Meta accepts both IPv4 and IPv6. UA capped server-side at 1024 chars.
  if (clientIp)        userData.client_ip_address = clientIp;
  if (clientUserAgent) userData.client_user_agent = clientUserAgent;

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
  let respJson: Record<string, unknown> | null = null;
  try { respJson = JSON.parse(respText); } catch { /* not JSON */ }
  const metaEventId =
    typeof respJson?.fbtrace_id === "string" ? (respJson.fbtrace_id as string) : null;

  if (!res.ok) {
    console.error(`Meta CAPI Purchase FAILED for ${studioSlug}: HTTP ${res.status} ${respText.slice(0, 300)}`);
    await logAttempt({
      ok: false,
      pixel_id: acct.pixel_id,
      http_status: res.status,
      error: respText.slice(0, 600),
      raw: respJson ?? { text: respText.slice(0, 600) },
    });
  } else {
    console.log(`Meta CAPI Purchase sent for ${studioSlug} ($${valueUsd}): ${respText.slice(0, 200)}`);
    await logAttempt({
      ok: true,
      pixel_id: acct.pixel_id,
      http_status: res.status,
      meta_event_id: metaEventId,
      raw: respJson ?? { text: respText.slice(0, 600) },
    });
  }
}

// ─── Inline email_log writer ────────────────────────────────────────────────
// We previously relied entirely on the Resend webhook to populate email_log.
// On 2026-06-02 audit, email_log had ZERO rows for 14 days — meaning the
// Resend webhook → DB pipeline is broken (or never wired up). Emails likely
// went out (Resend API accepted them) but we had no audit trail at all.
//
// Fix: every time we POST to Resend and get a 2xx back, write a row to
// email_log right here. event_type='sent_inline' so it's distinguishable
// from rows the webhook would write (event_type='sent', 'delivered', etc.).
// This gives us a bootstrap audit trail that doesn't depend on Resend
// webhook config or signature verification.
async function logEmailSentInline(supabase: any, params: {
  resend_id: string | null;
  send_path: string;
  from_addr: string;
  to_addrs: string[];
  subject: string;
  trial_signup_id?: string | null;
  studio_slug?: string | null;
}) {
  // 2026-06-12 NIGHT — same fix as abandoned-cart-followup. supabase-js does
  // NOT throw on insert errors; it returns { error }. The previous try/catch
  // was catching nothing. The REAL pg error was sitting in `error` and being
  // silently discarded, which is why /ops + the dashboard always showed
  // "0 emails sent" even though Resend was firing thousands.
  const payload = {
    resend_id:       params.resend_id ?? null,
    event_type:      "sent_inline",  // Resend webhook would write 'sent'
    from_addr:       params.from_addr,
    to_addrs:        params.to_addrs,
    subject:         params.subject,
    send_path:       params.send_path,
    trial_signup_id: params.trial_signup_id ?? null,
    raw:             { studio_slug: params.studio_slug ?? null, inline: true },
  };
  const { error: logErr } = await supabase.from("email_log").insert(payload);
  if (logErr) {
    console.error("logEmailSentInline FAILED", {
      pg_code:    (logErr as { code?: string }).code,
      pg_message: logErr.message,
      pg_details: (logErr as { details?: string }).details,
      pg_hint:    (logErr as { hint?: string }).hint,
      payload,
    });
    // Don't throw — the Resend send already succeeded. The loud console.error
    // surfaces the real reason in function logs so we can fix it.
  }
}

async function sendTrialEmail(studioSlug: string, variant: Variant, trial: {
  name: string; email: string; phone: string;
  address: string; city: string; zip_code: string;
  country?: string; newsletter_opted_in?: boolean;
  stripe_session_id: string; payment_date: string;
}) {
  if (!isSendPathEnabled("stripe_owner_email")) {
    console.log(`sendTrialEmail SKIPPED — path "stripe_owner_email" not in BBB_SEND_PATHS_ENABLED (studio=${studioSlug})`);
    return;
  }
  // ── Backfill / replay guard ──────────────────────────────────────────
  // 2026-05-31: a Stripe webhook replay sent 13 owner emails at once for
  // historical paid trials (May 15–29). 2026-06-03: tightened threshold from
  // 24h → 1h after the webhook-secret-mismatch fix triggered a 3-day backlog
  // drain. Real new-paid-trial sends fire <30s after payment; anything over
  // 1h is a replay or backfill — skip loudly.
  try {
    const ageMs = Date.now() - new Date(trial.payment_date).getTime();
    if (Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000) {
      console.warn(`sendTrialEmail SKIPPED — payment_date is ${Math.round(ageMs / 60000)}min old (replay/backfill suspected). studio=${studioSlug} session=${trial.stripe_session_id}`);
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
Stripe session: ${trial.stripe_session_id}`;
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
      // Bootstrap audit log so we don't depend on Resend's webhook to know
      // this email was sent. See logEmailSentInline definition for context.
      const supabaseLog = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      await logEmailSentInline(supabaseLog, {
        resend_id:    body?.id ?? null,
        send_path:    "stripe_owner_email",
        from_addr:    "trials@betterbodybootcamp.com",
        to_addrs:     recipients,
        subject:      staffOverrideNotice ? `[QA] ${subject}` : subject,
        studio_slug:  studioSlug,
      });
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
  trial: { name: string; phone: string; payment_date?: string },
  supabase: any,
  trialSignupId: string,
) {
  // ── Double-gate guardrail (2026-06-02) ────────────────────────────────────
  // Justin pulled approval for automated SMS sends after realizing the
  // env-var allowlist gave too coarse a permission. To re-arm automated
  // customer SMS, BOTH of these must be set to "true":
  //   1. stripe_customer_welcome_sms in BBB_SEND_PATHS_ENABLED  (path gate)
  //   2. BBB_SMS_AUTO_SEND_ENABLED = "true"                     (master gate)
  // The master gate is intentionally separate so a path-list edit can't
  // accidentally fire SMS to customers. Default: OFF.
  if (Deno.env.get("BBB_SMS_AUTO_SEND_ENABLED") !== "true") {
    console.log(`sendTrialWelcomeSms BLOCKED — BBB_SMS_AUTO_SEND_ENABLED not set to "true" (master gate)`);
    return;
  }
  // ── Backfill / replay guard (matches sendTrialEmail — 1h threshold) ──
  try {
    if (trial.payment_date) {
      const ageMs = Date.now() - new Date(trial.payment_date).getTime();
      if (Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000) {
        console.warn(`sendTrialWelcomeSms SKIPPED — payment_date is ${Math.round(ageMs / 60000)}min old (replay/backfill suspected). studio=${studioSlug}`);
        return;
      }
    }
  } catch (e) {
    console.warn(`sendTrialWelcomeSms age check failed (continuing): ${(e as Error).message}`);
  }
  if (!isSendPathEnabled("stripe_customer_welcome_sms")) {
    console.log(`sendTrialWelcomeSms SKIPPED — path "stripe_customer_welcome_sms" not in BBB_SEND_PATHS_ENABLED (studio=${studioSlug})`);
    return;
  }
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
  // SMS goes straight to MindBody — booking happens there, and a working
  // direct URL beats our own /schedule page (which iframes MB anyway and
  // adds an extra hop). Falls back to our page if we ever add a 5th studio
  // without populating the MB map.
  const MB_LOC_BY_SLUG_SMS: Record<string, number> = {
    "astoria": 2, "bayside": 6, "fresh-meadows": 3, "williamsburg": 1,
  };
  const mbLocIdSms = MB_LOC_BY_SLUG_SMS[studioSlug] ?? 0;
  const studioUrl = mbLocIdSms
    ? `https://clients.mindbodyonline.com/classic/ws?studioid=5733997&stype=-7&sLoc=${mbLocIdSms}`
    : `https://betterbodybootcamp.com/schedule/${studioSlug}`;
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
      // Bootstrap audit log to sms_messages so /homebase's per-customer
      // thread shows the welcome SMS. Independent of the Twilio status
      // webhook — even if that's broken, we still see the send happened.
      try {
        await supabase.from("sms_messages").insert({
          trial_signup_id: trialSignupId,
          studio_slug:     studioSlug,
          direction:       "outbound",
          from_phone:      from,
          to_phone:        to,
          body,
          twilio_sid:      respBody?.sid ?? null,
          status:          respBody?.status ?? "queued",
          sent_by:         "stripe_customer_welcome_sms",
        });
      } catch (logErr) {
        console.error("sms_messages welcome insert failed:", (logErr as Error).message);
      }
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
  trialSignupId: string | null,
) {
  if (!locationId) return;
  // ── Double-gate guardrail — see sendTrialWelcomeSms. Master switch off
  // by default. Even when stripe_owner_sms is allowlisted, no SMS fires
  // unless BBB_SMS_AUTO_SEND_ENABLED is explicitly "true".
  if (Deno.env.get("BBB_SMS_AUTO_SEND_ENABLED") !== "true") {
    console.log(`notifyOwnersOfSignup BLOCKED — BBB_SMS_AUTO_SEND_ENABLED not set to "true" (master gate)`);
    return;
  }
  if (!isSendPathEnabled("stripe_owner_sms")) {
    console.log(`notifyOwnersOfSignup SKIPPED — path "stripe_owner_sms" not in BBB_SEND_PATHS_ENABLED (studio=${studioName})`);
    return;
  }
  // ── Backfill / replay guard (matches sendTrialEmail — 1h threshold) ──
  // 2026-05-31: lock down owner SMS from any payment older than 24h. A real
  // new paid trial fires within seconds of payment; anything older = replay.
  try {
    if (trial.payment_date) {
      const ageMs = Date.now() - new Date(trial.payment_date).getTime();
      if (Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000) {
        console.warn(`notifyOwnersOfSignup SKIPPED — payment_date is ${Math.round(ageMs / 60000)}min old (replay/backfill suspected). studio=${studioName}`);
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
        // Bootstrap audit log to sms_messages. Owner notifications are
        // outbound + sent_by='stripe_owner_sms' so the /ops comms-health
        // card can count them. trial_signup_id can be NULL here — these
        // are studio-internal pings about a customer, not to the customer.
        try {
          await supabase.from("sms_messages").insert({
            // Was previously null — that orphaned every owner ping from the
            // customer card on /homebase. Tag with the customer's trial id
            // so the comms history modal can surface owner fan-outs.
            trial_signup_id: trialSignupId,
            studio_slug:     studioName.toLowerCase().replace(/\s+/g, "-"),
            direction:       "outbound",
            from_phone:      from,
            to_phone:        sendTo,
            body:            bodyOut,
            twilio_sid:      respBody?.sid ?? null,
            status:          respBody?.status ?? "queued",
            sent_by:         "stripe_owner_sms",
          });
        } catch (logErr) {
          console.error("sms_messages owner-notify insert failed:", (logErr as Error).message);
        }
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
  trial: { name: string; email: string; phone: string; payment_date?: string },
  trialSignupId: string | null,
  // 2026-06-26: data_source drives whether the email tells the customer to
  // look for a MindBody password email or a Mariana Tek password email.
  // Default 'mindbody' for backward-compat with old callers.
  dataSource: 'mindbody' | 'mariana_tek' | 'dual' = 'mindbody',
) {
  if (!isSendPathEnabled("stripe_customer_welcome_email")) {
    console.log(`sendCustomerConfirmationEmail SKIPPED — path "stripe_customer_welcome_email" not in BBB_SEND_PATHS_ENABLED (studio=${studioSlug})`);
    return;
  }
  // ── Backfill / replay guard (matches sendTrialEmail — 1h threshold) ──
  // Real welcomes fire <30s after payment. Anything older is a replay.
  try {
    if (trial.payment_date) {
      const ageMs = Date.now() - new Date(trial.payment_date).getTime();
      if (Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000) {
        console.warn(`sendCustomerConfirmationEmail SKIPPED — payment_date is ${Math.round(ageMs / 60000)}min old (replay/backfill suspected). studio=${studioSlug}`);
        return;
      }
    }
  } catch (e) {
    console.warn(`sendCustomerConfirmationEmail age check failed (continuing): ${(e as Error).message}`);
  }
  // ── No artificial delay ────────────────────────────────────────────────
  // Earlier draft staggered this 30s behind the MB password email so it
  // landed first in the inbox. Reverted: a sleep here blocks the webhook
  // response past Stripe's ~30s timeout, which would trigger retries and
  // double-fire welcomes + owner SMS. Instead, the email body itself now
  // teaches the customer to look for the MB password email regardless of
  // arrival order — order isn't deterministic across mail providers anyway.
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
  // Always-works MindBody fallback URL, in case our embedded schedule widget
  // is slow / fails on the customer's network. Site ID 5733997 is BBB org-wide;
  // sLoc is the per-studio MB location ID (confirmed from /sites endpoint).
  const MB_LOC_BY_SLUG: Record<string, number> = {
    "astoria": 2, "bayside": 6, "fresh-meadows": 3, "williamsburg": 1,
  };
  const mbLocId = MB_LOC_BY_SLUG[studioSlug] ?? 0;
  const mbDirectScheduleUrl = mbLocId
    ? `https://clients.mindbodyonline.com/classic/ws?studioid=5733997&stype=-7&sLoc=${mbLocId}`
    : scheduleUrl; // graceful degrade if we somehow get an unknown slug
  // 2026-07-11 FIX (Justin, ASAP): the "Book My First Class" button was pointing
  // at the raw MT tenant root (https://betterbodybootcamp.marianatek.com/) which
  // does NOT resolve to a usable customer booking page — new clients hit a dead
  // link. Point it at OUR OWN live schedule page instead: it lists this studio's
  // MT classes and books them natively (NativeClassList + MTBookingModal, signed
  // in with the MT password from step 1). Same domain, guaranteed to load.
  const mtPortalUrl = scheduleUrl;  // https://betterbodybootcamp.com/schedule/<slug>
  // Pick the booking URL based on which membership system this studio runs on.
  const isMT = dataSource === 'mariana_tek';
  const bookingUrl = isMT ? mtPortalUrl : mbDirectScheduleUrl;
  const bookingSystemName = isMT ? 'Mariana Tek' : 'MindBody';
  const bookingSenderHint = isMT
    ? 'an email from Mariana Tek (sender: <em>no-reply@marianatek.com</em>)'
    : 'an email from MindBody (sender: <em>no-reply@mindbodyonline.com</em>)';
  const bookingSenderHintPlain = isMT
    ? 'an email from Mariana Tek (no-reply@marianatek.com)'
    : 'an email from MindBody (no-reply@mindbodyonline.com)';
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
        <p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#222">${intro}</p>

        <!-- TWO-STEP SETUP — branches on dataSource. MT-flavored when the
             studio is post-cutover, MindBody-flavored otherwise. Step 2
             always = "book your first class" regardless of system. -->
        <div style="background:#fffaf5;border:2px solid ${cfg.heroHex};border-radius:12px;padding:20px 22px;margin:0 0 24px">
          <div style="font-size:11px;font-weight:800;color:${cfg.heroHex};text-transform:uppercase;letter-spacing:0.12em;margin-bottom:12px">Two-step setup · takes 60 seconds</div>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-bottom:14px;width:100%">
            <tr>
              <td style="width:40px;vertical-align:top;padding-right:14px">
                <div style="background:${cfg.heroHex};color:#fff;font-weight:800;font-size:14px;width:26px;height:26px;line-height:26px;border-radius:13px;text-align:center;display:inline-block">1</div>
              </td>
              <td style="vertical-align:top;font-size:14px;line-height:1.55;color:#222">
                <strong>Check your inbox for ${bookingSenderHint}.</strong>
                Click the link inside to set your password.
                <div style="font-size:12px;color:#888;margin-top:4px">It usually lands within a minute or two of this email. Look in Spam / Promotions if you don't see it.</div>
              </td>
            </tr>
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">
            <tr>
              <td style="width:40px;vertical-align:top;padding-right:14px">
                <div style="background:${cfg.heroHex};color:#fff;font-weight:800;font-size:14px;width:26px;height:26px;line-height:26px;border-radius:13px;text-align:center;display:inline-block">2</div>
              </td>
              <td style="vertical-align:top;font-size:14px;line-height:1.55;color:#222">
                <strong>Book your first class.</strong>
                The button below takes you straight to the schedule — sign in with the password you just set.
              </td>
            </tr>
          </table>
        </div>

        <!-- Single CTA → booking URL (MT or MB depending on studio). -->
        <div style="text-align:center;margin:0 0 28px">
          <a href="${bookingUrl}" style="background:${cfg.heroHex};color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px;display:inline-block;font-size:15px;letter-spacing:0.01em">Book My First Class →</a>
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
          <p style="margin:0 0 10px">Can't find the password-setup email or having trouble logging in? Just reply to this email — we'll get you sorted.</p>
        </div>
        <div style="border-top:1px solid #eee;margin-top:24px;padding-top:18px;font-size:12px;color:#888;text-align:center">
          <a href="${studioInfoUrl}" style="color:#888;text-decoration:underline">Studio info & directions</a>
          &nbsp;·&nbsp; <a href="${bookingUrl}" style="color:#888;text-decoration:underline">Class schedule</a>
        </div>
      </div>
    </div>
  `;
  const text = `${greeting}.

${intro}

TWO-STEP SETUP — takes 60 seconds:

1. CHECK YOUR INBOX for ${bookingSenderHintPlain}.
   Click the link inside to set your password. Look in Spam / Promotions if you don't see it within a minute or two.

2. BOOK YOUR FIRST CLASS — sign in with the password you just set.

Book your first class: ${bookingUrl}

What you've got:
- Offer: ${cfg.priceLabel} · ${cfg.durationLabel}
- Studio: ${studioName}
- Access: Unlimited classes for the full window

Tips: show up 10 minutes early, wear sneakers, bring water.

Can't find the password-setup email or having trouble logging in? Reply to this email and we'll get you sorted.

— Better Body Bootcamp`;
  // ─── Tags ────────────────────────────────────────────────────────────────
  // Resend echoes these back on every webhook event (sent / delivered /
  // opened / bounced / etc.) so resend-webhook can thread the email to the
  // customer card on /homebase. Tag names/values are constrained to
  // [a-zA-Z0-9_-]; UUIDs satisfy this.
  const tags: Array<{ name: string; value: string }> = [
    { name: "send_path", value: "stripe_customer_welcome_email" },
    { name: "studio_slug", value: studioSlug },
    { name: "variant", value: variant },
  ];
  if (trialSignupId) {
    tags.push({ name: "trial_signup_id", value: trialSignupId });
  }
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
        tags,
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
      // Bootstrap audit log. See logEmailSentInline definition for context.
      const supabaseLog = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      await logEmailSentInline(supabaseLog, {
        resend_id:       body?.id ?? null,
        send_path:       "stripe_customer_welcome_email",
        from_addr:       studioMail,
        to_addrs:        [recipient],
        subject:         overrideNotice ? `${cfg.customerSubject} [QA TEST]` : cfg.customerSubject,
        trial_signup_id: trialSignupId ?? null,
        studio_slug:     studioSlug,
      });
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
          null, // diagnostic path — no real trial_signup to thread to
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
      .select("stripe_secret_key, stripe_webhook_secret, gohighlevel_webhook_url, gohighlevel_api_key, name, data_source")
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
    // NOTE 2026-06-04: must use constructEventAsync in Deno edge runtime.
    // The synchronous constructEvent depends on Node's crypto.createHmac which
    // throws under Deno when Stripe SDK 17.x hardened its Node-only path.
    // Symptom: 100% signature failures across all 4 studios from June 1 onward,
    // even though the stored whsec_ matched Stripe's UI byte-for-byte.
    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        location.stripe_webhook_secret,
      );
    } catch (err) {
      console.error("BLOCKED: webhook signature verification failed for locationId", locationId, (err as Error).message);
      return new Response(
        JSON.stringify({ received: false, error: "invalid signature", detail: (err as Error).message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Received Stripe event:", event.type, "for location:", locationId);

    // ── Replay/backfill detection — Stripe's event.created is IMMUTABLE across
    // webhook retries, while Date.now() drifts on every retry. Use this for
    // age guards so backlog drains don't fire welcomes for old paid trials.
    const eventCreatedMs = (event.created && Number.isFinite(event.created))
      ? event.created * 1000
      : Date.now();

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = session.metadata || {};

      // Variant flows through Checkout metadata.
      //   'special'  = $129 / 30-day comeback (legacy)
      //   'comeback' = $29  / 1-week comeback offer (2026-06-11)
      //   else       = $49  / 2-week standard trial
      const variant: Variant = metadata.priceVariant === "special" ? "special" : "trial";
      const isComeback = metadata.priceVariant === "comeback";

      // For the $29 comeback flow, stamp comeback_converted_at on the ORIGINAL
      // abandoned trial_signups row so the dashboard can attribute the conversion
      // back to its first-touch lead. Best-effort — never block the webhook.
      const comebackOriginalSignupId =
        typeof metadata.comebackOriginalSignupId === "string" && metadata.comebackOriginalSignupId.length === 36
          ? metadata.comebackOriginalSignupId
          : null;
      if (isComeback && comebackOriginalSignupId) {
        try {
          await supabase
            .from("trial_signups")
            .update({
              comeback_converted_at: new Date(eventCreatedMs).toISOString(),
              comeback_stripe_session_id: session.id,
            })
            .eq("id", comebackOriginalSignupId);
          console.log(`comeback conversion stamped on original signup ${comebackOriginalSignupId}`);
        } catch (e) {
          console.error("comeback attribution stamp failed:", (e as Error).message);
        }
      }

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
        // Use Stripe's event.created (immutable across retries) so payment_date
        // reflects the REAL payment time and the age guards below work right.
        payment_date: new Date(eventCreatedMs).toISOString(),
        // NEVER leave source_category NULL on insert. If a downstream filter
        // ever does `.neq("source_category", "x")`, Postgres 3-valued logic
        // would silently drop every NULL row. That bug hid 25 paid leads
        // across all 4 studios on 2026-06-01. Tag every insert with a
        // non-null sentinel so the failure mode is structurally impossible.
        // 'stripe_checkout' here = paid via Stripe Checkout but no prior
        // pending row (i.e. external Payment Link, never touched our form).
        // The form path through create-trial-checkout tags 'trial_form'.
        // Comeback flow tags as 'comeback_form' for attribution.
        source_category: isComeback ? "comeback_form" : "stripe_checkout",
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

      // ─── Mirror to stripe_paid_mirror (single source of truth) ──────────
      // Real-time mirror write so the dashboard's count_paid_canonical can
      // see this purchase immediately, not on the next 5-min cron tick.
      // Idempotent — sync-stripe-paid-mirror also writes the same row.
      //
      // 2026-06-04: paid_at must come from event.created (Stripe's immutable
      // event timestamp), NOT new Date(). On a replay 3 days later, the old
      // code set paid_at to "now" and the customer showed up as "paid today"
      // on the dashboard. Real-world impact: bulk-resends after the 6/1–6/4
      // webhook outage made Misbah and Yissel show as "Paid today" on the
      // Daily Pulse tiles. eventCreatedMs is the event's true charge time.
      try {
        const studioSlugMirror = (location?.name ?? "").toLowerCase().replace(/\s+/g, "-");
        const pi = (session.payment_intent as string) || null;
        if (pi && studioSlugMirror) {
          await supabase.from("stripe_paid_mirror").upsert({
            stripe_payment_intent_id: pi,
            studio_slug:              studioSlugMirror,
            location_id:              metadata.locationId || null,
            amount_cents:             session.amount_total ?? 4900,
            currency:                 (session.currency || "usd").toLowerCase(),
            paid_at:                  new Date(eventCreatedMs).toISOString(),
            customer_email:           trialData.email || null,
            customer_name:            trialData.name  || null,
            customer_phone:           trialData.phone || null,
            stripe_customer_id:       (typeof session.customer === "string" ? session.customer : null),
            stripe_charge_id:         null,
            raw:                      { source: "stripe-webhook checkout.session.completed", session_id: session.id },
          }, { onConflict: "stripe_payment_intent_id" });
        }
      } catch (e) {
        console.error("stripe_paid_mirror upsert failed:", (e as Error).message);
      }

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
      //
      // trialSignupId flows through Resend tags so resend-webhook can thread
      // every send/delivered/opened event to the customer card on /homebase.
      // `data[0].id` is the trial_signups row produced by the upsert above.
      try {
        await sendCustomerConfirmationEmail(
          studioSlug,
          studioName,
          variant,
          { name: trialData.name, email: trialData.email, phone: trialData.phone, payment_date: trialData.payment_date },
          (data && data[0] && data[0].id) ? String(data[0].id) : null,
          // 2026-06-26: pass data_source so the email body picks MT vs MB
          // password-setup wording + booking URL.
          ((location as any).data_source || 'mindbody') as 'mindbody' | 'mariana_tek' | 'dual',
        );
      } catch (e) {
        console.error("customer confirmation email exception:", e);
      }

      // ─── Meta Conversions API — server-side Purchase event ───────────────
      // Reports the conversion to Meta so the dashboard's CPP / Funnel% / Paid
      // Trials stop reading zero. Uses the real amount Stripe charged.
      //
      // 2026-06-05: pull client_ip + client_user_agent + fbp + fbc off the
      // upserted row instead of trusting only Stripe metadata. The row is the
      // canonical capture (create-trial-checkout writes IP/UA from the request
      // headers + the fb cookies from the form body). Stripe metadata is the
      // fallback for the edge case where the row isn't found (no create-trial-
      // checkout call, e.g. external payment-link checkouts).
      try {
        const purchaseValue = session.amount_total
          ? session.amount_total / 100
          : (variant === "special" ? 129 : 49);
        const row = (data && data[0]) ? data[0] as Record<string, unknown> : {};
        const rowIp  = typeof row.client_ip          === "string" ? row.client_ip          : "";
        const rowUa  = typeof row.client_user_agent  === "string" ? row.client_user_agent  : "";
        const rowFbp = typeof row.fbp                === "string" ? row.fbp                : "";
        const rowFbc = typeof row.fbc                === "string" ? row.fbc                : "";
        await sendMetaPurchaseEvent(
          supabase,
          studioSlug,
          variant,
          { name: trialData.name, email: trialData.email, phone: trialData.phone },
          session.id,
          purchaseValue,
          rowFbp || metadata.fbp || "",
          rowFbc || metadata.fbc || "",
          rowIp,
          rowUa,
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
            { name: trialData.name, phone: trialData.phone, payment_date: trialData.payment_date },
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
          (data && data[0] && data[0].id) ? String(data[0].id) : null,
        );
      } catch (e) {
        console.error("owner notification SMS exception:", e);
      }

      // ─── Booking-system account creation — fire-and-forget ─────────────
      // 2026-06-09: this is the missing link that broke EVERY trial since
      // launch. The welcome email above tells the customer to look for a
      // password-setup email, but until 6/9 nobody actually created their
      // booking-system account — so the system never sent the password
      // email, and /schedule/[studio] couldn't authenticate them.
      //
      // 2026-06-23 Mariana Tek cutover: route this to MT or MB based on
      // the studio's `data_source`. Pre-cutover (`mindbody` or `dual`) →
      // MindBody. Post-cutover (`mariana_tek`) → Mariana Tek.
      //
      // Both functions run OUTSIDE the webhook response so we don't push
      // past Stripe's ~30s timeout (AddClient + Checkout can take 8-15s
      // combined). Errors are logged but never block.
      if (data && data[0]) {
        const trialSignupIdForBooking = data[0].id;
        // location.data_source is read into scope earlier in this handler
        // alongside other location fields. Default to "mindbody" if absent.
        const studioDataSource = (location as any).data_source || "mindbody";
        const targetFn = studioDataSource === "mariana_tek"
          ? "mariana-tek-create-trial-client"
          : "mindbody-create-trial-client";
        // 2026-06-26 — Now persists outcome to trial_signups (mt_create_status,
        // mt_create_attempted_at, mt_create_response) so we can monitor + retry
        // failures. Migration: 20260626_mt_create_status.sql adds the columns.
        const bookingCreateTask = (async () => {
          const startedAt = new Date().toISOString();
          try {
            const r = await fetch(
              `${Deno.env.get("SUPABASE_URL")}/functions/v1/${targetFn}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                  // MT function gates on x-bbb-secret; MB function ignores it.
                  "x-bbb-secret": Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27",
                },
                body: JSON.stringify({ trial_signup_id: trialSignupIdForBooking }),
              },
            );
            const body = await r.json().catch(() => ({}));
            const firstResult = Array.isArray(body?.results) ? body.results[0] : null;
            const resultStatus = firstResult?.status ?? (r.ok ? "unknown" : "http_error");

            // Persist outcome — surfaces in /ops + lets paid-trials-realtime-monitor retry.
            // Wrapped in try/catch so a DB write failure doesn't blow up the webhook.
            try {
              await supabase
                .from("trial_signups")
                .update({
                  mt_create_status: resultStatus,
                  mt_create_attempted_at: startedAt,
                  mt_create_response: { http: r.status, body: body },
                  mt_create_function: targetFn,
                } as any)
                .eq("id", trialSignupIdForBooking);
            } catch (persistErr) {
              console.error(`mt_create_status persist failed:`, (persistErr as Error).message);
            }

            if (!r.ok || resultStatus === "failed") {
              console.error(
                `${targetFn} FAILED for trial=${trialSignupIdForBooking}:`,
                JSON.stringify(body).slice(0, 600),
              );
              // Loud failure → SMS Justin so we know about it.
              // Owner alert via existing twilio-outbound-sms function.
              try {
                await fetch(
                  `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-outbound-sms`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                      "x-bbb-secret": Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27",
                    },
                    body: JSON.stringify({
                      to: "+19178709801", // Justin
                      body: `[BBB ALERT] ${targetFn} failed for paid trial ${trialSignupIdForBooking}. Check /ops or trial_signups.mt_create_response.`,
                      send_path: "owner_create_client_failed",
                      skip_brand_header: true,
                    }),
                  },
                );
              } catch (alertErr) {
                console.error("owner alert SMS failed:", (alertErr as Error).message);
              }
            } else {
              console.log(`${targetFn} OK for trial=${trialSignupIdForBooking}:`, JSON.stringify(body).slice(0, 200));
            }
          } catch (bookingErr) {
            console.error(`${targetFn} exception:`, (bookingErr as Error).message);
            try {
              await supabase
                .from("trial_signups")
                .update({
                  mt_create_status: "exception",
                  mt_create_attempted_at: startedAt,
                  mt_create_response: { exception: (bookingErr as Error).message },
                  mt_create_function: targetFn,
                } as any)
                .eq("id", trialSignupIdForBooking);
            } catch {}
          }
        })();
        // @ts-ignore — EdgeRuntime is provided by Supabase edge runtime
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
          // @ts-ignore
          EdgeRuntime.waitUntil(bookingCreateTask);
        } else {
          // Local dev fallback — await directly so dev tests don't lose the task
          await bookingCreateTask;
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
              // Live $49 paid via raw PI (no Checkout Session) — Payment Link
              // / Stripe Dashboard / direct API. Must be visible on /homebase
              // and dashboard, so tag as a live path, NOT 'legacy_archived'.
              // Previously this was 'legacy_archived' which silently hid real
              // recent purchases. Source: post-mortem on 2026-06-02.
              source_category: "stripe_payment_intent",
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
