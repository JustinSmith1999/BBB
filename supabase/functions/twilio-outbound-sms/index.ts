// Supabase Edge Function: twilio-outbound-sms
//
// Sends an SMS from BBB's Twilio number to a trial_signup customer, logging
// the message to sms_messages so /homebase shows the conversation thread.
//
// Goal: every text staff sends is recorded. "Did Kiana text this lead?" stops
// being a mystery — either it's in sms_messages or it didn't happen.
//
// POST body:
//   { trial_signup_id: uuid,
//     body: string,
//     sent_by?: string  // staff name (Kiana, CV, etc.) shown in /homebase
//   }
//
// Twilio status webhook (twilio-status-webhook) will later update the row's
// `status` field as the message is queued → sent → delivered → failed.
//
// ENV:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER (e.g. +18772860293)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (set automatically)
//
// Deploy: supabase functions deploy twilio-outbound-sms --no-verify-jwt

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

function normalizeUsPhone(p: string | null | undefined): string | null {
  const d = (p || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: { trial_signup_id?: string; to_phone?: string; studio?: string; body?: string; sent_by?: string; media_url?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const trialId = body?.trial_signup_id?.trim();
  const text    = body?.body?.trim();
  const sentBy  = body?.sent_by?.trim() || null;

  // 2026-09-01 · Homebase Inbox: allow sending to a raw phone (winback
  // members and other non-trial threads have no trial_signup_id).
  const directPhone = normalizeUsPhone(body?.to_phone);
  if ((!trialId && !directPhone) || !text) {
    return json({ ok: false, error: 'trial_signup_id or to_phone, plus body, required' }, 400);
  }
  if (text.length > 1500) {
    return json({ ok: false, error: 'body too long (>1500 chars)' }, 400);
  }

  const sbUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const sbKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const sb = createClient(sbUrl, sbKey);

  // Look up the trial_signup to get the customer's phone + studio slug.
  // In direct-phone mode there is no trial row; studio comes from the body.
  let trial: any = null;
  if (trialId) {
    const { data: t, error: trialErr } = await sb
      .from('trial_signups')
      .select('id, name, phone, opted_out_at, location_id, locations:location_id(name)')
      .eq('id', trialId)
      .is('deleted_at', null)
      .maybeSingle();
    if (trialErr || !t) {
      return json({ ok: false, error: `trial not found: ${trialErr?.message ?? 'no row'}` }, 404);
    }
    if (t.opted_out_at) {
      return json({ ok: false, error: 'customer has opted out — cannot SMS' }, 403);
    }
    trial = t;
  }
  const toPhone = trial ? normalizeUsPhone(trial.phone) : directPhone;
  if (!toPhone) {
    return json({ ok: false, error: `invalid phone` }, 400);
  }

  // Send via Twilio REST API.
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const authToken  = Deno.env.get('TWILIO_AUTH_TOKEN')  ?? '';
  const fromPhone  = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
  if (!accountSid || !authToken || !fromPhone) {
    return json({ ok: false, error: 'Twilio env vars missing' }, 500);
  }

  // 2026-06-24: US carriers don't allow alphanumeric sender IDs, and the
  // shared TWILIO_FROM_NUMBER shows up on some customers' phones as "Justin"
  // (his J20 Solutions contact name from prior interactions). Prepend a one-
  // line BBB brand header so customers immediately see who's texting them,
  // no matter what contact name their phone shows.
  // Skip the prepend if staff already typed "BBB" anywhere in the first 30
  // chars of the body — avoids double-branding when they wrote it manually.
  const studioName = String((trial as any)?.locations?.name ?? body?.studio ?? '').trim();
  const head30 = text.slice(0, 30).toUpperCase();
  const alreadyBranded = head30.includes('BBB') || head30.includes('BETTER BODY');
  const finalBody = (studioName && !alreadyBranded)
    ? `— BBB ${studioName} —\n${text}`
    : text;

  // Status webhook so we get queued → sent → delivered updates.
  const statusCallback = `${sbUrl}/functions/v1/twilio-status-webhook`;

  const tw = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: fromPhone,
        To: toPhone,
        Body: finalBody,
        StatusCallback: statusCallback,
        // 2026-08-22: optional image attachment (sends as MMS). Must be a
        // public https URL (e.g. the Supabase logos bucket).
        ...(body.media_url?.startsWith('https://') ? { MediaUrl: body.media_url } : {}),
      }),
    },
  );

  const twJson = await tw.json();
  if (!tw.ok) {
    // Log the failure to sms_messages so it shows in the thread too.
    await sb.from('sms_messages').insert({
      trial_signup_id: trialId ?? null,
      studio_slug: ((trial as any)?.locations?.name ?? body?.studio ?? '').toLowerCase().replace(/\s+/g, '-') || null,
      direction: 'outbound',
      from_phone: fromPhone,
      to_phone: toPhone,
      body: finalBody,
      send_path: trialId ? null : 'homebase_manual',
      status: 'failed',
      error_code: String(twJson?.code ?? ''),
      error_message: twJson?.message ?? 'unknown',
      sent_by: sentBy,
    });
    return json({ ok: false, twilio_error: twJson }, 502);
  }

  // Twilio accepted — log the outbound to the gateway.
  const { error: insErr } = await sb.from('sms_messages').insert({
    trial_signup_id: trialId ?? null,
    studio_slug: ((trial as any)?.locations?.name ?? body?.studio ?? '').toLowerCase().replace(/\s+/g, '-') || null,
    send_path: trialId ? null : 'homebase_manual',
    direction: 'outbound',
    from_phone: fromPhone,
    to_phone: toPhone,
    body: finalBody,
    twilio_sid: twJson.sid,
    status: twJson.status || 'queued',
    sent_by: sentBy,
  });
  if (insErr) {
    // The text DID send, but the log failed. Surface it loudly so staff
    // know there's a gap.
    return json({
      ok: true,
      sent: true,
      twilio_sid: twJson.sid,
      warning: `sms_messages insert failed: ${insErr.message}`,
    });
  }

  return json({
    ok: true,
    sent: true,
    twilio_sid: twJson.sid,
    status: twJson.status,
    to: toPhone,
  });
});
