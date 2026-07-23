// Supabase Edge Function: twilio-inbound-sms
//
// Handles inbound SMS replies to BBB's toll-free number. Two responsibilities:
//   1. ALWAYS write the inbound to sms_messages so /homebase shows the
//      thread on each trial_signup card.
//   2. ALWAYS forward the reply via SMS to gym owner + front-desk cells
//      configured in location_owners.notify_on_inbound=true, so the right
//      humans see it on THEIR phone, not just on the dashboard.
//      (2026-06-12)
//
// Plus the legacy YES-handler: watches for "YES" replies to the 2-visit
// Convert SMS — flags the trial signup for conversion follow-up and notifies
// the studio staff via Resend so they can close the deal by phone.
//
// Configure in Twilio Console → Phone Numbers → +1-877-286-0293 → Messaging →
// "A message comes in" webhook:
//   https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/twilio-inbound-sms
//
// Twilio expects a TwiML response — we return an empty <Response/> so the
// auto-reply (if any) is silent. The studio handles outreach manually.

// deno-lint-ignore-file
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Twilio-Signature',
};

const TRIAL_NOTIFY: Record<string, string[]> = {
  bayside: [
    'carlos@betterbodybootcamp.com',
    'bayside@betterbodybootcamp.com',
  ],
  'fresh-meadows': [
    'carlos@betterbodybootcamp.com',
    'freshmeadows@betterbodybootcamp.com',
  ],
  williamsburg: [
    'steve@betterbodybootcamp.com',
    'chris@betterbodybootcamp.com',
    'williamsburg@betterbodybootcamp.com',
  ],
  astoria: [
    'steve@betterbodybootcamp.com',
    'chris@betterbodybootcamp.com',
    'astoria@betterbodybootcamp.com',
  ],
};

// 2026-06-12 — per-studio FRONT-DESK email addresses for inbound-reply
// forwarding. Subset of TRIAL_NOTIFY: just the studio inbox, not the owners
// (they get SMS alerts via location_owners). Front-desk staff see the full
// conversation in email so they can react during shift, even if they're not
// looking at /homebase at that moment.
const FRONT_DESK_EMAIL: Record<string, string> = {
  bayside:         'bayside@betterbodybootcamp.com',
  'fresh-meadows': 'freshmeadows@betterbodybootcamp.com',
  williamsburg:    'williamsburg@betterbodybootcamp.com',
  astoria:         'astoria@betterbodybootcamp.com',
};

const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function isYes(body: string): boolean {
  // 2026-05-31: tightened after the funnel-recovery spam incident. Was matching
  // OK/Y/SURE which fired "🔥 Convert YES" emails to all owners on casual
  // replies like "ok thanks". Now requires an explicit YES-word AND the entire
  // message to be ≤12 chars — long replies are conversation, not consent.
  const cleaned = body.trim().toUpperCase().replace(/[^\w]/g, '');
  if (cleaned.length === 0 || cleaned.length > 12) return false;
  return ['YES', 'YEP', 'YUP', 'YESPLEASE', 'YEAH'].includes(cleaned);
}

function isStop(body: string): boolean {
  const cleaned = body.trim().toUpperCase();
  return ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT', 'CANCEL'].includes(cleaned);
}

async function notifyStaffOfConvertYes(
  studioSlug: string,
  studioName: string,
  fromPhone: string,
  body: string,
  trial: { name: string; email: string; phone: string } | null,
) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const recipients = TRIAL_NOTIFY[studioSlug];
  if (!apiKey || !recipients?.length) {
    console.warn('No Resend key or recipients for studio', studioSlug);
    return;
  }
  const subj = `🔥 Convert YES from ${trial?.name || fromPhone} — ${studioName}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
      <h2 style="margin:0 0 4px;font-size:22px;letter-spacing:-0.01em">🔥 New "YES" to convert</h2>
      <div style="color:#666;font-size:13px;margin-bottom:20px">${studioName} · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:6px 0;color:#666;width:120px">Name</td><td style="padding:6px 0;font-weight:600">${trial?.name || '(unknown — match on phone)'}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Phone</td><td style="padding:6px 0"><a href="tel:${fromPhone}" style="color:#0066cc;text-decoration:none">${fromPhone}</a></td></tr>
        <tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0">${trial?.email ? `<a href="mailto:${trial.email}" style="color:#0066cc;text-decoration:none">${trial.email}</a>` : '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Reply text</td><td style="padding:6px 0">"${body}"</td></tr>
      </table>
      <p style="font-size:14px;color:#111;margin:24px 0 0"><strong>Call them today</strong> to close the monthly conversion while the momentum is hot.</p>
    </div>
  `;
  const text = `🔥 Convert YES — ${studioName}\n\n${trial?.name || '(unknown)'}\n${fromPhone}\n${trial?.email || ''}\nReply: "${body}"\n\nCall to close.`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'BBB Trials <trials@betterbodybootcamp.com>',
        to: recipients,
        subject: subj,
        html,
        text,
        reply_to: trial?.email || undefined,
      }),
    });
    if (!r.ok) console.error('Resend YES notification failed:', await r.text());
    else console.log('Resend YES notification sent to', recipients.join(', '));
  } catch (e) {
    console.error('Resend YES notification exception:', e);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(TWIML_OK, { status: 200, headers: { ...cors, 'Content-Type': 'text/xml' } });
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await req.text());
  } catch {
    return new Response(TWIML_OK, { status: 200, headers: { ...cors, 'Content-Type': 'text/xml' } });
  }

  const from = params.get('From') ?? '';
  const to = params.get('To') ?? '';
  const body = (params.get('Body') ?? '').trim();
  const sid = params.get('MessageSid') ?? '';

  console.log(`twilio inbound: from=${from} to=${to} sid=${sid} body="${body.slice(0, 100)}"`);

  if (!from || !body) {
    return new Response(TWIML_OK, { status: 200, headers: { ...cors, 'Content-Type': 'text/xml' } });
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // Log every inbound to a generic table so nothing is ever lost. Best effort.
  try {
    await sb.from('twilio_inbound_log').insert({
      from_phone: from,
      to_phone: to,
      body,
      twilio_sid: sid,
    });
  } catch (e) {
    console.error('twilio_inbound_log insert failed (table may not exist):', e);
  }

  // ─── NEW: SMS gateway — attach EVERY inbound to a trial_signup card by
  // phone match (not just convert-SMS recipients). This is what /homebase
  // reads to render the conversation thread on each card. Without this,
  // staff have no record of what the customer texted them.
  let matchedTrialIdForGateway: string | null = null;
  let matchedLocationId: string | null = null;
  let matchedTrialName: string | null = null;
  try {
    const { data: mid } = await sb.rpc('match_trial_by_phone', { p_phone: from, p_studio_slug: null });
    matchedTrialIdForGateway = (mid as string | null) ?? null;
    const { error: smsErr } = await sb.from('sms_messages').insert({
      trial_signup_id: matchedTrialIdForGateway,
      from_phone: from,
      to_phone: to,
      body,
      direction: 'inbound',
      twilio_sid: sid,
      status: 'received',
    });
    if (smsErr) console.error('sms_messages inbound insert failed:', smsErr.message);
  } catch (e) {
    console.error('sms_messages inbound exception:', (e as Error).message);
  }

  // ─── 2026-06-12 · Forward inbound to gym owners + front desk via SMS ────
  // For every inbound that isn't a STOP/HELP keyword, look up every phone
  // in location_owners with notify_on_inbound=true for that studio and
  // fire a forward SMS so the right humans see the reply on THEIR phone.
  // Loop protection: skip if the inbound's from_phone is itself one of
  // the owner numbers (someone replying to a forward shouldn't re-trigger).
  // The forward includes the customer's name (if matched), the message,
  // their phone, and a /homebase link so the owner can reply with one tap.
  if (!isStop(body)) {
    try {
      // Find the customer's trial row to get their name + location_id for routing.
      const fromDigits = from.replace(/\D+/g, '');
      const phoneVariantsFwd = [from, '+' + fromDigits, fromDigits,
        fromDigits.length === 11 && fromDigits.startsWith('1') ? fromDigits.slice(1) : fromDigits];
      const { data: fwdTrial } = await sb
        .from('trial_signups')
        .select('id, name, location_id')
        .in('phone', Array.from(new Set(phoneVariantsFwd)))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      matchedLocationId = fwdTrial?.location_id ?? null;
      matchedTrialName = fwdTrial?.name ?? null;

      // 2026-06-12 — Twilio 11200 fix. Resolve studioSlug/rawStudioName HERE
      // inside the forward block instead of referencing the variables that
      // get declared later in the function (TDZ ReferenceError → 500 →
      // Twilio HTTP retrieval failure).
      let fwdStudioName: string | undefined;
      let fwdStudioSlug = '';
      if (matchedLocationId) {
        const locLookup = await sb.from('locations').select('name').eq('id', matchedLocationId).maybeSingle();
        fwdStudioName = locLookup?.data?.name as string | undefined;
        fwdStudioSlug = (fwdStudioName ?? '').toLowerCase().replace(/\s+/g, '-');
      }

      // If we couldn't tie the inbound to a studio, we can't route — log + bail.
      if (!matchedLocationId) {
        console.warn('owner-forward: no location_id matched for inbound from', from, '— forward skipped');
      } else {
        // Pull the recipient list for this studio.
        const { data: recipients, error: recErr } = await sb
          .from('location_owners')
          .select('name, role, phone')
          .eq('location_id', matchedLocationId)
          .eq('notify_on_inbound', true);
        if (recErr) console.error('location_owners lookup error:', recErr.message);

        const TWILIO_SID  = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
        const TWILIO_TOK  = Deno.env.get('TWILIO_AUTH_TOKEN')  ?? '';
        const TWILIO_FROM = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';

        if (!TWILIO_SID || !TWILIO_TOK || !TWILIO_FROM) {
          console.warn('owner-forward: TWILIO env not configured — skipping forward');
        } else if (recipients && recipients.length > 0) {
          // Normalize the from-phone for loop comparison.
          const fromDigitsFwd = from.replace(/\D+/g, '');
          const isLoop = (ownerPhone: string) =>
            ownerPhone.replace(/\D+/g, '').slice(-10) === fromDigitsFwd.slice(-10);

          // Compose the forward message. Keep it short — SMS char limits.
          const studioName = (fwdStudioName ?? 'BBB').trim();
          const senderLabel = matchedTrialName || from;
          const trimmedBody = body.length > 280 ? body.slice(0, 277) + '...' : body;
          const homebaseLink = matchedTrialIdForGateway
            ? `https://betterbodybootcamp.com/homebase#trial=${matchedTrialIdForGateway}`
            : 'https://betterbodybootcamp.com/homebase';
          const fwdMsg =
            `${studioName} — text from ${senderLabel} (${from}):\n\n` +
            `"${trimmedBody}"\n\n` +
            `Reply at ${homebaseLink}`;

          // Fire one Twilio call per recipient, in parallel. Each independently
          // logged to sms_messages so the dashboard shows what we sent + to whom.
          await Promise.all(recipients.map(async (r) => {
            const toOwner = String(r.phone || '').trim();
            if (!toOwner) return;
            if (isLoop(toOwner)) {
              console.log('owner-forward: skipping loop —', toOwner, 'is the sender');
              return;
            }
            try {
              const tform = new URLSearchParams();
              tform.set('To', toOwner);
              tform.set('From', TWILIO_FROM);
              tform.set('Body', fwdMsg);
              const tres = await fetch(
                `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOK}`),
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: tform.toString(),
                }
              );
              const tj: { sid?: string; message?: string } = await tres.json().catch(() => ({}));
              const okFwd = tres.ok && tj.sid;
              // Log this forward send so /homebase + /ops can see "owner X was
              // pinged at HH:MM about Y's reply".
              const { error: logErr } = await sb.from('sms_messages').insert({
                trial_signup_id: matchedTrialIdForGateway,
                from_phone: TWILIO_FROM,
                to_phone:   toOwner,
                body:       fwdMsg,
                direction:  'outbound',
                twilio_sid: okFwd ? tj.sid : null,
                status:     okFwd ? 'queued' : 'failed',
                send_path:  'owner_inbound_alert',
                studio_slug: fwdStudioSlug,
                error_message: okFwd ? null : (tj.message ?? `http_${tres.status}`),
              });
              if (logErr) {
                console.error('sms_messages owner-forward insert FAILED', {
                  pg_code: (logErr as { code?: string }).code,
                  pg_message: logErr.message,
                  to: toOwner,
                });
              }
              if (!okFwd) {
                console.error(`owner-forward Twilio fail for ${toOwner}:`, tj.message ?? tres.status);
              } else {
                console.log(`owner-forward sent to ${r.name || toOwner} (${r.role}) sid=${tj.sid}`);
              }
            } catch (e) {
              console.error(`owner-forward exception for ${toOwner}:`, (e as Error).message);
            }
          }));
        } else {
          console.warn('owner-forward: no recipients configured for location_id', matchedLocationId);
        }
      }
    } catch (e) {
      console.error('owner-forward outer exception:', (e as Error).message);
    }

    // ── Email forward to front-desk inbox so the conversation lands in
    //    shift email AND the dashboard, not just SMS. Best effort.
    // Uses the same studio resolution as the SMS forward above — we re-derive
    // it here so this block is independent (forward block exists, email
    // block runs in same scope).
    try {
      const apiKey = Deno.env.get('RESEND_API_KEY');
      // Re-resolve studio in case the SMS-forward block bailed early.
      let emailStudioName: string | undefined;
      let emailStudioSlug = '';
      if (matchedLocationId) {
        const locLookup2 = await sb.from('locations').select('name').eq('id', matchedLocationId).maybeSingle();
        emailStudioName = locLookup2?.data?.name as string | undefined;
        emailStudioSlug = (emailStudioName ?? '').toLowerCase().replace(/\s+/g, '-');
      }
      const fdEmail = FRONT_DESK_EMAIL[emailStudioSlug];
      if (apiKey && fdEmail) {
        const studioName = (emailStudioName ?? emailStudioSlug).trim();
        const senderLabel = matchedTrialName || from;
        const homebaseLink = matchedTrialIdForGateway
          ? `https://betterbodybootcamp.com/homebase#trial=${matchedTrialIdForGateway}`
          : 'https://betterbodybootcamp.com/homebase';
        const subj = `📩 Reply from ${senderLabel} — ${studioName}`;
        const safeBody = body
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeName = senderLabel
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const html = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
            <h2 style="margin:0 0 4px;font-size:20px;letter-spacing:-0.01em">Customer replied to your BBB text</h2>
            <div style="color:#666;font-size:13px;margin-bottom:20px">${studioName} · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}</div>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:6px 0;color:#666;width:120px">From</td><td style="padding:6px 0;font-weight:600">${safeName}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Phone</td><td style="padding:6px 0"><a href="tel:${from}" style="color:#0066cc;text-decoration:none">${from}</a></td></tr>
            </table>
            <div style="background:#f4f4f5;border-left:3px solid #0066cc;padding:14px 18px;margin:18px 0;border-radius:4px;font-size:15px;line-height:1.5;white-space:pre-wrap">${safeBody}</div>
            <p style="font-size:14px;margin:18px 0 0">
              <a href="${homebaseLink}" style="background:#0066cc;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600">Reply in /homebase</a>
            </p>
            <p style="font-size:12px;color:#888;margin:24px 0 0">This message was auto-forwarded from your BBB Twilio inbound webhook. Replies you type in /homebase will text back to the customer through the same number.</p>
          </div>
        `;
        const text = `Customer reply — ${studioName}\n\nFrom: ${senderLabel}\nPhone: ${from}\n\n"${body}"\n\nReply in /homebase: ${homebaseLink}`;
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'BBB Inbox <inbox@betterbodybootcamp.com>',
            to: [fdEmail],
            subject: subj,
            html, text,
            tags: [
              { name: 'send_path', value: 'owner_inbound_alert_email' },
              { name: 'studio_slug', value: emailStudioSlug },
            ],
          }),
        });
        const rj: { id?: string; message?: string } = await r.json().catch(() => ({}));
        // Log this email to email_log so /homebase + /ops show it.
        const { error: emErr } = await sb.from('email_log').insert({
          resend_id: r.ok ? (rj.id ?? null) : null,
          event_type: 'sent_inline',
          from_addr: 'inbox@betterbodybootcamp.com',
          to_addrs: [fdEmail],
          subject: subj,
          send_path: 'owner_inbound_alert_email',
          trial_signup_id: matchedTrialIdForGateway,
          raw: { studio_slug: emailStudioSlug, status: r.status, error: r.ok ? null : (rj.message ?? null) },
        });
        if (emErr) console.error('email_log owner-forward insert FAILED', {
          pg_code: (emErr as { code?: string }).code,
          pg_message: emErr.message,
        });
        if (!r.ok) console.error('Resend front-desk forward failed:', rj.message ?? r.status);
        else console.log(`front-desk email forward sent to ${fdEmail} id=${rj.id}`);
      } else if (!apiKey) {
        console.warn('owner-forward email: RESEND_API_KEY not set — skip');
      }
    } catch (e) {
      console.error('owner-forward email exception:', (e as Error).message);
    }
  }

  // Find the most recent trial signup matching this phone number that received
  // a convert SMS — that's the candidate for YES handling.
  const digits = from.replace(/\D+/g, '');
  const phoneVariants = [from, '+' + digits, digits, digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits];
  const { data: trial } = await sb
    .from('trial_signups')
    .select('id, name, email, phone, location_id, convert_sms_sent_at')
    .in('phone', Array.from(new Set(phoneVariants)))
    .not('convert_sms_sent_at', 'is', null)
    .order('convert_sms_sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const studioSlugLookup = trial?.location_id
    ? await sb.from('locations').select('name').eq('id', trial.location_id).maybeSingle()
    : null;
  const rawStudioName = studioSlugLookup?.data?.name as string | undefined;
  const studioSlug = (rawStudioName ?? '').toLowerCase().replace(/\s+/g, '-');

  if (isYes(body) && trial) {
    // Mark conversion intent on the row
    await sb
      .from('trial_signups')
      .update({
        convert_replied_yes_at: new Date().toISOString(),
        convert_reply_body: body.slice(0, 500),
      })
      .eq('id', trial.id);

    // Flip lead stage to a follow-up state
    if (trial.email) {
      await sb
        .from('leads')
        .update({ stage: 'convert_yes', last_touch_at: new Date().toISOString() })
        .eq('email', trial.email)
        .eq('studio_slug', studioSlug);
    }

    // Notify the studio staff
    await notifyStaffOfConvertYes(studioSlug, rawStudioName ?? studioSlug, from, body, trial);
  } else if (isStop(body)) {
    // Hard opt-out — Twilio handles the actual STOP filter, but mirror it.
    if (trial) {
      await sb
        .from('trial_signups')
        .update({ opted_out_at: new Date().toISOString() })
        .eq('id', trial.id);
    }
  } else {
    // Any other reply — log it, optionally notify studio so nothing falls through.
    if (trial) {
      await sb
        .from('trial_signups')
        .update({
          last_inbound_at: new Date().toISOString(),
          last_inbound_body: body.slice(0, 500),
        })
        .eq('id', trial.id);
    }
  }

  // Always return empty TwiML so Twilio doesn't auto-reply.
  return new Response(TWIML_OK, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'text/xml' },
  });
});
