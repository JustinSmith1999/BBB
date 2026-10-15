/**
 * owner-sms-trace — READ ONLY. End to end: does the owner trial text actually
 * reach Chris and Steve?
 *
 * Built 2026-10-13 after Chris reported entering a trial and getting no text.
 * Astoria and Williamsburg are not on Quo, so their owner alerts go out over
 * Twilio from manual-welcome-batch. This walks every link in that chain and
 * reports where it stops. Writes nothing, sends nothing.
 *
 * THE CHAIN
 *   1. location_owners        is there a row, with a good phone, notify_signups on?
 *   2. sms_messages           did manual-welcome-batch log an owner alert?
 *   3. Twilio API             what does Twilio say actually happened to it?
 *
 * Step 3 is the one nobody has done. sms_messages writes status:"queued" and
 * never updates it, because no status callback was ever wired up (see the note
 * in _shared/sms.ts: ~90% of outbound texts sit at "queued" forever). So a
 * "queued" row in our database tells you nothing at all about delivery. Only
 * Twilio knows. This asks Twilio, per message, and surfaces error codes.
 *
 * Twilio error codes worth knowing when they show up:
 *   30003 unreachable handset   30005 unknown destination
 *   30006 landline or unreachable carrier
 *   30007 carrier filtered (spam block)  <- the usual A2P culprit
 *   30008 unknown error         21610 recipient replied STOP
 *
 * Body: { "days": 21, "max_twilio_lookups": 60 }
 * Auth: x-bbb-secret.  Deploy: bbb deploy-fn owner-sms-trace
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

// Known location ids, because the locations table has no slug column and the
// name-based fallback produced "(unmapped:...)" for every row on 2026-10-13.
const LOC: Record<string, string> = {
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": "astoria",
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": "bayside",
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": "fresh-meadows",
  "80536b45-df0e-42d1-880c-e9301372e1cf": "williamsburg",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const days = Math.min(Math.max(Number(body.days ?? 21), 1), 120);
  const maxLookups = Math.min(Math.max(Number(body.max_twilio_lookups ?? 60), 0), 200);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── LINK 1: who is configured to receive the alert ────────────────────────
  const { data: owners, error: oErr } = await sb
    .from("location_owners")
    .select("location_id,owner_name,phone,notify_signups");
  if (oErr) return json({ ok: false, error: `location_owners: ${oErr.message}` }, 502);

  const ownersByStudio: Record<string, any[]> = {};
  for (const o of owners || []) {
    const slug = LOC[(o as any).location_id] || `(unmapped:${(o as any).location_id})`;
    (ownersByStudio[slug] ||= []).push({
      name: (o as any).owner_name,
      phone: (o as any).phone,
      notify_signups: (o as any).notify_signups,
      phone_looks_valid: /^\+1\d{10}$/.test(String((o as any).phone || "")),
    });
  }

  // ── LINK 2: what did we actually log ──────────────────────────────────────
  const { data: msgs, error: mErr } = await sb
    .from("sms_messages")
    .select("id,studio_slug,to_phone,from_phone,twilio_sid,status,sent_by,created_at,body")
    .gte("created_at", since)
    .eq("sent_by", "manual_owner_alert")
    .order("created_at", { ascending: false })
    .limit(500);
  if (mErr) return json({ ok: false, error: `sms_messages: ${mErr.message}` }, 502);

  // The wider backlog, for context on the 3,492-queued problem
  const { count: queuedCount } = await sb
    .from("sms_messages").select("id", { count: "exact", head: true }).eq("status", "queued");
  const { count: failedCount } = await sb
    .from("sms_messages").select("id", { count: "exact", head: true }).eq("status", "failed");

  // ── LINK 3: ask Twilio what really happened ───────────────────────────────
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const tok = Deno.env.get("TWILIO_AUTH_TOKEN");
  const auth = sid && tok ? "Basic " + btoa(`${sid}:${tok}`) : null;

  const checked: any[] = [];
  const statusTally: Record<string, number> = {};
  const errorTally: Record<string, number> = {};
  let looked = 0;

  if (auth) {
    for (const m of msgs || []) {
      if (looked >= maxLookups) break;
      const msid = (m as any).twilio_sid;
      if (!msid) {
        statusTally["(no twilio_sid logged)"] = (statusTally["(no twilio_sid logged)"] || 0) + 1;
        continue;
      }
      looked++;
      try {
        const r = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/${msid}.json`,
          { headers: { Authorization: auth } },
        );
        const j = await r.json().catch(() => ({}));
        const st = r.ok ? String((j as any).status) : `lookup_failed_${r.status}`;
        const ec = (j as any).error_code ? String((j as any).error_code) : null;
        statusTally[st] = (statusTally[st] || 0) + 1;
        if (ec) errorTally[ec] = (errorTally[ec] || 0) + 1;
        checked.push({
          at: (m as any).created_at,
          studio: (m as any).studio_slug,
          to: (m as any).to_phone,
          our_status: (m as any).status,
          twilio_status: st,
          twilio_error_code: ec,
          twilio_error_message: (j as any).error_message ?? null,
        });
      } catch (e) {
        statusTally["lookup_exception"] = (statusTally["lookup_exception"] || 0) + 1;
        checked.push({ at: (m as any).created_at, to: (m as any).to_phone, error: String(e).slice(0, 120) });
      }
    }
  }

  const byStudio: Record<string, number> = {};
  for (const m of msgs || []) {
    const k = String((m as any).studio_slug || "(none)");
    byStudio[k] = (byStudio[k] || 0) + 1;
  }

  return json({
    ok: true,
    read_only: true,
    window_days: days,
    since,
    link1_configured_owners: ownersByStudio,
    link2_owner_alerts_logged: {
      total: (msgs || []).length,
      by_studio: byStudio,
      note: "These are rows manual-welcome-batch wrote after Twilio accepted the message. A missing row means the alert was never attempted.",
    },
    link3_twilio_truth: {
      twilio_credentials_present: !!auth,
      messages_looked_up: looked,
      status_counts: statusTally,
      error_code_counts: errorTally,
      note: "our_status is always 'queued' because no status callback was ever wired. Trust twilio_status. delivered = it arrived. undelivered/failed with 30007 = carrier spam filtering, which is the usual cause of an owner never seeing the text.",
      sample: checked.slice(0, 40),
    },
    wider_backlog: { rows_stuck_at_queued: queuedCount ?? null, rows_failed: failedCount ?? null },
  });
});
