// Supabase Edge Function: trial-review-request
//
// THE MAP-PACK ENGINE. Review count + recency is the single biggest ranking
// factor for "gym near me". This asks every active $49 trial member for a
// Google review, per studio, on autopilot — the signal we're currently not
// collecting at all.
//
// WHO IT MESSAGES (all must be true):
//   - payment_status = 'completed' (a real paid trial)
//   - payment_date is min_days..max_days ago (default 5–13): they're mid-trial
//     and have almost certainly attended a few classes, so they're warm
//   - review_request_sent_at IS NULL (only ever asked once)
//   - opted_out_at IS NULL (respect opt-outs everywhere)
//   - their studio has locations.review_link set (skipped otherwise)
//
// WHAT IT SENDS: a short SMS + email pointing to that studio's Google review
// link. Marks review_request_sent_at so nobody is asked twice.
//
// ─────────────────────────────────────────────────────────────────────────────
// SAFETY — this sends NOTHING until you explicitly turn it on. Two locks:
//   1. dry_run defaults TRUE. You must POST { "live": true } to send.
//   2. Even with live:true, it stays in dry-run UNLESS BBB_SEND_PATHS_ENABLED
//      contains 'trial_review_request'. So it's inert until you add that flag.
// Recommended rollout: deploy → dry-run (see who'd be messaged) → add the send
// path → run live with a small limit → then schedule.
// ─────────────────────────────────────────────────────────────────────────────
//
// USAGE:
//   Dry run (safe, shows the audience, sends nothing):
//     POST {}                      // or { "dry_run": true }
//   Live (only after you add the send path + review links):
//     POST { "live": true, "limit": 25 }
//   Test one number/email:
//     POST { "live": true, "test_phone": "+1...", "test_email": "you@..." }
//
// DEPLOY:
//   bbb deploy-fn trial-review-request
//   (migration 20260819_trial_review_request.sql adds the columns it needs)
//
// SCHEDULE (after you're happy with live sends):
//   run daily ~11am via pg_cron, same pattern as the other drip crons.

// deno-lint-ignore-file
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length >= 8 && String(raw).trim().startsWith('+')) return '+' + digits;
  return null;
}
const firstName = (full: string) => (full || '').trim().split(/\s+/)[0] || 'there';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // ── Auth gate (same as the other drip functions) ──────────────────────────
  const SHARED_SECRET = Deno.env.get('FUNCTION_SHARED_SECRET') ?? '';
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presentedSecret = req.headers.get('x-bbb-secret') ?? '';
  const presentedBearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!((SHARED_SECRET && presentedSecret === SHARED_SECRET) ||
        (SERVICE_ROLE && presentedBearer === SERVICE_ROLE))) {
    return json({ ok: false, error: 'unauthorized — provide x-bbb-secret or service-role bearer' }, 401);
  }

  const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const minDays = Math.max(1, Math.min(60, Number(body.min_days ?? 5)));
  const maxDays = Math.max(minDays, Math.min(90, Number(body.max_days ?? 13)));
  const limit = Math.max(1, Math.min(200, Number(body.limit ?? 50)));

  // ── Safety locks ──────────────────────────────────────────────────────────
  const sendPaths = (Deno.env.get('BBB_SEND_PATHS_ENABLED') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const pathEnabled = sendPaths.includes('trial_review_request');
  // dry_run unless caller passes live:true AND the send path is enabled.
  // Exception (2026-08-28): test mode (test_phone/test_email) may send without
  // the path flag — it only ever targets the explicitly passed address, so the
  // preview can be reviewed BEFORE arming real sends.
  const wantsLive = body.live === true && !body.dry_run;
  const isTest = Boolean(body.test_phone || body.test_email);
  const dryRun = !(wantsLive && (pathEnabled || isTest));

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const sb = createClient(supabaseUrl, SERVICE_ROLE);

  // Twilio + Resend config
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const twToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const from = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  const fromEmail = Deno.env.get('FROM_EMAIL') ?? 'Better Body Bootcamp <hello@betterbodybootcamp.com>';
  const twAuth = 'Basic ' + btoa(`${sid}:${twToken}`);

  // ── Studio review links ────────────────────────────────────────────────────
  const { data: locs } = await sb.from('locations')
    .select('id, name, review_link, is_active').eq('is_active', true);
  const reviewLinkByLoc: Record<string, string> = {};
  const studioByLoc: Record<string, string> = {};
  for (const l of (locs ?? [])) {
    if (l.review_link) reviewLinkByLoc[l.id] = l.review_link;
    studioByLoc[l.id] = l.name;
  }

  // ── Candidate trials ────────────────────────────────────────────────────────
  const now = Date.now();
  const gte = new Date(now - maxDays * 864e5).toISOString();
  const lte = new Date(now - minDays * 864e5).toISOString();
  let candidates: any[] = [];
  if (body.test_phone || body.test_email) {
    candidates = [{
      id: 'test', name: body.test_name ?? 'Test Member', email: body.test_email ?? null,
      phone: body.test_phone ?? null, location_id: (locs ?? [])[0]?.id ?? null,
    }];
  } else {
    // 2026-08-28: targeted mode — mt-webhook fires this per check-in with
    // { target_email }. Skips the day window (they just walked out of class —
    // warmest possible moment) but keeps every other guard: completed payment,
    // never-asked-before, not opted out.
    const targetEmail = typeof body.target_email === 'string' ? body.target_email.trim().toLowerCase() : null;
    let q = sb.from('trial_signups')
      .select('id, name, email, phone, location_id, payment_date, review_request_sent_at, opted_out_at')
      .eq('payment_status', 'completed')
      .is('review_request_sent_at', null)
      .is('opted_out_at', null);
    q = targetEmail ? q.eq('email', targetEmail).limit(1) : q.gte('payment_date', gte).lte('payment_date', lte).limit(limit);
    const { data, error } = await q;
    if (error) return json({ ok: false, error: `query: ${error.message}` }, 500);
    candidates = data ?? [];
  }

  const results: any[] = [];
  let sent = 0, skipped = 0;

  for (const t of candidates) {
    const link = reviewLinkByLoc[t.location_id];
    const studio = studioByLoc[t.location_id] ?? 'Better Body Bootcamp';
    const row: any = { id: t.id, studio, email: t.email, phone: t.phone };
    if (!link) { row.skipped = 'no review_link for studio'; skipped++; results.push(row); continue; }

    const fn = firstName(t.name);
    const smsBody =
      `Hey ${fn}! Hope you're loving your classes at Better Body Bootcamp ${studio}. ` +
      `A quick Google review would mean a ton to the coaches — 30 seconds here: ${link} ` +
      `Reply STOP to opt out.`;
    const emailSubject = `How's your trial going at Better Body Bootcamp ${studio}?`;
    // 2026-08-28: branded review email (Justin: "make sure the review email is
    // branded and nice") — same dark design family as the campaign emails.
    const LOGO_URL = 'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png';
    const emailHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background-color:#0D0D0D;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0D0D0D;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#0D0D0D;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="padding:32px 36px 8px 36px;"><img src="${LOGO_URL}" alt="Better Body Bootcamp" width="72" style="display:block;border:0;"></td></tr>
<tr><td align="center" style="padding:36px 28px 0 28px;">
  <div style="font-size:12px;font-weight:bold;letter-spacing:4px;color:#E11D2A;">BETTER BODY ${studio.toUpperCase()}</div>
  <div style="font-family:'Arial Black',Arial,sans-serif;font-size:38px;line-height:42px;font-weight:900;color:#F2EFE6;padding-top:14px;">HOW'S&nbsp;IT&nbsp;GOING,<br>${fn.toUpperCase()}?</div>
  <div style="font-size:30px;letter-spacing:8px;padding-top:18px;color:#E11D2A;">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
  <div style="padding:18px 10px 0 10px;font-size:16px;line-height:26px;color:#CFCFCF;">If a coach or a class has made your week, a quick Google review is the biggest thank-you there is.<br>It takes 30 seconds and helps your neighbors find us.</div>
</td></tr>
<tr><td style="padding:30px 36px 0 36px;"><a href="${link}" style="display:block;background-color:#E11D2A;color:#FFFFFF;font-family:'Arial Black',Arial,sans-serif;font-size:20px;font-weight:900;letter-spacing:4px;text-align:center;text-decoration:none;padding:20px 10px;">LEAVE&nbsp;A&nbsp;REVIEW</a></td></tr>
<tr><td align="center" style="padding:16px 24px 0 24px;font-size:13px;color:#8A8A8A;">Opens Google &middot; no account setup needed</td></tr>
<tr><td style="padding:40px 36px 0 36px;">
  <div style="font-size:18px;font-weight:bold;color:#FFFFFF;">Better Than Yesterday.</div>
  <div style="padding-top:10px;font-size:13px;line-height:21px;color:#9A9A9A;">The ${studio} team &middot; Better Body Bootcamp</div>
  <div style="padding:20px 0 34px 0;font-size:11px;line-height:18px;color:#6E6E6E;">You're getting this because you train with us. Reply "unsubscribe" and we'll stop. &middot; Better Body Bootcamp, NYC</div>
</td></tr>
</table></td></tr></table></body></html>`;

    if (dryRun) {
      row.dry_run = true; row.would_sms = !!toE164(t.phone); row.would_email = !!t.email; row.link = link;
      results.push(row); continue;
    }

    // ── SEND (live) ──
    const e164 = toE164(t.phone);
    if (e164 && sid && twToken && from) {
      try {
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST', headers: { Authorization: twAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: e164, From: from, Body: smsBody }),
        });
        row.sms_ok = r.ok; if (!r.ok) row.sms_error = (await r.text()).slice(0, 160);
      } catch (e) { row.sms_ok = false; row.sms_error = String(e).slice(0, 160); }
    }
    if (t.email && resendKey) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: fromEmail, to: t.email, subject: emailSubject, html: emailHtml }),
        });
        row.email_ok = r.ok; if (!r.ok) row.email_error = (await r.text()).slice(0, 160);
        try {
          await sb.from('email_log').insert({
            event_type: 'sent', from_addr: fromEmail, to_addrs: [t.email],
            subject: emailSubject, send_path: 'trial_review_request', trial_signup_id: t.id === 'test' ? null : t.id,
          });
        } catch { /* email_log optional */ }
      } catch (e) { row.email_ok = false; row.email_error = String(e).slice(0, 160); }
    }
    if (t.id !== 'test' && (row.sms_ok || row.email_ok)) {
      await sb.from('trial_signups').update({ review_request_sent_at: new Date().toISOString() }).eq('id', t.id);
      sent++;
    }
    results.push(row);
  }

  return json({
    ok: true,
    dry_run: dryRun,
    send_path_enabled: pathEnabled,
    note: dryRun
      ? "DRY RUN — nothing sent. To go live: add 'trial_review_request' to BBB_SEND_PATHS_ENABLED, set locations.review_link per studio, then POST { live:true }."
      : 'LIVE — messages sent.',
    window_days: [minDays, maxDays],
    candidates: candidates.length,
    sent, skipped,
    studios_missing_review_link: (locs ?? []).filter((l) => !l.review_link).map((l) => l.name),
    results,
  });
});
