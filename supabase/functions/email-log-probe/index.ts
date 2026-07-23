/**
 * email-log-probe — fire a controlled INSERT into email_log and return the
 * actual {error} response from supabase-js. Used to diagnose why writes
 * have been silently failing for weeks (task #319).
 *
 * Strategy:
 *   1. Insert one test row with the exact same payload shape stripe-webhook +
 *      abandoned-cart-followup use.
 *   2. Capture and return ALL of the supabase-js return value (data + error).
 *   3. We'll see the real pg_code + pg_message so we know what to fix.
 *
 * Deploy + call:
 *   supabase functions deploy email-log-probe --no-verify-jwt --project-ref uracuwugpxqjfgtuobal
 *   curl -X POST -H "x-bbb-secret: bbb-test-2026-05-27" \
 *     https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/email-log-probe | jq
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  const ADMIN = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
  const secret = req.headers.get("x-bbb-secret") ?? "";
  if (secret !== ADMIN) return json({ ok: false, error: "unauthorized" }, 401);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Probe 1: exact stripe-webhook payload
  const payload1 = {
    resend_id:       "probe-" + Date.now(),
    event_type:      "sent_inline",
    from_addr:       "probe@betterbodybootcamp.com",
    to_addrs:        ["nobody@example.invalid"],
    subject:         "probe " + new Date().toISOString(),
    send_path:       "email_log_probe",
    trial_signup_id: null,
    raw:             { studio_slug: "bayside", inline: true, probe: true },
  };
  const probe1 = await sb.from("email_log").insert(payload1).select("id");

  // Probe 2: minimal payload (only required columns)
  const payload2 = {
    event_type: "probe_minimal",
    to_addrs:   ["nobody@example.invalid"],
  };
  const probe2 = await sb.from("email_log").insert(payload2).select("id");

  // Probe 3: schema discovery via select on a non-existent guard column to
  // confirm what columns the table currently has.
  const schemaProbe = await sb.from("email_log").select("*").limit(0);

  // Probe 4: total row count
  const { count } = await sb.from("email_log").select("*", { head: true, count: "exact" });

  return json({
    ok: true,
    diagnosis: probe1.error
      ? `INSERT FAILS — pg_code ${(probe1.error as any).code}: ${probe1.error.message}`
      : "INSERT SUCCEEDED — schema is fine, look upstream for the swallowed error",
    probe1_full_payload: {
      payload: payload1,
      data:    probe1.data,
      error:   probe1.error,
    },
    probe2_minimal_payload: {
      payload: payload2,
      data:    probe2.data,
      error:   probe2.error,
    },
    schema_select_error:   schemaProbe.error,
    current_row_count:     count,
  });
});
