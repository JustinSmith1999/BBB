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

  let body: { trial_signup_id?: string; body?: string; sent_by?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const trialId = body?.trial_signup_id?.trim();
  const text    = body?.body?.trim();
  const sentBy  = body?.sent_by?.trim() || null;

  if (!trialId || !text) {
    return json({ ok: false, error: 'trial_signup_id and body required' }, 400);
  }
  if (text.length > 1500) {
    return json({ ok: false, error: 'body too long (>1500 chars)' }, 400);
  }

  const sbUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const sbKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const sb = createClient(sbUrl, sbKey);

  // Look up the trial_signup to get the customer's phone + studio slug.
  const { data: trial, error: trialErr } = await sb
    .from('trial_signups')
    .select('id, name, phone, opted_out_at, location_id, locations:location_id(name)')
    .eq('id', trialId)
    .is('deleted_at', null)
    .maybeSingle();
  if (trialErr || !trial) {
    return json({ ok: false, error: `trial not found: ${trialErr?.message ?? 'no row'}` }, 404);
  }
  if (trial.opted_out_at) {
    return json({ ok: false, error: 'customer has opted out — cannot SMS' }, 403);
  }
  const toPhone = normalizeUsPhone(trial.phone);
  if (!toPhone) {
    return json({ ok: false, error: `trial has invalid phone: ${trial.phone}` }, 400);
  }

  // Send via Twilio REST API.
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const authToken  = Deno.env.get('TWILIO_AUTH_TOKEN')  ?? '';
  const fromPhone  = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
  if (!accountSid || !authToken || !fromPhone) {
    return json({ ok: false, error: 'Twilio env vars missing' }, 500);
  }

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
        Body: text,
        StatusCallback: statusCallback,
      }),
    },
  );

  const twJson = await tw.json();
  if (!tw.ok) {
    // Log the failure to sms_messages so it shows in the thread too.
    await sb.from('sms_messages').insert({
      trial_signup_id: trialId,
      studio_slug: (trial as any).locations?.name?.toLowerCase()?.replace(/\s+/g, '-') ?? null,
      direction: 'outbound',
      from_phone: fromPhone,
      to_phone: toPhone,
      body: text,
      status: 'failed',
      error_code: String(twJson?.code ?? ''),
      error_message: twJson?.message ?? 'unknown',
      sent_by: sentBy,
    });
    return json({ ok: false, twilio_error: twJson }, 502);
  }

  // Twilio accepted — log the outbound to the gateway.
  const { error: insErr } = await sb.from('sms_messages').insert({
    trial_signup_id: trialId,
    studio_slug: (trial as any).locations?.name?.toLowerCase()?.replace(/\s+/g, '-') ?? null,
    direction: 'outbound',
    from_phone: fromPhone,
    to_phone: toPhone,
    body: text,
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
