// Supabase Edge Function: meta-insights-sync
//
// Pulls daily ad insights from Meta Marketing API for every studio in
// `meta_accounts` and upserts them into `meta_insights_daily`. Designed to run
// every 6 hours via pg_cron.
//
// POST body (optional):
//   { studio_slug?: string,   // run for one studio (default: all ACTIVE)
//     window?: 'today' | 'last_7' | 'last_30',  // default last_7
//     dry_run?: boolean }     // log results, don't write
//
// Action types we count in Meta's response:
//   - "lead"                         → Lead events (form submit pre-Stripe)
//   - "offsite_conversion.fb_pixel_lead"
//   - "purchase" / "offsite_conversion.fb_pixel_purchase"
//   - "initiate_checkout" / "offsite_conversion.fb_pixel_initiate_checkout"

// deno-lint-ignore-file
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

type StudioRow = {
  studio_slug: string;
  ad_account_id: string;
  access_token: string;
  api_version: string;
  status: string;
};

type ActionRow = { action_type: string; value: string };
type InsightRow = {
  date_start: string;
  date_stop: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  unique_clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  actions?: ActionRow[];
  action_values?: ActionRow[];
};

function sumActions(actions: ActionRow[] | undefined, types: string[]): number {
  if (!actions) return 0;
  return actions
    .filter((a) => types.includes(a.action_type))
    .reduce((s, a) => s + Number(a.value || 0), 0);
}

const FIELDS = [
  'date_start', 'date_stop', 'spend', 'impressions', 'reach', 'clicks',
  'inline_link_clicks', 'unique_clicks', 'ctr', 'cpc', 'cpm', 'frequency',
  'actions', 'action_values',
].join(',');

async function fetchInsightsAttempt(
  baseUrl: string,
  adAccountId: string,
  accessToken: string,
  queryString: string
): Promise<{ rows: InsightRow[]; raw: unknown; status: number }> {
  const url = `${baseUrl}/${adAccountId}/insights?${queryString}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await r.json();
  if (!r.ok) {
    return { rows: [], raw: body, status: r.status };
  }
  return { rows: (body?.data ?? []) as InsightRow[], raw: body, status: r.status };
}

async function fetchInsights(
  baseUrl: string,
  adAccountId: string,
  accessToken: string,
  windowDays: number
): Promise<{ rows: InsightRow[]; attempts: Array<{ kind: string; rows: number; status: number; sample?: unknown }> }> {
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - windowDays);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const timeRange = JSON.stringify({ since: fmt(start), until: fmt(today) });

  const attempts: Array<{ kind: string; rows: number; status: number; sample?: unknown }> = [];

  // Attempt 1: explicit time_range, per-day
  let q = `fields=${FIELDS}&time_increment=1&time_range=${encodeURIComponent(timeRange)}&level=account`;
  let a = await fetchInsightsAttempt(baseUrl, adAccountId, accessToken, q);
  attempts.push({ kind: `time_range_${windowDays}d_per_day`, rows: a.rows.length, status: a.status });
  if (a.status >= 400) throw new Error(`Meta ${adAccountId}: HTTP ${a.status} ${JSON.stringify((a.raw as { error?: unknown })?.error ?? a.raw).slice(0, 400)}`);
  if (a.rows.length > 0) return { rows: a.rows, attempts };

  // Attempt 2: maximum date preset, per-day
  q = `fields=${FIELDS}&time_increment=1&date_preset=maximum&level=account`;
  a = await fetchInsightsAttempt(baseUrl, adAccountId, accessToken, q);
  attempts.push({ kind: 'maximum_per_day', rows: a.rows.length, status: a.status });
  if (a.rows.length > 0) return { rows: a.rows, attempts };

  // Attempt 3: today's aggregate
  q = `fields=${FIELDS}&date_preset=today&level=account`;
  a = await fetchInsightsAttempt(baseUrl, adAccountId, accessToken, q);
  attempts.push({ kind: 'today_aggregate', rows: a.rows.length, status: a.status, sample: a.raw });
  if (a.rows.length > 0) return { rows: a.rows, attempts };

  return { rows: [], attempts };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const body: { studio_slug?: string; window?: string; dry_run?: boolean } =
    req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  const windowDays =
    body.window === 'today' ? 1 :
    body.window === 'last_30' ? 30 : 7;
  const dryRun = !!body.dry_run;

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  let q = sb
    .from('meta_accounts')
    .select('studio_slug, ad_account_id, access_token, api_version, status');
  if (body.studio_slug) q = q.eq('studio_slug', body.studio_slug);
  else q = q.eq('status', 'ACTIVE');

  const { data: accounts, error: accErr } = await q;
  if (accErr) return json({ ok: false, error: accErr.message }, 500);
  if (!accounts || accounts.length === 0) {
    return json({ ok: true, note: 'no accounts to sync', studios: [] });
  }

  const summary: Record<string, unknown>[] = [];

  for (const acc of accounts as StudioRow[]) {
    const result: Record<string, unknown> = {
      studio: acc.studio_slug,
      ad_account: acc.ad_account_id,
      rows_synced: 0,
      window_days: windowDays,
    };

    try {
      const baseUrl = `https://graph.facebook.com/${acc.api_version || 'v19.0'}`;
      const { rows, attempts } = await fetchInsights(baseUrl, acc.ad_account_id, acc.access_token, windowDays);
      result.rows_returned = rows.length;
      result.fetch_attempts = attempts;

      const upserts = rows.map((row) => {
        const spendCents = Math.round(Number(row.spend ?? 0) * 100);
        const impressions = Number(row.impressions ?? 0);
        const reach = Number(row.reach ?? 0);
        const clicks = Number(row.clicks ?? 0);
        const inline = Number(row.inline_link_clicks ?? 0);
        const uniqueClicks = Number(row.unique_clicks ?? 0);
        const ctr = Number(row.ctr ?? 0);
        const cpcCents = Math.round(Number(row.cpc ?? 0) * 100);
        const cpmCents = Math.round(Number(row.cpm ?? 0) * 100);
        const frequency = Number(row.frequency ?? 0);

        const leads = sumActions(row.actions, [
          'lead',
          'offsite_conversion.fb_pixel_lead',
        ]);
        const purchases = sumActions(row.actions, [
          'purchase',
          'offsite_conversion.fb_pixel_purchase',
        ]);
        const purchaseValueCents = Math.round(
          sumActions(row.action_values, [
            'purchase',
            'offsite_conversion.fb_pixel_purchase',
          ]) * 100
        );
        const cplCents = leads > 0 ? Math.round(spendCents / leads) : 0;
        const cppCents = purchases > 0 ? Math.round(spendCents / purchases) : 0;
        const roas = spendCents > 0 ? purchaseValueCents / spendCents : 0;

        return {
          studio_slug: acc.studio_slug,
          date_start: row.date_start,
          spend_cents: spendCents,
          impressions,
          reach,
          clicks,
          inline_link_clicks: inline,
          unique_clicks: uniqueClicks,
          ctr,
          cpc_cents: cpcCents,
          cpm_cents: cpmCents,
          frequency,
          leads,
          purchases,
          purchase_value_cents: purchaseValueCents,
          cost_per_lead_cents: cplCents,
          cost_per_purchase_cents: cppCents,
          roas,
          raw: row as unknown as Record<string, unknown>,
          synced_at: new Date().toISOString(),
        };
      });

      if (!dryRun && upserts.length > 0) {
        const { error: upErr } = await sb
          .from('meta_insights_daily')
          .upsert(upserts, { onConflict: 'studio_slug,date_start' });
        if (upErr) throw new Error(`upsert: ${upErr.message}`);
        result.rows_synced = upserts.length;
      } else if (dryRun) {
        result.dry_run_sample = upserts.slice(0, 2);
      }
      result.ok = true;
    } catch (e: unknown) {
      result.ok = false;
      result.error = String((e as Error).message ?? e);
    }

    summary.push(result);
  }

  return json({
    ok: true,
    window_days: windowDays,
    studios_processed: summary.length,
    studios: summary,
  });
});
