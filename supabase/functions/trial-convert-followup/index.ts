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

  // Fix #12: Auth gate. Reject if the caller doesn't present either:
  //   (a) the FUNCTION_SHARED_SECRET in `x-bbb-secret` header, OR
  //   (b) the project SUPABASE_SERVICE_ROLE_KEY in `Authorization: Bearer ...`
  // This prevents anyone on the internet from calling buy_tollfree (charges
  // real money) or firing production SMS to customers.
  const SHARED_SECRET = Deno.env.get('FUNCTION_SHARED_SECRET') ?? '';
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presentedSecret = req.headers.get('x-bbb-secret') ?? '';
  const presentedBearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const isAuthorized =
    (SHARED_SECRET && presentedSecret === SHARED_SECRET) ||
    (SERVICE_ROLE && presentedBearer === SERVICE_ROLE);
  if (!isAuthorized) {
    return json({ ok: false, error: 'unauthorized — provide x-bbb-secret header or service-role bearer' }, 401);
  }

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

  // ─── Update TF number's SmsUrl + StatusCallback to point at our webhooks
  // POST { "set_webhooks": true, "phone": "+18772860293" }
  if ((body as any).set_webhooks) {
    const targetPhone = (body as any).phone || '+18772860293';
    const lookupR = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(targetPhone)}`,
      { headers: { Authorization: auth0 } },
    );
    const lookup = await lookupR.json();
    const numSid = lookup?.incoming_phone_numbers?.[0]?.sid;
    if (!numSid) {
      return json({ ok: false, error: `phone ${targetPhone} not found in account` }, 404);
    }
    const projectBase = 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1';
    const params = new URLSearchParams({
      SmsUrl: `${projectBase}/twilio-inbound-sms`,
      SmsMethod: 'POST',
      StatusCallback: `${projectBase}/twilio-status-webhook`,
      StatusCallbackMethod: 'POST',
    });
    const updR = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${numSid}.json`,
      {
        method: 'POST',
        headers: { Authorization: auth0, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
    );
    const updB = await updR.json();
    return json({
      ok: updR.ok,
      phone: updB?.phone_number,
      sms_url: updB?.sms_url,
      status_callback: updB?.status_callback,
      error: updR.ok ? null : (updB?.message || `HTTP ${updR.status}`),
    }, updR.ok ? 200 : 500);
  }

  // ─── Submit toll-free verification to carriers via Twilio API ─────────
  // POST { "submit_tf_verification": true, "phone": "+18772860293" }
  if ((body as any).submit_tf_verification) {
    const targetPhone = (body as any).phone || '+18772860293';
    const listR = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(targetPhone)}`,
      { headers: { Authorization: auth0 } }
    );
    const listB = await listR.json();
    const numberSid = listB?.incoming_phone_numbers?.[0]?.sid;
    if (!numberSid) {
      return json({ ok: false, step: 'lookup_sid', error: `phone ${targetPhone} not found in account`, raw: listB }, 404);
    }
    const params = new URLSearchParams();
    params.set('BusinessName', 'Bayside BB LLC');
    params.set('BusinessWebsite', 'https://betterbodybootcamp.com');
    params.set('NotificationEmail', 'Justin@j20solutions.com');
    params.append('UseCaseCategories', 'CUSTOMER_CARE');
    params.append('UseCaseCategories', 'ACCOUNT_NOTIFICATIONS');
    params.set('UseCaseSummary',
      'Transactional SMS to fitness studio members who paid for a $49 two-week trial on betterbodybootcamp.com/trial/{studio}. ' +
      'Two message types: (1) a welcome SMS with a booking link sent within seconds of Stripe payment confirmation, and ' +
      '(2) a follow-up SMS after the member has checked into 2 classes, asking if they want to convert to a monthly membership. ' +
      'All recipients consent by checking an explicit SMS opt-in checkbox on the paid trial form before submitting.'
    );
    params.set('ProductionMessageSample',
      'Hi Justin! Welcome to Better Body Bootcamp Williamsburg. Your 2-week trial is live — book your first class here: https://betterbodybootcamp.com/locations/williamsburg Reply with any questions, we\'re here to help. - BBB'
    );
    params.set('OptInType', 'WEB_FORM');
    params.append('OptInImageUrls', 'https://betterbodybootcamp.com/trial/williamsburg');
    params.append('OptInImageUrls', 'https://betterbodybootcamp.com/trial/bayside');
    params.set('MessageVolume', '100');
    params.set('TollfreePhoneNumberSid', numberSid);
    params.set('BusinessStreetAddress', '34-47 Bell Blvd');
    params.set('BusinessCity', 'Bayside');
    params.set('BusinessStateProvinceRegion', 'NY');
    params.set('BusinessPostalCode', '11361');
    params.set('BusinessCountry', 'US');
    params.set('BusinessContactFirstName', 'Justin');
    params.set('BusinessContactLastName', 'Smith');
    params.set('BusinessContactEmail', 'Justin@j20solutions.com');
    params.set('BusinessContactPhone', '+16317086585');
    params.set('BusinessType', 'PRIVATE_PROFIT');
    params.set('BusinessRegistrationNumber', '39-2476325');
    params.set('BusinessRegistrationAuthority', 'EIN');
    params.set('BusinessRegistrationCountry', 'US');
    params.set('BusinessIndustry', 'FITNESS');
    params.set('AdditionalInformation',
      'BBB is a fitness studio chain (4 NYC locations: Astoria, Bayside, Fresh Meadows, Williamsburg). ' +
      'Bayside BB LLC (EIN 39-2476325) is the registered legal entity for this Twilio account. ' +
      'SMS is transactional only — sent after paid Stripe purchase confirms consent. No marketing or promotional broadcasts.'
    );

    const vR = await fetch('https://messaging.twilio.com/v1/Tollfree/Verifications', {
      method: 'POST',
      headers: { Authorization: auth0, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const vB = await vR.json();
    return json({
      ok: vR.ok,
      step: 'submit_verification',
      tollfree_phone_sid: numberSid,
      verification_sid: vB?.sid ?? null,
      status: vB?.status ?? null,
      twilio_error: vR.ok ? null : (vB?.message || vB?.detail || `HTTP ${vR.status}`),
      raw: vR.ok ? undefined : vB,
    }, vR.ok ? 200 : 500);
  }

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

  // ─── Test mode — owner notification for a specific trial_signup_id ────
  // Mimics what stripe-webhook fires on a real paid trial: looks up the
  // trial row + that location's owners, sends each owner a notification SMS.
  // Idempotent — call as many times as needed during testing.
  //   curl ... -d '{"test_owner_notify":"<trial_signup_id>"}'
  if ((body as any).test_owner_notify) {
    const trialId = String((body as any).test_owner_notify);
    const sb2 = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    // 1. Pull the trial row
    const { data: trial, error: trialErr } = await sb2
      .from('trial_signups')
      .select('id, name, email, phone, location_id, payment_status, locations!inner(name)')
      .eq('id', trialId)
      .maybeSingle();
    if (trialErr || !trial) return json({ ok: false, error: `trial_signup not found: ${trialErr?.message || 'no row'}` }, 404);
    // 2. Pull the owners for that studio
    const { data: owners, error: ownersErr } = await sb2
      .from('location_owners')
      .select('owner_name, phone')
      .eq('location_id', trial.location_id)
      .eq('notify_signups', true);
    if (ownersErr) return json({ ok: false, error: `owners lookup failed: ${ownersErr.message}` }, 500);
    if (!owners || !owners.length) return json({ ok: false, error: `no owners seeded for location_id ${trial.location_id} — re-paste 20260527_location_owners.sql`, trial }, 404);
    // 3. Build + send identical body to what stripe-webhook would send
    const studioName = (trial as any).locations?.name || 'Studio';
    const body2 = `New $49 trial signup · ${studioName}\n` +
                  `${trial.name || '(no name)'}\n` +
                  `${trial.phone || ''}\n` +
                  `${trial.email || ''}`.trimEnd();
    const sent: any[] = [];
    for (const owner of owners) {
      const to = toE164(owner.phone);
      if (!to) { sent.push({ owner: owner.owner_name, error: `bad phone: ${owner.phone}` }); continue; }
      try {
        const r = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: 'POST',
            headers: { Authorization: auth0, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ From: from, To: to, Body: body2 }).toString(),
          }
        );
        const rb = await r.json();
        sent.push({ owner: owner.owner_name, to, sid: rb?.sid, status: rb?.status, ok: r.ok, error: r.ok ? null : (rb?.message || `HTTP ${r.status}`) });
      } catch (e) {
        sent.push({ owner: owner.owner_name, to, error: (e as Error).message });
      }
    }
    return json({ ok: true, mode: 'test_owner_notify', trial_id: trialId, studio: studioName, body_preview: body2, owners_sent: sent });
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
            convert_sms_sid: resBody?.sid ?? null,
            convert_sms_last_status: resBody?.status ?? 'queued',
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
