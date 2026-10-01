// _shared/sms.ts — THE one way to text a customer. Quo-first, Twilio fallback.
//
// Why: 31 functions each had their own Twilio sender, ~90% of outbound texts sat
// at "queued" forever (no status callback), and replies to a Twilio text landed
// in a shared relay thread instead of the customer's conversation. Justin's
// direction 2026-09-28: phase Twilio out, use Quo anywhere we can.
//
// Routing rule (per studio, from _shared/studios.ts):
//   studio has a Quo line  → send FROM that line via Quo API. The customer's
//                            reply threads into that studio's Quo inbox, and
//                            delivery status arrives via quo-inbound-webhook
//                            (message.delivered) — real status, for free.
//   no Quo line yet        → Twilio (Astoria / Williamsburg until they're on Quo).
//   Quo rejects (A2P / 4xx)→ fall back to Twilio so nothing silently drops,
//                            and record WHY on the log row.
//
// Every send is logged to sms_messages with send_path + which rail carried it
// (sent_by = "quo" | "twilio"), so the dashboard and Homebase see one truth.
//
// Usage (from any edge function):
//   import { sendCustomerSms } from "../_shared/sms.ts";
//   const r = await sendCustomerSms(sb, { studioSlug: "bayside", to: "+1917…",
//     body: "Hi Gabby! …", sendPath: "schedule_request_sms", trialSignupId });
//   // r = { ok, rail: "quo"|"twilio", id, error? }

import { studioBySlug } from "./studios.ts";

export type SendArgs = {
  studioSlug: string;         // "bayside" | "fresh-meadows" | "astoria" | "williamsburg"
  to: string;                 // E.164 (+1…) — caller normalises
  body: string;
  sendPath: string;           // e.g. "schedule_request_sms", "manual_welcome_batch"
  trialSignupId?: string | null;
  forceTwilio?: boolean;      // escape hatch for internal/staff alerts that should stay on Twilio
};
export type SendResult = { ok: boolean; rail: "quo" | "twilio" | "none"; id?: string; error?: string; fallback_reason?: string };

const QUO_API = "https://api.quo.com/v1/messages";

async function viaQuo(from: string, to: string, content: string): Promise<{ ok: boolean; id?: string; code?: string; error?: string }> {
  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return { ok: false, error: "QUO_API_KEY missing" };
  const r = await fetch(QUO_API, {
    method: "POST",
    headers: { "Authorization": key, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], content }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, id: (j as any)?.data?.id };
  return { ok: false, code: String((j as any)?.code || r.status), error: (j as any)?.message || `HTTP ${r.status}` };
}

async function viaTwilio(to: string, body: string): Promise<{ ok: boolean; id?: string; from?: string; code?: string; error?: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), tok = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER") || Deno.env.get("TWILIO_FROM") || "";
  if (!sid || !tok || !from) return { ok: false, error: "twilio env missing" };
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, id: (j as any).sid, from };
  return { ok: false, from, code: String((j as any).code || r.status), error: (j as any).message || `HTTP ${r.status}` };
}

// sb = a service-role supabase client (createClient(...)). Typed loosely so this
// helper doesn't pin a supabase-js version for every caller.
export async function sendCustomerSms(sb: any, a: SendArgs): Promise<SendResult> {
  const studio = studioBySlug(a.studioSlug);
  const quoFrom = studio?.quoNumber ?? null;
  let result: SendResult = { ok: false, rail: "none" };
  let fromPhone = "";
  let errCode: string | null = null, errMsg: string | null = null;

  if (quoFrom && !a.forceTwilio) {
    const q = await viaQuo(quoFrom, a.to, a.body);
    if (q.ok) { result = { ok: true, rail: "quo", id: q.id }; fromPhone = quoFrom; }
    else {
      // Quo refused (A2P not approved = 0206400, bad number, etc.) → Twilio so
      // the customer still gets the text; keep the reason on the row.
      const t = await viaTwilio(a.to, a.body);
      fromPhone = t.from || "";
      result = t.ok
        ? { ok: true, rail: "twilio", id: t.id, fallback_reason: `quo ${q.code}: ${q.error}` }
        : { ok: false, rail: "twilio", error: t.error, fallback_reason: `quo ${q.code}: ${q.error}` };
      if (!t.ok) { errCode = t.code ?? null; errMsg = t.error ?? null; }
    }
  } else {
    const t = await viaTwilio(a.to, a.body);
    fromPhone = t.from || "";
    result = t.ok ? { ok: true, rail: "twilio", id: t.id } : { ok: false, rail: "twilio", error: t.error };
    if (!t.ok) { errCode = t.code ?? null; errMsg = t.error ?? null; }
  }

  // One log row, one truth. Quo rows start "sent" (delivery flips to
  // "delivered" via quo-inbound-webhook); Twilio rows stay "queued" as before.
  try {
    await sb.from("sms_messages").insert({
      trial_signup_id: a.trialSignupId ?? null,
      studio_slug: a.studioSlug,
      direction: "outbound",
      from_phone: fromPhone || null,
      to_phone: a.to,
      body: a.body,
      twilio_sid: result.id ?? null,                 // Quo message id lives here too (same de-dupe key the webhook uses)
      status: result.ok ? (result.rail === "quo" ? "sent" : "queued") : "failed",
      error_code: errCode,
      error_message: errMsg ?? result.fallback_reason ?? null,
      sent_by: result.rail,
      sent_at: new Date().toISOString(),
      send_path: a.sendPath,
    });
  } catch (e) {
    console.error("sms log insert failed (non-fatal):", (e as Error).message);
  }
  return result;
}
