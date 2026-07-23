// ─────────────────────────────────────────────────────────────────────────────
// comeback-email-fu1 · Touch-2 follow-up email to abandoned-trial leads who
// already received the $29/1-week comeback SMS but haven't replied / clicked /
// converted. Plain HTML email via Resend; one shot per recipient (tracked
// via trial_signups.comeback_email_sent_at so re-runs are idempotent).
//
// Modes:
//   { "dry_run": true }   → log the recipient list + sample email, no sends
//   { "dry_run": false }  → live send via Resend
//   { "dry_run": true, "limit": 1 } → render exactly one example
//
// Auth: requires x-bbb-secret header.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BBB_SECRET = Deno.env.get("BBB_SECRET") ?? "bbb-test-2026-05-27";

const FROM_ADDRESS = "Better Body Bootcamp <hello@betterbodybootcamp.com>";

// Subject A/B: rotate by hash(email) so each recipient sees one of three.
const SUBJECT_LINES = [
  (firstName: string) => `${firstName}, $29 for a week of bootcamp`,
  (_: string) => `Still in? Here's $29 for 1 week of bootcamp`,
  (_: string) => `One more shot at the trial, on us — $29`,
];

const PREHEADER = "We saved you a spot. 1 week, $29, no commitment. Walk in any time.";

function buildEmailHtml(opts: {
  firstName: string;
  studioName: string;
  studioSlug: string;
  ctaUrl: string;
  unsubscribeUrl: string;
}) {
  const { firstName, studioName, ctaUrl, unsubscribeUrl } = opts;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0a0908">
<div style="display:none;font-size:1px;color:#f4f4f4;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${PREHEADER}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f4">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
<tr><td style="background:#0a0908;padding:32px 32px 28px;text-align:center">
<div style="font-size:11px;font-weight:800;letter-spacing:3px;color:#dc2626;text-transform:uppercase;margin-bottom:18px">BETTER BODY BOOTCAMP · ${studioName}</div>
<h1 style="margin:0;font-size:38px;line-height:1.1;font-weight:800;color:#ffffff;letter-spacing:-1px">One more shot.<br><span style="color:#dc2626">$29 for 1 week.</span></h1>
</td></tr>
<tr><td style="padding:32px 36px 16px">
<p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#0a0908">Hey ${firstName} —</p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#0a0908">We texted you the other day but figured email might land cleaner. You started signing up for our 2-Week Trial at BBB ${studioName} and didn't finish — no judgment, life gets in the way.</p>
<p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#0a0908">Here's what we'll do instead: <strong>1 full week of unlimited classes for $29</strong>. Same workouts, same trainers, same proven plan — just shorter so it's easier to commit.</p>
<p style="margin:0 0 28px;font-size:16px;line-height:1.55;color:#0a0908">Come to one class. If it's not for you, we won't bug you again. If it IS for you, you'll know in 45 minutes.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto"><tr><td align="center" style="background:#dc2626;border-radius:6px">
<a href="${ctaUrl}" style="display:inline-block;padding:16px 36px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.3px">Claim my $29 / 1 week →</a>
</td></tr></table>
<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#6b7280;text-align:center">No auto-renewal. No card on file after the week. Just show up.</p>
</td></tr>
<tr><td style="padding:8px 36px 28px"><div style="border-top:1px solid #e5e7eb;padding-top:22px;text-align:center"><div style="display:inline-block;text-align:center">
<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#6b7280;text-transform:uppercase;margin-bottom:8px">What you'll find inside</div>
<div style="font-size:14px;line-height:1.7;color:#374151">45-minute classes · Strength + conditioning · Welcoming atmosphere<br>Real coaches · Real community · Since 2011</div>
</div></div></td></tr>
<tr><td style="padding:24px 36px 28px;background:#f9fafb;text-align:center;border-top:1px solid #e5e7eb">
<p style="margin:0 0 10px;font-size:12px;color:#6b7280;line-height:1.5">Better Body Bootcamp ${studioName} · NYC's #1 group-fitness studio since 2011</p>
<p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.5">Don't want to hear from us again? <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a>. We get it.</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

function buildEmailText(opts: { firstName: string; studioName: string; ctaUrl: string; unsubscribeUrl: string }) {
  return `Hey ${opts.firstName},

We texted you the other day but figured email might land cleaner. You
started signing up for our 2-Week Trial at BBB ${opts.studioName} and didn't
finish — no judgment, life gets in the way.

Here's what we'll do instead: 1 full week of unlimited classes for $29.
Same workouts, same trainers, same proven plan — just shorter so it's
easier to commit.

Come to one class. If it's not for you, we won't bug you again. If it
IS for you, you'll know in 45 minutes.

→ Claim your $29 / 1 week here: ${opts.ctaUrl}

No auto-renewal. No card on file after the week. Just show up.

— The BBB ${opts.studioName} team

Don't want emails from us? ${opts.unsubscribeUrl}`;
}

serve(async (req) => {
  if (req.headers.get("x-bbb-secret") !== BBB_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false; // default to dry-run for safety
  const limit = Number(body.limit ?? 100);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Recipients: anyone who got the SMS but no email yet, AND has a valid email.
  const { data: rows, error } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, comeback_sms_sent_at, comeback_email_sent_at")
    .not("comeback_sms_sent_at", "is", null)
    .is("comeback_email_sent_at", null)
    .not("email", "is", null)
    .limit(limit);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Studio lookup so we can render "Better Body Bootcamp Astoria" etc.
  const { data: locs } = await sb.from("locations").select("id, name");
  const locMap = new Map<string, { name: string; slug: string }>();
  for (const l of locs ?? []) {
    locMap.set(l.id, { name: l.name, slug: l.name.toLowerCase().replace(/\s+/g, "-") });
  }

  const results: any[] = [];
  let firstSample: any = null;

  for (const r of rows ?? []) {
    const studio = locMap.get(r.location_id);
    if (!studio) {
      results.push({ id: r.id, name: r.name, action: "skip_no_studio" });
      continue;
    }
    const firstName = (r.name ?? "there").split(" ")[0];
    const ctaUrl = `https://betterbodybootcamp.com/comeback/${studio.slug}?t=email-fu1&c=email&tid=${r.id}`;
    const unsubscribeUrl = `https://betterbodybootcamp.com/unsubscribe?email=${encodeURIComponent(r.email!)}&tid=${r.id}`;
    // Hash-based subject rotation
    const subjectIdx =
      [...r.id]
        .reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % SUBJECT_LINES.length;
    const subject = SUBJECT_LINES[subjectIdx](firstName);
    const html = buildEmailHtml({
      firstName,
      studioName: studio.name,
      studioSlug: studio.slug,
      ctaUrl,
      unsubscribeUrl,
    });
    const text = buildEmailText({ firstName, studioName: studio.name, ctaUrl, unsubscribeUrl });

    if (!firstSample) {
      firstSample = { to: r.email, name: r.name, studio: studio.name, subject, ctaUrl, html_preview: html.slice(0, 800) + "...", text };
    }

    if (dryRun) {
      results.push({ id: r.id, name: r.name, studio: studio.name, to: r.email, subject, action: "dry_run" });
      continue;
    }

    // Live send via Resend.
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [r.email],
          subject,
          html,
          text,
          tags: [
            { name: "send_path", value: "comeback_email_fu1" },
            { name: "trial_signup_id", value: r.id },
            { name: "studio_slug", value: studio.slug },
          ],
          // Explicit tracking — Resend defaults are open=on, click=on for
          // HTML emails, but be paranoid: surface them in the request so
          // a future Resend default change can't silently break our funnel.
          tracking: { opens: true, clicks: true },
        }),
      });
      const respBody = await resp.json();
      if (!resp.ok) {
        results.push({ id: r.id, name: r.name, action: "send_failed", error: respBody });
        continue;
      }
      // Mark sent + log.
      await sb
        .from("trial_signups")
        .update({
          comeback_email_sent_at: new Date().toISOString(),
          comeback_email_id: respBody.id ?? null,
        })
        .eq("id", r.id);
      await sb.from("email_log").insert({
        resend_id: respBody.id ?? null,
        event_type: "sent_inline",
        from_addr: FROM_ADDRESS,
        to_addrs: [r.email],
        subject,
        send_path: "comeback_email_fu1",
        trial_signup_id: r.id,
        raw: { studio_slug: studio.slug },
      });
      results.push({ id: r.id, name: r.name, studio: studio.name, to: r.email, subject, action: "sent", resend_id: respBody.id });
    } catch (e) {
      results.push({ id: r.id, name: r.name, action: "send_threw", error: String(e) });
    }
  }

  return new Response(
    JSON.stringify(
      {
        ok: true,
        dry_run: dryRun,
        eligible_count: rows?.length ?? 0,
        sent: results.filter((x) => x.action === "sent").length,
        skipped: results.filter((x) => x.action !== "sent" && x.action !== "dry_run").length,
        results,
        first_sample: firstSample,
      },
      null,
      2,
    ),
    { headers: { "Content-Type": "application/json" } },
  );
});
