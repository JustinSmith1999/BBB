/**
 * probe-twilio — minimal verification endpoint for the Twilio credentials.
 *
 * Mirror of probe-resend. Confirms two things:
 *   1. TWILIO_* env vars are set on this function (proves project-wide
 *      secrets propagate to stripe-webhook's runtime too).
 *   2. The credentials are valid by hitting Twilio's read-only Account API.
 *
 * Optional: pass {"send_test": true, "to": "+1XXXXXXXXXX"} to fire ONE real
 * SMS so we can see it land. Off by default. Don't send to a customer.
 *
 * Deploy: supabase functions deploy probe-twilio --no-verify-jwt
 *
 * Use:
 *   curl -s https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/probe-twilio | jq
 *   curl -s -X POST https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/probe-twilio \
 *        -H 'content-type: application/json' \
 *        -d '{"send_test": true, "to": "+1XXXXXXXXXX"}' | jq
 *
 * Disposable. After verification:
 *   supabase functions delete probe-twilio --project-ref uracuwugpxqjfgtuobal
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sid   = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from  = Deno.env.get("TWILIO_FROM_NUMBER");

  const out: Record<string, unknown> = {
    twilio_account_sid_present: !!sid,
    twilio_account_sid_prefix:  sid ? sid.slice(0, 5) : null,   // "ACdb9..."
    twilio_auth_token_present:  !!token,
    twilio_from_number:         from ?? null,
    function_name: "probe-twilio",
    as_of: new Date().toISOString(),
  };

  if (!sid || !token) {
    return new Response(JSON.stringify({ ...out, ok: false, error: "Twilio creds incomplete" }, null, 2),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // 1. Validate the credentials against Twilio /Accounts/<sid>.json (read-only)
  try {
    const auth = "Basic " + btoa(`${sid}:${token}`);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: auth },
    });
    out.twilio_account_status = r.status;
    if (r.ok) {
      const body = await r.json() as { friendly_name?: string; status?: string; type?: string };
      out.twilio_account = {
        friendly_name: body.friendly_name,
        status: body.status,
        type: body.type,
      };
    } else {
      out.twilio_account_body = (await r.text()).slice(0, 400);
    }
  } catch (e) {
    out.twilio_account_error = (e as Error).message;
  }

  // 2. Optionally fire a real test SMS — GATED by the master SMS guardrail.
  let body: any = {};
  try { body = await req.json(); } catch {}
  if (body?.send_test === true) {
    // Same master gate as automated SMS in stripe-webhook. Even this probe
    // can't fire an SMS unless BBB_SMS_AUTO_SEND_ENABLED is explicitly "true".
    if (Deno.env.get("BBB_SMS_AUTO_SEND_ENABLED") !== "true") {
      out.send_test = { ok: false, error: "send_test BLOCKED — BBB_SMS_AUTO_SEND_ENABLED is not 'true'. Set the secret to re-arm SMS sending." };
      return new Response(JSON.stringify({ ok: true, ...out }, null, 2),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }
    const to = String(body?.to || "").trim();
    if (!from) {
      out.send_test = { ok: false, error: "TWILIO_FROM_NUMBER not set" };
    } else if (!/^\+\d{10,15}$/.test(to)) {
      out.send_test = { ok: false, error: "send_test requires 'to' in E.164 format like +13474390941" };
    } else {
      try {
        const auth = "Basic " + btoa(`${sid}:${token}`);
        const r = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              From: from,
              To: to,
              Body: `probe-twilio - verification SMS from BBB stack. Sent ${new Date().toISOString()}.`,
            }).toString(),
          },
        );
        const respBody = await r.json();
        out.send_test = {
          ok: r.ok,
          status: r.status,
          sid: respBody?.sid ?? null,
          twilio_status: respBody?.status ?? null,
          error: r.ok ? null : respBody,
        };
      } catch (e) {
        out.send_test = { ok: false, error: (e as Error).message };
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, ...out }, null, 2),
    { headers: { ...cors, "Content-Type": "application/json" } });
});
