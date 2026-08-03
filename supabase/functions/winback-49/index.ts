/**
 * winback-49 · "$49 Two-Week Trial — come back" win-back blast
 *
 * Per Chris + Justin (2026-07-30): send ALL old unconverted leads (all 4
 * studios) the $49 two-week-trial offer. Email first; SMS follow-up to the
 * same lead 3+ days later if they still haven't converted.
 * Replaces the killed $29 comeback offer — this one is MANUAL-ONLY (no cron):
 * every send is an explicit invocation, dry_run defaults to TRUE.
 *
 * Eligibility (per run):
 *   - trial_signups.payment_status NOT IN ('completed','attribution_only')
 *   - deleted_at IS NULL, winback49_converted_at IS NULL
 *   - email present; created_at <= 14 days ago (recent leads are already in
 *     the abandoned-cart / onboarding flows — don't double-message them)
 *   - never paid anywhere: stripe_paid_mirror, mindbody membership sales,
 *     AND any completed trial_signups row under the same email
 *
 * Send logic:
 *   - winback49_email_sent_at NULL                    → send EMAIL
 *   - email sent ≥3d ago AND winback49_sms_sent_at NULL AND phone → send SMS
 *
 * POST body:
 *   { "dry_run": true|false,          // DEFAULT TRUE
 *     "limit": 100,                   // max sends this run (default 100)
 *     "test_email": "you@x.com" }     // sends ONE sample email there, nothing else
 *
 * Auth: x-bbb-secret. Deploy: bbb deploy-fn winback-49
 * Requires migration 20260730_winback49_columns.sql.
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const SITE_URL = Deno.env.get("SITE_URL") || "https://betterbodybootcamp.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

function trialUrl(slug: string, channel: "email" | "sms"): string {
  const u = new URL(`/trial/${slug}`, SITE_URL);
  u.searchParams.set("utm_source", "winback49");
  u.searchParams.set("utm_medium", channel);
  u.searchParams.set("utm_campaign", "winback49-2026-07");
  return u.toString();
}

function emailHtml(firstName: string, studio: string, url: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f7f8fa;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8ee;">
      <div style="background:#16181d;padding:24px 28px;text-align:center;">
        <img src="https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png"
             alt="Better Body Bootcamp" width="200" style="display:inline-block;width:200px;max-width:70%;height:auto;" />
      </div>
      <div style="padding:30px 28px;text-align:center;">
        <h1 style="margin:0 0 6px;font-size:24px;color:#16181d;">Hey ${firstName} — still thinking about it?</h1>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#4b5563;">
          You checked us out a while back and life happened — we get it.
          The door's still open at <strong>Better Body Bootcamp ${studio}</strong>:
        </p>
        <div style="background:#fdf2f3;border:1px solid #f5c6cb;border-radius:12px;padding:18px 22px;margin:0 0 20px;">
          <div style="font-size:30px;font-weight:900;color:#E11D2A;">2 WEEKS · $49</div>
          <div style="font-size:14px;color:#4b5563;margin-top:4px;">Unlimited classes. Every class type. No commitment after.</div>
        </div>
        <a href="${url}" style="display:inline-block;background:#E11D2A;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:10px;">Claim my $49 trial →</a>
        <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#9aa3b2;">
          Spots in popular class times go fast — the link locks in the $49 rate for new customers.
        </p>
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:#9aa3b2;margin:18px 0 0;line-height:1.6;">
      Better Body Bootcamp · ${studio} · New York City<br/>
      Don't want these emails? Just reply "unsubscribe" and we'll take you off the list.
    </p>
  </div>
</body></html>`;
}

function emailText(firstName: string, studio: string, url: string): string {
  return `Hey ${firstName} — still thinking about it?\n\n` +
    `You checked us out a while back. The door's still open at Better Body Bootcamp ${studio}:\n\n` +
    `2 WEEKS OF UNLIMITED CLASSES — $49\n\nClaim it here: ${url}\n\n` +
    `— Better Body Bootcamp ${studio}\nReply "unsubscribe" to opt out.`;
}

Deno.serve(async (req) => {
  try { return await handler(req); } catch (e) {
    const err = e as Error;
    console.error("winback-49 uncaught:", err.message, err.stack);
    return json({ ok: false, error: "uncaught_exception", message: err.message }, 500);
  }
});

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const secret = req.headers.get("x-bbb-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!(secret === ADMIN_SECRET || (SR && bearer === SR))) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch {}
  const dryRun = body?.dry_run !== false; // DEFAULT TRUE — must pass dry_run:false to send
  const limit = Math.max(1, Math.min(500, Number(body?.limit) || 100));
  const testEmail = typeof body?.test_email === "string" ? body.test_email.trim() : "";

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supaUrl || !SR) return json({ ok: false, error: "supabase env missing" }, 500);
  const sb = createClient(supaUrl, SR);

  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM_EMAIL = Deno.env.get("COMEBACK_FROM_EMAIL") || "team@betterbodybootcamp.com";
  const FROM_NAME = "Better Body Bootcamp";
  const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_TOK = Deno.env.get("TWILIO_AUTH_TOKEN");
  const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER");

  // ── Test mode: one sample email to the given address, nothing else ───────
  if (testEmail) {
    const url = trialUrl("astoria", "email");
    if (!RESEND_KEY) return json({ ok: false, error: "no RESEND_API_KEY" }, 500);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [testEmail],
        subject: `[TEST] Justin, 2 weeks for $49 at Astoria`,
        html: emailHtml("Justin", "Astoria", url),
        text: emailText("Justin", "Astoria", url),
        tags: [{ name: "send_path", value: "winback49_test" }],
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    return json({ ok: r.ok, test_sent_to: testEmail, resend: j });
  }

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

  const { data: candidates, error: candErr } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, created_at, payment_status, winback49_email_sent_at, winback49_sms_sent_at, winback49_converted_at")
    .not("payment_status", "in", "(completed,attribution_only)")
    .is("deleted_at", null)
    .is("winback49_converted_at", null)
    .lte("created_at", fourteenDaysAgo)
    .not("email", "is", null)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (candErr) return json({ ok: false, error: `candidate query: ${candErr.message}` }, 500);
  if (!candidates?.length) return json({ ok: true, processed: 0, message: "no eligible leads" });

  // ── Never-paid-anywhere guard ─────────────────────────────────────────────
  const emails = candidates.map((c) => (c.email || "").toLowerCase().trim()).filter(Boolean);
  const paid = new Set<string>();
  // (a) same email has a COMPLETED trial_signups row anywhere
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    const { data } = await sb.from("trial_signups").select("email").eq("payment_status", "completed").in("email", chunk);
    (data || []).forEach((r: any) => paid.add((r.email || "").toLowerCase().trim()));
  }
  // (b) Stripe mirror
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    const { data } = await sb.from("stripe_paid_mirror").select("customer_email").in("customer_email", chunk);
    (data || []).forEach((r: any) => paid.add((r.customer_email || "").toLowerCase().trim()));
  }
  // (c) ANY Mariana Tek purchaser — trials, memberships, anything. This is the
  //     system of record since June: catches current members who joined via
  //     the MT app and never touched trial_signups/Stripe. (Justin 2026-07-30:
  //     "MAKE SURE EVERY SINGLE PERSON WHO GETS THIS ISNT A MEMBER ALREADY")
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    const { data } = await sb.from("mariana_tek_sales").select("customer_email").gt("total_cents", 0).in("customer_email", chunk);
    (data || []).forEach((r: any) => paid.add((r.customer_email || "").toLowerCase().trim()));
  }
  // (d) legacy MindBody membership buyers
  const { data: mbClients } = await sb.from("mindbody_clients").select("mindbody_id, email").in("email", emails.slice(0, 1000));
  const mbIds = (mbClients || []).map((c: any) => c.mindbody_id);
  if (mbIds.length) {
    const { data: mbSales } = await sb.from("mindbody_sales").select("customer_mindbody_id").in("customer_mindbody_id", mbIds).gte("total_cents", 4900);
    const memberIds = new Set((mbSales || []).map((s: any) => s.customer_mindbody_id));
    (mbClients || []).filter((c: any) => memberIds.has(c.mindbody_id))
      .forEach((c: any) => paid.add((c.email || "").toLowerCase().trim()));
  }

  const locIds = Array.from(new Set(candidates.map((c) => c.location_id)));
  const { data: locs } = await sb.from("locations").select("id, name").in("id", locIds);
  const locById = new Map<string, { name: string; slug: string }>();
  for (const l of (locs || []) as any[]) {
    locById.set(l.id, { name: l.name, slug: (l.name || "").toLowerCase().replace(/\s+/g, "-") });
  }

  let sentEmail = 0, sentSms = 0, failed = 0, skippedPaid = 0, skippedWait = 0, skippedDone = 0;
  const results: any[] = [];

  for (const c of candidates) {
    if (sentEmail + sentSms >= limit) break;
    // Resend allows 10 req/s — pace sends so batches never rate-limit again
    if (sentEmail + sentSms > 0) await new Promise((res) => setTimeout(res, 150));
    const emailLc = (c.email || "").toLowerCase().trim();
    if (paid.has(emailLc)) { skippedPaid++; continue; }
    const loc = locById.get(c.location_id);
    if (!loc) { results.push({ id: c.id, skip: "no_location" }); continue; }
    const firstName = ((c.name || "").trim().split(/\s+/)[0]) || "there";

    // ── EMAIL first ─────────────────────────────────────────────────────────
    if (!c.winback49_email_sent_at) {
      const url = trialUrl(loc.slug, "email");
      const subject = `${firstName}, 2 weeks for $49 at ${loc.name} — still yours`;
      if (dryRun) { sentEmail++; results.push({ id: c.id, action: "would_email", to: c.email, subject }); continue; }
      if (!RESEND_KEY) { results.push({ id: c.id, action: "email_skip_no_key" }); continue; }
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: `${FROM_NAME} <${FROM_EMAIL}>`,
            to: [c.email],
            subject,
            html: emailHtml(firstName, loc.name, url),
            text: emailText(firstName, loc.name, url),
            tags: [
              { name: "send_path", value: "winback49_email" },
              { name: "trial_signup_id", value: c.id },
              { name: "studio", value: loc.slug },
            ],
          }),
        });
        const j: any = await r.json().catch(() => ({}));
        if (r.ok && j.id) {
          await sb.from("trial_signups").update({ winback49_email_sent_at: new Date().toISOString(), winback49_email_error: null, winback49_resend_id: j.id }).eq("id", c.id);
          sentEmail++; results.push({ id: c.id, action: "email_sent" });
        } else {
          await sb.from("trial_signups").update({ winback49_email_error: j?.message || `http_${r.status}` }).eq("id", c.id);
          failed++; results.push({ id: c.id, action: "email_fail", error: j?.message || r.status });
        }
      } catch (e) {
        await sb.from("trial_signups").update({ winback49_email_error: (e as Error).message }).eq("id", c.id);
        failed++; results.push({ id: c.id, action: "email_exception", error: (e as Error).message });
      }
      continue;
    }

    // ── SMS follow-up: ≥3 days after email, phone required ─────────────────
    if (c.winback49_sms_sent_at) { skippedDone++; continue; }
    if (c.winback49_email_sent_at > threeDaysAgo) { skippedWait++; continue; }
    const phoneRaw = (c.phone || "").trim();
    if (!phoneRaw) { skippedDone++; continue; }
    const digits = phoneRaw.replace(/\D/g, "");
    const e164 = /^\+\d+$/.test(phoneRaw) ? phoneRaw : /^\d{10}$/.test(digits) ? "+1" + digits : null;
    if (!e164) {
      await sb.from("trial_signups").update({ winback49_sms_error: "invalid_phone_format" }).eq("id", c.id);
      failed++; continue;
    }
    const smsUrl = trialUrl(loc.slug, "sms");
    const msgBody =
      `Hey ${firstName}, Better Body Bootcamp ${loc.name} here. ` +
      `Our 2-week trial is still $49 — unlimited classes, no commitment. ` +
      `Grab it: ${smsUrl} (Txt STOP to opt out)`;
    if (dryRun) { sentSms++; results.push({ id: c.id, action: "would_sms", to: e164 }); continue; }
    if (!TWILIO_SID || !TWILIO_TOK || !TWILIO_FROM) { results.push({ id: c.id, action: "sms_skip_no_creds" }); continue; }
    try {
      const form = new URLSearchParams();
      form.set("To", e164); form.set("From", TWILIO_FROM); form.set("Body", msgBody);
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: "POST",
        headers: { "Authorization": "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOK}`), "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.sid) {
        await sb.from("trial_signups").update({ winback49_sms_sent_at: new Date().toISOString(), winback49_sms_sid: j.sid, winback49_sms_error: null }).eq("id", c.id);
        await sb.from("sms_messages").insert({
          trial_signup_id: c.id, direction: "outbound", from_phone: TWILIO_FROM, to_phone: e164,
          body: msgBody, twilio_sid: j.sid, status: "queued", send_path: "winback49_sms", studio_slug: loc.slug,
        });
        sentSms++; results.push({ id: c.id, action: "sms_sent" });
      } else {
        await sb.from("trial_signups").update({ winback49_sms_error: j?.message || `http_${r.status}` }).eq("id", c.id);
        failed++; results.push({ id: c.id, action: "sms_fail", error: j?.message });
      }
    } catch (e) {
      await sb.from("trial_signups").update({ winback49_sms_error: (e as Error).message }).eq("id", c.id);
      failed++; results.push({ id: c.id, action: "sms_exception", error: (e as Error).message });
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    candidates: candidates.length,
    sent_email: sentEmail,
    sent_sms: sentSms,
    skipped_already_paid: skippedPaid,
    skipped_waiting_3d: skippedWait,
    skipped_complete: skippedDone,
    failed,
    limit,
    sample: results.slice(0, 25),
  });
}
