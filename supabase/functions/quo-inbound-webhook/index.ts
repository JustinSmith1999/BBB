// Supabase Edge Function: quo-inbound-webhook
//
// Receives Quo (OpenPhone) message webhooks for the Bayside + Fresh Meadows
// lines and mirrors them into sms_messages, so /homebase keeps showing the full
// conversation thread even though texting now rides Quo instead of Twilio.
//
// Unlike the Twilio inbound webhook, this stays lean on purpose: Quo's own
// shared inbox + mobile app already notify every staffer on the line and let
// them reply/call, so there is NO owner-forward-by-SMS / front-desk-email
// machinery to rebuild here. We only: (1) log the message so Homebase's thread
// view stays whole, and (2) mirror STOP opt-outs onto the trial row.
//
// Handles both directions: inbound customer replies AND outbound texts staff
// send from the Quo app (so those show in Homebase too). Messages sent through
// twilio-outbound-sms are already logged there, so we de-dupe by Quo message id.
//
// Register in Quo (POST /v1/webhooks) with events message.received +
// message.delivered, pointed at:
//   https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/quo-inbound-webhook?s=<QUO_WEBHOOK_SECRET>
//
// Deploy: bbb deploy-fn quo-inbound-webhook

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const ok = (b: unknown = { ok: true }) => new Response(JSON.stringify(b), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });

const QUO_NUM2SLUG: Record<string, string> = { '+19178770759': 'bayside', '+16468876483': 'fresh-meadows' };

function e164(p: string | null | undefined): string | null {
  const d = String(p || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  return String(p || '').startsWith('+') ? String(p) : null;
}
function isStop(body: string): boolean {
  return ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT', 'CANCEL'].includes((body || '').trim().toUpperCase());
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return ok();

  // Lightweight shared-secret gate (the webhook is registered with ?s=...).
  const secret = Deno.env.get('QUO_WEBHOOK_SECRET') || Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';
  if (new URL(req.url).searchParams.get('s') !== secret) return new Response('forbidden', { status: 401, headers: cors });

  let evt: any = {};
  try { evt = await req.json(); } catch { return ok(); }
  const msg = evt?.data?.object ?? evt?.data ?? evt ?? {};
  const id = msg.id ?? evt.id ?? null;
  const dirRaw = String(msg.direction ?? '').toLowerCase();
  const inbound = dirRaw === 'incoming' || dirRaw === 'inbound';
  const from = e164(msg.from);
  const to = e164(Array.isArray(msg.to) ? msg.to[0] : msg.to);
  const text = String(msg.text ?? msg.body ?? '').trim();
  if (!id || (!from && !to)) return ok();

  const customer = inbound ? from : to;         // the non-BBB party
  const studioNum = inbound ? to : from;        // our Quo line
  const studioSlug = studioNum ? (QUO_NUM2SLUG[studioNum] ?? null) : null;

  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  // De-dupe: outbound sent through twilio-outbound-sms is already logged with
  // twilio_sid = the Quo message id. Skip anything we've already recorded.
  const { data: existing } = await sb.from('sms_messages').select('id').eq('twilio_sid', id).limit(1);
  if (existing && existing.length) return ok({ ok: true, deduped: true });

  // Tie to a trial card by the customer's phone (best-effort).
  let trialId: string | null = null;
  try {
    const { data: mid } = await sb.rpc('match_trial_by_phone', { p_phone: customer, p_studio_slug: null });
    trialId = (mid as string | null) ?? null;
  } catch (_e) { /* RPC optional */ }

  const { error: insErr } = await sb.from('sms_messages').insert({
    trial_signup_id: trialId,
    studio_slug: studioSlug,
    direction: inbound ? 'inbound' : 'outbound',
    from_phone: from,
    to_phone: to,
    body: text,
    twilio_sid: id,
    status: inbound ? 'received' : 'sent',
    send_path: inbound ? null : 'quo_app',
  });
  if (insErr) console.error('quo-inbound sms_messages insert failed:', insErr.message);

  // Mirror STOP opt-outs onto the matched trial (Quo enforces the block itself).
  if (inbound && isStop(text) && trialId) {
    await sb.from('trial_signups').update({ opted_out_at: new Date().toISOString() }).eq('id', trialId);
  }
  // Record the latest inbound body so the card shows recency, like the Twilio path.
  if (inbound && !isStop(text) && trialId) {
    await sb.from('trial_signups').update({ last_inbound_at: new Date().toISOString(), last_inbound_body: text.slice(0, 500) }).eq('id', trialId);
  }

  return ok();
});
