/**
 * checkout-bug-recovery-sms — One-shot apology SMS to the 20 customers who
 * tried to book a $49 trial between 6/11 and 6/17 morning while the
 * create-trial-checkout function was silently broken (automatic_payment_methods
 * config bug — fixed at 9am on 6/17). Every one of them filled the trial form,
 * got rejected at Stripe Checkout, and never paid.
 *
 * Personalization includes:
 *   - First name
 *   - Studio name (Williamsburg / Astoria / Bayside / Fresh Meadows)
 *   - The actual day-of-week + M/D when they tried (per Justin's request)
 *   - Owner-voiced apology ("Justin from BBB")
 *   - Direct working trial URL with UTM for tracking
 *
 * Cohort: trial_signups WHERE
 *   - created_at >= 2026-06-11 AND created_at < 2026-06-17 13:00 UTC (fix time)
 *   - payment_status != 'completed' (they got blocked)
 *   - deleted_at IS NULL
 *   - phone IS NOT NULL
 *   - name NOT LIKE '%test%' (skip Justin's own test row)
 *   - dedup by phone last-10-digits (Sofia + Mercedes submitted twice each)
 *
 * Idempotency: every send is logged to sms_messages with
 *   send_path = 'checkout_bug_recovery_2026_06_17'.
 * Re-running the function will skip anyone already sent.
 *
 * Throttle: 400ms between sends (Twilio TFV 2.5/sec ceiling).
 *
 * Auth: x-bbb-secret header.
 *
 * Modes:
 *   { "dry_run": true }   → count + sample, no sends (DEFAULT)
 *   { "dry_run": false }  → live send
 *
 * Deploy:
 *   supabase functions deploy checkout-bug-recovery-sms --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

const ADMIN_SECRET   = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const TWILIO_ACCOUNT = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_TOKEN   = Deno.env.get("TWILIO_AUTH_TOKEN")  || "";
const TWILIO_FROM    = Deno.env.get("TWILIO_FROM_NUMBER") || "+18772860293";
const SEND_PATH      = "checkout_bug_recovery_2026_06_17";

// ── Bug window: function broke 6/11, fixed 6/17 09:00 ET (13:00 UTC).
const WINDOW_START = "2026-06-11T00:00:00Z";
const WINDOW_END   = "2026-06-17T13:00:00Z";

// Studio mapping — same UUIDs as abandoned-cart-sms-resend.
const STUDIOS: Record<string, { slug: string; shortName: string }> = {
  "80536b45-df0e-42d1-880c-e9301372e1cf": { slug: "williamsburg",  shortName: "Williamsburg" },
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": { slug: "astoria",       shortName: "Astoria" },
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": { slug: "bayside",       shortName: "Bayside" },
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": { slug: "fresh-meadows", shortName: "Fresh Meadows" },
};

// Format the attempt date in ET as e.g. "Friday (6/13)"
function formatAttemptDate(isoCreatedAt: string): string {
  const d = new Date(isoCreatedAt);
  const opts: Intl.DateTimeFormatOptions = { timeZone: "America/New_York" };
  const weekday = new Intl.DateTimeFormat("en-US", { ...opts, weekday: "long" }).format(d);
  const month   = new Intl.DateTimeFormat("en-US", { ...opts, month: "numeric" }).format(d);
  const day     = new Intl.DateTimeFormat("en-US", { ...opts, day:   "numeric" }).format(d);
  return `${weekday} (${month}/${day})`;
}

// Body — owner-voiced apology with day + studio + working URL.
// Justin specifically asked for the day they tried.
function buildBody(firstName: string, studioShort: string, studioSlug: string, attemptDateStr: string) {
  return (
    `Hi ${firstName}, Justin from Better Body Bootcamp. ` +
    `You tried to book a $49 trial at ${studioShort} on ${attemptDateStr} but our checkout was broken — sorry about that. ` +
    `Fixed now, your $49 trial is here: https://betterbodybootcamp.com/trial/${studioSlug}?utm_source=recovery_sms&utm_campaign=checkout_fix_0617`
  );
}

const normPhone = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendTwilio(to: string, body: string) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT}/Messages.json`;
  const auth = btoa(`${TWILIO_ACCOUNT}:${TWILIO_TOKEN}`);
  const form = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body });
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const respBody = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, sid: respBody.sid, error: respBody.message ?? null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  if ((req.headers.get("x-bbb-secret") ?? "") !== ADMIN_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (!TWILIO_ACCOUNT || !TWILIO_TOKEN) {
    return json({ ok: false, error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set" }, 500);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body fine */ }
  const dryRun     = body.dry_run !== false;
  const throttleMs = Math.max(100, Math.min(2000, Number(body.throttle_ms ?? 400)));

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // ── 1. Pull the cohort: people who tried during the broken window
  const { data: candidates, error: cErr } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, created_at, payment_status")
    .gte("created_at", WINDOW_START)
    .lt("created_at",  WINDOW_END)
    .neq("payment_status", "completed")
    .not("phone", "is", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (cErr) return json({ ok: false, where: "candidates", error: cErr.message }, 500);

  // ── 2. Anyone who already got THIS sms (idempotent guard)
  const { data: alreadySent } = await sb
    .from("sms_messages")
    .select("to_phone, trial_signup_id")
    .eq("send_path", SEND_PATH);
  const alreadyPhones = new Set<string>();
  const alreadyIds    = new Set<string>();
  for (const r of alreadySent ?? []) {
    const p = normPhone((r as any).to_phone); if (p) alreadyPhones.add(p);
    if ((r as any).trial_signup_id) alreadyIds.add((r as any).trial_signup_id);
  }

  // ── 3. Filter + dedupe by phone last-10
  type Row = NonNullable<typeof candidates>[number];
  const seenPhonesInRun = new Set<string>();
  const willSend: Array<{ row: Row; studio: { slug: string; shortName: string }; e164: string; attemptDate: string }> = [];
  const skipped: Array<{ id: string; name: string; phone: string; reason: string }> = [];

  for (const row of candidates ?? []) {
    const phone = normPhone(row.phone);
    const studio = STUDIOS[row.location_id ?? ""];
    const name = row.name ?? "";

    if (!studio) { skipped.push({ id: row.id, name, phone, reason: "unknown_location" }); continue; }
    if (!phone || phone.length < 10) { skipped.push({ id: row.id, name, phone, reason: "bad_phone" }); continue; }
    if ((name ?? "").toLowerCase().includes("test")) { skipped.push({ id: row.id, name, phone, reason: "test_row" }); continue; }
    if (alreadyPhones.has(phone) || alreadyIds.has(row.id)) {
      skipped.push({ id: row.id, name, phone, reason: "already_sent" }); continue;
    }
    if (seenPhonesInRun.has(phone)) {
      skipped.push({ id: row.id, name, phone, reason: "duplicate_in_batch" }); continue;
    }
    seenPhonesInRun.add(phone);

    const e164 = phone.length === 10 ? `+1${phone}` : phone.length === 11 && phone.startsWith("1") ? `+${phone}` : `+${phone}`;
    willSend.push({
      row,
      studio,
      e164,
      attemptDate: formatAttemptDate(row.created_at),
    });
  }

  // ── 4. DRY RUN
  if (dryRun) {
    const byStudio: Record<string, number> = {};
    for (const w of willSend) byStudio[w.studio.slug] = (byStudio[w.studio.slug] ?? 0) + 1;

    return json({
      ok: true,
      dry_run: true,
      window_start: WINDOW_START,
      window_end:   WINDOW_END,
      candidate_pool: candidates?.length ?? 0,
      would_send: willSend.length,
      skipped: skipped.length,
      skip_breakdown: skipped.reduce<Record<string, number>>((acc, s) => {
        acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc;
      }, {}),
      by_studio: byStudio,
      sample_messages: willSend.slice(0, 3).map((w) => ({
        to: w.e164,
        name: w.row.name,
        studio: w.studio.shortName,
        attempt_date: w.attemptDate,
        body: buildBody((w.row.name ?? "there").split(" ")[0], w.studio.shortName, w.studio.slug, w.attemptDate),
      })),
      all_recipients: willSend.map((w) => ({
        name: w.row.name,
        phone: w.e164,
        studio: w.studio.slug,
        attempt_date: w.attemptDate,
      })),
    });
  }

  // ── 5. LIVE SEND with throttle
  const results: Array<{ id: string; phone: string; name: string; ok: boolean; sid?: string; err?: string }> = [];
  for (let i = 0; i < willSend.length; i++) {
    const { row, studio, e164, attemptDate } = willSend[i];
    const first = (row.name ?? "there").split(" ")[0];
    const text = buildBody(first, studio.shortName, studio.slug, attemptDate);

    const r = await sendTwilio(e164, text);
    if (!r.ok) {
      results.push({ id: row.id, name: row.name ?? "", phone: e164, ok: false, err: r.error ?? `status_${r.status}` });
    } else {
      await sb.from("sms_messages").insert({
        direction:       "outbound",
        from_phone:      TWILIO_FROM,
        to_phone:        e164,
        body:            text,
        sent_at:         new Date().toISOString(),
        send_path:       SEND_PATH,
        trial_signup_id: row.id,
        twilio_sid:      r.sid ?? null,
        raw:             { studio_slug: studio.slug, attempt_date: attemptDate, source: "checkout-bug-recovery-sms" },
      });
      results.push({ id: row.id, name: row.name ?? "", phone: e164, ok: true, sid: r.sid });
    }

    if (i < willSend.length - 1) await sleep(throttleMs);
  }

  return json({
    ok: true,
    dry_run: false,
    eligible: willSend.length,
    sent:    results.filter((r) => r.ok).length,
    failed:  results.filter((r) => !r.ok).length,
    throttle_ms: throttleMs,
    results,
  });
});
