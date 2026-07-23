// Supabase Edge Function: mindbody-clients-sync
//
// Refreshes `mindbody_clients` so the email-bridge from Stripe to MindBody
// actually works. Why this exists: /sale/sales returns ClientId but no
// PurchasedBy.Email, so we cannot infer customer identity from a sale alone.
// The Stripe paid mirror has email; mindbody_sales has ClientId; the only
// bridge is mindbody_clients.email → mindbody_clients.mindbody_id. That
// table got seeded once and never refreshed, so any customer who joined
// (or any pre-existing customer who re-engaged) since April 30 wasn't in it.
// As a result our Ad ROI RPC silently mismatched Stripe trial customers
// to whichever MindBody trial sale happened nearest in time at the same
// studio — collapsing multiple emails onto one mindbody_id and tripling-
// counting a single $150 purchase.
//
// Strategy: collect every distinct customer_mindbody_id from mindbody_sales
// since p_since, plus any existing mindbody_clients rows where email is
// still null, then re-fetch each via /client/clients?ClientIds=… (50 per
// call, repeat-param form — comma form silently returns zero rows) and
// upsert email/name/phone/etc.
//
// Auth: requires both MINDBODY_API_KEY + MINDBODY_SITE_ID and
// MINDBODY_SOURCE_NAME + MINDBODY_SOURCE_PASSWORD. Without source creds
// /client/clients returns empty Clients arrays. Confirmed empirically.
//
// POST body (optional):
//   { since?: 'YYYY-MM-DD',     // earliest sale date to source ClientIds from. default 2026-05-15
//     refetch_all?: boolean,    // ignore existing emails, refetch every id. default false
//     dry_run?: boolean,
//     max_ids?: number }        // hard cap on lookups per run, default 2000
//
// Deploy: supabase functions deploy mindbody-clients-sync --no-verify-jwt

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MB_BASE = 'https://api.mindbodyonline.com/public/v6';

const STUDIO_MAP: Record<number, string> = {
  1: 'williamsburg',
  2: 'astoria',
  3: 'fresh-meadows',
  6: 'bayside',
};

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

function getSourceCredentialsHeader(): string | null {
  const srcName = Deno.env.get('MINDBODY_SOURCE_NAME');
  const srcPass = Deno.env.get('MINDBODY_SOURCE_PASSWORD');
  if (!srcName || !srcPass) return null;
  return `${srcName}|${srcPass}`;
}

function mbHeaders(): Record<string, string> {
  const apiKey = Deno.env.get('MINDBODY_API_KEY') ?? '';
  const siteId = Deno.env.get('MINDBODY_SITE_ID') ?? '';
  if (!apiKey || !siteId) throw new Error('Missing MINDBODY_API_KEY or MINDBODY_SITE_ID env vars');
  const h: Record<string, string> = { 'Api-Key': apiKey, 'SiteId': siteId };
  const sc = getSourceCredentialsHeader();
  if (!sc) throw new Error('Missing MINDBODY_SOURCE_NAME / MINDBODY_SOURCE_PASSWORD — /client/clients requires source auth to return PII');
  h['SourceCredentials'] = sc;
  return h;
}

async function mbGet(path: string): Promise<any> {
  const r = await fetch(`${MB_BASE}${path}`, { headers: mbHeaders() });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`MindBody GET ${path} → HTTP ${r.status}: ${txt}`);
  }
  return r.json();
}

// Fetch full client records for a list of IDs. ClientIds must be passed as
// repeat params (comma form silently returns zero). MindBody caps at 20 IDs
// per call — exceeding it returns HTTP 400 "ClientIds should not be more than 20".
async function fetchClientsByIds(clientIds: string[]): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < clientIds.length; i += 20) {
    const batch = clientIds.slice(i, i + 20);
    const qs = batch.map((id) => `ClientIds=${encodeURIComponent(id)}`).join('&') + '&Limit=50';
    const data = await mbGet(`/client/clients?${qs}`);
    out.push(...(data?.Clients ?? []));
  }
  return out;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const body: {
    since?: string;
    refetch_all?: boolean;
    dry_run?: boolean;
    max_ids?: number;
    force_ids?: string[];        // NEW: explicit ID list bypasses sales lookup
    return_raw?: boolean;        // NEW: include MB raw JSON in response for debug
  } = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const since = body.since ?? '2026-05-15';
  const refetchAll = !!body.refetch_all;
  const dryRun = !!body.dry_run;
  const maxIds = Math.max(1, Math.min(10000, Number(body.max_ids ?? 2000)));
  const forceIds = Array.isArray(body.force_ids)
    ? body.force_ids.map((x) => String(x)).filter(Boolean)
    : null;
  const returnRaw = !!body.return_raw;

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const result: Record<string, unknown> = {
    since, refetch_all: refetchAll, dry_run: dryRun, max_ids: maxIds,
    force_ids_count: forceIds?.length ?? 0,
  };

  let idsArr: string[];

  if (forceIds && forceIds.length > 0) {
    // Force mode: skip sales lookup entirely.
    idsArr = forceIds.slice(0, maxIds);
    result.distinct_client_ids_in_sales = null;
  } else {
    // 1. Collect every distinct customer_mindbody_id from mindbody_sales since
    // the requested date. These are the customers who actually transacted, which
    // is the only population we need to bridge.
    const { data: salesIds, error: sErr } = await sb
      .from('mindbody_sales')
      .select('customer_mindbody_id')
      .gte('sale_date_time', `${since}T00:00:00Z`)
      .not('customer_mindbody_id', 'is', null);
    if (sErr) {
      result.sales_lookup_error = sErr.message;
      return json(result, 500);
    }
    const seenIds = new Set<string>();
    for (const r of salesIds ?? []) {
      if (r.customer_mindbody_id) seenIds.add(String(r.customer_mindbody_id));
    }
    result.distinct_client_ids_in_sales = seenIds.size;
    idsArr = [...seenIds].slice(0, maxIds);
  }

  // 2. Find which of those are missing from mindbody_clients, or present
  // but with a null email (the latter are stale rows that need refresh).
  const { data: existing, error: exErr } = await sb
    .from('mindbody_clients')
    .select('mindbody_id, email')
    .in('mindbody_id', idsArr);
  if (exErr) {
    result.clients_lookup_error = exErr.message;
    return json(result, 500);
  }
  const have = new Set((existing ?? []).map((r: { mindbody_id: string }) => r.mindbody_id));
  const haveButEmpty = new Set(
    (existing ?? [])
      .filter((r: { mindbody_id: string; email: string | null }) => !r.email)
      .map((r: { mindbody_id: string }) => r.mindbody_id),
  );
  // force_ids implies refetch_all semantics (bypass existence/email check).
  const toFetch = (refetchAll || forceIds)
    ? idsArr
    : idsArr.filter((id) => !have.has(id) || haveButEmpty.has(id));

  result.clients_already_complete = have.size - haveButEmpty.size;
  result.clients_with_null_email = haveButEmpty.size;
  result.clients_to_fetch = toFetch.length;

  if (dryRun) {
    result.dry_run_sample_ids = toFetch.slice(0, 10);
    return json(result);
  }

  if (toFetch.length === 0) {
    return json({ ...result, status: 'nothing to fetch' });
  }

  // 3. Fetch from MindBody and upsert.
  let upserted = 0;
  let fetched = 0;
  const returnedIds: string[] = [];
  let unmatched: string[] = [];
  try {
    const newClients = await fetchClientsByIds(toFetch);
    fetched = newClients.length;
    // Dedupe by mindbody_id — MindBody sometimes returns the same client
    // twice within a single response (e.g. linked accounts), which causes
    // ON CONFLICT to error: "command cannot affect row a second time".
    const dedup = new Map<string, any>();
    for (const c of newClients) {
      if (c?.Id != null) {
        const idStr = String(c.Id);
        dedup.set(idStr, c);
        returnedIds.push(idStr);
      }
    }
    // Diagnostic: any IDs we asked for that MB didn't return.
    const returnedSet = new Set(returnedIds);
    unmatched = toFetch.filter((id) => !returnedSet.has(id));
    if (returnRaw) {
      result.mb_returned_sample = newClients.slice(0, 5);
    }
    result.unmatched_ids = unmatched.slice(0, 50);
    result.unmatched_count = unmatched.length;
    const clientUpserts = Array.from(dedup.values()).map((c: any) => ({
      mindbody_id: String(c.Id),
      email: c.Email ?? null,
      first_name: c.FirstName ?? null,
      last_name: c.LastName ?? null,
      phone: c.MobilePhone ?? c.HomePhone ?? c.WorkPhone ?? null,
      date_of_birth: c.BirthDate ? String(c.BirthDate).slice(0, 10) : null,
      home_location_id: c.HomeLocation?.Id ?? null,
      studio_slug: STUDIO_MAP[c.HomeLocation?.Id as number] ?? null,
      member_since: c.CreationDate ?? null,
      status: c.Status ?? null,
      raw: c,
      imported_at: new Date().toISOString(),
    }));
    // Batch upserts in 500s.
    for (let i = 0; i < clientUpserts.length; i += 500) {
      const batch = clientUpserts.slice(i, i + 500);
      const { error: cErr } = await sb
        .from('mindbody_clients')
        .upsert(batch, { onConflict: 'mindbody_id' });
      if (cErr) { result.client_upsert_error = cErr.message; break; }
      upserted += batch.length;
    }
  } catch (e: unknown) {
    result.client_fetch_error = String((e as Error).message ?? e);
  }

  result.clients_fetched_from_mb = fetched;
  result.clients_upserted = upserted;
  // Quick read-back metric: how many of the to-fetch IDs now have a real email.
  if (upserted > 0) {
    const { count } = await sb
      .from('mindbody_clients')
      .select('mindbody_id', { count: 'exact', head: true })
      .in('mindbody_id', toFetch)
      .not('email', 'is', null);
    result.with_email_after = count ?? null;
  }
  return json(result);
});
