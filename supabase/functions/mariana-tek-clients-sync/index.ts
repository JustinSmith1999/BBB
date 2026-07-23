// Supabase Edge Function: mariana-tek-clients-sync
//
// MT equivalent of mindbody-clients-sync. Pulls the customer master from MT
// for every BBB studio that has been cut over, upserts into
// `mariana_tek_clients` so the email-bridge from Stripe → MT works.
//
// Auth: per-studio Bearer token + subdomain stored on the `locations` table:
//   - mariana_tek_subdomain
//   - mariana_tek_api_key
// Studios missing either are skipped (one-studio-at-a-time cutover).
//
// POST body (optional):
//   { since?: 'YYYY-MM-DD',     // default 2026-05-15
//     refetch_all?: boolean,    // default false
//     dry_run?: boolean,
//     max_ids?: number }        // default 2000
//
// Deploy: supabase functions deploy mariana-tek-clients-sync --no-verify-jwt

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const STUDIO_SLUGS = ['williamsburg', 'astoria', 'fresh-meadows', 'bayside'] as const;

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';

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
  slug: string;
  mariana_tek_subdomain: string | null;
  mariana_tek_api_key: string | null;
};

function mtHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

async function mtGet(subdomain: string, apiKey: string, path: string): Promise<any> {
  const url = `https://${subdomain}.marianatek.com${path}`;
  const r = await fetch(url, { headers: mtHeaders(apiKey) });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300);
    throw new Error(`MT GET ${url} → HTTP ${r.status}: ${txt}`);
  }
  return r.json();
}

// ─── TODO: VERIFY ENDPOINT SHAPE BEFORE GO-LIVE ─────────────────────────────
// Docs: https://guides.marianatek.com/api-overview
//
// The exact list-users endpoint + filter params need verification against
// the MT sandbox. Likely candidate:
//   GET /api/users/
//     ?filter[updated_after]=YYYY-MM-DD
//     &page[size]=200
//     &page[number]=N
//
// Justin: once you have a sandbox response, edit the two `// EDIT-AT-CUTOVER`
// lines below — the path and the verification flag.
// ────────────────────────────────────────────────────────────────────────────
const MT_USERS_VERIFIED = false;        // EDIT-AT-CUTOVER: flip to true after verifying
const MT_USERS_PATH = '/api/users/';    // EDIT-AT-CUTOVER: confirm exact path

async function fetchUsersForStudio(
  subdomain: string,
  apiKey: string,
  since: string,
  maxIds: number,
): Promise<any[]> {
  if (!MT_USERS_VERIFIED) {
    throw new Error(
      `MT_API endpoint not yet verified — see TODO above MT_USERS_VERIFIED. ` +
      `Confirm GET ${MT_USERS_PATH} shape against https://guides.marianatek.com/api-overview ` +
      `then flip MT_USERS_VERIFIED = true.`
    );
  }
  const out: any[] = [];
  let page = 1;
  const size = 200;
  while (out.length < maxIds) {
    const q =
      `?filter[updated_after]=${since}` +
      `&page[size]=${size}` +
      `&page[number]=${page}`;
    const data = await mtGet(subdomain, apiKey, `${MT_USERS_PATH}${q}`);
    // EDIT-AT-CUTOVER: confirm response envelope ({data:[]} JSON:API vs {results:[]}).
    const rows = (data?.data ?? data?.results ?? []) as any[];
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < size) break;
    page += 1;
    if (page > 200) break; // safety
  }
  return out.slice(0, maxIds);
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
    since?: string;
    refetch_all?: boolean;
    dry_run?: boolean;
    max_ids?: number;
  } = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const since = body.since ?? '2026-05-15';
  const refetchAll = !!body.refetch_all;
  const dryRun = !!body.dry_run;
  const maxIds = Math.max(1, Math.min(10000, Number(body.max_ids ?? 2000)));

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const { data: locs, error: locErr } = await sb
    .from('locations')
    .select('id, slug, mariana_tek_subdomain, mariana_tek_api_key')
    .in('slug', STUDIO_SLUGS as unknown as string[]);
  if (locErr) return json({ ok: false, error: `locations lookup: ${locErr.message}` }, 500);

  const result: Record<string, unknown> = {
    ok: true,
    since,
    refetch_all: refetchAll,
    dry_run: dryRun,
    max_ids: maxIds,
    studios: [] as unknown[],
  };

  const perStudio: Record<string, { studio: string; status: string; fetched: number; upserted: number; error?: string }> = {};
  for (const slug of STUDIO_SLUGS) {
    perStudio[slug] = { studio: slug, status: 'pending', fetched: 0, upserted: 0 };
  }

  const allUpserts: any[] = [];

  for (const loc of (locs ?? []) as LocationRow[]) {
    const slug = loc.slug;
    if (!perStudio[slug]) continue;
    if (!loc.mariana_tek_subdomain || !loc.mariana_tek_api_key) {
      perStudio[slug].status = 'skipped (no MT creds)';
      continue;
    }
    try {
      const rows = await fetchUsersForStudio(
        loc.mariana_tek_subdomain,
        loc.mariana_tek_api_key,
        since,
        maxIds,
      );
      perStudio[slug].fetched = rows.length;

      // EDIT-AT-CUTOVER: confirm field names below against real MT response.
      const upserts = rows.map((u: any) => {
        const a = u?.attributes ?? u ?? {};
        return {
          mt_id: String(u?.id ?? a?.id),
          studio_slug: slug,
          email: a.email ?? null,
          first_name: a.first_name ?? null,
          last_name: a.last_name ?? null,
          phone: a.phone_number ?? a.phone ?? null,
          dob: a.date_of_birth ? String(a.date_of_birth).slice(0, 10)
              : (a.dob ? String(a.dob).slice(0, 10) : null),
          created_at_mt: a.created ?? a.created_at ?? null,
          raw: u,
          synced_at: new Date().toISOString(),
        };
      }).filter((r) => r.mt_id && r.mt_id !== 'undefined');

      // If not refetch_all, skip rows we already have with a non-null email.
      let toUpsert = upserts;
      if (!refetchAll && upserts.length > 0) {
        const ids = upserts.map((u) => u.mt_id);
        const { data: existing } = await sb
          .from('mariana_tek_clients')
          .select('mt_id, email')
          .in('mt_id', ids);
        const complete = new Set(
          (existing ?? [])
            .filter((r: { mt_id: string; email: string | null }) => !!r.email)
            .map((r: { mt_id: string }) => r.mt_id),
        );
        toUpsert = upserts.filter((u) => !complete.has(u.mt_id));
      }

      allUpserts.push(...toUpsert);
      perStudio[slug].status = 'ok';
    } catch (e) {
      perStudio[slug].status = 'error';
      perStudio[slug].error = String((e as Error).message ?? e);
    }
  }

  result.studios = Object.values(perStudio);
  result.total_to_upsert = allUpserts.length;

  if (dryRun) {
    (result as any).dry_run_sample = allUpserts.slice(0, 3);
    return json(result);
  }

  if (allUpserts.length > 0) {
    let upserted = 0;
    for (let i = 0; i < allUpserts.length; i += 500) {
      const batch = allUpserts.slice(i, i + 500);
      const { error } = await sb
        .from('mariana_tek_clients')
        .upsert(batch, { onConflict: 'mt_id' });
      if (error) { (result as any).upsert_error = error.message; break; }
      upserted += batch.length;
    }
    result.clients_upserted = upserted;
  }

  return json(result);
});
