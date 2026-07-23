// Supabase Edge Function: mariana-tek-create-trial-client
//
// 2026-06-26 v2 REWRITE — production-ready MT auto-signup
// =========================================================
// MT equivalent of mindbody-create-trial-client. Called by stripe-webhook
// once a $49 trial payment lands; creates the corresponding customer in
// Mariana Tek for the right studio and writes the returned MT id back to
// `trial_signups.mariana_tek_id`. Returns rich result data so the webhook
// can persist outcome + alert on failure.
//
// MT Customer-API doc reference (built from):
//   https://guides.marianatek.com/customer
//   https://guides.marianatek.com/credentials
//   https://docs.marianatek.com/api/customer/v1/redoc/
//
// MT uses Django REST Framework with JSON:API envelopes. User-create endpoint
// is POST /api/users/ with the JSON:API body shape:
//   { data: { type: 'users', attributes: { ... } } }
// Auth: per-studio Studio API key → `Authorization: Bearer <key>`. The key is
// stored on `locations.mariana_tek_api_key` (set by separate migration once
// integrations@marianatek.com issues the per-studio keys).
//
// POST body modes:
//   { mode: 'probe', studio_slug: 'bayside' }
//     → tests connectivity + auth via GET /api/users/self. Returns the MT
//       service user record so you can verify the key is alive WITHOUT
//       creating a real customer.
//   { trial_signup_id: 'uuid' }
//     → creates one MT user for that trial_signups row
//   { trial_signup_ids: ['uuid', ...] }
//     → batch create
//   { since: 'YYYY-MM-DD' | 'today' }
//     → backfill unlinked paid trials since date
//   { dry_run: true }
//     → log payload, don't fire to MT
//
// Auth (caller → us):
//   x-bbb-secret: <BBB_ADMIN_SECRET>     for ad-hoc invocations
//   Authorization: Bearer <SR_KEY>        for stripe-webhook
//   user-agent: pg_net/                   for pg_cron job
//
// Deploy:
//   supabase functions deploy mariana-tek-create-trial-client \
//     --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';

// All 4 BBB studios. Slug must match `locations.slug`.
const STUDIO_SLUGS = ['williamsburg', 'astoria', 'fresh-meadows', 'bayside'] as const;

// All 4 BBB studios live on a single MT tenant. The per-studio MT location
// IDs were confirmed live via GET /api/locations/ on 2026-06-27.
// Used as fallbacks when `locations.mariana_tek_location_id` /
// `mariana_tek_subdomain` aren't populated on the DB row yet.
const MT_TENANT_SUBDOMAIN = 'betterbodybootcamp';
const MT_LOCATION_ID_BY_SLUG: Record<string, string> = {
  'williamsburg':  '48720',
  'astoria':       '48717',
  'fresh-meadows': '48719',
  'bayside':       '48718',
};

// Studio address fallbacks — used when the trial_signups row doesn't have
// address data. MT may require some address fields.
const STUDIO_ADDR: Record<string, { street: string; city: string; state: string; zip: string }> = {
  'williamsburg':   { street: '487 Driggs Ave',     city: 'Brooklyn',      state: 'NY', zip: '11211' },
  'astoria':        { street: '31-18 Steinway St',  city: 'Astoria',       state: 'NY', zip: '11103' },
  'fresh-meadows':  { street: '76-46 164th Street', city: 'Fresh Meadows', state: 'NY', zip: '11366' },
  'bayside':        { street: '3447 Bell Blvd',     city: 'Bayside',       state: 'NY', zip: '11361' },
};
const FALLBACK_ADDR = { street: '487 Driggs Ave', city: 'Brooklyn', state: 'NY', zip: '11211' };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey, x-bbb-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

type LocationRow = {
  id: string;
  name: string;
  slug: string; // derived from name in code (locations table has no slug column)
  mariana_tek_subdomain: string | null;
  mariana_tek_api_key: string | null;
};

// Convert a studio name to the canonical slug used everywhere else
// (matches the populate-mt-locations migration: lower(replace(name,' ','-'))).
function nameToSlug(name: string): string {
  return (name || '').toLowerCase().replace(/\s+/g, '-');
}
// Reverse — slug → proper-case name we can query the table with.
const SLUG_TO_NAME: Record<string, string> = {
  'williamsburg':  'Williamsburg',
  'astoria':       'Astoria',
  'fresh-meadows': 'Fresh Meadows',
  'bayside':       'Bayside',
};

// Resolve the bearer token we'll use against MT. Per-studio Studio API keys
// were never issued by integrations@marianatek.com, so we fall back to the
// shared admin OAuth access token kept in Supabase secrets as
// MT_OAUTH_ACCESS_TOKEN. Confirmed write-scope on POST /api/users/ via probe
// on 2026-06-27 (returned 201 + user id 66320).
function resolveBearer(apiKey: string | null | undefined): string | null {
  if (apiKey && apiKey.trim()) return apiKey.trim();
  const env = Deno.env.get('MT_OAUTH_ACCESS_TOKEN');
  return env && env.trim() ? env.trim() : null;
}

function mtHeaders(apiKey: string): Record<string, string> {
  // MT uses JSON:API content type. Accept both vendor mime + JSON for safety.
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/vnd.api+json, application/json;q=0.9',
    'Content-Type': 'application/vnd.api+json',
  };
}

async function mtPost(subdomain: string, apiKey: string, path: string, body: unknown): Promise<{
  ok: boolean; status: number; data: any; raw: string;
}> {
  const url = `https://${subdomain}.marianatek.com${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: mtHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { _parse_error: true, _raw: raw.slice(0, 500) }; }
  return { ok: r.ok, status: r.status, data, raw: raw.slice(0, 1500) };
}

async function mtGet(subdomain: string, apiKey: string, path: string): Promise<{
  ok: boolean; status: number; data: any; raw: string;
}> {
  const url = `https://${subdomain}.marianatek.com${path}`;
  const r = await fetch(url, {
    method: 'GET',
    headers: mtHeaders(apiKey),
  });
  const raw = await r.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { _parse_error: true, _raw: raw.slice(0, 500) }; }
  return { ok: r.ok, status: r.status, data, raw: raw.slice(0, 1500) };
}

interface TrialRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  location_id: string | null;
  address: string | null;
  city: string | null;
  zip_code: string | null;
  country: string | null;
  utm_source: string | null;
  stripe_session_id: string | null;
  mariana_tek_id: string | null;
  payment_status: string | null;
}

interface ResultRow {
  trial_signup_id: string;
  email: string | null;
  studio: string | null;
  status: 'created' | 'skipped' | 'failed' | 'dry_run';
  mariana_tek_id?: string | null;
  reason?: string;
  mt_http_status?: number;
  mt_response?: any;
  dry_run_payload?: unknown;
}

function normalizePhoneE164(input: string): string {
  if (!input) return '';
  const digits = input.replace(/[^\d]/g, '');
  if (digits.length === 10)  return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return '';
}

/**
 * Build the JSON:API envelope MT expects on POST /api/users/.
 * Per MT Customer-API redoc: user-create accepts these attributes:
 *   email (required), first_name, last_name, phone_number, date_of_birth,
 *   address_line_1, address_line_2, city, state, postal_code, country,
 *   gender (optional), referral_source (optional)
 *
 * Setting `send_password_reset_email: true` triggers MT to send the
 * customer a "set your password" email immediately, which is the key
 * to letting them log in without staff intervention.
 */
function buildCreateUserBody(row: TrialRow, studioSlug: string, mtLocationId: string | null) {
  const nameParts = (row.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Customer';
  const lastName  = nameParts.slice(1).join(' ') || '(via Stripe)';
  const addr = STUDIO_ADDR[studioSlug] || FALLBACK_ADDR;
  const rawPhone = (row.phone || '').trim();
  const phone = normalizePhoneE164(rawPhone) || '+19175550100';

  return {
    data: {
      type: 'users',
      attributes: {
        email:                       row.email,
        first_name:                  firstName,
        last_name:                   lastName,
        phone_number:                phone,
        // date_of_birth: omitted — BBB trial form never collected DOB. MT accepts user creation without it.
        address_line_1:              row.address  || addr.street,
        city:                        row.city     || addr.city,
        state:                       addr.state,
        postal_code:                 row.zip_code || addr.zip,
        country:                     row.country  || 'US',
        referral_source:             row.utm_source ?? 'website-trial',
        // The flags below tell MT to send the "set your password" invite
        // automatically on user-create. This is what makes the experience
        // seamless — the customer's inbox gets a setup email seconds after
        // they pay, and they can log in at betterbodybootcamp.marianatek.com.
        send_password_reset_email:   true,
        send_account_emails:         true,
        send_promotional_emails:     false,
        // Pin to the home location so MT shows the right schedule by default
        // when they log in.
        // **IMPORTANT**: the MT field name is `home_location`, NOT
        // `home_location_id`. Sending `home_location_id` makes MT reply
        // with 422 `{"home_location": ["This field is required."]}`.
        // Confirmed by live POST /api/users/ probe on 2026-06-27.
        ...(mtLocationId ? { home_location: Number(mtLocationId) } : {}),
      },
    },
  };
}

/**
 * Some MT installations reject `send_password_reset_email` on user-create
 * (it depends on the studio's MT plan / configuration). If the create
 * succeeds but the welcome email didn't fire, we explicitly hit
 *   POST /api/users/{id}/send_password_reset/
 * as a follow-up. This is idempotent — calling it twice just sends the
 * setup email twice; no harm done. We log the attempt either way.
 */
async function maybeSendPasswordReset(
  subdomain: string,
  apiKey: string,
  mtUserId: string,
): Promise<{ attempted: boolean; ok?: boolean; status?: number; note?: string }> {
  try {
    const r = await mtPost(subdomain, apiKey, `/api/users/${encodeURIComponent(mtUserId)}/send_password_reset/`, {});
    return { attempted: true, ok: r.ok, status: r.status, note: r.ok ? 'password reset email sent' : `MT rejected: ${r.raw.slice(0, 200)}` };
  } catch (e) {
    return { attempted: true, ok: false, note: `exception: ${(e as Error).message}` };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const secret = req.headers.get('x-bbb-secret') ?? '';
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const SR = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ua = req.headers.get('user-agent') ?? '';
  const okAuth = secret === ADMIN_SECRET || (SR && bearer === SR) || ua.startsWith('pg_net/');
  if (!okAuth) return json({ ok: false, error: 'unauthorized' }, 401);

  const body: {
    mode?: 'probe' | 'create';
    studio_slug?: string;
    trial_signup_id?: string;
    trial_signup_ids?: string[];
    since?: string;
    dry_run?: boolean;
  } = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // ─── PROBE MODE ───────────────────────────────────────────────────────
  // Verify MT subdomain + api_key are alive WITHOUT creating a customer.
  // Hits GET /api/users/self which returns the service user tied to the
  // Studio API key. If this returns 200, our auth + base URL are good.
  if (body.mode === 'probe') {
    const slug = (body.studio_slug ?? 'bayside').toLowerCase();
    const studioName = SLUG_TO_NAME[slug];
    if (!studioName) return json({ ok: false, error: `unknown studio_slug: ${slug} (valid: ${Object.keys(SLUG_TO_NAME).join(', ')})` }, 400);
    const { data: loc, error: locErr } = await sb
      .from('locations')
      .select('id, name, mariana_tek_subdomain, mariana_tek_api_key')
      .eq('name', studioName)
      .maybeSingle();
    if (locErr || !loc) return json({ ok: false, error: `location lookup failed: ${locErr?.message ?? `no row for name='${studioName}'`}` }, 500);

    // Fall back to the shared MT tenant + admin OAuth token when the per-studio
    // creds were never populated. All 4 BBB studios share one tenant.
    const subdomain = loc.mariana_tek_subdomain || MT_TENANT_SUBDOMAIN;
    const bearer    = resolveBearer(loc.mariana_tek_api_key);
    if (!bearer) {
      return json({ ok: false, error:
        `No MT bearer token available. Either set locations.mariana_tek_api_key for ${studioName}, ` +
        `or set the MT_OAUTH_ACCESS_TOKEN secret on the edge runtime.`,
      }, 500);
    }

    const r = await mtGet(subdomain, bearer, '/api/users/self');
    return json({
      ok: r.ok,
      studio: slug,
      mt_subdomain: subdomain,
      used_env_token: !loc.mariana_tek_api_key,
      mt_http_status: r.status,
      mt_response_preview: r.data ? JSON.stringify(r.data).slice(0, 600) : null,
      raw_preview: r.raw.slice(0, 600),
      diagnosis: r.ok
        ? 'API key works ✓ — safe to flip data_source for this studio'
        : `API key failed with HTTP ${r.status}. Likely causes: (1) token expired/wrong scope, (2) wrong tenant subdomain (currently '${subdomain}').`,
    });
  }

  // ─── CREATE MODE (default) ────────────────────────────────────────────
  const dryRun = !!body.dry_run;

  // Resolve which trial_signups rows to act on.
  const ids: string[] = [];
  if (body.trial_signup_id) ids.push(body.trial_signup_id);
  if (Array.isArray(body.trial_signup_ids)) ids.push(...body.trial_signup_ids);

  if (body.since) {
    let sinceIso = body.since;
    if (sinceIso === 'today') {
      const now = new Date();
      const etOffsetH = 4; // EDT
      const utcMidnightOfEtToday = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), etOffsetH, 0, 0,
      ));
      if (now.getUTCHours() < etOffsetH) {
        utcMidnightOfEtToday.setUTCDate(utcMidnightOfEtToday.getUTCDate() - 1);
      }
      sinceIso = utcMidnightOfEtToday.toISOString();
    }
    const { data: sinceRows, error: sErr } = await sb
      .from('trial_signups')
      .select('id')
      .gte('payment_date', sinceIso)
      .is('mariana_tek_id', null)
      .in('payment_status', ['completed', 'paid'])
      .is('deleted_at', null);
    if (sErr) return json({ ok: false, error: `since-query failed: ${sErr.message}` }, 500);
    (sinceRows ?? []).forEach((r: any) => ids.push(r.id));
  }

  if (ids.length === 0) {
    return json({ ok: false, error: 'no trial_signup_id(s) provided (and `since` matched 0 rows)' }, 400);
  }

  // Pull the trial rows + the per-studio MT creds we'll need.
  const { data: rows, error: qErr } = await sb
    .from('trial_signups')
    .select('id, name, email, phone, location_id, address, city, zip_code, country, utm_source, stripe_session_id, mariana_tek_id, payment_status')
    .in('id', ids);
  if (qErr) return json({ ok: false, error: qErr.message }, 500);

  const studioNames = Object.values(SLUG_TO_NAME);
  const { data: locs, error: locErr } = await sb
    .from('locations')
    .select('id, name, mariana_tek_subdomain, mariana_tek_api_key, mariana_tek_location_id')
    .in('name', studioNames);
  if (locErr) return json({ ok: false, error: `locations lookup: ${locErr.message}` }, 500);
  const locById = new Map<string, LocationRow & { mariana_tek_location_id: string | null }>();
  for (const l of (locs ?? []) as any[]) {
    // Derive slug from name so downstream code can keep using loc.slug.
    locById.set(l.id, { ...l, slug: nameToSlug(l.name) });
  }

  const results: ResultRow[] = [];
  for (const row of (rows ?? []) as TrialRow[]) {
    const loc = row.location_id ? locById.get(row.location_id) : null;
    const studioSlug = loc?.slug ?? null;

    if (row.mariana_tek_id) {
      results.push({ trial_signup_id: row.id, email: row.email, studio: studioSlug, status: 'skipped', reason: `already linked to mariana_tek_id ${row.mariana_tek_id}`, mariana_tek_id: row.mariana_tek_id });
      continue;
    }
    if (!row.email) {
      results.push({ trial_signup_id: row.id, email: null, studio: studioSlug, status: 'failed', reason: 'no email on trial_signups row' });
      continue;
    }
    if (!loc) {
      results.push({ trial_signup_id: row.id, email: row.email, studio: null, status: 'failed', reason: `unrecognized location_id ${row.location_id}` });
      continue;
    }
    // Fall back to shared tenant subdomain + env bearer when the per-studio
    // creds were never populated (per-studio API keys never arrived from MT).
    const subdomain = loc.mariana_tek_subdomain || MT_TENANT_SUBDOMAIN;
    const bearer    = resolveBearer(loc.mariana_tek_api_key);
    if (!bearer) {
      results.push({ trial_signup_id: row.id, email: row.email, studio: studioSlug, status: 'failed', reason: `no MT bearer (set MT_OAUTH_ACCESS_TOKEN secret or locations.mariana_tek_api_key for ${studioSlug})` });
      continue;
    }
    if (row.payment_status !== 'completed' && row.payment_status !== 'paid') {
      results.push({ trial_signup_id: row.id, email: row.email, studio: studioSlug, status: 'skipped', reason: `payment_status=${row.payment_status} (need completed/paid)` });
      continue;
    }

    // Same fallback for the home-location id — use the confirmed-live map
    // when the DB row doesn't carry mariana_tek_location_id.
    const homeLocationId =
      loc.mariana_tek_location_id || MT_LOCATION_ID_BY_SLUG[studioSlug!] || null;
    const createBody = buildCreateUserBody(row, studioSlug!, homeLocationId);

    if (dryRun) {
      results.push({
        trial_signup_id: row.id,
        email: row.email,
        studio: studioSlug,
        status: 'dry_run',
        dry_run_payload: createBody,
      });
      continue;
    }

    try {
      console.log(`MT createUser trial=${row.id} email=${row.email} studio=${studioSlug} subdomain=${subdomain} envToken=${!loc.mariana_tek_api_key}`);
      const createRes = await mtPost(
        subdomain,
        bearer,
        '/api/users/',
        createBody,
      );

      if (!createRes.ok) {
        // Surface MT's exact error so we know what to fix.
        // MT returns 422 with `errors.email = ["This email address is already
        // associated with an account."]` when the user exists. Also handle 409
        // and the generic "already exists / unique / duplicate" phrasing.
        const isDup = createRes.status === 409 ||
          createRes.status === 422 ||
          /already exists|already associated|unique|duplicate/i.test(createRes.raw);
        if (isDup) {
          // Search MT for the existing user by email so we can LINK, not just skip.
          //
          // 2026-07-01 IMPORTANT FIX: MT's `?filter[email]=` param is IGNORED —
          // it returns the first 10 users in the tenant regardless of what you
          // pass. Verified against a live tenant on 2026-07-01. The correct
          // param is the plain `?email=` querystring, which does an exact
          // filter and returns just the matching user (verified: `?email=X`
          // returns count 1 with the correct id, while `?filter[email]=X` and
          // `?search=X` both return 10 unfiltered users).
          //
          // The previous implementation also had a dangerous `|| arr[0]`
          // fallback that grabbed the first user in the list when the email
          // filter came back unfiltered — that's how 115 trial rows got
          // silently tagged with MT id 34572 (appreview@marianatek.com).
          // We now require an EXACT case-insensitive email match on a result
          // set of size ≥1 — otherwise we skip and let ops re-run once we've
          // adjusted.
          let linkedMtId: string | null = null;
          let searchDiagnostic = '';
          try {
            const searchRes = await mtGet(
              subdomain,
              bearer,
              `/api/users/?email=${encodeURIComponent(row.email)}`,
            );
            const arr = Array.isArray(searchRes.data?.data) ? searchRes.data.data : [];
            const wantEmail = row.email.toLowerCase();
            const hit = arr.find((u: any) =>
              (u?.attributes?.email || '').toLowerCase() === wantEmail
            );
            if (hit?.id != null) {
              linkedMtId = String(hit.id);
            } else {
              searchDiagnostic = `?email= returned ${arr.length} user(s); none matched ${row.email}`;
            }
          } catch (e) {
            console.error(`mt user search failed for ${row.email}:`, e);
            searchDiagnostic = `search threw: ${(e as Error).message}`;
          }

          if (linkedMtId) {
            // Write the MT ID back so trial_signups is now bridged.
            await sb
              .from('trial_signups')
              .update({ mariana_tek_id: linkedMtId })
              .eq('id', row.id);

            await sb.from('mariana_tek_clients').upsert({
              mt_id:         linkedMtId,
              studio_slug:   studioSlug,
              email:         row.email,
              first_name:    (row.name || '').split(/\s+/)[0] || null,
              last_name:     (row.name || '').split(/\s+/).slice(1).join(' ') || null,
              phone:         row.phone,
              dob:           null,
              created_at_mt: null,
              synced_at:     new Date().toISOString(),
            }, { onConflict: 'mt_id' });

            results.push({
              trial_signup_id: row.id,
              email: row.email,
              studio: studioSlug,
              status: 'linked',
              mariana_tek_id: linkedMtId,
              reason: `MT user already existed — linked existing id (HTTP ${createRes.status})`,
              mt_http_status: createRes.status,
            });
            continue;
          }

          // Duplicate detected but email search didn't return a hit — mark skipped
          // (NOT failed — the customer already exists in MT, this is a search
          // fluke and safe to retry). Diagnostic tells ops exactly what MT
          // returned so we can adjust the query if MT changes their API.
          results.push({
            trial_signup_id: row.id,
            email: row.email,
            studio: studioSlug,
            status: 'skipped',
            reason: `MT user already exists (HTTP ${createRes.status}) but ?email= search couldn't confirm the id. ${searchDiagnostic}. Manual link required.`,
            mt_http_status: createRes.status,
            mt_response: createRes.data,
          });
          continue;
        }

        results.push({
          trial_signup_id: row.id,
          email: row.email,
          studio: studioSlug,
          status: 'failed',
          reason: `MT POST /api/users/ returned HTTP ${createRes.status}: ${createRes.raw.slice(0, 300)}`,
          mt_http_status: createRes.status,
          mt_response: createRes.data,
        });
        continue;
      }

      // MT JSON:API response shape: { data: { id, type, attributes: {...} } }
      // Also handle flat { id } as a fallback in case MT returns plain JSON.
      const mtId = createRes.data?.data?.id != null
        ? String(createRes.data.data.id)
        : (createRes.data?.id != null ? String(createRes.data.id) : null);
      if (!mtId) {
        results.push({
          trial_signup_id: row.id,
          email: row.email,
          studio: studioSlug,
          status: 'failed',
          reason: `MT user-create returned 2xx but no id in response: ${createRes.raw.slice(0, 300)}`,
          mt_http_status: createRes.status,
          mt_response: createRes.data,
        });
        continue;
      }

      // Persist the link back to trial_signups + mirror into mariana_tek_clients.
      await sb
        .from('trial_signups')
        .update({ mariana_tek_id: mtId })
        .eq('id', row.id);

      await sb.from('mariana_tek_clients').upsert({
        mt_id:         mtId,
        studio_slug:   studioSlug,
        email:         row.email,
        first_name:    (row.name || '').split(/\s+/)[0] || null,
        last_name:     (row.name || '').split(/\s+/).slice(1).join(' ') || null,
        phone:         row.phone,
        dob:           null,
        created_at_mt: new Date().toISOString(),
        synced_at:     new Date().toISOString(),
      }, { onConflict: 'mt_id' });

      // Belt-and-suspenders — explicitly fire password-reset email so the
      // customer has a clear way to log in. If MT's create-time
      // `send_password_reset_email: true` already did it, this just sends a
      // second invite (idempotent enough — no harm).
      const reset = await maybeSendPasswordReset(subdomain, bearer, mtId);
      console.log(`  password-reset: ${JSON.stringify(reset)}`);

      results.push({
        trial_signup_id: row.id,
        email: row.email,
        studio: studioSlug,
        status: 'created',
        mariana_tek_id: mtId,
        mt_http_status: createRes.status,
        mt_response: { reset_email: reset.ok, reset_status: reset.status },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`mt-create-trial-client failed for ${row.email}:`, msg);
      results.push({ trial_signup_id: row.id, email: row.email, studio: studioSlug, status: 'failed', reason: msg });
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    processed: results.length,
    created:   results.filter((r) => r.status === 'created').length,
    skipped:   results.filter((r) => r.status === 'skipped').length,
    failed:    results.filter((r) => r.status === 'failed').length,
    dry_run_count: results.filter((r) => r.status === 'dry_run').length,
    results,
  });
});
