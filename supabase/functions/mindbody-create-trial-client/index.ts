// Supabase Edge Function: mindbody-create-trial-client
//
// When a customer pays the $49 trial in Stripe, they get a confirmation
// email and a /homebase entry — but NOT a MindBody account. That means:
//   1. They can't log into MindBody to book classes themselves.
//   2. They can't see their trial pass in any Healcode widget.
//   3. The studio's front-desk has to manually create them at first visit.
//
// This function closes that gap. It runs once per paid trial:
//   1. POST /client/addclient   → creates a MB client at the right studio
//      with SendAccountEmails=true, so MindBody emails them a "set your
//      password" activation link.
//   2. POST /sale/checkoutshoppingcart → assigns pricing option Id 100041
//      ($49 Two Weeks) to the new client. Payment type = "Other" with the
//      Stripe session id as the note (so MB recognises $49 was collected
//      but doesn't try to double-charge).
//   3. Saves the returned MB client_id back to trial_signups.mindbody_id.
//
// Called by:
//   - stripe-webhook (on checkout.session.completed) — fire-and-forget
//   - one-time backfill script (for the ~75 paid trials since May 15
//     launch that never got a MB account)
//
// Idempotent: skips any trial_signup row that already has a mindbody_id.
//
// POST body:
//   { trial_signup_id: 'uuid' }                 // single
//   { trial_signup_ids: ['uuid', 'uuid', ...] } // batch (backfill)
//   { dry_run?: boolean }                       // log AddClient + Cart calls
//                                               //   but don't actually fire
//
// Required env (inherited from existing MB functions):
//   MINDBODY_API_KEY, MINDBODY_SITE_ID,
//   MINDBODY_SOURCE_NAME, MINDBODY_SOURCE_PASSWORD,
//   MINDBODY_STAFF_USERNAME, MINDBODY_STAFF_PASSWORD  (CheckoutShoppingCart
//                                                     needs staff auth)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY            (auto-injected)
//
// Deploy:
//   supabase functions deploy mindbody-create-trial-client \
//     --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MB_BASE = 'https://api.mindbodyonline.com/public/v6';

// Pricing option Id for "$49 Two Weeks" (enabled Sell-online 2026-06-06).
// Same Id across all 4 BBB locations — confirmed via mindbody-list-trial-products.
const TRIAL_PRICING_OPTION_ID = 100041;

// Maps Supabase trial_signups.location_id (the studio's MB site/location) →
// MindBody numeric location id used in the AddClient + CheckoutShoppingCart
// payloads. Mirrors the mapping in mindbody-clients-sync.
const SUPA_LOCATION_TO_MB: Record<string, number> = {
  '80536b45-df0e-42d1-880c-e9301372e1cf': 1, // williamsburg
  'dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45': 2, // astoria
  '6bbbe077-bcc6-4d9d-a10b-7605c1484752': 3, // fresh-meadows
  '5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7': 6, // bayside
};

const MB_LOCATION_TO_SLUG: Record<number, string> = {
  1: 'williamsburg',
  2: 'astoria',
  3: 'fresh-meadows',
  6: 'bayside',
};

// Studio address defaults — used as placeholders when the trial_signups row
// doesn't have address data (the trial form stopped collecting it). MindBody
// site validation requires Street / City / State / PostalCode on AddClient
// or it returns HTTP 400 "MissingRequiredFields". 2026-06-08 fix.
const STUDIO_ADDR: Record<number, { street: string; city: string; state: string; zip: string }> = {
  1: { street: '487 Driggs Ave',     city: 'Brooklyn',      state: 'NY', zip: '11211' }, // williamsburg
  2: { street: '31-18 Steinway St',  city: 'Astoria',       state: 'NY', zip: '11103' }, // astoria
  3: { street: '76-46 164th Street', city: 'Fresh Meadows', state: 'NY', zip: '11366' }, // fresh-meadows
  6: { street: '3447 Bell Blvd',     city: 'Bayside',       state: 'NY', zip: '11361' }, // bayside
};
// Fallback if studio lookup misses (shouldn't happen but defensive).
const FALLBACK_ADDR = { street: '487 Driggs Ave', city: 'Brooklyn', state: 'NY', zip: '11211' };

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

// ─── MindBody auth helpers ────────────────────────────────────────────────
// ─── MindBody V6 auth — UserToken flow ───────────────────────────────────────
// 2026-06-09: AddClient was failing for every customer with
//   HTTP 400 "MissingRequiredFields: FirstName, LastName, Email, Street, ..."
// even on dry-run payloads that visibly contained all the listed fields.
// Root cause: this function was using the legacy V5-style headers
//   SourceCredentials: "<name>|<pass>"
//   StaffCredentials:  "<user>|<pass>"
// MindBody V6 silently rejects writes under those headers (treats the
// request as guest-tier, then validation fails at the schema layer with
// a generic "MissingRequiredFields" wrapping the real cause).
//
// Fix: use the V6 UserToken flow — POST /usertoken/issue with the staff
// Username/Password, get an AccessToken back, then send it as the
// `Authorization` header (NO `Bearer ` prefix — MindBody is non-standard).
// This is exactly what probe-mindbody does, and it's the same auth path
// that mindbody-visits-sync has been using successfully.
//
// Token is cached in module scope for the function instance lifetime
// (~15 min in Supabase Edge Functions). Each cold start re-issues.
// ─────────────────────────────────────────────────────────────────────────────

let cachedUserToken: { token: string; issuedAt: number } | null = null;
const USER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h; MB issues 24h tokens

async function getMbUserToken(): Promise<string> {
  if (cachedUserToken && (Date.now() - cachedUserToken.issuedAt) < USER_TOKEN_TTL_MS) {
    return cachedUserToken.token;
  }
  const apiKey = Deno.env.get('MINDBODY_API_KEY');
  const siteId = Deno.env.get('MINDBODY_SITE_ID');
  // Support either naming convention — STAFF_USER/PASS (probe-mindbody style)
  // OR STAFF_USERNAME/PASSWORD (this function's original style). Whichever
  // is set, we use. Both should work; we don't change env vars.
  const staffUser = Deno.env.get('MINDBODY_STAFF_USER')
                 ?? Deno.env.get('MINDBODY_STAFF_USERNAME');
  const staffPass = Deno.env.get('MINDBODY_STAFF_PASS')
                 ?? Deno.env.get('MINDBODY_STAFF_PASSWORD');
  if (!apiKey || !siteId) throw new Error('Missing MINDBODY_API_KEY or MINDBODY_SITE_ID');
  if (!staffUser || !staffPass) {
    throw new Error('Missing MINDBODY_STAFF_USER(NAME) / MINDBODY_STAFF_PASS(WORD) — required for V6 UserToken');
  }
  const r = await fetch(`${MB_BASE}/usertoken/issue`, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'SiteId': siteId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ Username: staffUser, Password: staffPass }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.AccessToken) {
    throw new Error(
      `MindBody /usertoken/issue failed (HTTP ${r.status}): ${JSON.stringify(body).slice(0, 300)}`
    );
  }
  cachedUserToken = { token: body.AccessToken, issuedAt: Date.now() };
  return cachedUserToken.token;
}

async function mbHeaders(_opts: { staff?: boolean } = {}): Promise<Record<string, string>> {
  // `staff` option is preserved in the signature for backward compatibility,
  // but ignored — the UserToken obtained from staff credentials grants the
  // same write privileges, so there's no longer a guest-vs-staff split.
  const apiKey = Deno.env.get('MINDBODY_API_KEY') ?? '';
  const siteId = Deno.env.get('MINDBODY_SITE_ID') ?? '';
  if (!apiKey || !siteId) throw new Error('Missing MINDBODY_API_KEY or MINDBODY_SITE_ID');
  const token = await getMbUserToken();
  return {
    'Api-Key': apiKey,
    'SiteId': siteId,
    'Content-Type': 'application/json',
    'Authorization': token, // NOTE: no "Bearer " — MindBody is non-standard
  };
}

async function mbPost<T = any>(path: string, body: unknown, opts: { staff?: boolean } = {}): Promise<T> {
  const headers = await mbHeaders(opts);
  const r = await fetch(`${MB_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 500);
    throw new Error(`MindBody POST ${path} → HTTP ${r.status}: ${txt}`);
  }
  return r.json();
}

// ─── Build the AddClient payload from a trial_signups row ─────────────────
// Notes:
// - SendAccountEmails=true → MindBody emails the customer their password-
//   setup link, which is the whole point. They click → set password → log
//   into Healcode → book.
// - SendPromotionalEmails=false → respects the privacy / opt-in posture
//   we've been guarding everywhere else (#123, #124).
// - HomeLocation is the studio they bought the trial for. Without this MB
//   defaults to site location 1 (Williamsburg) for all clients regardless
//   of which studio they actually trained at — corrupts visit attribution.
function buildAddClientPayload(row: TrialRow, mbLocationId: number) {
  const nameParts = (row.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Customer';
  const lastName  = nameParts.slice(1).join(' ') || '(via Stripe)';
  // 2026-06-09 (v3): stripped the field-name duplicates that didn't help.
  // Now sending CLEAN V6 spec only + top-level CrossRegionalUpdate flag.
  //
  // The 4 failing customers all had complete, valid V6 payloads (verified
  // via dry_run). MindBody still returned "MissingRequiredFields" listing
  // the standard 8 fields. That generic error masks the real cause, which
  // is almost certainly the BBB site has CUSTOM CLIENT FIELDS configured
  // as required. Those need to be sent in a `ClientFields` array with
  // field IDs the site exposes via /v6/site/customclientfields — we'll
  // query that endpoint and log the result on the next failure so we
  // can identify the exact field IDs to populate.
  const addr  = STUDIO_ADDR[mbLocationId] || FALLBACK_ADDR;
  const rawPhone = (row.phone || '').trim();
  const phone = normalizePhoneE164(rawPhone) || '+19175550100';

  const street = row.address  || addr.street;
  const city   = row.city     || addr.city;
  const state  = addr.state;
  const zip    = row.zip_code || addr.zip;
  const country = row.country  || 'US';

  return {
    CrossRegionalUpdate: false,
    Test: false,
    Client: {
      FirstName:    firstName,
      LastName:     lastName,
      Email:        row.email,
      MobilePhone:  phone,
      AddressLine1: street,
      City:         city,
      State:        state,
      PostalCode:   zip,
      Country:      country,
      HomeLocation: { Id: mbLocationId },
      ReferredBy:   row.utm_source ?? 'website-trial',
      SendAccountEmails:     true,
      SendPromotionalEmails: false,
      SendScheduleEmails:    true,
    },
  };
}

// On AddClient failure, query MindBody for the site's custom client fields
// + required client fields + valid locations so we can identify what's
// actually being checked. Logs only — never alters the request.
async function diagnoseMissingRequiredFields(): Promise<string> {
  try {
    const baseHeaders = await mbHeaders({ staff: true });
    const siteIdHeader = Deno.env.get('MINDBODY_SITE_ID') ?? '(none)';
    const r1 = await fetch(`${MB_BASE}/site/sites`, { method: 'GET', headers: baseHeaders });
    const sites = await r1.json().catch(() => ({}));
    const r2 = await fetch(`${MB_BASE}/client/requiredclientfields`, { method: 'GET', headers: baseHeaders });
    const req = await r2.json().catch(() => ({}));
    const r3 = await fetch(`${MB_BASE}/client/clientformulasandquestions`, { method: 'GET', headers: baseHeaders });
    const custom = await r3.json().catch(() => ({}));
    // CRITICAL: list valid locations so we know what HomeLocation.Id values
    // are actually accepted. If our SUPA_LOCATION_TO_MB mapping is stale,
    // this will show what to remap to.
    const r4 = await fetch(`${MB_BASE}/site/locations`, { method: 'GET', headers: baseHeaders });
    const locations = await r4.json().catch(() => ({}));
    return JSON.stringify({
      siteIdHeaderUsed: siteIdHeader,
      sites,
      requiredFields: req,
      customFieldsAndQuestions: custom,
      validLocations: locations,
    }, null, 2);
  } catch (e) {
    return `diagnoseMissingRequiredFields error: ${(e as Error).message}`;
  }
}

// Normalize a US phone string to E.164. Returns empty string if input is
// unusable, so the caller can apply a fallback. Examples:
//   "(917) 555-1234"   → "+19175551234"
//   "917-555-1234"     → "+19175551234"
//   "+1 917 555 1234"  → "+19175551234"
//   "9175551234"       → "+19175551234"
//   "5551234"          → ""           (not enough digits, caller falls back)
function normalizePhoneE164(input: string): string {
  if (!input) return '';
  const digits = input.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return '';
}

// CheckoutShoppingCart assigns the $49 Two Weeks pricing option to the
// newly-created client. Test the integration in dry-run mode first; the
// real call records a sale + grants the trial pass.
function buildCheckoutPayload(mbClientId: string, mbLocationId: number, stripeSessionId: string | null) {
  return {
    ClientId: mbClientId,
    LocationId: mbLocationId,
    Test: false, // Set true on first deploys to validate without committing
    CartItems: [
      {
        Item: { Type: 'Service', Metadata: { Id: TRIAL_PRICING_OPTION_ID } },
        DiscountAmount: 0,
        Quantity: 1,
      },
    ],
    // Payment type "Other" lets us record that $49 was collected outside MB
    // (it was — Stripe took it). Notes carries the Stripe session id so the
    // front desk can reconcile if asked.
    Payments: [
      {
        Type: 'Other',
        Metadata: { Amount: 49.00, Notes: `Paid via Stripe ${stripeSessionId ?? '(unknown session)'}` },
      },
    ],
    SendEmail: false, // The AddClient call already kicked the password email
  };
}

// ─── Types ────────────────────────────────────────────────────────────────
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
  mindbody_id: string | null;
  payment_status: string | null;
}

interface ResultRow {
  trial_signup_id: string;
  email: string | null;
  studio: string | null;
  status: 'created' | 'skipped' | 'failed' | 'dry_run';
  mindbody_id?: string | null;
  reason?: string;
  dry_run_payload?: unknown;
}

// ─── Main ─────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const body: {
    trial_signup_id?: string;
    trial_signup_ids?: string[];
    since?: string;       // ISO date / timestamp — backfill all unlinked paid
                          // trials whose payment_date is >= this. Added 2026-06-09
                          // so Justin can run `{"since":"today"}`-style backfills
                          // without pasting UUIDs.
    dry_run?: boolean;
  } = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  const dryRun = !!body.dry_run;

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Resolve which trial_signups rows to act on.
  // Mode 1: explicit IDs passed (trial_signup_id / trial_signup_ids).
  // Mode 2: `since` filter — find paid trials with NULL mindbody_id whose
  //         payment_date is >= the given timestamp.
  const ids: string[] = [];
  if (body.trial_signup_id) ids.push(body.trial_signup_id);
  if (Array.isArray(body.trial_signup_ids)) ids.push(...body.trial_signup_ids);

  if (body.since) {
    // Accept 'today' as shorthand → midnight ET today (UTC-aware).
    let sinceIso = body.since;
    if (sinceIso === 'today') {
      // Compute today 00:00 America/New_York → ISO. ET is UTC-4 in summer,
      // UTC-5 in winter. We're in June (EDT, UTC-4) so build it as such.
      const now = new Date();
      const etOffsetH = 4; // EDT
      const utcMidnightOfEtToday = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), etOffsetH, 0, 0,
      ));
      // If "now" is between 00:00-04:00 UTC, "today" in ET is actually
      // yesterday's UTC date. Adjust.
      if (now.getUTCHours() < etOffsetH) {
        utcMidnightOfEtToday.setUTCDate(utcMidnightOfEtToday.getUTCDate() - 1);
      }
      sinceIso = utcMidnightOfEtToday.toISOString();
    }
    const { data: sinceRows, error: sErr } = await sb
      .from('trial_signups')
      .select('id')
      .gte('payment_date', sinceIso)
      .is('mindbody_id', null)
      .in('payment_status', ['completed', 'paid'])
      .is('deleted_at', null);
    if (sErr) return json({ ok: false, error: `since-query failed: ${sErr.message}` }, 500);
    (sinceRows ?? []).forEach((r: any) => ids.push(r.id));
  }

  if (ids.length === 0) {
    return json({ ok: false, error: 'no trial_signup_id(s) provided (and `since` matched 0 rows)' }, 400);
  }

  const { data: rows, error: qErr } = await sb
    .from('trial_signups')
    .select('id, name, email, phone, location_id, address, city, zip_code, country, utm_source, stripe_session_id, mindbody_id, payment_status')
    .in('id', ids);
  if (qErr) return json({ ok: false, error: qErr.message }, 500);

  const results: ResultRow[] = [];
  for (const row of (rows ?? []) as TrialRow[]) {
    const mbLocationId = SUPA_LOCATION_TO_MB[row.location_id ?? ''];
    const studioSlug = mbLocationId ? MB_LOCATION_TO_SLUG[mbLocationId] : null;

    // Idempotency: never re-create.
    if (row.mindbody_id) {
      results.push({ trial_signup_id: row.id, email: row.email, studio: studioSlug, status: 'skipped', reason: `already linked to mindbody_id ${row.mindbody_id}`, mindbody_id: row.mindbody_id });
      continue;
    }
    if (!row.email) {
      results.push({ trial_signup_id: row.id, email: null, studio: studioSlug, status: 'failed', reason: 'no email on trial_signups row' });
      continue;
    }
    if (!mbLocationId) {
      results.push({ trial_signup_id: row.id, email: row.email, studio: null, status: 'failed', reason: `unrecognized location_id ${row.location_id}` });
      continue;
    }
    // Defensive: never create accounts for unpaid trial rows. Caller (stripe-
    // webhook or backfill) should already have filtered, but belt + suspenders.
    if (row.payment_status !== 'completed' && row.payment_status !== 'paid') {
      results.push({ trial_signup_id: row.id, email: row.email, studio: studioSlug, status: 'skipped', reason: `payment_status=${row.payment_status} (need completed/paid)` });
      continue;
    }

    const addClientPayload = buildAddClientPayload(row, mbLocationId);

    if (dryRun) {
      results.push({
        trial_signup_id: row.id,
        email: row.email,
        studio: studioSlug,
        status: 'dry_run',
        dry_run_payload: {
          addClient: addClientPayload,
          // checkoutCart filled in after we'd have a real ClientId
          checkoutCart: '(would build with real ClientId returned from AddClient)',
        },
      });
      continue;
    }

    let addRes: { Client?: { Id?: string | number } };
    try {
      // 1. Create the MindBody client.
      console.log(
        `AddClient payload for trial=${row.id} email=${row.email}:`,
        JSON.stringify(addClientPayload),
      );
      // ─── Layered duplicate detection ────────────────────────────────────
      // MB rejects AddClient with a misleading "MissingRequiredFields" error
      // when the client already exists. Catching it up front saves hours of
      // debugging plus avoids wasted API calls.
      //
      // 2026-06-09 lesson from chasing this bug: V6 /client/clients?SearchText
      // doesn't reliably match by email. Justin tested Hannah Turner — her MB
      // account uses media.hjt@gmail.com as login but hannahjaneturner12 as
      // her "contact email." SearchText found 0; our local DB (synced from MB
      // nightly) found her by phone.
      //
      // Strategy (priority order, first match wins):
      //   1. Local mindbody_clients by EMAIL  — fast, no API call
      //   2. Local mindbody_clients by PHONE  — catches email-mismatch cases
      //   3. MB API /client/clients?SearchText — last-ditch fallback
      let preExisting: { Id?: string | number; UniqueId?: string | number; source?: string } | null = null;

      // (1) Try local mindbody_clients by lowercased email.
      try {
        const { data: byEmail } = await sb
          .from('mindbody_clients')
          .select('mindbody_id, email, phone, first_name, last_name')
          .ilike('email', row.email!)
          .limit(1);
        if (byEmail && byEmail.length > 0) {
          preExisting = { Id: byEmail[0].mindbody_id, source: 'local-email' };
          console.log(`MB lookup (local-email): ${row.email} → MB Id=${byEmail[0].mindbody_id}`);
        }
      } catch (e) {
        console.warn(`local-email lookup failed: ${(e as Error).message}`);
      }

      // (2) Try local mindbody_clients by normalized phone if email missed.
      if (!preExisting && row.phone) {
        // Strip everything non-digit, compare last 10 digits (US number core).
        const tail10 = (row.phone || '').replace(/\D/g, '').slice(-10);
        if (tail10.length === 10) {
          try {
            // Postgres `ilike` doesn't support digit-only comparison directly;
            // pull a small set and filter client-side. Use the regex pattern
            // to narrow down to phones containing the digits.
            const { data: byPhone } = await sb
              .from('mindbody_clients')
              .select('mindbody_id, email, phone')
              .ilike('phone', `%${tail10}%`)
              .limit(5);
            const matched = (byPhone ?? []).find((c: any) =>
              (c.phone || '').replace(/\D/g, '').slice(-10) === tail10
            );
            if (matched) {
              preExisting = { Id: matched.mindbody_id, source: 'local-phone' };
              console.log(`MB lookup (local-phone): ${row.email} (phone ${tail10}) → MB Id=${matched.mindbody_id} (MB email=${matched.email})`);
            }
          } catch (e) {
            console.warn(`local-phone lookup failed: ${(e as Error).message}`);
          }
        }
      }

      // (3) Fall back to MB API SearchText (the unreliable one, but covers
      // brand-new MB clients that haven't been synced into our table yet).
      if (!preExisting) {
        try {
          const lookupRes = await fetch(
            `${MB_BASE}/client/clients?SearchText=${encodeURIComponent(row.email!)}&Limit=5`,
            { method: 'GET', headers: await mbHeaders({ staff: true }) },
          );
          const lookupBody = await lookupRes.json().catch(() => ({}));
          const found = (lookupBody?.Clients ?? []).find((c: any) =>
            (c.Email || '').toLowerCase() === (row.email || '').toLowerCase()
          );
          if (found) {
            preExisting = { Id: found.Id, UniqueId: found.UniqueId, source: 'mb-api' };
            console.log(`MB lookup (mb-api): ${row.email} → MB Id=${found.Id}`);
          } else {
            console.log(`MB lookup (all sources): ${row.email} not found, will create`);
          }
        } catch (lookupErr) {
          console.warn(`MB API lookup failed (continuing): ${(lookupErr as Error).message}`);
        }
      }

      if (preExisting) {
        // Customer already has a MindBody account — just link our trial_signup
        // to their existing mindbody_id and skip AddClient. We can still try
        // CheckoutShoppingCart to assign the $49 trial pass.
        const mbClientId = String(preExisting.Id);
        await sb
          .from('trial_signups')
          .update({ mindbody_id: mbClientId })
          .eq('id', row.id);
        try {
          const cartPayload = buildCheckoutPayload(mbClientId, mbLocationId, row.stripe_session_id);
          await mbPost('/sale/checkoutshoppingcart', cartPayload, { staff: true });
        } catch (cartErr) {
          console.warn(`CheckoutCart for existing client ${mbClientId} failed: ${(cartErr as Error).message}`);
        }
        results.push({
          trial_signup_id: row.id,
          email: row.email,
          studio: studioSlug,
          status: 'created',
          mindbody_id: mbClientId,
          reason: `linked-to-existing-mb-client (via ${preExisting.source ?? 'unknown'})`,
        });
        continue;
      }

      // 3-attempt strategy: rich → no-HomeLocation → minimal (V6 docs literal)
      const attemptPayloads: Array<{ label: string; body: any }> = [
        { label: 'full',         body: addClientPayload },
        { label: 'no-HomeLoc',   body: (() => { const c = JSON.parse(JSON.stringify(addClientPayload)); delete c.Client.HomeLocation; return c; })() },
        { label: 'minimal',      body: {
            CrossRegionalUpdate: false,
            Test: false,
            Client: {
              FirstName: addClientPayload.Client.FirstName,
              LastName:  addClientPayload.Client.LastName,
              Email:     addClientPayload.Client.Email,
              MobilePhone:  addClientPayload.Client.MobilePhone,
              AddressLine1: addClientPayload.Client.AddressLine1,
              City:         addClientPayload.Client.City,
              State:        addClientPayload.Client.State,
              PostalCode:   addClientPayload.Client.PostalCode,
            },
          },
        },
      ];
      let lastErr: Error | null = null;
      let addResOk: { Client?: { Id?: string | number } } | null = null;
      for (const attempt of attemptPayloads) {
        try {
          console.log(`AddClient attempt=${attempt.label}:`, JSON.stringify(attempt.body));
          addResOk = await mbPost<{ Client?: { Id?: string | number } }>(
            '/client/addclient',
            attempt.body,
            { staff: true },
          );
          console.log(`AddClient attempt=${attempt.label} SUCCEEDED, Client.Id=${addResOk?.Client?.Id}`);
          break;
        } catch (attemptErr) {
          lastErr = attemptErr as Error;
          console.log(`AddClient attempt=${attempt.label} failed: ${(attemptErr as Error).message.slice(0, 200)}`);
        }
      }
      if (!addResOk) throw (lastErr ?? new Error('all AddClient attempts failed'));
      addRes = addResOk;
      const mbClientId = addRes?.Client?.Id != null ? String(addRes.Client.Id) : null;
      if (!mbClientId) {
        throw new Error(`AddClient returned no Client.Id (response: ${JSON.stringify(addRes).slice(0, 200)})`);
      }

      // 2. Assign the $49 Two Weeks pricing option (records the sale).
      const cartPayload = buildCheckoutPayload(mbClientId, mbLocationId, row.stripe_session_id);
      await mbPost('/sale/checkoutshoppingcart', cartPayload, { staff: true });

      // 3. Persist the link back to trial_signups so /homebase + later runs
      //    of this function recognise the row as handled.
      await sb
        .from('trial_signups')
        .update({ mindbody_id: mbClientId })
        .eq('id', row.id);

      // 4. Mirror into mindbody_clients so the same Ad-ROI bridge that the
      //    Stripe → MindBody join uses can resolve this customer immediately,
      //    instead of waiting for the next mindbody-clients-sync cron run.
      await sb.from('mindbody_clients').upsert({
        mindbody_id:      mbClientId,
        email:            row.email,
        first_name:       (row.name || '').split(/\s+/)[0] || null,
        last_name:        (row.name || '').split(/\s+/).slice(1).join(' ') || null,
        phone:            row.phone,
        home_location_id: mbLocationId,
        studio_slug:      studioSlug,
        member_since:     new Date().toISOString(),
        status:           'Active',
        imported_at:      new Date().toISOString(),
      }, { onConflict: 'mindbody_id' });

      results.push({ trial_signup_id: row.id, email: row.email, studio: studioSlug, status: 'created', mindbody_id: mbClientId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`create-trial-client failed for ${row.email}:`, msg);
      results.push({ trial_signup_id: row.id, email: row.email, studio: studioSlug, status: 'failed', reason: msg });
    }
  }

  // ── Diagnostic on failure ───────────────────────────────────────────────
  // If everything failed with MissingRequiredFields, query MindBody for its
  // actual required-fields config and any custom client fields/questions.
  // This is the smoking-gun debug — tells us exactly what MB expects.
  let mbDiagnostic: string | undefined = undefined;
  if (
    results.length > 0 &&
    results.every((r) => r.status === 'failed' && (r.reason || '').includes('MissingRequiredFields'))
  ) {
    mbDiagnostic = await diagnoseMissingRequiredFields();
    console.log('MB site config dump (on universal MissingRequiredFields):', mbDiagnostic);
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
    ...(mbDiagnostic ? { mb_site_config: mbDiagnostic } : {}),
  });
});
