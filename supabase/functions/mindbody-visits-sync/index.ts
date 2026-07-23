// Supabase Edge Function: mindbody-visits-sync
//
// Pulls class visits from MindBody for every BBB studio and upserts them
// into `mindbody_visits`. For any visit whose ClientId we don't yet have
// in `mindbody_clients`, fetches that client's details (email, name, phone,
// DOB) and upserts them too — so the email-join in `get_trial_journey`
// works for brand-new trial customers as soon as they attend a class.
//
// No staff token required: both `/class/classvisits` and `/client/clients?ClientIds=…`
// work with just the Api-Key + SiteId headers.
//
// ENV required (set via `supabase secrets set …`):
//   MINDBODY_API_KEY   — developer-portal API key
//   MINDBODY_SITE_ID   — single BBB site (e.g. 5733997) — 4 LocationIds under it.
//
// POST body (optional):
//   { lookback_days?: number,      // how many days back to walk (default 2, max 60)
//     start_offset_days?: number,  // skip this many recent days (default 0). Use to
//                                  // backfill in chunks, e.g. {lookback_days:2, start_offset_days:2}
//                                  // covers days 2-3 ago.
//     concurrency?: number,        // parallel visit fetches (default 5, max 10).
//                                  // Higher = faster but more pressure on Mindbody rate limit.
//     dry_run?: boolean }
//
// Deploy: supabase functions deploy mindbody-visits-sync

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MB_BASE = 'https://api.mindbodyonline.com/public/v6';

// Single MindBody site, multiple Locations → BBB studio slug.
const STUDIO_MAP: Record<number, string> = {
  1: 'williamsburg',
  2: 'astoria',
  3: 'fresh-meadows',
  6: 'bayside',
  // 98 = "Online Store" — skipped.
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

// ── MindBody HTTP ───────────────────────────────────────────────────────────
// Two auth modes:
//   - "anon"   → Api-Key + SiteId. Reads schedules + class visits. No client PII.
//   - "source" → also includes a legacy `SourceCredentials: <SourceName>|<SourcePassword>`
//                header. /usertoken/issue wants real staff-user creds (which we
//                don't have), but the SourceCredentials header is honored by
//                /client/clients and unlocks email/phone enrichment — confirmed
//                empirically with a direct probe.
function getSourceCredentialsHeader(): string | null {
  const srcName = Deno.env.get('MINDBODY_SOURCE_NAME');
  const srcPass = Deno.env.get('MINDBODY_SOURCE_PASSWORD');
  if (!srcName || !srcPass) return null;
  return `${srcName}|${srcPass}`;
}

function mbHeaders(useSourceAuth = false): Record<string, string> {
  const apiKey = Deno.env.get('MINDBODY_API_KEY') ?? '';
  const siteId = Deno.env.get('MINDBODY_SITE_ID') ?? '';
  if (!apiKey || !siteId) {
    throw new Error('Missing MINDBODY_API_KEY or MINDBODY_SITE_ID env vars');
  }
  const h: Record<string, string> = { 'Api-Key': apiKey, 'SiteId': siteId };
  if (useSourceAuth) {
    const sc = getSourceCredentialsHeader();
    if (sc) h['SourceCredentials'] = sc;
  }
  return h;
}

async function mbGet(path: string, useSourceAuth = false): Promise<any> {
  const r = await fetch(`${MB_BASE}${path}`, { headers: mbHeaders(useSourceAuth) });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`MindBody GET ${path} → HTTP ${r.status}: ${txt}`);
  }
  return r.json();
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

async function listClassIdsForDay(locationId: number, date: string): Promise<number[]> {
  const q = `LocationIds=${locationId}&StartDateTime=${date}T00:00:00&EndDateTime=${date}T23:59:59&Limit=200`;
  const data = await mbGet(`/class/classes?${q}`);
  return (data?.Classes ?? []).map((c: { Id: number }) => c.Id);
}

async function fetchVisitsForClass(classId: number): Promise<any[]> {
  const data = await mbGet(`/class/classvisits?classId=${classId}`);
  return (data?.Class?.Visits ?? []) as any[];
}

async function fetchClientsByIds(clientIds: string[], useSourceAuth = false): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < clientIds.length; i += 50) {
    const batch = clientIds.slice(i, i + 50);
    // CRITICAL: ClientIds must be passed as repeat params (ClientIds=A&ClientIds=B),
    // not comma-separated. The comma format silently returns zero rows even with
    // SourceCredentials. Confirmed via direct probe — the repeat format works.
    const qs = batch.map((id) => `ClientIds=${encodeURIComponent(id)}`).join('&') + '&Limit=200';
    const data = await mbGet(`/client/clients?${qs}`, useSourceAuth);
    out.push(...(data?.Clients ?? []));
  }
  return out;
}

// Pull each client's upcoming class bookings — powers the "next class" chip on
// the homebase Kanban. Uses SourceCredentials auth.
async function fetchClientUpcomingBookings(
  clientIds: string[],
): Promise<Record<string, { class_id: number; start: string; service_name: string | null }[]>> {
  const out: Record<string, { class_id: number; start: string; service_name: string | null }[]> = {};
  const startDate = new Date().toISOString().slice(0, 10);
  const endDate   = new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 10);
  for (const cid of clientIds) {
    try {
      const data = await mbGet(
        `/client/clientvisits?clientId=${cid}&startDate=${startDate}&endDate=${endDate}`,
        true, // useSourceAuth
      );
      const visits = (data?.Visits ?? []) as any[];
      out[cid] = visits
        .filter(v => !v.LateCancelled && !v.Missed)
        .map(v => ({
          class_id: v.ClassId,
          start:    String(v.StartDateTime ?? ''),
          service_name: v.Name ?? v.ServiceName ?? null,
        }));
    } catch (e) {
      out[cid] = [];
    }
  }
  return out;
}

// Concurrency-limited map. Runs `worker` over every item, max `limit` in flight.
async function parallelEach<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runner = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try { await worker(items[idx]); } catch (_) { /* swallowed per-item */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
}

// ── Main ────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const body: { lookback_days?: number; start_offset_days?: number; concurrency?: number; dry_run?: boolean } =
    req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const lookbackDays = Math.max(1, Math.min(60, Number(body.lookback_days ?? 2)));
  const startOffsetDays = Math.max(0, Math.min(365, Number(body.start_offset_days ?? 0)));
  const concurrency = Math.max(1, Math.min(10, Number(body.concurrency ?? 5)));
  const dryRun = !!body.dry_run;

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const result: Record<string, unknown> = {
    window_days: lookbackDays,
    start_offset_days: startOffsetDays,
    concurrency,
    dry_run: dryRun,
    studios: [] as unknown[],
  };

  // SourceCredentials availability = whether we can enrich clients with PII.
  // Without it, /client/clients silently returns empty arrays for new IDs.
  const sourceAuthAvailable = !!getSourceCredentialsHeader();
  (result as any).source_auth_available = sourceAuthAvailable;

  const today = new Date();
  const allVisits: any[] = [];
  const seenClientIds = new Set<string>();

  // 1. Per studio per day: list class IDs (sequential — only ~40 calls).
  const classQueue: Array<{ slug: string; classId: number }> = [];
  const perStudio: Record<string, { studio: string; location_id: number; classes: number; visits: number; error?: string }> = {};

  for (const [locIdStr, slug] of Object.entries(STUDIO_MAP)) {
    const locId = Number(locIdStr);
    perStudio[slug] = { studio: slug, location_id: locId, classes: 0, visits: 0 };
    try {
      const ids = new Set<number>();
      for (let i = startOffsetDays; i < startOffsetDays + lookbackDays; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dayIds = await listClassIdsForDay(locId, fmtDate(d));
        dayIds.forEach((x: number) => ids.add(x));
      }
      perStudio[slug].classes = ids.size;
      ids.forEach((id) => classQueue.push({ slug, classId: id }));
    } catch (e: unknown) {
      perStudio[slug].error = String((e as Error).message ?? e);
    }
  }

  // 2. Parallel-fetch visits across all classes (this was the bottleneck).
  await parallelEach(classQueue, concurrency, async ({ slug, classId }) => {
    const visits = await fetchVisitsForClass(classId);
    for (const v of visits) {
      allVisits.push({ ...v, _studio_slug: slug });
      if (v.ClientId) seenClientIds.add(String(v.ClientId));
      perStudio[slug].visits++;
    }
  });

  result.studios = Object.values(perStudio);
  result.total_visits = allVisits.length;
  result.unique_client_ids = seenClientIds.size;

  if (dryRun) {
    result.dry_run_visit_sample = allVisits.slice(0, 2);
    return json(result);
  }

  // 3. Look up + upsert any clients we don't have yet — AND re-enrich any
  // existing client rows where email is still NULL (those got created during
  // the no-staff-token era and never got their PII filled in).
  if (seenClientIds.size > 0) {
    const idsArr = [...seenClientIds];
    const { data: existing, error: exErr } = await sb
      .from('mindbody_clients')
      .select('mindbody_id, email')
      .in('mindbody_id', idsArr);
    if (exErr) result.client_lookup_error = exErr.message;
    const have = new Set((existing ?? []).map((r: { mindbody_id: string }) => r.mindbody_id));
    const haveButEmpty = new Set(
      (existing ?? [])
        .filter((r: { mindbody_id: string; email: string | null }) => !r.email)
        .map((r: { mindbody_id: string }) => r.mindbody_id),
    );
    // With SourceCredentials we re-fetch the empty rows too so the email
    // bridge fills in for previously-missing customers.
    const needsEnrichment = sourceAuthAvailable
      ? idsArr.filter((id) => !have.has(id) || haveButEmpty.has(id))
      : idsArr.filter((id) => !have.has(id));
    const missing = needsEnrichment;
    result.clients_already_have = have.size;
    result.clients_to_fetch = missing.length;
    (result as any).clients_to_reenrich = haveButEmpty.size;

    if (missing.length > 0) {
      try {
        // SourceCredentials header unlocks the real client data.
        const newClients = await fetchClientsByIds(missing, sourceAuthAvailable);
        const clientUpserts = newClients.map((c: any) => ({
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
        const { error: cErr } = await sb
          .from('mindbody_clients')
          .upsert(clientUpserts, { onConflict: 'mindbody_id' });
        if (cErr) result.client_upsert_error = cErr.message;
        else result.clients_upserted = clientUpserts.length;
      } catch (e: unknown) {
        result.client_fetch_error = String((e as Error).message ?? e);
      }
    }
  }

  // 4. Upsert visits, batched.
  if (allVisits.length > 0) {
    const visitUpserts = allVisits.map((v: any) => ({
      mindbody_visit_id: v.Id,
      mindbody_client_id: v.ClientId != null ? String(v.ClientId) : null,
      mindbody_class_id: v.ClassId ?? null,
      studio_slug: STUDIO_MAP[v.LocationId as number] ?? v._studio_slug ?? null,
      starts_at: v.StartDateTime ?? null,
      ended_at: v.EndDateTime ?? null,
      signed_in: !!v.SignedIn,
      late_cancelled: !!v.LateCancelled,
      cancelled: !!v.Missed,
      service_name: v.ServiceName ?? null,
      raw: v,
      imported_at: new Date().toISOString(),
    }));
    let visitsUpserted = 0;
    for (let i = 0; i < visitUpserts.length; i += 500) {
      const batch = visitUpserts.slice(i, i + 500);
      const { error: vErr } = await sb
        .from('mindbody_visits')
        .upsert(batch, { onConflict: 'mindbody_visit_id' });
      if (vErr) { result.visit_upsert_error = vErr.message; break; }
      visitsUpserted += batch.length;
    }
    result.visits_upserted = visitsUpserted;
  }

  return json(result);
});
