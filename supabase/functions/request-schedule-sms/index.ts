/**
 * request-schedule-sms — soft-conversion endpoint for trial-page bouncers.
 *
 * The trial form asks for the full $49 commitment up front. Many visitors
 * (industry baseline: 4-8% of bounces) will give us a phone number for a
 * lower-friction ask. This function powers a "text me the class schedule"
 * mini-form on the trial page.
 *
 * What it does:
 *   1. Validates phone via Twilio Lookup v2 (rejects landlines / bad numbers)
 *   2. Upserts into leads table tagged source='schedule-request-{slug}',
 *      stage='soft_conversion' so /homebase can show them separately
 *   3. Sends a Twilio SMS with the /schedule/{slug} link
 *
 * Returns: { ok: true, sid?: string } | { ok: false, error: string, field?: string }
 *
 * Deploy:
 *   supabase functions deploy request-schedule-sms --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function toE164US(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

async function lookupPhone(e164: string): Promise<{ ok: true; e164: string } | { ok: false; reason: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const tok = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!sid || !tok) return { ok: true, e164 }; // dev fallback
  const res = await fetch(
    `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
    { headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`) } }
  );
  if (res.status === 404) return { ok: false, reason: "Phone number not found." };
  if (!res.ok) return { ok: true, e164 }; // Twilio outage = let it through
  const body = await res.json();
  if (body.valid === false) return { ok: false, reason: "That phone number isn't valid." };
  const type = body?.line_type_intelligence?.type as string | undefined;
  const BAD = new Set(["nonFixedVoip", "personal", "tollFree", "unknown"]);
  if (type && BAD.has(type)) return { ok: false, reason: "Please use a real mobile phone number." };
  return { ok: true, e164: body.phone_number ?? e164 };
}

async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const tok = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !tok || !from) return { ok: false, error: "twilio_not_configured" };
  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", from);
  form.set("Body", body);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${tok}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok && j.sid) return { ok: true, sid: j.sid };
  return { ok: false, error: j.message || `http_${res.status}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }

  const studioSlug = String(body.studio_slug || "").trim().toLowerCase();
  const studioName = String(body.studio_name || "").trim() || studioSlug;
  const locationId = String(body.location_id || "").trim();
  const phoneRaw   = String(body.phone || "").trim();
  const firstName  = String(body.first_name || "").trim();
  // 2026-06-12 — capture full identity for follow-up (was first_name + phone only)
  const lastName   = String(body.last_name || "").trim();
  const emailRaw   = String(body.email || "").trim().toLowerCase();

  // ── Full Meta + referral context ────────────────────────────────────────
  // Captured client-side and posted alongside the phone. Everything optional;
  // gracefully degrades if a privacy-mode user supplies none.
  const fbp           = String(body.fbp || "").trim();
  const fbc           = String(body.fbc || "").trim();
  const utmSource     = String(body.utm_source || "").trim();
  const utmMedium     = String(body.utm_medium || "").trim();
  const utmCampaign   = String(body.utm_campaign || "").trim();
  const utmContent    = String(body.utm_content || "").trim();
  const referrer      = String(body.referrer || "").trim();
  const pageUrl       = String(body.page_url || "").trim();
  const timeOnPageMs  = Number.isFinite(body.time_on_page_ms) ? Math.floor(body.time_on_page_ms) : null;
  const userAgent     = req.headers.get("user-agent") || "";
  const clientIp      = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
                     || req.headers.get("cf-connecting-ip")
                     || "";

  // Decode ad_id from fbc when possible. Meta fbc format:
  //   fb.<subdomain>.<creation_ts>.<click_id_AEbxxxxx>
  // The full click_id is what we get; the ad-level breakdown comes from
  // Meta's API when we later join offline conversions.
  let adClickId = "";
  if (fbc) {
    const parts = fbc.split(".");
    if (parts.length >= 4) adClickId = parts.slice(3).join(".");
  }

  if (!studioSlug)             return json({ ok: false, field: "studio", error: "studio missing" }, 400);
  if (!phoneRaw)               return json({ ok: false, field: "phone", error: "Please enter your phone number." }, 400);

  const e164 = toE164US(phoneRaw);
  if (!e164) return json({ ok: false, field: "phone", error: "Please enter a valid US phone number." }, 400);

  const lookup = await lookupPhone(e164);
  if (!lookup.ok) return json({ ok: false, field: "phone", error: lookup.reason }, 400);
  const phoneE164 = lookup.e164;

  // Save to leads — non-blocking but try
  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  try {
    const metaBlob: Record<string, unknown> = {};
    if (fbp)          metaBlob.fbp = fbp;
    if (fbc)          metaBlob.fbc = fbc;
    if (adClickId)    metaBlob.ad_click_id = adClickId;
    if (utmSource)    metaBlob.utm_source = utmSource;
    if (utmMedium)    metaBlob.utm_medium = utmMedium;
    if (utmCampaign)  metaBlob.utm_campaign = utmCampaign;
    if (utmContent)   metaBlob.utm_content = utmContent;
    if (referrer)     metaBlob.referrer = referrer;
    if (pageUrl)      metaBlob.page_url = pageUrl;
    if (userAgent)    metaBlob.user_agent = userAgent;
    if (clientIp)     metaBlob.client_ip = clientIp;
    if (timeOnPageMs != null) metaBlob.time_on_page_ms = timeOnPageMs;
    metaBlob.captured_at = new Date().toISOString();

    // 2026-06-12 — full identity captured (was first_name + phone only).
    // full_name = "First Last" when both present; falls back gracefully.
    const composedName = [firstName, lastName].filter(Boolean).join(" ") || firstName || null;
    const upsert: Record<string, unknown> = {
      full_name:   composedName,
      first_name:  firstName || null,
      last_name:   lastName  || null,
      email:       emailRaw  || null,
      phone:       phoneE164,
      source:      `schedule-request-${studioSlug}`,
      stage:       "soft_conversion",
      studio_slug: studioSlug,
      last_touch_at: new Date().toISOString(),
      notes: `Requested class schedule via trial page soft-conversion. NOT a $49 trial signup. Follow up: ask if they want to come in for a class.`,
      meta:  Object.keys(metaBlob).length > 0 ? metaBlob : null,
    };
    // leads has no unique constraint on phone; try update-then-insert by phone+studio
    const { data: updated } = await sb
      .from("leads")
      .update(upsert)
      .eq("phone", phoneE164)
      .eq("studio_slug", studioSlug)
      .select("id");
    if (!updated || updated.length === 0) {
      await sb.from("leads").insert(upsert);
    }
  } catch (e) {
    console.error("leads upsert failed:", (e as Error).message);
    // continue — don't block the SMS
  }

  // Compose the SMS. 2026-09-02: /mb/{slug} pointed at the retired MindBody
  // schedule; our /schedule/{slug} is now the native MT class list (no more
  // Healcode iframe). Send customers straight to our own page.
  const greeting = firstName ? `Hi ${firstName}!` : "Hi!";
  const msg =
    `${greeting} Class schedule for Better Body Bootcamp ${studioName}: ` +
    `https://betterbodybootcamp.com/schedule/${studioSlug}\n\n` +
    `Drop in any time! Reply HELP for help or STOP to opt out.`;

  const sms = await sendSms(phoneE164, msg);

  // 2026-06-12 — log the send into sms_messages so /homebase + /ops can see
  // it. Previously we sent SMS into the void; the comms history modal showed
  // nothing because we never wrote a row. Loud-fail on logging error so the
  // function logs surface the real Postgres error code instead of silence.
  const logPayload = {
    direction:  "outbound",
    to_phone:   phoneE164,
    from_phone: Deno.env.get("TWILIO_FROM_NUMBER") ?? null,
    body:       msg,
    status:     sms.ok ? "queued" : "failed",
    twilio_sid: sms.ok ? sms.sid : null,
    send_path:  "schedule_request_sms",
    error_message: sms.ok ? null : (sms.error ?? "unknown"),
  };
  const { error: logErr } = await sb.from("sms_messages").insert(logPayload);
  if (logErr) {
    console.error("sms_messages insert FAILED", {
      pg_code:    (logErr as { code?: string }).code,
      pg_message: logErr.message,
      pg_details: (logErr as { details?: string }).details,
      pg_hint:    (logErr as { hint?: string }).hint,
      payload:    logPayload,
    });
  }

  if (!sms.ok) {
    console.error("schedule-SMS send failed:", sms.error);
    return json({ ok: true, saved: true, sms_failed: true, error: sms.error });
  }

  return json({ ok: true, sid: sms.sid });
});
