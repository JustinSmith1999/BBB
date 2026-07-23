/**
 * stripe-webhook-heartbeat — runs every 15 min via cron.
 *
 * Calls check_stripe_webhook_heartbeat(). If status='down' OR status='degraded',
 * fires ONE alert email + ONE alert SMS to Justin. Uses last_alerted_at column
 * on a tiny ops_alerts table so we don't spam — re-alert max once per hour
 * while status stays bad.
 *
 * No customer-facing comms here. Justin-only.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const JUSTIN_EMAIL = "Justin@j20solutions.com";
const JUSTIN_PHONE = "+16317086585";  // from Twilio probe history
const ALERT_KEY    = "stripe_webhook_heartbeat";
const RE_ALERT_INTERVAL_MIN = 60;

Deno.serve(async () => {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: rows, error } = await sb.rpc("check_stripe_webhook_heartbeat");
    if (error) throw new Error("rpc failed: " + error.message);
    const row = (rows ?? [])[0];
    if (!row) return json({ ok: true, skipped: "no rows" });

    const { status, paid_in_last_hour, capi_ok_last_hour, capi_fail_last_hour, detail } = row;
    // For backward-compat with the alert format we keep a "webhook" tally:
    const webhook_in_last_hour = capi_ok_last_hour;

    if (status === "ok" || status === "idle") {
      // Reset re-alert window so the NEXT outage triggers immediately.
      await sb.from("ops_alerts")
        .upsert({ key: ALERT_KEY, last_status: status, last_alerted_at: null, last_seen_at: new Date().toISOString() },
                { onConflict: "key" });
      return json({ ok: true, status, detail });
    }

    // status is 'down' or 'degraded' — alert if we haven't in the last 60 min.
    const { data: prev } = await sb.from("ops_alerts").select("last_alerted_at").eq("key", ALERT_KEY).maybeSingle();
    const cooldownMs = RE_ALERT_INTERVAL_MIN * 60 * 1000;
    const since = prev?.last_alerted_at ? Date.now() - new Date(prev.last_alerted_at).getTime() : Infinity;
    if (since < cooldownMs) {
      return json({ ok: true, status, detail, suppressed: "within cooldown", since_min: Math.round(since/60000) });
    }

    const subject = `STRIPE WEBHOOK ${status.toUpperCase()} — ${webhook_in_last_hour}/${paid_in_last_hour} in last 60min`;
    const body    = `${detail}\n\nDashboard: https://uracuwugpxqjfgtuobal.supabase.co/project/uracuwugpxqjfgtuobal/functions/stripe-webhook/logs\nStripe webhooks: https://dashboard.stripe.com/webhooks\n\nCheck: did Stripe SDK auto-upgrade? grep stripe-webhook/index.ts for npm:stripe — must be EXACT pin not ^.`;

    // Send email via Resend
    const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
    if (resendKey) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ops@betterbodybootcamp.com",
          to:   [JUSTIN_EMAIL],
          subject,
          text: body,
        }),
      });
    }

    // Send SMS via Twilio
    const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const tok = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const fr  = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
    if (sid && tok && fr) {
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${sid}:${tok}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: fr, To: JUSTIN_PHONE, Body: subject + " — check email." }).toString(),
      });
    }

    await sb.from("ops_alerts").upsert(
      { key: ALERT_KEY, last_status: status, last_alerted_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
      { onConflict: "key" },
    );

    return json({ ok: true, status, detail, alerted: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
}
