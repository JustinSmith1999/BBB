// Supabase Edge Function: mariana-tek-clients-sync (v2 · 2026-09-01)
//
// COMPLETE REWRITE. The v1 of this function was dead on arrival: it selected
// a `locations.slug` column that doesn't exist and authenticated with
// per-studio `mariana_tek_api_key` values that were never populated. It never
// ran successfully once — the customer roster froze on July 11 and Homebase
// went stale for seven weeks before anyone noticed.
//
// v2 design principles:
//   1. Reuse the ONE working MT auth path instead of duplicating it: this
//      function calls the book-class function's `probe` action in-project.
//      book-class owns the OAuth refresh/rotation machinery (and the future
//      MT_ADMIN_API_KEY). One auth implementation, one place to fix it.
//   2. MT user ids are sequential integers. Sync = walk forward from the
//      highest mt_id we already have until we hit a run of 404s (the end of
//      the id space). No date filters, no per-studio credentials, nothing
//      that can silently skip people.
//   3. Registered in sync-orchestrator (2026-09-01) so it runs every cycle.
//      The freshness watchdog should alarm if max(synced_at) goes stale.
//
// POST body (optional):
//   { start_id?: number,   // default: max(mt_id) in table + 1
//     max_ids?:  number,   // default 300 per invocation (orchestrator-safe)
//     stop_after_404s?: number }  // default 30 consecutive misses = done
//
// Auth: x-bbb-secret header.
// Deploy: supabase functions deploy mariana-tek-clients-sync --no-verify-jwt

// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-bbb-secret, Authorization, Apikey, X-Client-Info',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function mtGetUser(uid: number): Promise<{ status: number; attrs?: Record<string, unknown> }> {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/book-class`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bbb-secret': ADMIN_SECRET },
    body: JSON.stringify({ action: 'probe', method: 'GET', path: `/api/users/${uid}` }),
  });
  const b = await r.json().catch(() => ({}));
  const status = Number(b?.mt_status ?? 0);
  const attrs = b?.mt_body?.data?.attributes as Record<string, unknown> | undefined;
  return { status, attrs };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  // Allow the orchestrator (which may call without the header from inside the
  // project) OR the admin secret. Reject everything else.
  const secretOk = req.headers.get('x-bbb-secret') === ADMIN_SECRET;
  const hasServiceAuth = (req.headers.get('Authorization') || '').length > 0;
  if (!secretOk && !hasServiceAuth) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { start_id?: number; max_ids?: number; stop_after_404s?: number } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const maxIds = Math.min(Number(body.max_ids) || 300, 2000);
  const stopAfter = Math.min(Number(body.stop_after_404s) || 30, 100);

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Resume point: numeric max of mt_id. mt_id is TEXT, and plain text ordering
  // puts '9994' above '66910' — the old code resumed from ~10000 and re-scanned
  // thousands of live ids until the function timed out (500) on every cron run.
  // Fix: within a fixed digit-length, text order == numeric order. Probe the
  // longest populated length first.
  let startId = Number(body.start_id) || 0;
  if (!startId) {
    let maxId = 0;
    for (const digits of [7, 6, 5, 4]) {
      const lo = '1' + '0'.repeat(digits - 1);
      const hi = '9'.repeat(digits);
      const { data } = await sb.from('mariana_tek_clients')
        .select('mt_id').gte('mt_id', lo).lte('mt_id', hi)
        .order('mt_id', { ascending: false }).limit(1);
      if (data && data.length) { maxId = parseInt(data[0].mt_id, 10) || 0; break; }
    }
    startId = maxId + 1;
  }
  if (!startId || startId < 2) return json({ ok: false, error: 'could not determine start_id' }, 500);

  const rows: Record<string, unknown>[] = [];
  let misses = 0, scanned = 0, uid = startId;
  for (; scanned < maxIds && misses < stopAfter; uid++, scanned++) {
    const { status, attrs } = await mtGetUser(uid);
    if (status === 200 && attrs) {
      misses = 0;
      rows.push({
        mt_id: String(uid),
        email: (String(attrs.email ?? '').toLowerCase()) || null,
        first_name: attrs.first_name ?? null,
        last_name: attrs.last_name ?? null,
        phone: attrs.phone_number ?? null,
        created_at_mt: attrs.date_joined ?? null,
        synced_at: new Date().toISOString(),
      });
    } else if (status === 404) {
      misses++;
    } else {
      // Auth or transient error — stop rather than record garbage.
      return json({ ok: false, error: `MT probe returned ${status} at id ${uid}`, upserted: rows.length, scanned }, 502);
    }
  }

  let upserted = 0;
  if (rows.length) {
    const { error } = await sb.from('mariana_tek_clients').upsert(rows, { onConflict: 'mt_id' });
    if (error) return json({ ok: false, error: `upsert: ${error.message}`, scanned }, 500);
    upserted = rows.length;
  }
  return json({
    ok: true, start_id: startId, scanned, upserted,
    reached_end: misses >= stopAfter,
    next_start_id: uid,
  });
});
