// Supabase Edge Function: mariana-tek-clients-sync (v3 · 2026-10-05)
//
// WHAT WAS BROKEN (found 2026-10-05, roster frozen since 2026-09-08)
// v2 walked the MT user-id space ONE ID AT A TIME, and each id was a nested
// call to book-class, which in turn called MT. The orchestrator invoked it
// hourly with { max_ids: 2000 } — i.e. 2000 nested round trips in a single
// invocation. Measured live today:
//
//     max_ids=10  -> HTTP 200 in  5.1s   (10 upserted)
//     max_ids=40  -> HTTP 500 in 16.4s   (0 upserted)
//
// It dies somewhere above ~30 ids, and 16s is far short of the wall clock, so
// this is the nested sub-request budget giving out, not a timeout. Worse, v2
// upserted only AFTER the whole loop finished, so a crash saved NOTHING. Every
// hourly run since September 8 did the same thing: spent its budget, crashed,
// wrote nothing, and left `synced_at` 27 days old while the watchdog texted
// about it once an hour. The same "runs, returns, achieves nothing" shape as
// the rest of this codebase's failures.
//
// WHAT v3 DOES INSTEAD
//   1. PAGES the list endpoint rather than fetching users one by one.
//      /api/users?page_size=200&page=N returns 200 users per call — 162 pages
//      covers all 32,373 users. One call now does the work of 200.
//   2. UPSERTS EACH PAGE IMMEDIATELY. Progress is durable; a crash mid-run
//      keeps everything already written.
//   3. RESUMES from a cursor in public.sync_cursor, so consecutive runs march
//      through the pages instead of redoing page 1 forever. At the default 8
//      pages per run, hourly, a full pass takes under a day and then loops.
//   4. NEVER THROWS past the loop. Any failure returns 200 with what it got
//      plus the cursor it stopped on, so the orchestrator keeps making
//      progress rather than dying on a single bad page.
//
// NOTE ON SORTING: MT ignores sort/ordering on /api/users — verified 2026-10-05
// against `sort=-date_joined`, `ordering=-date_joined` and `sort=-id`, all of
// which returned byte-identical first pages. So "just fetch the newest" is not
// available; a full rolling pass is the honest way to keep the roster true.
//
// POST body (all optional):
//   { page?: number,            // force a start page (ignores the cursor)
//     pages_per_run?: number,   // default 8, hard cap 30
//     page_size?: number,       // default 200 (MT's max that we've verified)
//     reset?: boolean }         // start again from page 1
//
// Deploy: bbb deploy-fn mariana-tek-clients-sync
// Needs migration 20261005_sync_cursor.sql applied first.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';
const CURSOR_KEY = 'mariana_tek_clients_page';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-bbb-secret, Authorization, Apikey, X-Client-Info',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/** One page of MT users, fetched through book-class (the single owner of MT auth). */
async function mtUsersPage(page: number, pageSize: number): Promise<{ status: number; users: any[]; pages: number }> {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/book-class`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bbb-secret': ADMIN_SECRET },
    body: JSON.stringify({
      action: 'probe',
      method: 'GET',
      path: `/api/users?page_size=${pageSize}&page=${page}`,
    }),
  });
  const b = await r.json().catch(() => ({}));
  const status = Number(b?.mt_status ?? 0);
  const body = b?.mt_body ?? {};
  return {
    status,
    users: Array.isArray(body?.data) ? body.data : [],
    pages: Number(body?.meta?.pagination?.pages ?? 0),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  // The orchestrator may call from inside the project with service auth and no
  // custom header; admin callers use the shared secret. Reject anything else.
  const secretOk = req.headers.get('x-bbb-secret') === ADMIN_SECRET;
  const hasServiceAuth = (req.headers.get('Authorization') || '').length > 0;
  if (!secretOk && !hasServiceAuth) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { page?: number; pages_per_run?: number; page_size?: number; reset?: boolean } = {};
  try { body = await req.json(); } catch { /* defaults */ }

  const pagesPerRun = Math.min(Math.max(Number(body.pages_per_run) || 8, 1), 30);
  const pageSize    = Math.min(Math.max(Number(body.page_size) || 200, 25), 200);

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // ── resume point ─────────────────────────────────────────────────────────
  let startPage = 1;
  if (!body.reset) {
    if (Number(body.page) > 0) {
      startPage = Number(body.page);
    } else {
      const { data } = await sb.from('sync_cursor').select('value').eq('key', CURSOR_KEY).maybeSingle();
      const stored = Number((data?.value as any)?.next_page);
      if (stored > 0) startPage = stored;
    }
  }

  let page = startPage;
  let totalPages = 0;
  let upserted = 0;
  let pagesDone = 0;
  let stoppedBecause: string | null = null;

  try {
    for (; pagesDone < pagesPerRun; pagesDone++, page++) {
      const { status, users, pages } = await mtUsersPage(page, pageSize);
      if (pages) totalPages = pages;

      if (status !== 200) { stoppedBecause = `MT returned ${status} on page ${page}`; break; }
      if (!users.length)  { stoppedBecause = 'empty page — end of list'; break; }

      const rows = users.map((u: any) => {
        const a = u?.attributes ?? {};
        return {
          mt_id: String(u?.id ?? ''),
          email: (String(a.email ?? '').toLowerCase()) || null,
          first_name: a.first_name ?? null,
          last_name: a.last_name ?? null,
          phone: a.phone_number ?? null,
          created_at_mt: a.date_joined ?? null,
          synced_at: new Date().toISOString(),
        };
      }).filter((r) => r.mt_id);

      if (rows.length) {
        // Write THIS page before fetching the next one. The whole point: if the
        // next call blows the sub-request budget, these rows are already safe.
        const { error } = await sb.from('mariana_tek_clients').upsert(rows, { onConflict: 'mt_id' });
        if (error) { stoppedBecause = `upsert failed on page ${page}: ${error.message}`; break; }
        upserted += rows.length;
      }

      if (totalPages && page >= totalPages) { page++; stoppedBecause = 'reached last page'; break; }
    }
  } catch (e) {
    // Never 500. Whatever we wrote stays written and the cursor still advances.
    stoppedBecause = `exception: ${(e as Error).message}`;
  }

  // Wrap around when we run off the end so the roster keeps refreshing.
  const nextPage = (totalPages && page > totalPages) ? 1 : page;
  try {
    await sb.from('sync_cursor').upsert({
      key: CURSOR_KEY,
      value: { next_page: nextPage, total_pages: totalPages, last_run: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch { /* cursor is an optimisation, not a correctness requirement */ }

  return json({
    ok: true,
    start_page: startPage,
    pages_fetched: pagesDone,
    total_pages: totalPages,
    upserted,
    next_page: nextPage,
    wrapped: nextPage === 1 && startPage !== 1,
    stopped_because: stoppedBecause,
  });
});
