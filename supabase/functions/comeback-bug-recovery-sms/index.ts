/**
 * comeback-bug-recovery-sms — Apology SMS to customers who received the $29
 * 1-week comeback offer on 6/12 but couldn't actually use it because the
 * create-trial-checkout function (shared by both $49 trial AND $29 comeback
 * via priceVariant) was silently broken 6/11-6/17 morning.
 *
 * Cohort: trial_signups WHERE
 *   - comeback_sms_sent_at IS NOT NULL (got the original offer)
 *   - comeback_sms_sent_at >= 2026-06-11 (sent during bug window)
 *   - comeback_converted_at IS NULL (didn't pay $29 — would have been impossible
 *     anyway since session_was_created was false for all 24)
 *   - payment_status != 'completed' (didn't paid via any path)
 *   - deleted_at IS NULL
 *   - has phone
 *   - dedup by phone last-10
 *   - not already in this recovery batch (send_path idempotency)
 *
 * Personalization:
 *   - First name
 *   - Studio short name
 *   - Day-of-week + (M/D) when the offer was sent
 *   - Direct comeback URL with UTM tracking
 *   - Owner-voiced apology
 *
 * Idempotency: send_path = 'comeback_bug_recovery_2026_06_17'
 *
 * Throttle: 400ms (Twilio TFV 2.5/sec ceiling).
 *
 * Auth: x-bbb-secret header.
 *
 * Modes:
 *   { "dry_run": true }   → count + sample, no sends (DEFAULT)
 *   { "dry_run": false }  → live send
 *
 * Deploy:
 *   supabase functions deploy comeback-bug-recovery-sms --no-verify-jwt \
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
const SEND_PATH      = "comeback_bug_recovery_2026_06_17";

// Bug window: original create-trial-checkout broke 6/11, fixed 6/17 09:00 ET.
const COMEBACK_FIRE_START = "2026-06-11T00:00:00Z";
const COMEBACK_FIRE_END   = "2026-06-17T13:00:00Z";

const STUDIOS: Record<string, { slug: string; shortName: string }> = {
  "80536b45-df0e-42d1-880c-e9301372e1cf": { slug: "williamsburg",  shortName: "Williamsburg" },
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": { slug: "astoria",       shortName: "Astoria" },
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": { slug: "bayside",       shortName: "Bayside" },
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": { slug: "fresh-meadows", shortName: "Fresh Meadows" },
};

function formatOfferDate(isoSentAt: string): string {
  const d = new Date(isoSentAt);
  const opts: Intl.DateTimeFormatOptions = { timeZone: "America/New_York" };
  const weekday = new Intl.DateTimeFormat("en-US", { ...opts, weekday: "long" }).format(d);
  const month   = new Intl.DateTimeFormat("en-US", { ...opts, month: "numeric" }).format(d);
  const day     = new Intl.DateTimeFormat("en-US", { ...opts, day:   "numeric" }).format(d);
  return `${weekday} (${month}/${day})`;
}

// Owner-voiced apology about the broken comeback link. Short, specific,
// owns the failure, makes the next step trivial.
//
// URL includes ?ref=<row_id> so the comeback signup page can:
//   1. Pre-fill the form with the customer's existing name/email/phone
//   2. Fire comeback_clicked_at PATCH (without ref, click tracking is dead)
//   3. Credit comeback_converted_at to the ORIGINAL trial_signups row when paid
function buildBody(firstName: string, studioShort: string, studioSlug: string, offerDateStr: string, refSignupId: string) {
  return (
    `Hi ${firstName}, Justin from Better Body Bootcamp. ` +
    `I sent you the $29 1-week comeback offer ${offerDateStr} but our checkout was broken at the time — sorry about that. ` +
    `It's fixed now, your $29 week is here: https://betterbodybootcamp.com/comeback/${studioSlug}?ref=${refSignupId}&utm_source=comeback_recovery_sms&utm_campaign=checkout_fix_0617`
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

  // ── Cohort: comeback recipients who never converted
  const { data: candidates, error: cErr } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, comeback_sms_sent_at, comeback_converted_at, payment_status")
    .not("comeback_sms_sent_at", "is", null)
    .gte("comeback_sms_sent_at", COMEBACK_FIRE_START)
    .lt("comeback_sms_sent_at",  COMEBACK_FIRE_END)
    .is("comeback_converted_at", null)
    .neq("payment_status", "completed")
    .not("phone", "is", null)
    .is("deleted_at", null)
    .order("comeback_sms_sent_at", { ascending: false });

  if (cErr) return json({ ok: false, where: "candidates", error: cErr.message }, 500);

  // ── Idempotency: anyone already sent THIS recovery campaign
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

  // ── Filter + dedupe by phone last-10
  type Row = NonNullable<typeof candidates>[number];
  const seenPhonesInRun = new Set<string>();
  const willSend: Array<{ row: Row; studio: { slug: string; shortName: string }; e164: string; offerDate: string }> = [];
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
      offerDate: formatOfferDate(row.comeback_sms_sent_at as string),
    });
  }

  // ── DRY RUN
  if (dryRun) {
    const byStudio: Record<string, number> = {};
    for (const w of willSend) byStudio[w.studio.slug] = (byStudio[w.studio.slug] ?? 0) + 1;

    return json({
      ok: true,
      dry_run: true,
      window_start: COMEBACK_FIRE_START,
      window_end:   COMEBACK_FIRE_END,
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
        offer_date: w.offerDate,
        body: buildBody((w.row.name ?? "there").split(" ")[0], w.studio.shortName, w.studio.slug, w.offerDate, w.row.id),
      })),
      all_recipients: willSend.map((w) => ({
        name: w.row.name,
        phone: w.e164,
        studio: w.studio.slug,
        offer_date: w.offerDate,
      })),
    });
  }

  // ── LIVE SEND with throttle
  const results: Array<{ id: string; phone: string; name: string; ok: boolean; sid?: string; err?: string }> = [];
  for (let i = 0; i < willSend.length; i++) {
    const { row, studio, e164, offerDate } = willSend[i];
    const first = (row.name ?? "there").split(" ")[0];
    const text = buildBody(first, studio.shortName, studio.slug, offerDate, row.id);

    const r = await sendTwilio(e164, text);
    if (!r.ok) {
      results.push({ id: row.id, name: row.name ?? "", phone: e164, ok: false, err: r.error ?? `status_${r.status}` });
    } else {
      // Log to sms_messages with proper schema. Schema audit showed inserts
      // were silently failing in checkout-bug-recovery-sms — likely a column
      // mismatch. Wrapping in try/catch and logging errors so we catch this
      // time rather than silently dropping the log.
      try {
        const { error: logErr } = await sb.from("sms_messages").insert({
          direction:       "outbound",
          from_phone:      TWILIO_FROM,
          to_phone:        e164,
          body:            text,
          sent_at:         new Date().toISOString(),
          send_path:       SEND_PATH,
          trial_signup_id: row.id,
          twilio_sid:      r.sid ?? null,
          raw:             { studio_slug: studio.slug, offer_date: offerDate, source: "comeback-bug-recovery-sms" },
        });
        if (logErr) console.error("sms_messages log failed:", logErr.message, logErr.details ?? "");
      } catch (e) {
        console.error("sms_messages log exception:", (e as Error).message);
      }
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
