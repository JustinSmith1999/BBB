/**
 * configure-twilio-webhook — one-shot tool to set BBB's Twilio inbound-SMS
 * webhook URL via the Twilio REST API. Avoids hand-clicking in the Twilio
 * Console.
 *
 * What it does:
 *   1. Authenticates to Twilio with TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
 *   2. Looks up every IncomingPhoneNumber on the account
 *   3. Finds the BBB toll-free (+1-877-286-0293 by default; override by POST
 *      body { phone: "+1..."} )
 *   4. Updates that number's SmsUrl + SmsMethod to point at our function
 *   5. Returns a JSON before/after diff so we can prove the change took
 *
 * Idempotent — re-running just confirms the state. Re-run anytime as a
 * health check.
 *
 * Deploy:
 *   supabase functions deploy configure-twilio-webhook --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 *
 * Call:
 *   curl -X POST -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
 *     https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/configure-twilio-webhook
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const DEFAULT_BBB_NUMBER = "+18772860293";
const WEBHOOK_URL =
  "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/twilio-inbound-sms";

interface TwilioPhoneNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string;
  sms_url: string;
  sms_method: string;
  sms_fallback_url: string;
  sms_application_sid: string;
  status_callback: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  // Auth — accept any of:
  //   1. x-bbb-secret header matching BBB_ADMIN_SECRET (default "bbb-test-2026-05-27")
  //   2. Bearer matching SUPABASE_SERVICE_ROLE_KEY
  // Same belt+suspenders pattern used by sync-orchestrator.
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ADMIN = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-bbb-secret") ?? "";
  const okAuth = secret === ADMIN || (SR && bearer === SR);
  if (!okAuth) {
    return json({
      ok: false,
      error: "unauthorized — pass header 'x-bbb-secret: bbb-test-2026-05-27' or service-role bearer",
    }, 401);
  }

  const TW_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const TW_TOK = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  if (!TW_SID || !TW_TOK) {
    return json({ ok: false, error: "TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set" }, 500);
  }

  const basicAuth = "Basic " + btoa(`${TW_SID}:${TW_TOK}`);

  // Optional override — which phone to configure (default = BBB toll-free)
  let targetNumber = DEFAULT_BBB_NUMBER;
  try {
    const body = await req.json();
    if (body?.phone) targetNumber = String(body.phone).trim();
  } catch { /* empty body fine */ }

  // 1. List all IncomingPhoneNumbers on the account
  const listRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/IncomingPhoneNumbers.json?PageSize=50`,
    { headers: { Authorization: basicAuth } },
  );
  if (!listRes.ok) {
    return json({
      ok: false,
      step: "list",
      status: listRes.status,
      body: await listRes.text(),
    }, 502);
  }
  const listJson = await listRes.json() as { incoming_phone_numbers: TwilioPhoneNumber[] };
  const allNumbers = listJson.incoming_phone_numbers ?? [];

  const target = allNumbers.find((p) => p.phone_number === targetNumber);
  if (!target) {
    return json({
      ok: false,
      error: `phone number ${targetNumber} not found on this Twilio account`,
      available_numbers: allNumbers.map((p) => ({
        phone: p.phone_number, friendly_name: p.friendly_name, sid: p.sid,
      })),
    }, 404);
  }

  // Snapshot the BEFORE state
  const before = {
    phone:        target.phone_number,
    sid:          target.sid,
    sms_url:      target.sms_url,
    sms_method:   target.sms_method,
    sms_fallback_url: target.sms_fallback_url,
    sms_application_sid: target.sms_application_sid,
  };

  // If already correct, skip the write so we don't bump nothing.
  const alreadyCorrect = target.sms_url === WEBHOOK_URL
    && target.sms_method === "POST"
    && !target.sms_application_sid; // SMS Application overrides direct URL
  if (alreadyCorrect) {
    return json({
      ok:  true,
      action: "no-op",
      message: "Twilio webhook already pointed at our function. No change needed.",
      state: before,
    });
  }

  // 2. Update SmsUrl + SmsMethod (and clear SmsApplicationSid if set, since
  //    that would override the direct URL).
  const form = new URLSearchParams();
  form.set("SmsUrl", WEBHOOK_URL);
  form.set("SmsMethod", "POST");
  // Clear SmsApplicationSid in case it's set — empty string unbinds it.
  if (target.sms_application_sid) form.set("SmsApplicationSid", "");

  const updRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/IncomingPhoneNumbers/${target.sid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: basicAuth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  if (!updRes.ok) {
    return json({
      ok: false,
      step: "update",
      status: updRes.status,
      body: await updRes.text(),
      before,
    }, 502);
  }
  const updated = await updRes.json() as TwilioPhoneNumber;
  const after = {
    phone:        updated.phone_number,
    sid:          updated.sid,
    sms_url:      updated.sms_url,
    sms_method:   updated.sms_method,
    sms_fallback_url: updated.sms_fallback_url,
    sms_application_sid: updated.sms_application_sid,
  };

  return json({
    ok:     true,
    action: "updated",
    message: `Twilio +${updated.phone_number.replace(/^\+/, "")} webhook now points at our function.`,
    before,
    after,
  });
});
