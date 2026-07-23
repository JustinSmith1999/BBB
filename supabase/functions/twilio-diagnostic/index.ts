/**
 * twilio-diagnostic — show what Twilio actually sees for the BBB toll-free
 * number. Used to diagnose the "I texted it but nothing landed" case.
 *
 * Returns:
 *   - Last 10 inbound + outbound messages from Twilio's API perspective
 *   - The phone number's current SMS webhook config
 *   - Toll-free verification status (Twilio's anti-spam approval, which
 *     blocks inbound on toll-free until completed)
 *
 * If `inbound_count` is > 0 → Twilio IS receiving customer texts. Then the
 * issue is on our side (function fails / DB write fails).
 *
 * If `inbound_count` is 0 → Twilio is blocking inbound. Almost always
 * because Toll-Free Verification isn't approved.
 *
 * Deploy:
 *   supabase functions deploy twilio-diagnostic --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 *
 * Call:
 *   curl -X POST -H "x-bbb-secret: bbb-test-2026-05-27" \
 *     https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/twilio-diagnostic | jq
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const BBB_NUMBER = "+18772860293";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  // Auth — accept BBB_ADMIN_SECRET or service role
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ADMIN = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-bbb-secret") ?? "";
  if (!(secret === ADMIN || (SR && bearer === SR))) {
    return json({ ok: false, error: "unauthorized — pass header 'x-bbb-secret: bbb-test-2026-05-27'" }, 401);
  }

  const TW_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const TW_TOK = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  if (!TW_SID || !TW_TOK) return json({ ok: false, error: "Twilio creds missing in env" }, 500);

  const basicAuth = "Basic " + btoa(`${TW_SID}:${TW_TOK}`);

  // 1. Last 10 INBOUND messages To our number (any sender, last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const inboundUrl = `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`
    + `?To=${encodeURIComponent(BBB_NUMBER)}`
    + `&DateSent%3E=${sevenDaysAgo}`
    + `&PageSize=10`;
  const inRes = await fetch(inboundUrl, { headers: { Authorization: basicAuth } });
  const inJson = await inRes.json().catch(() => ({})) as { messages?: Array<Record<string, unknown>> };
  const inboundMsgs = (inJson.messages ?? []).map((m) => ({
    sid:       m.sid,
    from:      m.from,
    to:        m.to,
    direction: m.direction,
    status:    m.status,
    body:      String(m.body ?? "").slice(0, 100),
    sent_at:   m.date_sent,
    error:     m.error_code ? `${m.error_code}: ${m.error_message}` : null,
  }));

  // 2. Last 5 OUTBOUND messages From our number (for sanity)
  const outboundUrl = `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`
    + `?From=${encodeURIComponent(BBB_NUMBER)}`
    + `&PageSize=5`;
  const outRes = await fetch(outboundUrl, { headers: { Authorization: basicAuth } });
  const outJson = await outRes.json().catch(() => ({})) as { messages?: Array<Record<string, unknown>> };
  const outboundMsgs = (outJson.messages ?? []).map((m) => ({
    sid:    m.sid,
    to:     m.to,
    status: m.status,
    body:   String(m.body ?? "").slice(0, 80),
    sent_at: m.date_sent,
    error:  m.error_code ? `${m.error_code}: ${m.error_message}` : null,
  }));

  // 3. Phone number's current webhook config
  const phoneRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(BBB_NUMBER)}`,
    { headers: { Authorization: basicAuth } },
  );
  const phoneJson = await phoneRes.json().catch(() => ({})) as {
    incoming_phone_numbers?: Array<{
      sid: string; phone_number: string; sms_url: string; sms_method: string;
      sms_application_sid: string; status_callback: string;
    }>;
  };
  const phoneRec = phoneJson.incoming_phone_numbers?.[0];

  // 4. Toll-free verification status (if any compliance bundle exists)
  // Twilio's Compliance Registrations API surfaces TFV records.
  const tfvRes = await fetch(
    `https://messaging.twilio.com/v1/Tollfree/Verifications?PageSize=10`,
    { headers: { Authorization: basicAuth } },
  );
  const tfvJson = await tfvRes.json().catch(() => ({})) as {
    verifications?: Array<{
      sid: string; tollfree_phone_number_sid: string;
      status: string; rejection_reason?: string;
      business_name?: string;
    }>;
  };
  const tfvForBBB = (tfvJson.verifications ?? []).filter(
    (v) => phoneRec?.sid && v.tollfree_phone_number_sid === phoneRec.sid,
  );

  return json({
    ok: true,
    bbb_number: BBB_NUMBER,
    inbound_count_7d: inboundMsgs.length,
    outbound_count_recent: outboundMsgs.length,
    phone_config: phoneRec ? {
      sid:        phoneRec.sid,
      sms_url:    phoneRec.sms_url,
      sms_method: phoneRec.sms_method,
      sms_application_sid: phoneRec.sms_application_sid,
      status_callback: phoneRec.status_callback,
    } : null,
    toll_free_verification: tfvForBBB.length > 0 ? tfvForBBB : (tfvJson.verifications?.length ? "found-but-not-for-bbb" : "none-on-account"),
    inbound_messages: inboundMsgs,
    outbound_messages_recent: outboundMsgs,
    diagnosis: inboundMsgs.length > 0
      ? "Twilio IS receiving inbound. Issue is on our side (function error / DB write fail)."
      : "Twilio is NOT delivering inbound to webhook. Most likely cause: Toll-Free Verification not approved.",
  });
});
