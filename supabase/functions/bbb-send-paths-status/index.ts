/**
 * bbb-send-paths-status — returns the live state of BBB_SEND_PATHS_ENABLED.
 *
 * This is the truth source the /ops Pipeline view calls so the dashboard
 * matches what stripe-webhook actually does. Whatever you type into the env
 * var in Supabase Dashboard → Edge Functions → bbb-send-paths-status →
 * Settings, this endpoint returns. Same default fallback as stripe-webhook.
 *
 * Read-only, no side effects. Public — there is nothing sensitive to leak;
 * the env var only lists the NAMES of allowed send paths, not credentials.
 *
 * Deploy: supabase functions deploy bbb-send-paths-status --no-verify-jwt
 *
 * IMPORTANT: when you edit BBB_SEND_PATHS_ENABLED, edit it on BOTH this
 * function AND stripe-webhook. They share the same default — if you only
 * change one, the dashboard and reality drift apart. Same string in both.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DEFAULT_ENABLED_PATHS = "stripe_owner_sms,stripe_customer_welcome_email";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const raw = Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? DEFAULT_ENABLED_PATHS;
  const enabled = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const body = {
    enabled,
    raw,
    is_default: !Deno.env.get("BBB_SEND_PATHS_ENABLED"),
    as_of: new Date().toISOString(),
    // Mirror — the full menu of known paths so the UI can show ON vs OFF for all of them
    known_paths: [
      "stripe_owner_email",
      "stripe_owner_sms",
      "stripe_customer_welcome_email",
      "stripe_customer_welcome_sms",
      "justin_daily_digest",
      "trial_membership_nudge",
    ],
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
