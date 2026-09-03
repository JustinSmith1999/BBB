/**
 * manual-welcome-batch — one-shot manual welcome dispatcher.
 *
 * Justin/staff fire this from a curl AFTER reviewing drafts. It bypasses
 * the BBB_SMS_AUTO_SEND_ENABLED master gate because every send here is
 * explicitly approved per-recipient via the request body — this is
 * manual-approval mode, not automated.
 *
 * REQUEST:
 *   POST /functions/v1/manual-welcome-batch
 *   {
 *     "trial_ids": ["uuid1","uuid2",...],
 *     "exclude_trial_ids": ["uuid"],                // optional skip list
 *     "send_customer_sms": true,
 *     "send_customer_email": true,
 *     "send_owner_sms": true,
 *     "send_studio_email": true,
 *     "dry_run": false
 *   }
 *
 * AUTH:
 *   x-bbb-secret header (same as other admin endpoints)
 *
 * Per customer:
 *   - Customer welcome SMS (BBB voice, sender = BBB toll-free Twilio #)
 *   - Customer welcome email (from studio mailbox)
 *   - Owner SMS to every phone in location_owners for that studio
 *   - Studio inbox email alerting front desk
 *
 * Idempotency: writes to sms_messages + email_log so a re-run can be
 * de-duped by the caller. No automatic dedupe inside the function — the
 * caller is in control.
 *
 * Deploy: supabase functions deploy manual-welcome-batch --no-verify-jwt
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

function studioSlugOf(name: string | null | undefined): string {
  return (name || "").toLowerCase().replace(/\s+/g, "-");
}
function studioMailboxOf(slug: string): string {
  return `${slug.replace(/-/g, "")}@betterbodybootcamp.com`;
}
function firstNameOf(name: string | null | undefined): string {
  return (name || "").trim().split(/\s+/)[0] || "there";
}
function bookingUrlOf(slug: string): string {
  // Post-MindBody-cutover (2026-06-25): send customers to the BBB /schedule
  // page that hosts the Mariana Tek booking widget. Same URL we just set
  // on the GBP Book button so the brand stays consistent everywhere.
  return `https://betterbodybootcamp.com/schedule/${slug}`;
}
function studioPhoneOf(slug: string): string {
  const m: Record<string, string> = {
    "williamsburg":  "(718) 683-1864",
    "astoria":       "(718) 704-9954",
    "bayside":       "(646) 566-8870",
    "fresh-meadows": "(646) 566-8207",
  };
  return m[slug] || "";
}

async function twilioSend(opts: {
  sid: string; token: string; from: string;
  to: string; body: string;
}): Promise<{ ok: boolean; status: number; sid?: string; error?: any }> {
  const auth = "Basic " + btoa(`${opts.sid}:${opts.token}`);
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${opts.sid}/Messages.json`,
    {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: opts.from, To: opts.to, Body: opts.body }).toString(),
    }
  );
  const respBody = await r.json();
  return { ok: r.ok, status: r.status, sid: respBody?.sid, error: r.ok ? null : respBody };
}

async function resendSend(opts: {
  apiKey: string; from: string; to: string; replyTo?: string;
  subject: string; html: string; text: string;
  tags?: Array<{ name: string; value: string }>;
}): Promise<{ ok: boolean; status: number; id?: string; error?: any }> {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: opts.from,
      to: [opts.to],
      reply_to: opts.replyTo,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      tags: opts.tags,
    }),
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, id: body?.id, error: r.ok ? null : body };
}

function normalizeE164(p: string | null | undefined): string | null {
  const d = (p || "").replace(/\D+/g, "");
  if (d.length === 11 && d[0] === "1") return "+" + d;
  if (d.length === 10) return "+1" + d;
  return null;
}

// ─── Templates ──────────────────────────────────────────────────────────────
function customerSmsBody(firstName: string, studioShort: string, bookingUrl: string): string {
  return `Hi ${firstName}, welcome to BBB ${studioShort}! Your $49 trial is live. Book your first class: ${bookingUrl} Reply with any questions. - BBB`;
}
// Customer email templates — mirror the stripe-webhook designed welcome
// email so manual and automated paths look identical to the customer.
const HERO_HEX = "#D83B3B"; // 2026-07-27: BBB brand red (was #dc2626 generic red)
const LOGO_URL = "https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png";
function customerEmailSubject(_firstName: string, _studioShort: string): string {
  return `You're in! Your 2-week trial at Better Body Bootcamp`;
}
function customerEmailText(firstName: string, studioShort: string, bookingUrl: string): string {
  return [
    `You're in, ${firstName}.`, "",
    `Welcome to Better Body Bootcamp ${studioShort}. Your 2-week trial is locked in.`, "",
    `Book your first class today — schedule updates live:`,
    bookingUrl, "",
    `What you've got:`,
    `- Offer: $49 · 2 Weeks`,
    `- Studio: ${studioShort}`,
    `- Access: Unlimited classes for the full window`, "",
    `Tips: show up 10 minutes early, wear sneakers, bring water.`, "",
    `Questions? Reply to this email and it goes straight to your studio.`, "",
    `— Better Body Bootcamp`,
  ].join("\n");
}
function customerEmailHtml(firstName: string, studioShort: string, bookingUrl: string, studioSlug: string): string {
  const studioInfoUrl = `https://betterbodybootcamp.com/locations/${studioSlug}`;
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#111;background:#fff">
      <div style="background:${HERO_HEX};color:#fff;padding:26px 28px 24px;text-align:center">
        <img src="${LOGO_URL}" alt="Better Body Bootcamp" width="160" style="max-width:160px;height:auto;margin:0 auto 14px;display:block" />
        <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;opacity:0.85;margin-bottom:8px">${studioShort}</div>
        <h1 style="margin:0;font-size:28px;font-weight:800;letter-spacing:-0.02em;line-height:1.1;color:#fff">You're in, ${firstName}.</h1>
      </div>
      <div style="padding:28px">
        <p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#222">Welcome to Better Body Bootcamp ${studioShort}. Your 2-week trial is locked in.</p>
        <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#444">You'll get the most out of this if you book your <strong>first class today</strong>. The schedule updates live — pick a time that fits and we'll see you on the floor.</p>
        <div style="text-align:center;margin:26px 0 28px">
          <a href="${bookingUrl}" style="background:${HERO_HEX};color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px;display:inline-block;font-size:15px;letter-spacing:0.01em">Book My First Class →</a>
        </div>
        <div style="background:#fafafa;border:1px solid #eee;border-radius:12px;padding:18px 20px;margin-bottom:22px">
          <div style="font-size:12px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">What you've got</div>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:4px 0;color:#666;width:140px">Offer</td><td style="padding:4px 0;font-weight:600">$49 · 2 Weeks</td></tr>
            <tr><td style="padding:4px 0;color:#666">Studio</td><td style="padding:4px 0;font-weight:600">${studioShort}</td></tr>
            <tr><td style="padding:4px 0;color:#666">Access</td><td style="padding:4px 0">Unlimited classes for the full window</td></tr>
          </table>
        </div>
        <div style="font-size:14px;color:#444;line-height:1.55">
          <p style="margin:0 0 10px"><strong>First class tips:</strong> show up 10 minutes early, wear sneakers, bring water. Coach will get you set up.</p>
          <p style="margin:0 0 10px">Questions? Just reply to this email — it goes straight to your studio.</p>
        </div>
        <div style="border-top:1px solid #eee;margin-top:24px;padding-top:18px;font-size:12px;color:#888;text-align:center">
          <a href="${studioInfoUrl}" style="color:#888;text-decoration:underline">Studio info & directions</a>
          &nbsp;·&nbsp; <a href="${bookingUrl}" style="color:#888;text-decoration:underline">Class schedule</a>
        </div>
      </div>
    </div>
  `;
}
function ownerSmsBody(studioShort: string, customerName: string, customerPhone: string, customerEmail: string): string {
  return [
    `New $49 trial signup · ${studioShort}`,
    customerName || "(no name)",
    customerPhone || "",
    customerEmail || "",
    `Call today to book class 1.`,
  ].filter(Boolean).join("\n");
}
function studioEmailSubject(customerName: string, studioShort: string): string {
  return `🎉 New $49 Trial — ${customerName || "(no name)"} · ${studioShort}`;
}
function studioEmailText(customerName: string, studioShort: string, phone: string, email: string, paidEt: string, mtId: string | null): string {
  return [
    `🎉 NEW $49 TRIAL · BBB ${studioShort}`,
    "",
    `${customerName || "(no name)"}`,
    `Email: ${email || "—"}`,
    `Phone: ${phone || "—"}`,
    `Paid:  ${paidEt}`,
    `Mariana Tek ID: ${mtId || "—"}`,
  ].join("\n");
}

// Designed HTML matching the stripe-webhook owner template
// (gradient header, formatted rows, NEXT STEP callout). No MindBody mention.
function studioEmailHtml(customerName: string, studioShort: string, phone: string, email: string, paidEt: string, mtId: string | null): string {
  const heroHex = "#dc2626"; // BBB red
  const safeName = customerName || "(no name provided)";
  // Deep-link to the customer's profile in MT admin so staff can click straight in.
  const mtAdminUrl = mtId
    ? `https://betterbodybootcamp.marianatools.com/admin/users/${encodeURIComponent(mtId)}`
    : null;
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
      <div style="background:${heroHex};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0;margin:-24px -24px 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;opacity:0.9">New $49 Trial · ${studioShort}</div>
        <h2 style="margin:6px 0 0;font-size:24px;font-weight:800;letter-spacing:-0.02em">${safeName}</h2>
        <div style="font-size:13px;opacity:0.95;margin-top:4px">${paidEt}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:20px">
        <tr><td style="padding:8px 0;color:#666;width:120px;border-bottom:1px solid #f0f0f0">Name</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f0f0">${safeName}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Email</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><a href="mailto:${email}" style="color:#dc2626;text-decoration:none;font-weight:600">${email || "—"}</a></td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><a href="tel:${phone}" style="color:#dc2626;text-decoration:none;font-weight:600">${phone || "—"}</a></td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Studio</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${studioShort}</td></tr>
        <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0">Paid</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${paidEt}</td></tr>
        <tr><td style="padding:8px 0;color:#666">Mariana Tek ID</td><td style="padding:8px 0;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:600">${
          mtAdminUrl
            ? `<a href="${mtAdminUrl}" style="color:#dc2626;text-decoration:none;font-weight:600">${mtId}</a>`
            : (mtId || "<span style=\"color:#999\">— (not linked yet)</span>")
        }</td></tr>
      </table>
      <div style="margin-top:20px;font-size:12px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:16px">
        BBB Trial Automation
      </div>
    </div>
  `;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Auth — secret OR service role
  const secret = req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret");
  if (secret !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch {}
  let trialIds: string[] = (body?.trial_ids || []).filter((x: unknown) => typeof x === "string");
  const excludeIds = new Set<string>((body?.exclude_trial_ids || []).filter((x: unknown) => typeof x === "string"));
  // 2026-08-09: AUTO-RECOVER mode. When the MT sync goes dark for >3h (e.g. the
  // dead OAuth-token outage), trials get boarded but the 3-hour past-send guard
  // in mt-orders-sync skips their welcome — so those paying customers never get
  // the BBB welcome/booking nudge. Pass { auto_recover_days: N } (with NO
  // trial_ids) to find mt_app trials from the last N days that have NO welcome
  // email on record and welcome them. Idempotent: skips anyone already in
  // email_log for a welcome path, and dry_run previews first. Conservative
  // channel defaults so a backlog run can't spam — email only, no SMS / owner /
  // studio unless explicitly turned on.
  const autoRecoverDays = (Number.isFinite(Number(body?.auto_recover_days)) && Number(body?.auto_recover_days) > 0)
    ? Math.min(60, Number(body.auto_recover_days)) : 0;
  const autoMode = autoRecoverDays > 0 && !trialIds.length;
  const sendCustomerSms   = autoMode ? (body?.send_customer_sms === true) : (body?.send_customer_sms   !== false);
  const sendCustomerEmail = body?.send_customer_email !== false;
  const sendOwnerSms      = autoMode ? (body?.send_owner_sms === true)    : (body?.send_owner_sms      !== false);
  const sendStudioEmail   = autoMode ? (body?.send_studio_email === true) : (body?.send_studio_email   !== false);
  const dryRun            = body?.dry_run             === true;
  if (!trialIds.length && !autoMode) return json({ ok: false, error: "trial_ids required (non-empty array), or pass auto_recover_days" }, 400);

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const twSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const twToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const twFrom = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
  if (!supaUrl || !supaKey)      return json({ ok: false, error: "supabase env missing" }, 500);
  if (sendCustomerEmail && !resendKey) return json({ ok: false, error: "RESEND_API_KEY missing" }, 500);
  if (sendStudioEmail   && !resendKey) return json({ ok: false, error: "RESEND_API_KEY missing" }, 500);
  if ((sendCustomerSms || sendOwnerSms) && (!twSid || !twToken || !twFrom)) {
    return json({ ok: false, error: "Twilio env missing" }, 500);
  }
  const sb = createClient(supaUrl, supaKey);

  // AUTO-RECOVER discovery: resolve the trial_ids ourselves — every mt_app trial
  // in the window that has NO welcome email logged yet. Read-only; safe in dry_run.
  let autoRecoverInfo: any = null;
  if (autoMode) {
    const sinceIso = new Date(Date.now() - autoRecoverDays * 864e5).toISOString();
    const { data: cand, error: cErr } = await sb
      .from("trial_signups")
      .select("id, payment_date")
      .eq("source_category", "mt_app")
      .eq("payment_status", "completed")
      .is("deleted_at", null)
      .gte("payment_date", sinceIso)
      .order("payment_date", { ascending: false })
      .limit(1000);
    if (cErr) return json({ ok: false, error: `auto-recover query: ${cErr.message}` }, 500);
    const candIds = (cand ?? []).map((r: any) => r.id as string);
    // Exclude anyone who already has ANY welcome email logged — never double-welcome.
    const welcomed = new Set<string>();
    for (let i = 0; i < candIds.length; i += 200) {
      const chunk = candIds.slice(i, i + 200);
      const { data: logs } = await sb
        .from("email_log")
        .select("trial_signup_id, send_path")
        .in("trial_signup_id", chunk);
      for (const l of (logs ?? []) as any[]) {
        if (/welcome/i.test(String(l.send_path || ""))) welcomed.add(l.trial_signup_id);
      }
    }
    trialIds = candIds.filter((id) => !welcomed.has(id) && !excludeIds.has(id));
    autoRecoverInfo = {
      window_days: autoRecoverDays,
      mt_app_completed_in_window: candIds.length,
      already_welcomed: welcomed.size,
      to_recover: trialIds.length,
    };
    if (!trialIds.length) {
      return json({ ok: true, auto_recover: autoRecoverInfo, count: 0, dry_run: dryRun, message: "no un-welcomed mt_app trials in window — nothing to recover." });
    }
  }

  // Pull trials + their studio + owners in one shot
  const { data: trials, error: tErr } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, payment_date, mariana_tek_id, locations:location_id(name)")
    .in("id", trialIds);
  if (tErr || !trials) return json({ ok: false, error: tErr?.message || "trial lookup failed" }, 500);

  const studioOwners: Record<string, any[]> = {};
  if (sendOwnerSms) {
    const locIds = Array.from(new Set(trials.map((t: any) => t.location_id).filter(Boolean)));
    const { data: owners } = await sb
      .from("location_owners")
      .select("location_id, owner_name, phone")
      .in("location_id", locIds)
      .eq("notify_signups", true);
    for (const o of (owners ?? [])) {
      const k = (o as any).location_id;
      (studioOwners[k] = studioOwners[k] || []).push(o);
    }
  }

  const results: any[] = [];
  for (const t of trials as any[]) {
    if (excludeIds.has(t.id)) { results.push({ id: t.id, skipped: "excluded" }); continue; }
    const studioName  = t.locations?.name || "Studio";
    const studioShort = studioName;
    const studioSlug  = studioSlugOf(studioName);
    const studioMail  = studioMailboxOf(studioSlug);
    const bookingUrl  = bookingUrlOf(studioSlug);
    const firstName   = firstNameOf(t.name);
    const customerTo  = normalizeE164(t.phone);
    const paidEt      = t.payment_date
      ? new Date(t.payment_date).toLocaleString("en-US", { timeZone: "America/New_York" })
      : "(not set)";
    const out: any = { id: t.id, name: t.name, email: t.email, studio: studioShort };

    // 1. Customer SMS
    if (sendCustomerSms) {
      const txt = customerSmsBody(firstName, studioShort, bookingUrl);
      if (!customerTo) {
        out.customer_sms = { ok: false, error: "invalid phone" };
      } else if (dryRun) {
        out.customer_sms = { ok: true, dry_run: true, preview: { to: customerTo, body: txt } };
      } else {
        const r = await twilioSend({ sid: twSid, token: twToken, from: twFrom, to: customerTo, body: txt });
        out.customer_sms = { ok: r.ok, status: r.status, sid: r.sid, error: r.error };
        if (r.ok) {
          try {
            await sb.from("sms_messages").insert({
              trial_signup_id: t.id, studio_slug: studioSlug, direction: "outbound",
              from_phone: twFrom, to_phone: customerTo, body: txt,
              twilio_sid: r.sid ?? null, status: "queued", sent_by: "manual_welcome_batch",
            });
          } catch {}
          // 2026-07-22: stamp welcome_sms_sent_at (same column stripe-webhook
          // sets for website trials) so the welcome text shows in Homebase Comms
          // and a re-run won't double-text a customer who was already welcomed.
          try {
            await sb.from("trial_signups")
              .update({ welcome_sms_sent_at: new Date().toISOString() })
              .eq("id", t.id)
              .is("welcome_sms_sent_at", null);
          } catch {}
        }
      }
    }

    // 2. Customer Email
    if (sendCustomerEmail) {
      const subject = customerEmailSubject(firstName, studioShort);
      const text    = customerEmailText(firstName, studioShort, bookingUrl);
      const html    = customerEmailHtml(firstName, studioShort, bookingUrl, studioSlug);
      if (!t.email) {
        out.customer_email = { ok: false, error: "no email" };
      } else if (dryRun) {
        out.customer_email = { ok: true, dry_run: true, preview: { to: t.email, from: studioMail, subject } };
      } else {
        const r = await resendSend({
          apiKey: resendKey,
          from: `Better Body Bootcamp ${studioShort} <${studioMail}>`,
          to: t.email, replyTo: studioMail,
          subject, html, text,
          tags: [
            { name: "send_path",      value: "manual_welcome_batch" },
            { name: "studio_slug",    value: studioSlug },
            { name: "trial_signup_id", value: String(t.id) },
          ],
        });
        out.customer_email = { ok: r.ok, status: r.status, resend_id: r.id, error: r.error };
        if (r.ok) {
          try {
            await sb.from("email_log").insert({
              resend_id: r.id ?? null, event_type: "sent_inline",
              from_addr: studioMail, to_addrs: [t.email], subject,
              send_path: "manual_welcome_batch", trial_signup_id: t.id,
              raw: { studio_slug: studioSlug, manual: true },
            });
          } catch {}
        }
      }
    }

    // 3. Owner SMS
    if (sendOwnerSms) {
      const owners = studioOwners[t.location_id] || [];
      const txt = ownerSmsBody(studioShort, t.name || "", t.phone || "", t.email || "");
      const sent: any[] = [];
      for (const o of owners) {
        const to = normalizeE164(o.phone);
        if (!to) { sent.push({ owner: o.owner_name, ok: false, error: "bad phone" }); continue; }
        if (dryRun) { sent.push({ owner: o.owner_name, ok: true, dry_run: true, to, body: txt }); continue; }
        const r = await twilioSend({ sid: twSid, token: twToken, from: twFrom, to, body: txt });
        sent.push({ owner: o.owner_name, to, ok: r.ok, status: r.status, sid: r.sid, error: r.error });
        if (r.ok) {
          try {
            await sb.from("sms_messages").insert({
              // Tag with the trial id so /homebase comms history can surface
              // these owner pings under the customer's card. Was previously
              // null which made them invisible.
              trial_signup_id: t.id, studio_slug: studioSlug, direction: "outbound",
              from_phone: twFrom, to_phone: to, body: txt,
              twilio_sid: r.sid ?? null, status: "queued", sent_by: "manual_owner_alert",
            });
          } catch {}
        }
      }
      out.owner_sms = sent.length ? sent : [{ ok: false, error: "no owners found" }];
    }

    // 4. Studio inbox email
    if (sendStudioEmail) {
      const subject = studioEmailSubject(t.name || "", studioShort);
      const text    = studioEmailText(t.name || "", studioShort, t.phone || "", t.email || "", paidEt, t.mariana_tek_id || null);
      const html    = studioEmailHtml(t.name || "", studioShort, t.phone || "", t.email || "", paidEt, t.mariana_tek_id || null);
      if (dryRun) {
        out.studio_email = { ok: true, dry_run: true, preview: { to: studioMail, subject } };
      } else {
        const r = await resendSend({
          apiKey: resendKey,
          from: `BBB Trials <trials@betterbodybootcamp.com>`,
          to: studioMail, replyTo: studioMail,
          subject, html, text,
          tags: [
            { name: "send_path",       value: "manual_studio_alert" },
            { name: "studio_slug",     value: studioSlug },
            { name: "trial_signup_id", value: String(t.id) },
          ],
        });
        out.studio_email = { ok: r.ok, status: r.status, resend_id: r.id, error: r.error };
        if (r.ok) {
          try {
            await sb.from("email_log").insert({
              resend_id: r.id ?? null, event_type: "sent_inline",
              from_addr: "trials@betterbodybootcamp.com", to_addrs: [studioMail], subject,
              send_path: "manual_studio_alert", trial_signup_id: t.id,
              raw: { studio_slug: studioSlug, manual: true },
            });
          } catch {}
        }
      }
    }

    results.push(out);
  }

  return json({ ok: true, count: results.length, dry_run: dryRun, ...(autoRecoverInfo ? { auto_recover: autoRecoverInfo } : {}), results });
});
