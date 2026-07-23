/**
 * comeback-offer-cron · $29 / 1-Week Comeback Trial outreach
 *
 * Triggers (per Justin's spec, 2026-06-11):
 *   Day 0 from this cron's POV = lead's trial_signups.created_at + 7 days.
 *   - If comeback_sms_sent_at IS NULL AND age ≥ 7 days        → SEND SMS
 *   - If comeback_sms_sent_at ≥ 3 days ago AND email NULL     → SEND EMAIL
 *   - Otherwise                                                → skip
 *
 * Eligibility:
 *   - trial_signups.payment_status NOT IN ('completed')
 *   - trial_signups.deleted_at IS NULL
 *   - trial_signups.comeback_converted_at IS NULL
 *   - trial_signups.email exists AND phone exists
 *   - lead never bought ANY trial / membership at ANY studio (cross-studio check
 *     via mindbody_sales + stripe_paid_mirror to avoid offering $29 to someone
 *     who already paid full price elsewhere)
 *   - age > 7 days (no upper bound per Justin)
 *
 * Idempotency:
 *   - SMS / Email columns set the moment we successfully send.
 *   - Failures stamp comeback_sms_error / comeback_email_error AND null the
 *     sent_at, so the next tick retries (up to ~5 attempts, then we surface
 *     to ops_alerts).
 *
 * The customer's $29 checkout link includes a signed token so we know which
 * trial_signups row to credit when they convert. See /comeback/[studio] page.
 *
 * Deploy:
 *   supabase functions deploy comeback-offer-cron --no-verify-jwt --project-ref uracuwugpxqjfgtuobal
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

type Studio = "astoria" | "bayside" | "fresh-meadows" | "williamsburg";

const STUDIO_LABEL: Record<Studio, string> = {
  "astoria": "Astoria",
  "bayside": "Bayside",
  "fresh-meadows": "Fresh Meadows",
  "williamsburg": "Williamsburg",
};

// Generate a per-row signed-ish token so the comeback page can credit
// conversions back to the original lead without exposing internal IDs.
async function signToken(rowId: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${rowId}.${salt}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function comebackUrl(slug: string, rowId: string, token: string, channel: "sms" | "email"): string {
  const u = new URL(`/comeback/${slug}`, SITE_URL);
  u.searchParams.set("ref", rowId);
  u.searchParams.set("t", token);
  u.searchParams.set("ch", channel);
  return u.toString();
}

Deno.serve(async (req) => {
  try {
    return await handler(req);
  } catch (e) {
    const err = e as Error;
    console.error("comeback-offer-cron uncaught:", err.message, err.stack);
    return json({ ok: false, error: "uncaught_exception", message: err.message, stack: (err.stack || "").slice(0, 1500) }, 500);
  }
});

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Auth: BBB_ADMIN_SECRET OR Bearer SR OR pg_net/* UA (cron).
  const secret = req.headers.get("x-bbb-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  const okAuth = secret === ADMIN_SECRET || (SR && bearer === SR) || ua.startsWith("pg_net/");
  if (!okAuth) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch {}
  const dryRun = body?.dry_run === true;

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supaUrl || !SR) return json({ ok: false, error: "supabase env missing" }, 500);
  const sb = createClient(supaUrl, SR);

  const tokenSalt = Deno.env.get("COMEBACK_TOKEN_SALT") || "bbb-comeback-v1-2026";

  // ── 1. Eligibility query: abandoned >7d, never converted, never paid anywhere
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

  // Pull leads where:
  //   payment_status != 'completed', not deleted, not yet converted via comeback
  //   created_at <= 7 days ago
  //   has email AND phone
  const { data: candidates, error: candErr } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, created_at, comeback_sms_sent_at, comeback_email_sent_at, comeback_converted_at, payment_status")
    .neq("payment_status", "completed")
    .is("deleted_at", null)
    .is("comeback_converted_at", null)
    .lte("created_at", sevenDaysAgo)
    .not("email", "is", null)
    .not("phone", "is", null)
    .order("created_at", { ascending: true })
    .limit(500);

  if (candErr) return json({ ok: false, error: `candidate query: ${candErr.message}` }, 500);
  if (!candidates || candidates.length === 0) {
    return json({ ok: true, processed: 0, message: "no eligible leads in window" });
  }

  // ── 2. Cross-studio guard: skip if customer already paid at ANY studio via
  //      Stripe (stripe_paid_mirror) OR has a membership in MB (mindbody_clients
  //      → mindbody_sales). Avoids offering $29 to someone who's already in.
  const emails = candidates.map((c) => (c.email || "").toLowerCase().trim()).filter(Boolean);
  const { data: paidStripe } = await sb
    .from("stripe_paid_mirror")
    .select("customer_email")
    .in("customer_email", emails);
  const paidEmails = new Set((paidStripe || []).map((r: any) => (r.customer_email || "").toLowerCase().trim()));

  // MB clients with membership sales
  const { data: mbClients } = await sb
    .from("mindbody_clients")
    .select("mindbody_id, email")
    .in("email", emails);
  const mbIds = (mbClients || []).map((c: any) => c.mindbody_id);
  let mbMemberEmails = new Set<string>();
  if (mbIds.length) {
    const { data: mbSales } = await sb
      .from("mindbody_sales")
      .select("customer_mindbody_id, total_cents")
      .in("customer_mindbody_id", mbIds)
      .gte("total_cents", 4900);
    const memberIds = new Set((mbSales || []).map((s: any) => s.customer_mindbody_id));
    mbMemberEmails = new Set(
      (mbClients || [])
        .filter((c: any) => memberIds.has(c.mindbody_id))
        .map((c: any) => (c.email || "").toLowerCase().trim()),
    );
  }

  // Locations for slug mapping + studio name
  const locIds = Array.from(new Set(candidates.map((c) => c.location_id)));
  const { data: locs } = await sb.from("locations").select("id, name").in("id", locIds);
  const locById = new Map<string, { name: string; slug: Studio }>();
  for (const l of (locs || []) as any[]) {
    const slug = (l.name || "").toLowerCase().replace(/\s+/g, "-") as Studio;
    locById.set(l.id, { name: l.name, slug });
  }

  // Twilio + Resend creds
  const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_TOK = Deno.env.get("TWILIO_AUTH_TOKEN");
  const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER");
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM_EMAIL = Deno.env.get("COMEBACK_FROM_EMAIL") || "team@betterbodybootcamp.com";
  const FROM_NAME = "Better Body Bootcamp";

  let sentSms = 0, sentEmail = 0, skippedAlreadyPaid = 0, skippedNeitherDue = 0, failedSms = 0, failedEmail = 0;
  const results: any[] = [];

  for (const c of candidates) {
    const emailLc = (c.email || "").toLowerCase().trim();
    if (paidEmails.has(emailLc) || mbMemberEmails.has(emailLc)) {
      skippedAlreadyPaid++;
      results.push({ id: c.id, name: c.name, skip: "already_paid_or_member" });
      continue;
    }

    const loc = locById.get(c.location_id);
    if (!loc) {
      results.push({ id: c.id, skip: "no_location" });
      continue;
    }

    const firstName = ((c.name || "").trim().split(/\s+/)[0]) || "there";
    const token = await signToken(c.id, tokenSalt);

    // ── SMS branch: first touch, only if not sent yet ───────────────────────
    if (!c.comeback_sms_sent_at) {
      const phone = (c.phone || "").trim();
      const e164 = /^\+\d+$/.test(phone) ? phone :
                   /^\d{10}$/.test(phone.replace(/\D/g, "")) ? "+1" + phone.replace(/\D/g, "") :
                   null;
      if (!e164) {
        await sb.from("trial_signups").update({ comeback_sms_error: "invalid_phone_format" }).eq("id", c.id);
        failedSms++;
        results.push({ id: c.id, name: c.name, action: "sms_skip_bad_phone" });
        continue;
      }

      const url = comebackUrl(loc.slug, c.id, token, "sms");
      const msgBody =
        `Hey ${firstName}, it's Better Body Bootcamp ${loc.name}. ` +
        `Noticed you didn't finish signing up for our 2-Week Trial. ` +
        `Want to give it a shot for just $29 / 1 week instead? ` +
        `${url}`;

      if (dryRun) {
        results.push({ id: c.id, name: c.name, action: "would_sms", to: e164, body_len: msgBody.length });
        sentSms++;
        continue;
      }

      if (!TWILIO_SID || !TWILIO_TOK || !TWILIO_FROM) {
        results.push({ id: c.id, name: c.name, action: "sms_skip_no_twilio_creds" });
        continue;
      }

      try {
        const form = new URLSearchParams();
        form.set("To", e164);
        form.set("From", TWILIO_FROM);
        form.set("Body", msgBody);
        const r = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
          {
            method: "POST",
            headers: {
              "Authorization": "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOK}`),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
          },
        );
        const respJson: any = await r.json().catch(() => ({}));
        if (r.ok && respJson.sid) {
          await sb.from("trial_signups").update({
            comeback_sms_sent_at: new Date().toISOString(),
            comeback_sms_sid: respJson.sid,
            comeback_sms_error: null,
          }).eq("id", c.id);

          // 2026-06-12 — ALSO log to sms_messages so /homebase comms thread
          // shows the send. Without this, the message is invisible to staff
          // until the customer replies (which triggers an inbound row).
          const { error: smsLogErr } = await sb.from("sms_messages").insert({
            trial_signup_id: c.id,
            direction:   "outbound",
            from_phone:  TWILIO_FROM,
            to_phone:    e164,
            body:        msgBody,
            twilio_sid:  respJson.sid,
            status:      "queued",
            send_path:   "comeback_sms",
            studio_slug: loc.slug,
          });
          if (smsLogErr) {
            console.error("sms_messages insert FAILED for comeback", {
              pg_code: (smsLogErr as { code?: string }).code,
              pg_message: smsLogErr.message,
              trial_id: c.id,
            });
          }

          sentSms++;
          results.push({ id: c.id, name: c.name, action: "sms_sent", sid: respJson.sid });
        } else {
          await sb.from("trial_signups").update({
            comeback_sms_error: respJson?.message || `http_${r.status}`,
          }).eq("id", c.id);
          failedSms++;
          results.push({ id: c.id, name: c.name, action: "sms_fail", error: respJson?.message });
        }
      } catch (e) {
        await sb.from("trial_signups").update({ comeback_sms_error: (e as Error).message }).eq("id", c.id);
        failedSms++;
        results.push({ id: c.id, action: "sms_exception", error: (e as Error).message });
      }
      continue;
    }

    // ── Email branch: only after SMS+3 days, only if not sent yet ───────────
    const smsSentAt = c.comeback_sms_sent_at!;
    if (smsSentAt > threeDaysAgo) {
      // SMS sent, but <3 days ago — wait
      skippedNeitherDue++;
      results.push({ id: c.id, name: c.name, action: "wait_for_3d_email", sms_age_h: Math.floor((Date.now() - new Date(smsSentAt).getTime()) / 3600000) });
      continue;
    }
    if (c.comeback_email_sent_at) {
      // Both already sent — nothing more to do
      skippedNeitherDue++;
      continue;
    }

    const url = comebackUrl(loc.slug, c.id, token, "email");
    const subject = `${firstName}, $29 for your first week at ${loc.name}`;
    const html = comebackEmailHtml({ firstName, studio: loc.name, url });
    const text = comebackEmailText({ firstName, studio: loc.name, url });

    if (dryRun) {
      results.push({ id: c.id, name: c.name, action: "would_email", to: c.email, subject });
      sentEmail++;
      continue;
    }

    if (!RESEND_KEY) {
      results.push({ id: c.id, name: c.name, action: "email_skip_no_resend_key" });
      continue;
    }

    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to: [c.email],
          subject,
          html,
          text,
          tags: [
            { name: "send_path", value: "comeback_email" },
            { name: "trial_signup_id", value: c.id },
            { name: "studio", value: loc.slug },
          ],
        }),
      });
      const respJson: any = await r.json().catch(() => ({}));
      if (r.ok && respJson.id) {
        await sb.from("trial_signups").update({
          comeback_email_sent_at: new Date().toISOString(),
          comeback_email_id: respJson.id,
          comeback_email_error: null,
        }).eq("id", c.id);
        sentEmail++;
        results.push({ id: c.id, name: c.name, action: "email_sent", resend_id: respJson.id });
      } else {
        await sb.from("trial_signups").update({
          comeback_email_error: respJson?.message || `http_${r.status}`,
        }).eq("id", c.id);
        failedEmail++;
        results.push({ id: c.id, action: "email_fail", error: respJson?.message });
      }
    } catch (e) {
      await sb.from("trial_signups").update({ comeback_email_error: (e as Error).message }).eq("id", c.id);
      failedEmail++;
      results.push({ id: c.id, action: "email_exception", error: (e as Error).message });
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    processed: candidates.length,
    sent_sms: sentSms,
    sent_email: sentEmail,
    skipped_already_paid_or_member: skippedAlreadyPaid,
    skipped_neither_due: skippedNeitherDue,
    failed_sms: failedSms,
    failed_email: failedEmail,
    results,
  });
}

// ─── Email templates ─────────────────────────────────────────────────────────
function comebackEmailHtml({ firstName, studio, url }: { firstName: string; studio: string; url: string }): string {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;color:#111;background:#fafafa">
  <h1 style="font-size:28px;line-height:1.2;margin:0 0 16px;color:#111">Hey ${firstName},</h1>
  <p style="font-size:16px;line-height:1.55;margin:0 0 16px">
    A little while back you started signing up for our 2-Week Trial at <strong>Better Body Bootcamp ${studio}</strong> but didn't finish.
  </p>
  <p style="font-size:16px;line-height:1.55;margin:0 0 24px">
    We get it — life happens. So here's a softer landing: <strong>$29 for one full week</strong> of unlimited classes. No commitment, no auto-renew.
  </p>
  <p style="margin:32px 0">
    <a href="${url}" style="display:inline-block;background:#ff5500;color:#fff;padding:16px 28px;border-radius:8px;font-size:18px;font-weight:600;text-decoration:none">Claim your $29 week →</a>
  </p>
  <p style="font-size:14px;line-height:1.5;color:#555;margin:24px 0 0">
    7 days. Unlimited classes. Real trainers. Real community. If you love it, you're in. If you don't, no hard feelings.
  </p>
  <p style="font-size:13px;color:#888;margin:32px 0 0;border-top:1px solid #ddd;padding-top:16px">
    — The team at Better Body Bootcamp ${studio}<br>
    This offer is for you only. Reply to this email if you have questions.
  </p>
</body></html>`;
}

function comebackEmailText({ firstName, studio, url }: { firstName: string; studio: string; url: string }): string {
  return `Hey ${firstName},

A little while back you started signing up for our 2-Week Trial at Better Body Bootcamp ${studio} but didn't finish. We get it — life happens.

So here's a softer landing: $29 for one full week of unlimited classes. No commitment, no auto-renew.

Claim your $29 week:
${url}

7 days. Unlimited classes. Real trainers. Real community. If you love it, you're in. If you don't, no hard feelings.

— The team at Better Body Bootcamp ${studio}`;
}
