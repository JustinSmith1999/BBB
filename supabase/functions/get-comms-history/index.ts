// Supabase Edge Function: get-comms-history
//
// Returns every Resend email + Twilio SMS sent to a single person, by their
// email + phone. Powers the "comms history" panel on the /homebase Kanban
// modal so staff can see what we've already sent before sending more.
//
// POST body:
//   { email?: string, phone?: string, limit?: number, days?: number }
//
// Auth: requires Authorization: Bearer <anon or service-role JWT> (Supabase
// gateway already enforces this). No extra shared-secret check — staff are
// already authenticated to /homebase via Supabase Auth.
//
// Deploy: supabase functions deploy get-comms-history

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

function normPhoneE164(p: string | undefined | null): string | null {
  if (!p) return null;
  const digits = p.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return digits.length >= 8 ? '+' + digits : null;
}

// Map a subject/body line to the funnel stage it belongs to. The /homebase
// modal renders this as a colored chip so staff can see at a glance whether
// the customer got the welcome / reminders / abandoned-checkout sequence /
// owner notification / etc. — instead of just a wall of timestamps.
//
// Patterns are intentionally lenient (case-insensitive substring/regex) so
// minor copy edits don't break the classification. Order matters: more
// specific stages come before generic ones.
function classifyFunnelStage(subject: string, body: string): string {
  const s = (subject || '').toLowerCase();
  const b = (body || '').toLowerCase();
  const hay = s + ' \n ' + b;

  if (/welcome|you'?re in|here'?s what to do first|trial confirm|trial is booked/.test(hay)) return 'welcome';
  if (/abandoned|didn'?t finish|complete your (signup|checkout)|left.*behind|come back and finish/.test(hay)) return 'abandoned_checkout';
  if (/comeback|win.?back|we miss you|haven'?t seen you|come back/.test(hay)) return 'winback';
  if (/halfway through your trial|day [3-5] check|how'?s your trial going/.test(hay)) return 'mid_trial';
  if (/last chance|trial ends|final day|trial is ending|expires (today|tomorrow)/.test(hay)) return 'trial_ending';
  if (/booked|confirmed for|see you (at|on)|class reminder|tomorrow at \d/.test(hay)) return 'class_confirmation';
  if (/reschedul|moved your class|switched your class/.test(hay)) return 'reschedule';
  if (/new (paid )?trial:|🚨|new signup at|just signed up/.test(hay)) return 'owner_notification';
  if (/contact form|got your message|thanks for reaching out|we received your inquiry/.test(hay)) return 'contact_reply';
  if (/receipt|invoice|payment (received|confirmation)|charged \$/.test(hay)) return 'receipt';
  return 'other';
}

// Resend: list every email this account has sent, filter client-side by
// recipient. Their API doesn't support server-side filtering by `to`.
// Returns { emails, error } so the caller can surface API issues (e.g. 401
// from a send-only API key) instead of silently returning empty.
async function listResendEmails(email: string, limit: number): Promise<{ emails: any[]; error: string | null; pages_scanned: number }> {
  // Prefer a dedicated read key (set with: supabase secrets set RESEND_READ_API_KEY=re_...)
  // because the standard RESEND_API_KEY is typically scoped to "Sending access"
  // only and can't read the /emails list.
  const KEY = Deno.env.get('RESEND_READ_API_KEY') || Deno.env.get('RESEND_API_KEY');
  if (!KEY) return { emails: [], error: 'no Resend API key configured', pages_scanned: 0 };
  const out: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  while (pages < 5 && out.length < limit) {
    const url = new URL('https://api.resend.com/emails');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('after', cursor);
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${KEY}` } });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 300);
      return { emails: out, error: `Resend list HTTP ${r.status}: ${text}`, pages_scanned: pages };
    }
    const body = await r.json() as { data?: any[]; has_more?: boolean };
    const items = body?.data || [];
    for (const item of items) {
      const tos = Array.isArray(item.to) ? item.to.map((t: any) => String(t).toLowerCase()) : [String(item.to || '').toLowerCase()];
      if (tos.includes(email.toLowerCase())) {
        const subject = item.subject || '(no subject)';
        if (/halfway through your trial/i.test(subject)) continue;
        out.push({
          channel: 'email',
          sent_at: item.created_at,
          to: tos.join(', '),
          subject,
          from: item.from || null,
          status: item.last_event || 'sent',
          provider_id: item.id,
          funnel_stage: classifyFunnelStage(subject, ''),
          // Body isn't on the list endpoint — panel loads it on click via
          // { email_id } request (see fetchResendEmailBody below).
        });
        if (out.length >= limit) break;
      }
    }
    pages++;
    if (!body?.has_more || !items.length) break;
    cursor = items[items.length - 1]?.id ?? null;
    if (!cursor) break;
  }
  return { emails: out, error: null, pages_scanned: pages };
}

// Twilio: native server-side filter by `To` address. Both directions (outbound
// = sent to customer, inbound = customer replied) are included.
async function listTwilioMessages(phone: string, limit: number): Promise<{ messages: any[]; error: string | null }> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const tok = Deno.env.get('TWILIO_AUTH_TOKEN');
  if (!sid || !tok) return { messages: [], error: 'no Twilio credentials' };
  const auth = 'Basic ' + btoa(`${sid}:${tok}`);
  const out: any[] = [];
  let firstErr: string | null = null;
  for (const filter of [`To=${encodeURIComponent(phone)}`, `From=${encodeURIComponent(phone)}`]) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?${filter}&PageSize=${Math.min(limit, 50)}`;
    const r = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) {
      if (!firstErr) firstErr = `Twilio ${r.status}: ${(await r.text()).slice(0, 200)}`;
      continue;
    }
    const body = await r.json();
    const items = (body?.messages || []) as any[];
    for (const m of items) {
      const text = String(m.body || '');
      if (/halfway through your trial/i.test(text)) continue;
      out.push({
        channel: 'sms',
        sent_at: m.date_created,
        to: m.to,
        from: m.from,
        direction: m.direction,
        // Full SMS body (SMS rarely > 320 chars). Panel can render the
        // whole thing — no need to truncate aggressively like email subject.
        subject: text.slice(0, 320),
        body: text,
        status: m.status,
        error_code: m.error_code || null,
        provider_id: m.sid,
        funnel_stage: classifyFunnelStage('', text),
      });
    }
  }
  return { messages: out, error: firstErr };
}

// On-demand: pull a single email's full body so the panel can expand a row.
// Resend's list endpoint doesn't return body content, so we lazy-fetch per
// email when the user clicks "Read more".
async function fetchResendEmailBody(emailId: string): Promise<{ html: string | null; text: string | null; subject: string | null; error: string | null }> {
  const KEY = Deno.env.get('RESEND_READ_API_KEY') || Deno.env.get('RESEND_API_KEY');
  if (!KEY) return { html: null, text: null, subject: null, error: 'no Resend API key configured' };
  const r = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 300);
    return { html: null, text: null, subject: null, error: `Resend get HTTP ${r.status}: ${text}` };
  }
  const j = await r.json() as any;
  return {
    html: j.html || null,
    text: j.text || null,
    subject: j.subject || null,
    error: null,
  };
}

serve(async (req) => {
  // ─── 2026-09-01 · INBOX MODE ────────────────────────────────────────────
  // { inbox: true, days?: 30 } → every SMS conversation of the last N days
  // grouped into threads, with names resolved from trial_signups and
  // mariana_tek_clients (winback members). Powers the Homebase Inbox tab.
  if (req.method === 'POST') {
    let peek: any = {};
    try { peek = await req.clone().json(); } catch { /* fall through */ }
    if (peek?.inbox === true) {
      try {
        const days = Math.min(Number(peek.days) || 30, 90);
        const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
        const sb2 = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        );
        const { data: msgs, error: mErr } = await sb2
          .from('sms_messages')
          .select('created_at, from_phone, to_phone, body, direction, status, send_path, sent_by, trial_signup_id')
          .gte('created_at', sinceIso)
          // NULL-safe exclude: .neq alone drops send_path IS NULL rows too
          // (SQL three-valued logic) — which is every inbound text.
          .or('send_path.is.null,send_path.neq.owner_inbound_alert')
          .order('created_at', { ascending: false })
          .limit(4000);
        if (mErr) return json({ ok: false, error: mErr.message }, 500);
        // We fetched newest-first (so a 30-day window never truncates TODAY);
        // flip back to chronological for thread building.
        (msgs ?? []).reverse();
        const { data: owners } = await sb2.from('location_owners').select('phone');
        const ownerSet = new Set((owners ?? []).map((o: any) => String(o.phone || '').replace(/\D+/g, '').slice(-10)).filter(Boolean));
        const last10 = (p: string) => String(p || '').replace(/\D+/g, '').slice(-10);
        const threads = new Map<string, any>();
        for (const m of msgs ?? []) {
          const counterpart = m.direction === 'inbound' ? m.from_phone : m.to_phone;
          const key = last10(counterpart);
          if (!key || key.length < 10) continue;
          if (ownerSet.has(key)) continue; // owner pings are not customer threads
          let t = threads.get(key);
          if (!t) { t = { phone: '+1' + key, messages: [], trial_signup_id: null }; threads.set(key, t); }
          if (m.trial_signup_id) t.trial_signup_id = m.trial_signup_id;
          t.messages.push({ at: m.created_at, dir: m.direction, body: m.body, status: m.status, path: m.send_path, by: m.sent_by });
        }
        // Resolve names: trial_signups first, then mariana_tek_clients.
        const phones = [...threads.keys()].map((k) => '+1' + k);
        const nameByKey: Record<string, any> = {};
        if (phones.length) {
          const { data: ts } = await sb2.from('trial_signups')
            .select('id, name, phone, front_desk_stage, location_id, locations:location_id(name)')
            .in('phone', phones).is('deleted_at', null);
          for (const r of ts ?? []) nameByKey[last10(r.phone)] = {
            name: r.name, kind: 'lead', stage: r.front_desk_stage,
            studio: (r as any).locations?.name ?? null, trial_signup_id: r.id,
          };
          const { data: mc } = await sb2.from('mariana_tek_clients')
            .select('first_name, last_name, phone, studio_slug')
            .in('phone', phones);
          for (const r of mc ?? []) {
            const k = last10(r.phone);
            if (!nameByKey[k]) nameByKey[k] = {
              name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), kind: 'member',
              stage: null, studio: r.studio_slug, trial_signup_id: null,
            };
          }
        }
        // Winback name fallback: the campaign batch file knows every
        // recipient's name + studio even when no DB table does.
        try {
          const { data: batchBlob } = await sb2.storage.from('campaigns').download('winback-batch-2026-08-21.json');
          if (batchBlob) {
            const batch = JSON.parse(await batchBlob.text());
            const rows2 = Array.isArray(batch) ? batch : (batch.rows || batch.recipients || []);
            for (const r of rows2) {
              const k = last10(r.phone);
              if (k && !nameByKey[k]) nameByKey[k] = { name: r.name, kind: 'member', stage: null, studio: r.studio, trial_signup_id: null };
            }
          }
        } catch (_e) { /* name fallback only */ }

        const out = [...threads.entries()].map(([k, t]) => {
          const info = nameByKey[k] || {};
          const msgsArr = t.messages.slice(-50);
          const lastIn = [...msgsArr].reverse().find((m: any) => m.dir === 'inbound');
          const lastOutHuman = [...msgsArr].reverse().find((m: any) => m.dir === 'outbound' && !['auto_reply'].includes(m.path || ''));
          const unanswered = !!lastIn && (!lastOutHuman || lastOutHuman.at < lastIn.at)
            && !/^(stop|stopall|unsubscribe)$/i.test((lastIn.body || '').trim());
          return {
            phone: t.phone,
            name: info.name || null, kind: info.kind || 'unknown',
            stage: info.stage || null, studio: info.studio || null,
            trial_signup_id: info.trial_signup_id || t.trial_signup_id,
            last_at: msgsArr[msgsArr.length - 1]?.at, unanswered,
            messages: msgsArr,
          };
        })
        // Blast-only threads (we texted an offer, they never replied and no
        // human ever manually texted them) are campaign logs, not
        // conversations — keep the inbox to real threads.
        .filter((t: any) => t.messages.some((m: any) => m.dir === 'inbound'
          || (m.dir === 'outbound' && !String(m.path || '').startsWith('winback') && m.path !== 'auto_reply')))
        .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at))).slice(0, 60);
        return json({ ok: true, threads: out, days });
      } catch (e) {
        return json({ ok: false, error: (e as Error).message }, 500);
      }
    }
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const body: { email?: string; phone?: string; limit?: number; days?: number; email_id?: string; trial_id?: string } =
    req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  // Mode 2: load a single email's full body for the expand-on-click action.
  if (body.email_id) {
    const detail = await fetchResendEmailBody(String(body.email_id));
    return json({ ok: !detail.error, email_id: body.email_id, ...detail });
  }

  const email = (body.email || '').trim().toLowerCase();
  const phone = normPhoneE164(body.phone);
  const trialId = (body.trial_id || '').trim() || null;
  const limit = Math.max(5, Math.min(100, Number(body.limit ?? 30)));

  if (!email && !phone) {
    return json({ ok: false, error: 'provide at least one of email, phone' }, 400);
  }

  // Owner / studio SMS pings are sent to Chris / Steve / Carlos's phones
  // (not the customer's), so Twilio's `To=customerPhone` filter misses them
  // entirely. Pull from our local sms_messages table by trial_signup_id so
  // the customer card surfaces every send fanned out about that customer.
  async function listLocalOwnerSms(): Promise<{ messages: any[]; error: string | null }> {
    if (!trialId) return { messages: [], error: null };
    try {
      const sb = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      );
      const { data, error } = await sb.from('sms_messages')
        .select('twilio_sid, sent_by, to_phone, from_phone, body, status, direction, created_at')
        .eq('trial_signup_id', trialId)
        .in('sent_by', ['manual_owner_alert', 'stripe_owner_sms', 'manual_studio_alert'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return { messages: [], error: error.message };
      const messages = (data ?? []).map((m: any) => ({
        channel: 'sms',
        sent_at: m.created_at,
        to: m.to_phone,
        from: m.from_phone,
        direction: m.direction || 'outbound',
        subject: String(m.body || '').slice(0, 320),
        body: String(m.body || ''),
        status: m.status || 'queued',
        provider_id: m.twilio_sid || null,
        sent_by: m.sent_by,
        funnel_stage: 'owner_notification',
      }));
      return { messages, error: null };
    } catch (e) {
      return { messages: [], error: (e as Error).message };
    }
  }

  // Pull the customer's own contact-form submissions (if any) so the original
  // "I'd like pricing info" message renders as the first item in the Comms
  // thread alongside outbound emails + SMS. Matched by email so both new and
  // pre-trigger historical submissions surface here.
  async function listLocalInquiries(): Promise<{ inquiries: any[]; error: string | null }> {
    if (!email) return { inquiries: [], error: null };
    try {
      const sb = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      );
      const { data, error } = await sb.from('contact_submissions')
        .select('id, name, email, phone, message, location_id, created_at')
        .ilike('email', email)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) return { inquiries: [], error: error.message };
      const inquiries = (data ?? []).map((c: any) => ({
        channel: 'inquiry',
        direction: 'inbound',
        sent_at: c.created_at,
        to: 'Better Body Bootcamp',
        from: c.email,
        // Use a short label as subject and the FULL message as body so the
        // frontend can expand-on-click just like a full email read.
        subject: 'Contact-form inquiry · ' + (String(c.message || '(no message)').slice(0, 160)),
        body: c.message || '(no message)',
        status: 'received',
        provider_id: c.id,
        funnel_stage: 'inquiry',
      }));
      return { inquiries, error: null };
    } catch (e) {
      return { inquiries: [], error: (e as Error).message };
    }
  }

  const [emailResult, smsResult, localOwnerSms, localInquiries] = await Promise.all([
    email ? listResendEmails(email, limit) : Promise.resolve({ emails: [] as any[], error: null, pages_scanned: 0 }),
    phone ? listTwilioMessages(phone, limit) : Promise.resolve({ messages: [] as any[], error: null }),
    listLocalOwnerSms(),
    listLocalInquiries(),
  ]);

  // De-dupe by Twilio SID across Twilio API + local table so we don't double
  // up if a row exists in both (shouldn't usually, but be safe).
  const seenSids = new Set<string>();
  const sms = [...smsResult.messages, ...localOwnerSms.messages].filter((m: any) => {
    const sid = String(m.provider_id || '');
    if (!sid) return true;
    if (seenSids.has(sid)) return false;
    seenSids.add(sid);
    return true;
  });

  const all = [...emailResult.emails, ...sms, ...localInquiries.inquiries].sort((a, b) => {
    return String(b.sent_at || '').localeCompare(String(a.sent_at || ''));
  }).slice(0, limit);

  return json({
    ok: true,
    email_queried: email || null,
    phone_queried: phone || null,
    trial_id_queried: trialId,
    email_count: emailResult.emails.length,
    sms_count: sms.length,
    owner_sms_count: localOwnerSms.messages.length,
    inquiry_count: localInquiries.inquiries.length,
    resend_error: emailResult.error,
    resend_pages_scanned: emailResult.pages_scanned,
    twilio_error: smsResult.error,
    local_owner_sms_error: localOwnerSms.error,
    local_inquiry_error: localInquiries.error,
    comms: all,
  });
});
