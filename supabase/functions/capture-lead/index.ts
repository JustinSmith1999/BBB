// Supabase Edge Function: capture-lead (2026-10-07)
//
// WHY THIS EXISTS
// The trial page asked for nine required fields before anyone counted as a
// lead: first name, last name, email, phone, card number, expiry, CVC, ZIP.
// 95% of that traffic is on a phone. Measured week of Sep 27 - Oct 4:
//
//     763 people reached a trial page
//      34 submitted            = 4.5%
//      29 of those 34 paid     = 85%
//
// The checkout converts fine. The problem is that there was no way to say
// "I'm interested" without typing a credit card, so the other 729 left no
// trace at all. Not a name, not a number, nothing to call back.
//
// This function is the half-step. The page calls it the moment name, email
// and phone are valid and BEFORE the card fields, so a person who bails at
// the card is still a row the front desk can ring.
//
// SILENT BY DEFAULT. The row is written with abandoned_email_sent_at already
// stamped, which is the flag every automated sender checks. Nothing emails
// or texts these people. They appear in Homebase's New Lead column and a
// human decides what happens next. To put them into the normal abandoned-cart
// drip instead, pass { "drip": true } from the page (see DRIP below).
//
// Idempotent: re-posting the same phone or email updates the existing row
// rather than creating a second one, so the page can call it on every blur
// without making duplicates. Never touches a row that already paid.
//
// POST (anon key, called from the browser):
//   { studio_slug, location_id, first_name, last_name, email, phone,
//     fbp?, fbc?, utm_source?, utm_medium?, utm_campaign?, utm_content?,
//     referrer?, page_url?, time_on_page_ms?, ab_variant?, drip? }
//
// Deploy: supabase functions deploy capture-lead --no-verify-jwt

// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-bbb-secret',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/** US 10/11-digit -> E.164. Returns null if it isn't a plausible US number. */
function normPhone(raw: string): string | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}
const normEmail = (raw: string) => {
  const e = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  let b: any = {};
  try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const phone = normPhone(b.phone);
  const email = normEmail(b.email);
  const locationId = String(b.location_id || '').trim();
  // Need something to call them on, and somewhere to file them.
  if (!phone && !email) return json({ ok: false, error: 'need a phone or an email' }, 400);
  if (!locationId) return json({ ok: false, error: 'location_id required' }, 400);

  const first = String(b.first_name || '').trim();
  const last = String(b.last_name || '').trim();
  const name = [first, last].filter(Boolean).join(' ') || null;

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // ── DRIP: default off. abandoned_email_sent_at is the field every sender
  // keys on (abandoned-cart-followup needs it NULL to fire; the -2, -resend
  // and -sms-resend variants need it set AND an email). Stamping it now and
  // nulling the email means nothing automated can reach these people.
  const drip = b.drip === true;
  const nowIso = new Date().toISOString();

  try {
    // ── find an existing row for this human, newest first.
    let existing: any = null;
    const tryFind = async (col: string, val: string) => {
      const { data } = await sb.from('trial_signups')
        .select('id, payment_status, front_desk_stage, created_at, deleted_at')
        .eq(col, val).order('created_at', { ascending: false }).limit(1);
      return data && data.length ? data[0] : null;
    };
    if (phone) existing = await tryFind('phone', phone);
    if (!existing && email) existing = await tryFind('email', email);

    // Already bought. Leave it completely alone — never downgrade a paid row.
    if (existing && ['completed', 'paid'].includes(String(existing.payment_status || ''))) {
      return json({ ok: true, status: 'already_paid', id: existing.id, wrote: false });
    }

    // 2026-10-07 OUTAGE. This object used to carry `referrer` and `page_url`.
    // NEITHER COLUMN EXISTS on trial_signups. PostgREST rejects the whole
    // insert with "Could not find the 'page_url' column", so from deploy until
    // now this function wrote NOTHING. Every person who typed their name and
    // number into a trial page got a 500 and disappeared; the page sends them
    // on to the card regardless, so it looked fine from outside. Confirmed by
    // querying the live table: zero trial_partial rows, ever.
    //
    // Verified against information_schema before rewriting this. Do not add a
    // field here without checking it exists — one wrong name kills the row.
    const attribution = {
      fbp: b.fbp || null,
      fbc: b.fbc || null,
      utm_source: b.utm_source || null,
      utm_medium: b.utm_medium || null,
      utm_campaign: b.utm_campaign || null,
      utm_content: b.utm_content || null,
      ab_variant: (b.ab_variant === 'A' || b.ab_variant === 'B') ? b.ab_variant : null,
      // The moment this lands, every click this browser ever made becomes
      // attributable to this person, retroactively.
      visitor_id: typeof b.visitor_id === 'string' ? b.visitor_id.slice(0, 64) : null,
      client_user_agent: req.headers.get('user-agent') || null,
      client_ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    };

    if (existing) {
      // Fill in anything we now know without clobbering what's there, and
      // never move someone the desk has already worked back to 'new_lead'.
      const patch: Record<string, unknown> = { ...attribution };
      if (name) patch.name = name;
      if (phone) patch.phone = phone;
      // Upgrade a placeholder to a real address if we now have one; never
      // overwrite a real one with a placeholder.
      if (email) patch.email = email;
      for (const k of Object.keys(patch)) if (patch[k] == null) delete patch[k];
      if (!existing.front_desk_stage) patch.front_desk_stage = 'new_lead';
      await sb.from('trial_signups').update(patch).eq('id', existing.id);
      return json({ ok: true, status: 'updated', id: existing.id, wrote: true, drip });
    }

    // ── EMAIL IS NOT NULL on trial_signups ──────────────────────────────
    // The old plan was to withhold the email entirely as a hard kill-switch
    // against automated senders. The column does not allow it, so that plan
    // was never going to work.
    //
    // What replaces it: the real email when we have one (variant A asks for
    // it; the desk can then actually reach the person), and the existing
    // @no-email.bbb.local convention when we don't (variant B is phone-only).
    // That domain is already used by stripe-payment-audit and already filtered
    // out by funnel-recovery, and it does not resolve, so nothing can be
    // delivered to it.
    //
    // Silence now rests on abandoned_email_sent_at being pre-stamped below,
    // which every drip sender checks. That is one lock instead of two, so if
    // a NEW sender is ever written it MUST check that field.
    const placeholderEmail = `lead-${(phone || '').replace(/\D/g, '') || Date.now()}@no-email.bbb.local`;

    const { data: ins, error } = await sb.from('trial_signups').insert({
      name: name || 'Website lead',          // name is NOT NULL too
      phone,
      email: email || placeholderEmail,
      location_id: locationId,
      payment_status: 'pending',
      front_desk_stage: 'new_lead',
      source_category: 'trial_partial',
      lead_source: `trial-page-partial-${String(b.studio_slug || '').trim() || 'unknown'}`,
      abandoned_email_sent_at: drip ? null : nowIso,
      ...attribution,
    }).select('id').single();

    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, status: 'created', id: ins?.id, wrote: true, drip });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message).slice(0, 300) }, 500);
  }
});
