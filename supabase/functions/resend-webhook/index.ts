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
  // 2026-10-05 — accept BOTH tag shapes. Senders set tags on the SEND as an
  // array of { name, value } (Resend's send API format), but Resend echoes
  // them on WEBHOOK EVENTS as an object map: { send_path: "...", ... }.
  // This only handled the array, so `Array.isArray` was false on every real
  // event, tags resolved to [], and every row landed with send_path NULL and
  // trial_signup_id NULL.
  //
  // Measured right after the webhook was first connected: 217 of 221 rows in
  // 24h were orphaned — including 109 winback-49 sends that tag correctly at
  // the source. The senders were never the problem; the parser was throwing
  // the tags away on arrival.
  const rawTags = data.tags;
  const tagVal = (name: string): string | null => {
    if (Array.isArray(rawTags)) {
      const hit = rawTags.find((t: any) => t && t.name === name);
      return hit?.value ?? null;
    }
    if (rawTags && typeof rawTags === "object") {
      const v = (rawTags as Record<string, unknown>)[name];
      return typeof v === "string" ? v : (v == null ? null : String(v));
    }
    return null;
  };

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

  // ── Fall back to the original send row ────────────────────────────────────
  // 2026-10-21. The 2026-10-05 fix above made the parser read both tag shapes,
  // and that worked — but it only helps when Resend actually echoes the tags.
  // It does not always do so: a `delivered` or `bounced` event can arrive with
  // tags stripped, and every one of those still landed with send_path NULL.
  // Fourteen such rows accumulated in a single day.
  //
  // The label is never actually lost, though. The sender already wrote an
  // `email.sent` row carrying the same resend_id AND the correct send_path. So
  // when the tag is missing, read it off that row instead of giving up.
  //
  // Cheap (one indexed lookup on resend_id, only on the miss path) and it
  // cannot invent a label: no earlier row means it stays null and the default
  // from the migration flags it for a human.
  const resendId = data.email_id ?? data.id ?? null;
  let sendPath = sendPathTag;
  let trialId = trialSignupId;
  if (resendId && (!sendPath || !trialId)) {
    const { data: origin } = await sb
      .from("email_log")
      .select("send_path,trial_signup_id")
      .eq("resend_id", resendId)
      .not("send_path", "is", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (origin) {
      sendPath = sendPath ?? origin.send_path ?? null;
      trialId  = trialId  ?? origin.trial_signup_id ?? null;
    }
  }

  const { error } = await sb.from("email_log").insert({
    resend_id: resendId,
    event_type: eventType || "unknown",
    from_addr:  data.from ?? null,
    to_addrs:   Array.isArray(data.to) ? data.to : (data.to ? [data.to] : null),
    subject:    data.subject ?? null,
    send_path:  sendPath,
    trial_signup_id: trialId,
    // so a future orphan says which path produced it, not just that it exists
    raw: { ...payload, _send_path_source: sendPathTag ? "tag" : (sendPath ? "origin_row" : "none") },
  });
  if (error) {
    console.error("email_log insert error:", error.message);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true, event: eventType }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
});
