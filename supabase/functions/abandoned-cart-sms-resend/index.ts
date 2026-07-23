/**
 * abandoned-cart-sms-resend — Manual one-shot SMS to every lead who
 * abandoned checkout, never paid a trial, and never became a MindBody member.
 *
 * Cohort:
 *   1. trial_signups row exists, payment_status != 'completed'
 *   2. Has a phone number (no SMS w/out a target)
 *   3. NOT in any paid source:
 *        - trial_signups.payment_status = 'completed' (any time, any email/phone)
 *        - stripe_paid_mirror (any amount, by email or phone)
 *   4. NOT a MindBody member:
 *        - no row in mindbody_sales joined via mindbody_clients
 *        - fewer than 3 visits in mindbody_visits
 *   5. NOT already sent THIS SMS (idempotent via sms_messages.send_path
 *      = 'abandoned_sms_resend_1')
 *   6. deleted_at IS NULL (skip soft-deleted spam rows)
 *
 * Throttled to 400ms between sends — Twilio Toll-Free Verification has a soft
 * 3 msg/sec ceiling. 400ms = 2.5/sec, safely below it.
 *
 * Modes:
 *   { "dry_run": true }   → count + sample, no sends (DEFAULT)
 *   { "dry_run": false }  → live send
 *   { "limit": N }        → cap candidates (default 500)
 *   { "studio_slug": "x" } → restrict to one studio (debug only)
 *
 * Auth: x-bbb-secret header.
 *
 * Compliance note: each studio's TFV is approved for transactional SMS to
 * customers who opted in via the trial form. These leads filled the form
 * (consent implied via opt-in checkbox). The body still carries the legally
 * required STOP/HELP instructions.
 *
 * Deploy:
 *   supabase functions deploy abandoned-cart-sms-resend --no-verify-jwt \
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

const ADMIN_SECRET     = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const TWILIO_ACCOUNT   = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_TOKEN     = Deno.env.get("TWILIO_AUTH_TOKEN")  || "";
const TWILIO_FROM      = Deno.env.get("TWILIO_FROM_NUMBER") || "+18772860293";
const SEND_PATH        = "abandoned_sms_resend_1";

// ─── Studio config (slug → display + booking URL slug)
const STUDIOS: Record<string, { slug: string; shortName: string }> = {
  "80536b45-df0e-42d1-880c-e9301372e1cf": { slug: "williamsburg",  shortName: "Williamsburg" },
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": { slug: "astoria",       shortName: "Astoria" },
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": { slug: "bayside",       shortName: "Bayside" },
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": { slug: "fresh-meadows", shortName: "Fresh Meadows" },
};

// Body — keep it short, friendly, signed by studio. Two segments expected.
function buildBody(firstName: string, studioShort: string, studioSlug: string) {
  return (
    `Hi ${firstName}! It's BBB ${studioShort}. ` +
    `Saw you started our 2-week trial but didn't finish — $49 for 14 days unlimited. ` +
    `Finish here: https://betterbodybootcamp.com/trial/${studioSlug} ` +
    `Reply STOP to opt out.`
  );
}

const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
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
  return { ok: resp.ok, status: resp.status, sid: respBody.sid, error: respBody.message ?? null, raw: respBody };
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
  const limit      = Math.max(1, Math.min(1000, Number(body.limit ?? 500)));
  const studioFilt = typeof body.studio_slug === "string" ? body.studio_slug : null;
  const throttleMs = Math.max(100, Math.min(2000, Number(body.throttle_ms ?? 400)));

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // ── 1. Candidate pool: pending trial_signups with a phone number.
  // Any source_category — trial_form, contact_form, schedule_request — all
  // count as "abandoned checkout" because none of them paid.
  const { data: candidates, error: cErr } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, created_at, source_category")
    .eq("payment_status", "pending")
    .not("phone", "is", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cErr) return json({ ok: false, where: "candidates", error: cErr.message }, 500);

  // ── 2. Exclusion sets

  // 2a. Anyone who has ever paid anything (trial_signups completed + mirror)
  const [paidRows, mirrorRows] = await Promise.all([
    sb.from("trial_signups").select("email, phone").eq("payment_status", "completed"),
    sb.from("stripe_paid_mirror").select("customer_email, customer_phone"),
  ]);
  const paidEmails = new Set<string>();
  const paidPhones = new Set<string>();
  for (const r of paidRows.data ?? []) {
    const e = normEmail(r.email);   if (e) paidEmails.add(e);
    const p = normPhone(r.phone);   if (p) paidPhones.add(p);
  }
  for (const m of mirrorRows.data ?? []) {
    const e = normEmail(m.customer_email);   if (e) paidEmails.add(e);
    const p = normPhone(m.customer_phone);   if (p) paidPhones.add(p);
  }

  // 2b. MindBody members (any sale row OR ≥3 visits)
  const memberEmails = new Set<string>();
  const memberPhones = new Set<string>();
  try {
    const { data: mbc } = await sb
      .from("mindbody_clients")
      .select("mindbody_client_id, email, phone")
      .limit(20000);
    const idByEmail = new Map<string, string>();
    const idByPhone = new Map<string, string>();
    for (const c of mbc ?? []) {
      const e = normEmail((c as any).email);
      const p = normPhone((c as any).phone);
      if (e) idByEmail.set(e, (c as any).mindbody_client_id);
      if (p) idByPhone.set(p, (c as any).mindbody_client_id);
    }
    const { data: sales } = await sb
      .from("mindbody_sales").select("mindbody_client_id").limit(50000);
    const buyers = new Set<string>();
    for (const s of sales ?? []) {
      const id = String((s as any).mindbody_client_id ?? "");
      if (id) buyers.add(id);
    }
    const { data: visits } = await sb
      .from("mindbody_visits").select("mindbody_client_id").limit(100000);
    const visitCt = new Map<string, number>();
    for (const v of visits ?? []) {
      const id = String((v as any).mindbody_client_id ?? "");
      if (!id) continue;
      visitCt.set(id, (visitCt.get(id) ?? 0) + 1);
    }
    const heavy = new Set<string>();
    for (const [id, n] of visitCt) if (n >= 3) heavy.add(id);
    for (const [e, id] of idByEmail) if (buyers.has(id) || heavy.has(id)) memberEmails.add(e);
    for (const [p, id] of idByPhone) if (buyers.has(id) || heavy.has(id)) memberPhones.add(p);
  } catch (e) {
    console.error("MindBody exclusion build failed:", (e as Error).message);
  }

  // 2c. Anyone who already got THIS SMS (idempotent)
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

  // ── 3. Filter
  type Row = NonNullable<typeof candidates>[number];
  const seenPhonesInRun = new Set<string>();
  const willSend: Array<{ row: Row; studio: { slug: string; shortName: string }; e164: string }> = [];
  const skipped: Array<{ id: string; name: string; phone: string; reason: string }> = [];

  for (const row of candidates ?? []) {
    const phone = normPhone(row.phone);
    const email = normEmail(row.email);
    const studio = STUDIOS[row.location_id ?? ""];
    const name = row.name ?? "";

    if (!studio) { skipped.push({ id: row.id, name, phone, reason: "unknown_location" }); continue; }
    if (studioFilt && studio.slug !== studioFilt) continue;
    if (!phone || phone.length < 10) { skipped.push({ id: row.id, name, phone, reason: "bad_phone" }); continue; }
    if (paidPhones.has(phone) || (email && paidEmails.has(email))) {
      skipped.push({ id: row.id, name, phone, reason: "already_paid" }); continue;
    }
    if (memberPhones.has(phone) || (email && memberEmails.has(email))) {
      skipped.push({ id: row.id, name, phone, reason: "mindbody_member" }); continue;
    }
    if (alreadyPhones.has(phone) || alreadyIds.has(row.id)) {
      skipped.push({ id: row.id, name, phone, reason: "already_sms_resent" }); continue;
    }
    if (seenPhonesInRun.has(phone)) {
      skipped.push({ id: row.id, name, phone, reason: "duplicate_in_batch" }); continue;
    }
    seenPhonesInRun.add(phone);

    // Build E.164 — US assumption. Already-formatted numbers pass through.
    const e164 = phone.length === 10 ? `+1${phone}` : phone.length === 11 && phone.startsWith("1") ? `+${phone}` : `+${phone}`;
    willSend.push({ row, studio, e164 });
  }

  // ── 4. DRY RUN
  if (dryRun) {
    const byStudio: Record<string, number> = {};
    for (const w of willSend) byStudio[w.studio.slug] = (byStudio[w.studio.slug] ?? 0) + 1;

    const sampleBody = willSend[0]
      ? buildBody((willSend[0].row.name ?? "there").split(" ")[0], willSend[0].studio.shortName, willSend[0].studio.slug)
      : null;

    return json({
      ok: true,
      dry_run: true,
      candidate_pool: candidates?.length ?? 0,
      would_send: willSend.length,
      skipped: skipped.length,
      skip_breakdown: skipped.reduce<Record<string, number>>((acc, s) => {
        acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc;
      }, {}),
      by_studio: byStudio,
      exclusion_set_sizes: {
        paid_emails: paidEmails.size,
        paid_phones: paidPhones.size,
        member_emails: memberEmails.size,
        member_phones: memberPhones.size,
        already_resent_phones: alreadyPhones.size,
      },
      sample_message: sampleBody ? {
        to: willSend[0].e164,
        name: willSend[0].row.name,
        studio: willSend[0].studio.shortName,
        body: sampleBody,
        char_count: sampleBody.length,
        segments: Math.ceil(sampleBody.length / 153),
      } : null,
      sample_first_5: willSend.slice(0, 5).map((w) => ({
        name: w.row.name,
        phone: w.e164,
        studio: w.studio.slug,
        source: w.row.source_category,
        days_since_signup: Math.round((Date.now() - new Date(w.row.created_at).getTime()) / 86400000),
      })),
      sample_first_5_skipped: skipped.slice(0, 5),
    });
  }

  // ── 5. LIVE SEND with throttle
  const results: Array<{ id: string; phone: string; ok: boolean; sid?: string; err?: string }> = [];
  for (let i = 0; i < willSend.length; i++) {
    const { row, studio, e164 } = willSend[i];
    const first = (row.name ?? "there").split(" ")[0];
    const text = buildBody(first, studio.shortName, studio.slug);

    const r = await sendTwilio(e164, text);
    if (!r.ok) {
      results.push({ id: row.id, phone: e164, ok: false, err: r.error ?? `status_${r.status}` });
    } else {
      // Log to sms_messages so subsequent runs are idempotent
      await sb.from("sms_messages").insert({
        direction:       "outbound",
        from_phone:      TWILIO_FROM,
        to_phone:        e164,
        body:            text,
        sent_at:         new Date().toISOString(),
        send_path:       SEND_PATH,
        trial_signup_id: row.id,
        twilio_sid:      r.sid ?? null,
        raw:             { studio_slug: studio.slug, source: "abandoned-cart-sms-resend" },
      });
      results.push({ id: row.id, phone: e164, ok: true, sid: r.sid });
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
    skipped_sample: skipped.slice(0, 10),
  });
});
