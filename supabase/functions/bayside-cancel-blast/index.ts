// Supabase Edge Function: bayside-cancel-blast
//
// ONE-SHOT mass SMS to a hand-curated list of customer phones — built for the
// 2026-06-25 Bayside same-day class cancellation. Bypasses the trial_signups
// lookup that twilio-outbound-sms requires because these are long-time MEMBERS
// (not trial leads) so they're not in trial_signups.
//
// AUTHORIZATION: Manual one-shot only. Justin authorizes each call in chat by
// posting the phone list + body. Function does NOT honor stored schedules and
// does NOT loop. It fires once and returns per-recipient status.
//
// POST body:
//   { phones: string[],        // any format, normalized to E.164 internally
//     body: string,            // SMS body (max 1500 chars)
//     studio_slug: string,     // 'bayside' | 'astoria' | 'fresh-meadows' | 'williamsburg'
//     secret: string }         // BBB_ADMIN_SECRET, must match
//
// Returns:
//   { ok: true, attempted: N, sent: N, failed: N, results: [{ phone, ok, error? }] }
//
// Auto-prepends "— BBB <Studio> —\n" to body so customers know the source.
// Skips numbers that can't be normalized to E.164.
//
// Deploy: supabase functions deploy bayside-cancel-blast --no-verify-jwt

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';

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

const STUDIO_LABELS: Record<string, string> = {
  'bayside':       'Bayside',
  'astoria':       'Astoria',
  'fresh-meadows': 'Fresh Meadows',
  'williamsburg':  'Williamsburg',
};

function normalizeUsPhone(p: string | null | undefined): string | null {
  const d = (p || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  return null;
}

function brandPrefix(body: string, studioLabel: string): string {
  // Match twilio-outbound-sms behavior: skip prefix if "BBB" or "BETTER BODY"
  // already in the first 30 chars, otherwise prepend.
  const head = body.slice(0, 30).toUpperCase();
  if (head.includes('BBB') || head.includes('BETTER BODY')) return body;
  return `— BBB ${studioLabel} —\n${body}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: { phones?: string[]; body?: string; studio_slug?: string; secret?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  if (body.secret !== ADMIN_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const phones = Array.isArray(body.phones) ? body.phones : [];
  const text   = (body.body || '').trim();
  const slug   = (body.studio_slug || '').trim().toLowerCase();
  const studioLabel = STUDIO_LABELS[slug];

  if (phones.length === 0) return json({ ok: false, error: 'phones[] required' }, 400);
  if (phones.length > 100) return json({ ok: false, error: 'too many phones (max 100)' }, 400);
  if (!text)               return json({ ok: false, error: 'body required' }, 400);
  if (text.length > 1500)  return json({ ok: false, error: 'body too long (>1500)' }, 400);
  if (!studioLabel)        return json({ ok: false, error: 'studio_slug must be bayside|astoria|fresh-meadows|williamsburg' }, 400);

  const sid   = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from  = Deno.env.get('TWILIO_FROM_NUMBER');
  if (!sid || !token || !from) {
    return json({ ok: false, error: 'Twilio env vars missing' }, 500);
  }
  const auth = 'Basic ' + btoa(`${sid}:${token}`);
  const finalBody = brandPrefix(text, studioLabel);

  const results: Array<{ phone: string; normalized: string | null; ok: boolean; twilio_sid?: string; status?: string; error?: string }> = [];
  let sent = 0, failed = 0;

  for (const raw of phones) {
    const to = normalizeUsPhone(raw);
    if (!to) {
      results.push({ phone: raw, normalized: null, ok: false, error: 'phone could not be normalized to E.164' });
      failed++;
      continue;
    }
    try {
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: from, To: to, Body: finalBody }).toString(),
        },
      );
      const resp = await r.json();
      if (r.ok) {
        results.push({ phone: raw, normalized: to, ok: true, twilio_sid: resp?.sid, status: resp?.status });
        sent++;
      } else {
        results.push({ phone: raw, normalized: to, ok: false, error: `${r.status}: ${resp?.message || JSON.stringify(resp).slice(0, 200)}` });
        failed++;
      }
    } catch (e) {
      results.push({ phone: raw, normalized: to, ok: false, error: (e as Error).message });
      failed++;
    }
    // Tiny gap between sends — Twilio doesn't really need it, but keeps us
    // under the default 1 msg/sec long-code limit and avoids 429s.
    await new Promise(r => setTimeout(r, 250));
  }

  return json({
    ok: true,
    attempted: phones.length,
    sent,
    failed,
    studio: studioLabel,
    body_preview: finalBody.slice(0, 200),
    results,
  });
});
