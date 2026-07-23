// Supabase Edge Function: bayside-cancel-email-blast
//
// ONE-SHOT email blast paired with bayside-cancel-blast (the SMS sibling).
// Takes a list of customer phones, looks up matching emails in
// `mindbody_clients` (the only place we have their contact info — these are
// long-time members, not trial_signups), then fires a Resend email to each
// found address.
//
// AUTHORIZATION: Manual one-shot only. Justin authorizes each call in chat.
// Function does NOT run on a schedule.
//
// POST body:
//   { phones: string[],           // any format, normalized to E.164 internally
//     subject: string,
//     body_html?: string,         // OR body_text — at least one required
//     body_text?: string,
//     studio_slug: string,        // 'bayside' | 'astoria' | 'fresh-meadows' | 'williamsburg'
//     dry_run?: boolean,          // if true, only do the lookup, don't send
//     secret: string }            // BBB_ADMIN_SECRET
//
// Returns:
//   { ok: true,
//     dry_run: bool,
//     phone_count: N,
//     emails_found: N,
//     emails_missing: N,
//     missing_phones: [{ phone, reason }],   // not found OR no email on file
//     sent: N,                                // 0 when dry_run
//     failed: N,
//     results: [{ phone, email, first_name, ok, error?, resend_id? }] }
//
// Deploy: supabase functions deploy bayside-cancel-email-blast --no-verify-jwt

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';
const FROM_EMAIL   = Deno.env.get('FROM_EMAIL') || 'Better Body Bootcamp <hello@betterbodybootcamp.com>';

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
// Return ONLY the 10 digits — used for fuzzy matching against mindbody_clients
// which stores phones in various formats (with/without +1, dots, dashes).
function digits10(p: string | null | undefined): string | null {
  const d = (p || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  if (d.length === 10) return d;
  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: {
    phones?: string[];
    subject?: string;
    body_html?: string;
    body_text?: string;
    studio_slug?: string;
    dry_run?: boolean;
    secret?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  if (body.secret !== ADMIN_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const phones    = Array.isArray(body.phones) ? body.phones : [];
  const subject   = (body.subject || '').trim();
  const bodyHtml  = (body.body_html || '').trim();
  const bodyText  = (body.body_text || '').trim();
  const slug      = (body.studio_slug || '').trim().toLowerCase();
  const dryRun    = body.dry_run === true;
  const studioLabel = STUDIO_LABELS[slug];

  if (phones.length === 0)                return json({ ok: false, error: 'phones[] required' }, 400);
  if (phones.length > 100)                return json({ ok: false, error: 'too many phones (max 100)' }, 400);
  if (!subject)                           return json({ ok: false, error: 'subject required' }, 400);
  if (!bodyHtml && !bodyText)             return json({ ok: false, error: 'body_html or body_text required' }, 400);
  if (!studioLabel)                       return json({ ok: false, error: 'studio_slug must be bayside|astoria|fresh-meadows|williamsburg' }, 400);

  const sbUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const sbKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const sb = createClient(sbUrl, sbKey);

  // Build the lookup table: 10-digit-only phone → original phone
  const phoneIndex: Record<string, string> = {};
  for (const p of phones) {
    const d10 = digits10(p);
    if (d10) phoneIndex[d10] = p;
  }
  const wantedDigits = Object.keys(phoneIndex);
  if (wantedDigits.length === 0) {
    return json({ ok: false, error: 'no valid 10-digit phones in input' }, 400);
  }

  // Pull ALL mindbody_clients rows whose phone matches one of our wanted
  // 10-digit numbers. We can't do a single SQL WHERE in() because the phone
  // formats vary in the DB, so we fetch a broader set and filter in JS.
  //
  // Strategy: for each wanted 10-digit number, try a LIKE %lastSeven% match
  // (last 7 digits are unique enough at our scale) and accumulate.
  const allMatches: Array<{ phone: string; email: string | null; first_name: string | null; last_name: string | null }> = [];
  const seenMbIds = new Set<string>();
  for (const d10 of wantedDigits) {
    const last7 = d10.slice(-7);
    const { data, error } = await sb
      .from('mindbody_clients')
      .select('mindbody_id, phone, email, first_name, last_name')
      .ilike('phone', `%${last7}%`)
      .limit(20);
    if (error) {
      // Log + keep going — partial lookup is better than total fail.
      console.error(`mindbody_clients lookup failed for ${d10}: ${error.message}`);
      continue;
    }
    for (const row of (data || [])) {
      if (!row.mindbody_id || seenMbIds.has(row.mindbody_id)) continue;
      seenMbIds.add(row.mindbody_id);
      allMatches.push({
        phone: row.phone || '',
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
      });
    }
  }

  // For each input phone, find the best matching mindbody_clients row.
  type Hit = { input_phone: string; email: string; first_name: string | null };
  type Miss = { input_phone: string; reason: string };
  const hits: Hit[] = [];
  const misses: Miss[] = [];
  for (const inputPhone of phones) {
    const wantedD10 = digits10(inputPhone);
    if (!wantedD10) {
      misses.push({ input_phone: inputPhone, reason: 'phone could not be normalized' });
      continue;
    }
    // Pick the first match whose MB phone (digit-stripped) ends in our wantedD10.
    const match = allMatches.find(m => {
      const mbD10 = digits10(m.phone);
      return mbD10 === wantedD10;
    });
    if (!match) {
      misses.push({ input_phone: inputPhone, reason: 'no mindbody_clients row with matching phone' });
      continue;
    }
    if (!match.email || !match.email.includes('@')) {
      misses.push({ input_phone: inputPhone, reason: `MB row found but email missing (name: ${match.first_name} ${match.last_name})` });
      continue;
    }
    hits.push({ input_phone: inputPhone, email: match.email.trim(), first_name: match.first_name });
  }

  const summary = {
    ok: true,
    dry_run: dryRun,
    phone_count: phones.length,
    emails_found: hits.length,
    emails_missing: misses.length,
    studio: studioLabel,
    from: FROM_EMAIL,
    subject,
    missing_phones: misses,
  };

  if (dryRun) {
    return json({
      ...summary,
      sent: 0,
      failed: 0,
      results: hits.map(h => ({
        phone: h.input_phone,
        email: h.email,
        first_name: h.first_name,
        ok: null,
        note: 'dry_run — not sent',
      })),
    });
  }

  // Real send via Resend.
  const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';
  if (!resendKey) {
    return json({ ok: false, error: 'RESEND_API_KEY missing' }, 500);
  }

  const results: Array<{ phone: string; email: string; first_name: string | null; ok: boolean; resend_id?: string; error?: string }> = [];
  let sent = 0, failed = 0;
  for (const h of hits) {
    // Replace {first_name} token in subject + body.
    const fname = h.first_name ? h.first_name.trim() : 'there';
    const subj  = subject.replace(/\{first_name\}/gi, fname);
    const html  = bodyHtml.replace(/\{first_name\}/gi, fname);
    const text  = bodyText.replace(/\{first_name\}/gi, fname);

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    FROM_EMAIL,
          to:      h.email,
          subject: subj,
          ...(html ? { html } : {}),
          ...(text ? { text } : {}),
          tags: [
            { name: 'send_path', value: 'bayside_cancel_email_blast' },
            { name: 'studio',    value: slug },
          ],
        }),
      });
      const resp = await r.json();
      if (r.ok) {
        results.push({ phone: h.input_phone, email: h.email, first_name: h.first_name, ok: true, resend_id: resp?.id });
        sent++;
      } else {
        results.push({ phone: h.input_phone, email: h.email, first_name: h.first_name, ok: false, error: `${r.status}: ${resp?.message || JSON.stringify(resp).slice(0, 200)}` });
        failed++;
      }
    } catch (e) {
      results.push({ phone: h.input_phone, email: h.email, first_name: h.first_name, ok: false, error: (e as Error).message });
      failed++;
    }
    // Light pacing — Resend is generous but be polite.
    await new Promise(r => setTimeout(r, 150));
  }

  return json({
    ...summary,
    sent,
    failed,
    results,
  });
});
