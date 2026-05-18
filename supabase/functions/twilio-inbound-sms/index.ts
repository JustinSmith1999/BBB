// Supabase Edge Function: twilio-inbound-sms
//
// Handles inbound SMS replies to BBB's toll-free number. Specifically watches
// for "YES" replies to the 2-visit Convert SMS — flags the trial signup for
// conversion follow-up and notifies the studio staff via Resend so they can
// close the deal by phone.
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

const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function isYes(body: string): boolean {
  const cleaned = body.trim().toUpperCase().replace(/[^\w]/g, '');
  return ['YES', 'Y', 'YEP', 'YUP', 'SURE', 'OK', 'OKAY', 'YESPLEASE'].includes(cleaned);
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
