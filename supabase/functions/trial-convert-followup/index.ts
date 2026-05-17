// Supabase Edge Function: trial-convert-followup
//
// Runs every 30 min via pg_cron. For each paid trial signup that:
//   - completed Stripe checkout
//   - has NOT yet been sent a "convert to monthly" SMS
//   - has 2+ MindBody visits since their trial start
// sends a Twilio SMS asking them to reply YES to lock in a monthly membership.
// Marks `convert_sms_sent_at` so they're only ever messaged once.
//
// POST body (optional):
//   { dry_run?: boolean, min_visits?: number, lookback_days?: number }

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

function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length >= 8 && raw.trim().startsWith('+')) return '+' + digits;
  return null;
}

function firstName(full: string): string {
  return (full || '').trim().split(/\s+/)[0] || 'there';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const body: {
    dry_run?: boolean;
    min_visits?: number;
    lookback_days?: number;
    test_phone?: string;
    test_name?: string;
    test_studio?: string;
    test_kind?: 'welcome' | 'convert';
  } = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const dryRun = !!body.dry_run;
  const minVisits = Math.max(1, Math.min(20, Number(body.min_visits ?? 2)));
  const lookbackDays = Math.max(1, Math.min(180, Number(body.lookback_days ?? 60)));

  const sid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const token = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const from = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
  if (!sid || !token || !from) {
    return json({ ok: false, error: 'Twilio secrets not set' }, 500);
  }
  const auth0 = 'Basic ' + btoa(`${sid}:${token}`);

  // ─── Buy a toll-free number (search + purchase in one call) ───────────
  // POST { "buy_tollfree": true }  (optional: { area_code: "877" })
  if ((body as any).buy_tollfree) {
    const areaCode = (body as any).area_code as string | undefined;
    const searchUrl = new URL(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/TollFree.json`
    );
    searchUrl.searchParams.set('SmsEnabled', 'true');
    searchUrl.searchParams.set('PageSize', '1');
    if (areaCode) searchUrl.searchParams.set('AreaCode', areaCode);
    const s = await fetch(searchUrl.toString(), { headers: { Authorization: auth0 } });
    const sb = await s.json();
    const candidate = sb?.available_phone_numbers?.[0]?.phone_number;
    if (!candidate) {
      return json({ ok: false, step: 'search', error: sb?.message || 'no TF numbers available', raw: sb }, 500);
    }
    const p = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
      {
        method: 'POST',
        headers: { Authorization: auth0, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          PhoneNumber: candidate,
          FriendlyName: 'BBB Toll-Free SMS (auto-purchased)',
        }).toString(),
      }
    );
    const pb = await p.json();
    if (!p.ok) {
      return json({ ok: false, step: 'purchase', candidate, error: pb?.message || `HTTP ${p.status}`, raw: pb }, 500);
    }
    return json({
      ok: true,
      purchased: {
        phone: pb.phone_number,
        sid: pb.sid,
        friendly_name: pb.friendly_name,
        capabilities: pb.capabilities,
      },
    });
  }

  // ─── List owned phone numbers in this Twilio account ──────────────────
  if ((body as any).list_numbers) {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=50`,
      { headers: { Authorization: auth0 } }
    );
    const b = await r.json();
    const nums = (b?.incoming_phone_numbers || []).map((n: any) => ({
      sid: n.sid,
      phone: n.phone_number,
      friendly_name: n.friendly_name,
      date_created: n.date_created,
      capabilities: n.capabilities,
    }));
    return json({ ok: r.ok, numbers: nums, count: nums.length });
  }

  // ─── Status check — list the last N messages with full delivery info ──
  // Use to debug "queued but never arrived" issues (A2P 10DLC, trial account
  // unverified recipients, carrier blocks, etc.)
  //   curl ... -d '{"list_recent":5}'
  if (body.list_recent || (body as any).list_recent === 0) {
    const limit = Math.max(1, Math.min(50, Number((body as any).list_recent || 5)));
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?PageSize=${limit}`,
      { headers: { Authorization: auth0 } }
    );
    const b = await r.json();
    const msgs = (b?.messages || []).map((m: any) => ({
      sid: m.sid,
      date: m.date_created,
      from: m.from,
      to: m.to,
      status: m.status,
      error_code: m.error_code,
      error_message: m.error_message,
      direction: m.direction,
      body_preview: (m.body || '').slice(0, 80),
    }));
    return json({ ok: r.ok, recent_messages: msgs, http: r.status });
  }

  // ─── Test mode — send a single SMS to a specific number ───────────────
  // Use to QA both message templates without inserting fake data or paying.
  //   curl ... -d '{"test_phone":"6317086585","test_kind":"welcome"}'
  //   curl ... -d '{"test_phone":"6317086585","test_kind":"convert"}'
  if (body.test_phone) {
    const to = toE164(body.test_phone);
    if (!to) return json({ ok: false, error: `unparseable test_phone: ${body.test_phone}` }, 400);
    const fname = firstName(body.test_name || 'Justin');
    const studio = body.test_studio || 'Astoria';
    const slug = studio.toLowerCase().replace(/\s+/g, '-');
    const kind = body.test_kind || 'welcome';
    const msg = kind === 'convert'
      ? `Hey ${fname}! 2 classes in at BBB ${studio} — nice work. Want to lock in monthly unlimited and keep the momentum? Reply YES and we'll get you set up. - BBB`
      : `Hi ${fname}! Welcome to Better Body Bootcamp ${studio}. Your 2-week trial is live — book your first class here: https://betterbodybootcamp.com/locations/${slug} Reply with any questions, we're here to help. - BBB`;
    try {
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: 'POST',
          headers: { Authorization: auth0, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: from, To: to, Body: msg }).toString(),
        }
      );
      const resBody = await resp.json();
      return json({
        ok: resp.ok,
        mode: 'test',
        kind,
        to,
        body_preview: msg,
        twilio_sid: resBody?.sid ?? null,
        twilio_error: resp.ok ? null : (resBody?.message ?? `HTTP ${resp.status}`),
      }, resp.ok ? 200 : 500);
    } catch (e) {
      return json({ ok: false, mode: 'test', error: (e as Error).message }, 500);
    }
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const { data: candidates, error } = await sb.rpc(
    'get_trials_ready_for_convert_sms',
    { p_min_visits: minVisits, p_lookback_days: lookbackDays }
  );
  if (error) return json({ ok: false, error: error.message }, 500);
  if (!candidates || candidates.length === 0) {
    return json({ ok: true, candidates_found: 0, sent: 0, results: [] });
  }

  const auth = 'Basic ' + btoa(`${sid}:${token}`);
  const results: Array<Record<string, unknown>> = [];

  for (const c of candidates as Array<{
    trial_id: string;
    name: string;
    email: string;
    phone: string;
    studio_slug: string;
    studio_name: string;
    visit_count: number;
  }>) {
    const to = toE164(c.phone);
    const r: Record<string, unknown> = {
      trial_id: c.trial_id,
      email: c.email,
      studio: c.studio_slug,
      visits: c.visit_count,
      phone_e164: to,
      sent: false,
      sid: null as string | null,
      error: null as string | null,
    };

    if (!to) {
      r.error = `unparseable phone: ${c.phone}`;
      await sb
        .from('trial_signups')
        .update({
          convert_sms_error: r.error,
          visit_count_at_followup: c.visit_count,
        })
        .eq('id', c.trial_id);
      results.push(r);
      continue;
    }

    const studioLabel = c.studio_name || c.studio_slug;
    const msg =
      `Hey ${firstName(c.name)}! ${c.visit_count} classes in at BBB ${studioLabel} — ` +
      `nice work. Want to lock in monthly unlimited and keep the momentum? ` +
      `Reply YES and we'll get you set up. - BBB`;

    if (dryRun) {
      r.sent = false;
      r.dry_run_preview = msg;
      results.push(r);
      continue;
    }

    try {
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ From: from, To: to, Body: msg }).toString(),
        }
      );
      const resBody = await resp.json();
      if (!resp.ok) {
        const errMsg = resBody?.message || `HTTP ${resp.status}`;
        r.error = errMsg;
        await sb
          .from('trial_signups')
          .update({
            convert_sms_error: String(errMsg).slice(0, 500),
            visit_count_at_followup: c.visit_count,
          })
          .eq('id', c.trial_id);
      } else {
        r.sent = true;
        r.sid = resBody?.sid ?? null;
        await sb
          .from('trial_signups')
          .update({
            convert_sms_sent_at: new Date().toISOString(),
            convert_sms_error: null,
            visit_count_at_followup: c.visit_count,
          })
          .eq('id', c.trial_id);
      }
    } catch (e) {
      const errMsg = (e as Error).message || String(e);
      r.error = errMsg;
      await sb
        .from('trial_signups')
        .update({
          convert_sms_error: errMsg.slice(0, 500),
          visit_count_at_followup: c.visit_count,
        })
        .eq('id', c.trial_id);
    }
    results.push(r);
  }

  return json({
    ok: true,
    dry_run: dryRun,
    min_visits: minVisits,
    lookback_days: lookbackDays,
    candidates_found: candidates.length,
    sent: results.filter((r) => r.sent).length,
    results,
  });
});
