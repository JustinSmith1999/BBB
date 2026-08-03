/**
 * winback-49-report · tracking feed for the "BBB Winback $49" Google Sheet
 *
 * Returns one row per winback recipient:
 *   name, email, studio, email_sent_at, sms_sent_at,
 *   delivery  — Resend last_event (delivered / opened / clicked / bounced / …)
 *   outcome   — "CONVERTED 🎉" if a completed purchase exists for that email
 *               dated after the send (trial_signups OR mariana_tek_sales),
 *               else current front_desk_stage, else "no response yet"
 *
 * Auth: x-bbb-secret. GET or POST. The live Google Sheet's Apps Script calls
 * this every refresh. Resend lookups are capped + cached-ish (only rows with
 * a stored resend id are queried; failures degrade to "sent").
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const secret = req.headers.get("x-bbb-secret") || url.searchParams.get("secret") || "";
  if (secret !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", SR);
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");

  const { data: rows, error } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, winback49_email_sent_at, winback49_sms_sent_at, winback49_resend_id, winback49_converted_at, front_desk_stage")
    .not("winback49_email_sent_at", "is", null)
    .order("winback49_email_sent_at", { ascending: true });
  if (error) return json({ ok: false, error: error.message }, 500);
  if (!rows?.length) return json({ ok: true, rows: [] });

  const locIds = Array.from(new Set(rows.map((r) => r.location_id)));
  const { data: locs } = await sb.from("locations").select("id, name").in("id", locIds);
  const locName = new Map((locs || []).map((l: any) => [l.id, l.name]));

  // Conversions: completed purchases under the same email AFTER the send
  const emails = rows.map((r) => (r.email || "").toLowerCase().trim());
  const conv = new Map<string, string>(); // email -> converted_at
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    const { data: t } = await sb.from("trial_signups").select("email, created_at").eq("payment_status", "completed").in("email", chunk);
    (t || []).forEach((r: any) => conv.set((r.email || "").toLowerCase().trim(), r.created_at));
    const { data: s } = await sb.from("mariana_tek_sales").select("customer_email, sale_date_time").gt("total_cents", 0).in("customer_email", chunk);
    (s || []).forEach((r: any) => {
      const e = (r.customer_email || "").toLowerCase().trim();
      if (!conv.has(e)) conv.set(e, r.sale_date_time);
    });
  }

  // Resend delivery status (last_event) — best effort, max 150 lookups
  const status = new Map<string, string>();
  if (RESEND_KEY) {
    const withIds = rows.filter((r) => r.winback49_resend_id).slice(0, 150);
    await Promise.all(withIds.map(async (r) => {
      try {
        const resp = await fetch(`https://api.resend.com/emails/${r.winback49_resend_id}`, {
          headers: { "Authorization": `Bearer ${RESEND_KEY}` },
        });
        const j: any = await resp.json().catch(() => ({}));
        if (resp.ok && j.last_event) status.set(r.id, j.last_event);
      } catch (_) { /* degrade to "sent" */ }
    }));
  }

  const out = rows.map((r) => {
    const emailLc = (r.email || "").toLowerCase().trim();
    const convAt = conv.get(emailLc);
    // 2026-07-31: once winback49_converted_at is stamped it is the source of
    // truth — recomputing from row created_at broke when Meghan's OLD lead row
    // was upgraded to completed (June created_at predates the send).
    const converted = !!r.winback49_converted_at ||
      (convAt && r.winback49_email_sent_at && convAt > r.winback49_email_sent_at);
    if (converted && !r.winback49_converted_at) {
      // stamp it (fire-and-forget) so the winback sender never re-touches them
      sb.from("trial_signups").update({ winback49_converted_at: convAt }).eq("id", r.id).then(() => {});
    }
    return {
      name: r.name,
      email: r.email,
      studio: locName.get(r.location_id) || "",
      email_sent_at: r.winback49_email_sent_at,
      sms_sent_at: r.winback49_sms_sent_at,
      delivery: status.get(r.id) || (r.winback49_resend_id ? "sent" : ""),
      outcome: converted ? "CONVERTED 🎉" : (r.front_desk_stage && r.front_desk_stage !== "new_lead" ? r.front_desk_stage : "no response yet"),
    };
  });
  return json({ ok: true, count: out.length, converted: out.filter((r) => r.outcome.startsWith("CONVERTED")).length, rows: out });
});
