/**
 * resend-webhook — ingest Resend's webhook events into email_log.
 *
 * Wire up in Resend dashboard → Webhooks → Add endpoint:
 *   URL:    https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/resend-webhook
 *   Events: email.sent, email.delivered, email.delivery_delayed,
 *           email.bounced, email.complained, email.opened, email.clicked
 *
 * Authentication: Resend signs each request with a HMAC using a webhook
 * signing secret. We verify the signature when RESEND_WEBHOOK_SECRET is set
 * (skips verification in dev so local probes work).
 *
 * Every event becomes one row in email_log. The /ops page reads from there.
 *
 * Deploy: supabase functions deploy resend-webhook --no-verify-jwt
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, svix-id, svix-timestamp, svix-signature",
};

async function verifySvix(body: string, headers: Headers, secret: string): Promise<boolean> {
  // Resend uses Svix for webhook signing. Format: "v1,base64sig v1,sig2 ..."
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;
  const toSign = `${id}.${ts}.${body}`;
  // Svix signing secret starts with whsec_; the base64-decoded bit is the key
  const keyB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(toSign));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  // sigHeader can contain multiple "v1,sig" pairs separated by spaces.
  return sigHeader.split(" ").some((pair) => {
    const [_, s] = pair.split(",");
    return s === computed;
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: cors });
  }

  const bodyText = await req.text();
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (secret) {
    const ok = await verifySvix(bodyText, req.headers, secret).catch(() => false);
    if (!ok) {
      console.warn("resend-webhook: signature verification failed");
      return new Response(JSON.stringify({ ok: false, error: "bad signature" }), { status: 401, headers: cors });
    }
  }

  let payload: any;
  try { payload = JSON.parse(bodyText); } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid JSON" }), { status: 400, headers: cors });
  }

  // Resend payload: { type: 'email.delivered', created_at, data: { email_id, from, to, subject, tags, ... } }
  // We pull two tags off every event (set by the senders at send time):
  //   - send_path        → internal label (e.g. stripe_customer_welcome_email)
  //   - trial_signup_id  → links this email to a customer card on /homebase.
  // Both flow through Resend untouched; Resend echoes them on every event
  // for the email_id (sent → delivered → opened → bounced → etc.).
  const eventType = String(payload.type || "").replace(/^email\./, "");
  const data = payload.data || {};
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const tagVal = (name: string) =>
    tags.find((t: any) => t && (t.name === name))?.value ?? null;

  const sendPathTag = tagVal("send_path") || tagVal("path");
  const rawTrialId = tagVal("trial_signup_id");
  // Validate uuid shape — if a sender passes a junk tag we don't want to
  // null-foreign-key into trial_signups.
  const trialSignupId =
    typeof rawTrialId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawTrialId)
      ? rawTrialId
      : null;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const { error } = await sb.from("email_log").insert({
    resend_id: data.email_id ?? data.id ?? null,
    event_type: eventType || "unknown",
    from_addr:  data.from ?? null,
    to_addrs:   Array.isArray(data.to) ? data.to : (data.to ? [data.to] : null),
    subject:    data.subject ?? null,
    send_path:  sendPathTag,
    trial_signup_id: trialSignupId,
    raw:        payload,
  });
  if (error) {
    console.error("email_log insert error:", error.message);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true, event: eventType }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
});
