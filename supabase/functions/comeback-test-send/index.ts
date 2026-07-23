/**
 * comeback-test-send — sends one comeback-offer SMS to a specified phone
 * using the exact same template as comeback-offer-cron. For previewing the
 * actual customer experience before unleashing on the 24-person live list.
 *
 * POST body:
 *   { phone: "+1...", first_name: "Justin", studio_slug: "fresh-meadows", studio_name?: "Fresh Meadows" }
 *
 * Deploy + call:
 *   supabase functions deploy comeback-test-send --no-verify-jwt --project-ref uracuwugpxqjfgtuobal
 *   curl -X POST -H "x-bbb-secret: bbb-test-2026-05-27" \
 *     -H "Content-Type: application/json" \
 *     -d '{"phone":"+16317086585","first_name":"Justin","studio_slug":"fresh-meadows","studio_name":"Fresh Meadows"}' \
 *     https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/comeback-test-send | jq
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SITE_URL = Deno.env.get("SITE_URL") || "https://betterbodybootcamp.com";

const STUDIO_NAME: Record<string, string> = {
  "astoria":       "Astoria",
  "bayside":       "Bayside",
  "fresh-meadows": "Fresh Meadows",
  "williamsburg":  "Williamsburg",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  const ADMIN = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
  if ((req.headers.get("x-bbb-secret") ?? "") !== ADMIN) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: { phone?: string; first_name?: string; studio_slug?: string; studio_name?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }

  const phone = String(body.phone || "").trim();
  const firstName = String(body.first_name || "there").trim() || "there";
  const studioSlug = String(body.studio_slug || "fresh-meadows").trim().toLowerCase();
  const studioName = String(body.studio_name || STUDIO_NAME[studioSlug] || studioSlug).trim();

  if (!phone) return json({ ok: false, error: "phone required (E.164 format like +1...)" }, 400);

  // Build a TEST token so the URL renders correctly but is clearly marked
  // as a preview send (the real cron uses a HMAC of trial_signup_id).
  const testToken = "test-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  // Same URL pattern as comeback-offer-cron · comebackUrl()
  const u = new URL(`/comeback/${studioSlug}`, SITE_URL);
  u.searchParams.set("t", testToken);
  u.searchParams.set("c", "sms");
  u.searchParams.set("preview", "1");
  const url = u.toString();

  // EXACT same SMS body template as comeback-offer-cron line 211-215
  const msgBody =
    `Hey ${firstName}, it's Better Body Bootcamp ${studioName}. ` +
    `Noticed you didn't finish signing up for our 2-Week Trial. ` +
    `Want to give it a shot for just $29 / 1 week instead? ` +
    `${url}`;

  // Fire Twilio
  const TWILIO_SID  = Deno.env.get("TWILIO_ACCOUNT_SID")  ?? "";
  const TWILIO_TOK  = Deno.env.get("TWILIO_AUTH_TOKEN")   ?? "";
  const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER")  ?? "";
  if (!TWILIO_SID || !TWILIO_TOK || !TWILIO_FROM) {
    return json({
      ok: false,
      error: "twilio_not_configured",
      sid: !!TWILIO_SID, tok: !!TWILIO_TOK, from: !!TWILIO_FROM,
    }, 500);
  }

  const form = new URLSearchParams();
  form.set("To", phone);
  form.set("From", TWILIO_FROM);
  form.set("Body", msgBody);

  const tres = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOK}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  const tj = await tres.json().catch(() => ({})) as { sid?: string; message?: string; error_code?: number };

  return json({
    ok: tres.ok && !!tj.sid,
    sent_to: phone,
    sms_body: msgBody,
    sms_length_chars: msgBody.length,
    sms_segments: Math.ceil(msgBody.length / 160),
    twilio_response: {
      status: tres.status,
      sid: tj.sid ?? null,
      message: tj.message ?? null,
      error_code: tj.error_code ?? null,
    },
  });
});
