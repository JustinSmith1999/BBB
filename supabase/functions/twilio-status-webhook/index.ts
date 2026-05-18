// Supabase Edge Function: twilio-status-webhook
//
// Consumes Twilio MessageStatus webhook callbacks and writes delivery state
// back to trial_signups. Configure in Twilio Console → Phone Numbers →
// +1-877-286-0293 → Messaging → "A message comes in" status callback URL:
//   https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/twilio-status-webhook
//
// Twilio POSTs form-urlencoded with at minimum:
//   MessageSid · MessageStatus · To · From · ErrorCode (optional)
//
// MessageStatus values: queued → sent → delivered (or failed / undelivered)
// ErrorCode 30032 = TF not verified, 30034 = 10DLC not registered, etc.
//
// We match by `welcome_sms_sid` or `convert_sms_sid` columns on trial_signups
// (added by 20260517_add_sms_sid_columns.sql migration).

// deno-lint-ignore-file
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Twilio-Signature',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: cors });
  }

  // Twilio sends application/x-www-form-urlencoded by default
  let params: URLSearchParams;
  try {
    const text = await req.text();
    params = new URLSearchParams(text);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'bad body' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const messageSid = params.get('MessageSid') ?? params.get('SmsSid') ?? '';
  const messageStatus = params.get('MessageStatus') ?? params.get('SmsStatus') ?? '';
  const errorCode = params.get('ErrorCode') ?? null;
  const to = params.get('To') ?? '';
  const from = params.get('From') ?? '';

  if (!messageSid) {
    return new Response(JSON.stringify({ ok: false, error: 'missing MessageSid' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // Map status → column updates. We track both welcome + convert SMS in the
  // same trial_signups row, so find whichever sid column matches.
  const nowIso = new Date().toISOString();
  const isFinal = ['delivered', 'failed', 'undelivered'].includes(messageStatus);
  const isOk = messageStatus === 'delivered';

  // Try welcome first
  const welcomeUpdate: Record<string, unknown> = {};
  if (isFinal) {
    if (isOk) welcomeUpdate.welcome_sms_delivered_at = nowIso;
    else welcomeUpdate.welcome_sms_failed_at = nowIso;
  }
  if (errorCode) welcomeUpdate.welcome_sms_error_code = errorCode;
  welcomeUpdate.welcome_sms_last_status = messageStatus;

  const { data: welcomeMatch, error: welcomeErr } = await sb
    .from('trial_signups')
    .update(welcomeUpdate)
    .eq('welcome_sms_sid', messageSid)
    .select('id');

  let touched = welcomeMatch?.length ?? 0;

  // If no welcome match, try convert
  if (touched === 0) {
    const convertUpdate: Record<string, unknown> = {};
    if (isFinal) {
      if (isOk) convertUpdate.convert_sms_delivered_at = nowIso;
      else convertUpdate.convert_sms_failed_at = nowIso;
    }
    if (errorCode) convertUpdate.convert_sms_error_code = errorCode;
    convertUpdate.convert_sms_last_status = messageStatus;

    const { data: convertMatch, error: convertErr } = await sb
      .from('trial_signups')
      .update(convertUpdate)
      .eq('convert_sms_sid', messageSid)
      .select('id');
    touched = convertMatch?.length ?? 0;
    if (convertErr) console.error('convert update error:', convertErr.message);
  }
  if (welcomeErr) console.error('welcome update error:', welcomeErr.message);

  console.log(`twilio status: sid=${messageSid} status=${messageStatus} error=${errorCode ?? '-'} to=${to} from=${from} rows_touched=${touched}`);

  return new Response(JSON.stringify({ ok: true, messageSid, messageStatus, errorCode, rows_touched: touched }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
