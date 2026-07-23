// Supabase Edge Function: meta-breakdowns-sync
//
// Pulls audience-delivery breakdowns from the Meta Marketing API for every
// studio in meta_accounts and writes them to meta_breakdowns_daily.
//
// Three breakdowns per studio per day, in three API calls each:
//   1. region              — where (state-level) Meta served the ad
//   2. age + gender        — demographic mix of who saw the ad
//   3. publisher_platform  — FB vs IG vs Messenger
//      + impression_device — mobile vs desktop
//
// Why a separate function: meta-insights-sync is already complex. Breakdowns
// have different row shape + fail modes (some accounts can't break down by
// every dimension) so isolating keeps both functions readable.
//
// POST body (optional):
//   { studio_slug?: string,    // run for one studio (default: all ACTIVE)
//     window?: 'last_7' | 'last_14' | 'last_30',  // default last_14
//     dry_run?: boolean }
//
// Auth: x-bbb-secret header OR service-role bearer (called by cron).

// deno-lint-ignore-file
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-bbb-secret, Authorization',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

type ActionRow = { action_type: string; value: string };
type BreakdownRow = {
  date_start: string;
  date_stop: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: ActionRow[];
  // Possible breakdown columns Meta adds depending on the request:
  region?: string;
  age?: string;
  gender?: string;
  publisher_platform?: string;
  impression_device?: string;
  platform_position?: string;
};

const WINDOW_DAYS: Record<string, number> = {
  last_7: 7,
  last_14: 14,
  last_30: 30,
};

const FIELDS = 'date_start,date_stop,spend,impressions,clicks,actions';

function sumActions(actions: ActionRow[] | undefined, types: string[]): number {
  if (!actions) return 0;
  return actions
    .filter((a) => types.includes(a.action_type))
    .reduce((s, a) => s + Number(a.value || 0), 0);
}

async function fetchBreakdown(
  baseUrl: string,
  adAccountId: string,
  accessToken: string,
  windowDays: number,
  breakdowns: string,
): Promise<{ rows: BreakdownRow[]; status: number; raw?: unknown }> {
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - windowDays);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const timeRange = JSON.stringify({ since: fmt(start), until: fmt(today) });

  const params =
    `fields=${FIELDS}` +
    `&breakdowns=${encodeURIComponent(breakdowns)}` +
    `&time_increment=1` +
    `&time_range=${encodeURIComponent(timeRange)}` +
    `&level=account` +
    `&limit=500`;
  const url = `${baseUrl}/${adAccountId}/insights?${params}`;

  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await r.json();
  if (!r.ok) {
    return { rows: [], status: r.status, raw: body };
  }
  return { rows: (body?.data ?? []) as BreakdownRow[], status: r.status };
}

function rowToUpsert(
  studioSlug: string,
  row: BreakdownRow,
  breakdownType: 'region' | 'age_gender' | 'placement',
) {
  let value = '';
  if (breakdownType === 'region') {
    value = row.region || 'Unknown';
  } else if (breakdownType === 'age_gender') {
    value = `${row.age || 'unknown'}|${row.gender || 'unknown'}`;
  } else if (breakdownType === 'placement') {
    value = `${row.publisher_platform || 'unknown'}|${row.platform_position || 'unknown'}|${row.impression_device || 'unknown'}`;
  }

  const spendCents = Math.round(Number(row.spend || 0) * 100);
  const impressions = Number(row.impressions || 0);
  const clicks = Number(row.clicks || 0);
  const leads = sumActions(row.actions, ['lead', 'offsite_conversion.fb_pixel_lead']);
  const purchases = sumActions(row.actions, [
    'purchase',
    'offsite_conversion.fb_pixel_purchase',
    'omni_purchase',
  ]);

  return {
    studio_slug: studioSlug,
    date_start: row.date_start,
    breakdown_type: breakdownType,
    breakdown_value: value,
    spend_cents: spendCents,
    impressions,
    clicks,
    leads,
    purchases,
    raw: row,
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  // Auth: x-bbb-secret OR a service-role bearer (cron uses this pattern)
  const secret = req.headers.get('x-bbb-secret') || req.headers.get('X-Bbb-Secret');
  const auth = req.headers.get('authorization') || '';
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (secret !== ADMIN_SECRET && !auth.includes(serviceRole.slice(-20))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const window = body.window || 'last_14';
  const windowDays = WINDOW_DAYS[window] ?? 14;
  const dryRun = body.dry_run === true;

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // Match the meta-insights-sync pattern — no default status filter. If the
  // caller wants a single studio, they pass studio_slug; otherwise we pull
  // every row in meta_accounts.
  let q = sb
    .from('meta_accounts')
    .select('studio_slug, ad_account_id, access_token, api_version, status');
  if (body.studio_slug) q = q.eq('studio_slug', body.studio_slug);
  const { data: accounts, error: aErr } = await q;
  if (aErr) return json({ ok: false, error: aErr.message }, 500);
  if (!accounts || accounts.length === 0) {
    return json({ ok: false, error: 'no meta_accounts rows found' }, 404);
  }

  // Three breakdowns we want for each studio
  const BREAKDOWN_PLAN: Array<{ key: 'region' | 'age_gender' | 'placement'; meta: string }> = [
    { key: 'region', meta: 'region' },
    { key: 'age_gender', meta: 'age,gender' },
    { key: 'placement', meta: 'publisher_platform,platform_position,impression_device' },
  ];

  const studiosResult: any[] = [];
  let totalUpserts = 0;

  for (const acct of accounts) {
    const v = acct.api_version || 'v19.0';
    const baseUrl = `https://graph.facebook.com/${v}`;
    const perBreakdown: any[] = [];

    for (const plan of BREAKDOWN_PLAN) {
      try {
        const { rows, status, raw } = await fetchBreakdown(
          baseUrl,
          acct.ad_account_id,
          acct.access_token,
          windowDays,
          plan.meta,
        );
        if (status >= 400) {
          perBreakdown.push({
            type: plan.key,
            ok: false,
            status,
            error: JSON.stringify((raw as any)?.error ?? raw).slice(0, 300),
          });
          continue;
        }

        const upserts = rows.map((r) => rowToUpsert(acct.studio_slug, r, plan.key));
        let upserted = 0;
        if (!dryRun && upserts.length > 0) {
          const { error: uErr } = await sb
            .from('meta_breakdowns_daily')
            .upsert(upserts, {
              onConflict: 'studio_slug,date_start,breakdown_type,breakdown_value',
            });
          if (uErr) {
            perBreakdown.push({ type: plan.key, ok: false, error: uErr.message, rows: rows.length });
            continue;
          }
          upserted = upserts.length;
          totalUpserts += upserted;
        }
        perBreakdown.push({
          type: plan.key,
          ok: true,
          rows_fetched: rows.length,
          rows_upserted: upserted,
          sample: rows[0]
            ? {
                date: rows[0].date_start,
                region: rows[0].region,
                age: rows[0].age,
                gender: rows[0].gender,
                platform: rows[0].publisher_platform,
                impressions: rows[0].impressions,
              }
            : null,
        });
      } catch (e: unknown) {
        perBreakdown.push({
          type: plan.key,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    studiosResult.push({
      studio: acct.studio_slug,
      ad_account: acct.ad_account_id,
      window_days: windowDays,
      breakdowns: perBreakdown,
    });
  }

  return json({
    ok: true,
    dry_run: dryRun,
    window_days: windowDays,
    total_upserts: totalUpserts,
    studios: studiosResult,
  });
});
