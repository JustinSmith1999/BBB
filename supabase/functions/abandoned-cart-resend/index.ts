/**
 * abandoned-cart-resend — Manual one-shot follow-up email.
 *
 * Sends the abandoned-cart email AGAIN to every lead who:
 *   1. Filled out the trial form (trial_signups row exists)
 *   2. Never actually paid:
 *        - payment_status != 'completed' on trial_signups, AND
 *        - no row in stripe_paid_mirror by email or phone
 *   3. Never became a MindBody member (no recent visits + no membership sale)
 *   4. Already received the first abandoned-cart email earlier (we're following
 *      up on people who got Touch-1 and still didn't convert)
 *   5. Hasn't already received THIS resend (idempotent via email_log
 *      send_path='abandoned_cart_resend_1')
 *
 * Throttled to 250ms between sends (≈4/sec) to stay under Resend's 5/sec limit
 * — the comeback-email-fu1 fire earlier today got 10 send_failed 429s, this
 * function paces explicitly so it never hits that wall.
 *
 * Modes:
 *   { "dry_run": true }   → count + list candidates, no sends (DEFAULT)
 *   { "dry_run": false }  → live send
 *   { "limit": N }        → cap candidates (default 500)
 *   { "studio_slug": "x" } → restrict to one studio (debug only)
 *
 * Auth: x-bbb-secret header.
 *
 * Deploy:
 *   supabase functions deploy abandoned-cart-resend --no-verify-jwt \
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

const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Better Body Bootcamp <hello@betterbodybootcamp.com>";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const SEND_PATH = "abandoned_cart_resend_1";

// ─── Studio config — copied from abandoned-cart-followup, single source of
// truth would be nicer but keeping it inline avoids cross-function imports.
const STUDIOS: Record<string, {
  slug: string; name: string; shortName: string; phone: string;
  address: string; city: string; zip: string; bookingUrl: string; studioEmail: string;
}> = {
  "80536b45-df0e-42d1-880c-e9301372e1cf": {
    slug: "williamsburg", name: "Better Body Bootcamp Williamsburg", shortName: "Williamsburg",
    phone: "(718) 683-1864", address: "487 Driggs Ave", city: "Brooklyn", zip: "11211",
    bookingUrl: "https://betterbodybootcamp.com/trial/williamsburg",
    studioEmail: "williamsburg@betterbodybootcamp.com",
  },
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": {
    slug: "astoria", name: "Better Body Bootcamp Astoria", shortName: "Astoria",
    phone: "(718) 704-9954", address: "31-18 Steinway Street", city: "Astoria", zip: "11103",
    bookingUrl: "https://betterbodybootcamp.com/trial/astoria",
    studioEmail: "astoria@betterbodybootcamp.com",
  },
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": {
    slug: "bayside", name: "Better Body Bootcamp Bayside", shortName: "Bayside",
    phone: "(646) 566-8870", address: "3447 Bell Blvd", city: "Bayside", zip: "11361",
    bookingUrl: "https://betterbodybootcamp.com/trial/bayside",
    studioEmail: "bayside@betterbodybootcamp.com",
  },
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": {
    slug: "fresh-meadows", name: "Better Body Bootcamp Fresh Meadows", shortName: "Fresh Meadows",
    phone: "(646) 566-8207", address: "76-46 164th Street", city: "Fresh Meadows", zip: "11366",
    bookingUrl: "https://betterbodybootcamp.com/trial/fresh-meadows",
    studioEmail: "freshmeadows@betterbodybootcamp.com",
  },
};

// ─── Touch-2 email body — slightly different framing from Touch-1. Touch-1
// said "you didn't finish, finish now." Touch-2 acknowledges they got that
// email and adds a gentle "is something stopping you?" hook.
function buildEmail(customerName: string | null, studio: typeof STUDIOS[string]) {
  const firstName = (customerName || "").split(" ")[0] || "there";
  return {
    subject: `${firstName}, still thinking about the trial?`,
    html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f5;color:#1a1a1a">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden">
<tr><td style="background:#d63838;padding:32px;text-align:center">
<h1 style="margin:0;color:#fff;font-size:26px;letter-spacing:1px">STILL HOLDING YOUR SPOT</h1>
<p style="margin:8px 0 0;color:#fff;font-size:14px;opacity:0.9">${studio.name.toUpperCase()}</p>
</td></tr>
<tr><td style="padding:32px">
<h2 style="margin:0 0 16px;font-size:22px">Hey ${firstName},</h2>
<p style="margin:0 0 16px;line-height:1.6;font-size:16px">A while back you started signing up for our <strong>2-week unlimited trial</strong> at ${studio.shortName}. We sent a follow-up — you may have missed it — and your spot is still open.</p>
<p style="margin:0 0 16px;line-height:1.6;font-size:16px">No pressure, no sales call. <strong>$49 for 14 days of unlimited classes.</strong> Walk in, take a class, decide if it's for you. Most people who finish the trial stay — but plenty don't, and that's fine too.</p>
<p style="margin:0 0 24px;line-height:1.6;font-size:16px">If something stopped you — schedule, price, nerves about a new gym — hit reply and tell us. We read every email.</p>
<table cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#d63838;border-radius:6px">
<a href="${studio.bookingUrl}" style="display:inline-block;padding:16px 32px;color:#fff;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:0.5px">FINISH MY $49 TRIAL →</a>
</td></tr></table>
<p style="margin:32px 0 8px;font-size:15px;line-height:1.6">Prefer to call? <strong>${studio.phone}</strong> — we actually pick up.</p>
<p style="margin:24px 0 0;line-height:1.6;font-size:14px;color:#666">${studio.address}, ${studio.city}, NY ${studio.zip}<br>— Team ${studio.shortName}</p>
</td></tr>
<tr><td style="background:#fafafa;padding:16px;text-align:center;font-size:11px;color:#888;border-top:1px solid #eee">
You're receiving this because you started a trial signup at ${studio.shortName}. Don't want these emails? Just reply STOP.
</td></tr>
</table></td></tr></table></body></html>`,
    text: `Hey ${firstName},

A while back you started signing up for our 2-week unlimited trial at ${studio.shortName}. We sent a follow-up — you may have missed it — and your spot is still open.

No pressure. $49 for 14 days of unlimited classes. Walk in, take a class, decide if it's for you.

If something stopped you — schedule, price, nerves about a new gym — hit reply and tell us. We read every email.

Finish your trial: ${studio.bookingUrl}
Or call: ${studio.phone}

${studio.address}, ${studio.city}, NY ${studio.zip}
— Team ${studio.shortName}`,
  };
}

const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
const normPhone = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  const secret = req.headers.get("x-bbb-secret") ?? "";
  if (secret !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  if (!RESEND_API_KEY) return json({ ok: false, error: "RESEND_API_KEY not set" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body fine */ }
  const dryRun     = body.dry_run !== false; // default true for safety
  const limit      = Math.max(1, Math.min(1000, Number(body.limit ?? 500)));
  const studioFilt = typeof body.studio_slug === "string" ? body.studio_slug : null;
  const throttleMs = Math.max(0, Math.min(2000, Number(body.throttle_ms ?? 250)));

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // ── 1. Candidate pool: pending trial_signups that already received Touch-1
  const { data: candidates, error: cErr } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, created_at, abandoned_email_sent_at, source_category")
    .eq("payment_status", "pending")
    .not("abandoned_email_sent_at", "is", null)
    .not("email", "is", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cErr) return json({ ok: false, where: "candidates", error: cErr.message }, 500);

  // ── 2. Exclusion sets

  // 2a. Anyone who has ever completed a payment (trial_signups + mirror, any amount)
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

  // 2b. Anyone already a MindBody member or active client.
  //
  // We treat "became a member" as having either:
  //   - a sale row in mindbody_sales (any product they paid for in MB)
  //   - 3+ visit rows in mindbody_visits (heavy class taker — clearly active)
  // Email match via mindbody_clients lookup.
  const memberEmails = new Set<string>();
  const memberPhones = new Set<string>();
  try {
    // Pull every mindbody_clients row with any email/phone — small table.
    const { data: mbc } = await sb
      .from("mindbody_clients")
      .select("mindbody_client_id, email, phone")
      .limit(20000);
    const clientIdByEmail = new Map<string, string>();
    const clientIdByPhone = new Map<string, string>();
    for (const c of mbc ?? []) {
      const e = normEmail((c as any).email);
      const p = normPhone((c as any).phone);
      if (e) clientIdByEmail.set(e, (c as any).mindbody_client_id);
      if (p) clientIdByPhone.set(p, (c as any).mindbody_client_id);
    }

    // Pull every mindbody_sales row — any client_id that appears here = paid MB
    const { data: sales } = await sb
      .from("mindbody_sales")
      .select("mindbody_client_id")
      .limit(50000);
    const buyerClientIds = new Set<string>();
    for (const s of sales ?? []) {
      const id = String((s as any).mindbody_client_id ?? "");
      if (id) buyerClientIds.add(id);
    }

    // Pull visit counts per client. Anyone with ≥3 visits = active member.
    const { data: visits } = await sb
      .from("mindbody_visits")
      .select("mindbody_client_id")
      .limit(100000);
    const visitCount = new Map<string, number>();
    for (const v of visits ?? []) {
      const id = String((v as any).mindbody_client_id ?? "");
      if (!id) continue;
      visitCount.set(id, (visitCount.get(id) ?? 0) + 1);
    }
    const heavyClientIds = new Set<string>();
    for (const [id, n] of visitCount) if (n >= 3) heavyClientIds.add(id);

    // Build email/phone exclusion sets from buyer + heavy client IDs
    for (const [email, id] of clientIdByEmail) {
      if (buyerClientIds.has(id) || heavyClientIds.has(id)) memberEmails.add(email);
    }
    for (const [phone, id] of clientIdByPhone) {
      if (buyerClientIds.has(id) || heavyClientIds.has(id)) memberPhones.add(phone);
    }
  } catch (e) {
    console.error("MindBody exclusion build failed (continuing without it):", (e as Error).message);
  }

  // 2c. Anyone who already got THIS resend (idempotency guard)
  const { data: alreadyResent } = await sb
    .from("email_log")
    .select("trial_signup_id, to_addrs")
    .eq("send_path", SEND_PATH);
  const alreadyResentIds    = new Set<string>();
  const alreadyResentEmails = new Set<string>();
  for (const r of alreadyResent ?? []) {
    if ((r as any).trial_signup_id) alreadyResentIds.add((r as any).trial_signup_id);
    for (const e of (r as any).to_addrs ?? []) {
      const ne = normEmail(e); if (ne) alreadyResentEmails.add(ne);
    }
  }

  // ── 3. Filter the candidate pool through every exclusion
  type Row = NonNullable<typeof candidates>[number];
  const seenEmailsInRun = new Set<string>();
  const seenPhonesInRun = new Set<string>();
  const willSend: Array<{ row: Row; studio: typeof STUDIOS[string] }> = [];
  const skipped: Array<{ id: string; name: string; email: string; reason: string }> = [];

  for (const row of candidates ?? []) {
    const email = normEmail(row.email);
    const phone = normPhone(row.phone);
    const studio = STUDIOS[row.location_id ?? ""];
    const name = row.name ?? "";

    if (studioFilt && studio && studio.slug !== studioFilt) {
      continue; // silent skip on studio filter
    }
    if (!studio) {
      skipped.push({ id: row.id, name, email, reason: "unknown_location" });
      continue;
    }
    if (!email) {
      skipped.push({ id: row.id, name, email, reason: "no_email" });
      continue;
    }
    if (paidEmails.has(email) || (phone && paidPhones.has(phone))) {
      skipped.push({ id: row.id, name, email, reason: "already_paid" });
      continue;
    }
    if (memberEmails.has(email) || (phone && memberPhones.has(phone))) {
      skipped.push({ id: row.id, name, email, reason: "mindbody_member" });
      continue;
    }
    if (alreadyResentIds.has(row.id) || alreadyResentEmails.has(email)) {
      skipped.push({ id: row.id, name, email, reason: "already_resent" });
      continue;
    }
    if (seenEmailsInRun.has(email) || (phone && seenPhonesInRun.has(phone))) {
      skipped.push({ id: row.id, name, email, reason: "duplicate_in_batch" });
      continue;
    }

    seenEmailsInRun.add(email);
    if (phone) seenPhonesInRun.add(phone);
    willSend.push({ row, studio });
  }

  // ── 4. DRY RUN — just show counts + sample
  if (dryRun) {
    const byStudio: Record<string, number> = {};
    for (const w of willSend) {
      byStudio[w.studio.slug] = (byStudio[w.studio.slug] ?? 0) + 1;
    }
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
        already_resent_ids: alreadyResentIds.size,
      },
      sample_first_5: willSend.slice(0, 5).map((w) => ({
        name: w.row.name, email: w.row.email, studio: w.studio.slug,
        source_category: w.row.source_category,
        days_since_signup: Math.round(
          (Date.now() - new Date(w.row.created_at).getTime()) / (24 * 3600 * 1000),
        ),
      })),
      sample_first_5_skipped: skipped.slice(0, 5),
    });
  }

  // ── 5. LIVE SEND — throttle to avoid Resend 429
  const results: Array<{ id: string; email: string; ok: boolean; err?: string; resend_id?: string }> = [];
  for (let i = 0; i < willSend.length; i++) {
    const { row, studio } = willSend[i];
    const tmpl = buildEmail(row.name, studio);
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [row.email],
          reply_to: studio.studioEmail,
          subject: tmpl.subject,
          html: tmpl.html,
          text: tmpl.text,
          tags: [
            { name: "send_path",       value: SEND_PATH },
            { name: "trial_signup_id", value: row.id },
            { name: "studio_slug",     value: studio.slug },
          ],
          tracking: { opens: true, clicks: true },
        }),
      });
      const rb = await resp.json();
      if (!resp.ok) {
        results.push({ id: row.id, email: row.email!, ok: false, err: `Resend ${resp.status}: ${JSON.stringify(rb)}` });
        continue;
      }

      // Log to email_log for idempotency on subsequent fires
      await sb.from("email_log").insert({
        trial_signup_id: row.id,
        send_path:       SEND_PATH,
        resend_id:       rb?.id ?? null,
        from_addr:       FROM_EMAIL,
        to_addrs:        [row.email],
        subject:         tmpl.subject,
        event_type:      "sent_inline",
        raw:             { source: "abandoned-cart-resend", studio_slug: studio.slug, touch: 2 },
      });

      results.push({ id: row.id, email: row.email!, ok: true, resend_id: rb?.id });
    } catch (e) {
      results.push({ id: row.id, email: row.email!, ok: false, err: (e as Error).message });
    }

    // Throttle between every send so we never trip Resend's 5/sec ceiling.
    if (i < willSend.length - 1) await sleep(throttleMs);
  }

  return json({
    ok: true,
    dry_run: false,
    eligible: willSend.length,
    sent:    results.filter((r) => r.ok).length,
    failed:  results.filter((r) => !r.ok).length,
    skipped: skipped.length,
    throttle_ms: throttleMs,
    results,
    skipped_sample: skipped.slice(0, 10),
  });
});
