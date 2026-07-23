// Supabase Edge Function: meta-insights-sync
//
// Pulls ad insights from the Meta Marketing API for every studio in
// `meta_accounts` and writes THREE things:
//   1. account-level daily totals  -> meta_insights_daily      (original)
//   2. per-ad daily metrics        -> meta_ad_insights_daily    (new)
//   3. per-ad creative + identity  -> meta_ads                  (new)
// Designed to run every 6 hours via pg_cron.
//
// POST body (optional):
//   { studio_slug?: string,   // run for one studio (default: all ACTIVE)
//     window?: 'today' | 'last_7' | 'last_30',  // default last_7
//     dry_run?: boolean }     // log results, don't write
//
// Action types we count in Meta's response:
//   - "omni_lead"    (preferred — matches Ads Manager default "Leads" column)
//     with fallback to "lead" / "offsite_conversion.fb_pixel_lead" /
//     "onsite_conversion.lead_grouped" for older ads.
//   - "omni_purchase" (preferred — matches Ads Manager default "Purchases" column)
//     with fallback to "purchase" / "offsite_conversion.fb_pixel_purchase" /
//     "onsite_web_purchase" / "onsite_web_app_purchase" / "web_in_store_purchase".
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
  ad_id?: string;
  ad_name?: string;
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

// 2026-07-01: Meta reports the same conversion under multiple action_types
// depending on how it was captured (web pixel, CAPI, on-Facebook app, in-store).
// Ads Manager's default "Purchases" / "Leads" columns show the aggregated
// `omni_*` variants. Our previous sum-of-components approach missed everything
// reported under `omni_purchase` alone, causing 0 purchases in the DB while
// Ads Manager showed the true count.
//
// Fix: prefer `omni_*` when present (matches Ads Manager), fall back to the
// componentized list for older ads that don't report the omni aggregate.
// max() avoids both undercount AND double-count when both are populated
// (they should be equal totals — omni is the sum of components).
function sumActionsAggregate(
  actions: ActionRow[] | undefined,
  omniType: string,
  componentTypes: string[]
): number {
  if (!actions) return 0;
  let omni = 0;
  let components = 0;
  for (const a of actions) {
    const v = Number(a.value || 0);
    if (a.action_type === omniType) omni += v;
    else if (componentTypes.includes(a.action_type)) components += v;
  }
  return Math.max(omni, components);
}

// Componentized action_types that make up `omni_purchase` in Meta's reporting.
const PURCHASE_COMPONENTS = [
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_web_purchase',
  'onsite_web_app_purchase',
  'web_in_store_purchase',
];

// Componentized action_types that make up `omni_lead`.
const LEAD_COMPONENTS = [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
];

const FIELDS = [
  'date_start', 'date_stop', 'spend', 'impressions', 'reach', 'clicks',
  'inline_link_clicks', 'unique_clicks', 'ctr', 'cpc', 'cpm', 'frequency',
  'actions', 'action_values',
].join(',');

// Ad-level insight fields. Adds ad_id / ad_name so each row is one ad-day.
const AD_FIELDS = [
  'ad_id', 'ad_name', 'date_start', 'date_stop', 'spend', 'impressions',
  'reach', 'clicks', 'inline_link_clicks', 'ctr', 'cpm', 'frequency', 'actions',
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

  // Fix #11: propagate non-200 from ALL attempts so a token expiration
  // (401/403) surfaces as an actual error instead of "no data". Previously
  // only attempt 1 threw; attempts 2 + 3 swallowed errors silently.
  // Attempt 1: explicit time_range, per-day
  let q = `fields=${FIELDS}&time_increment=1&time_range=${encodeURIComponent(timeRange)}&level=account`;
  let a = await fetchInsightsAttempt(baseUrl, adAccountId, accessToken, q);
  attempts.push({ kind: `time_range_${windowDays}d_per_day`, rows: a.rows.length, status: a.status });
  if (a.status >= 400) throw new Error(`Meta ${adAccountId} attempt 1: HTTP ${a.status} ${JSON.stringify((a.raw as { error?: unknown })?.error ?? a.raw).slice(0, 400)}`);
  if (a.rows.length > 0) return { rows: a.rows, attempts };

  // Attempt 2: maximum date preset, per-day
  q = `fields=${FIELDS}&time_increment=1&date_preset=maximum&level=account`;
  a = await fetchInsightsAttempt(baseUrl, adAccountId, accessToken, q);
  attempts.push({ kind: 'maximum_per_day', rows: a.rows.length, status: a.status });
  if (a.status >= 400) throw new Error(`Meta ${adAccountId} attempt 2: HTTP ${a.status} ${JSON.stringify((a.raw as { error?: unknown })?.error ?? a.raw).slice(0, 400)}`);
  if (a.rows.length > 0) return { rows: a.rows, attempts };

  // Attempt 3: today's aggregate
  q = `fields=${FIELDS}&date_preset=today&level=account`;
  a = await fetchInsightsAttempt(baseUrl, adAccountId, accessToken, q);
  attempts.push({ kind: 'today_aggregate', rows: a.rows.length, status: a.status, sample: a.raw });
  if (a.status >= 400) throw new Error(`Meta ${adAccountId} attempt 3: HTTP ${a.status} ${JSON.stringify((a.raw as { error?: unknown })?.error ?? a.raw).slice(0, 400)}`);
  if (a.rows.length > 0) return { rows: a.rows, attempts };

  return { rows: [], attempts };
}

// ── AD-LEVEL: per-ad daily insights ─────────────────────────────────────────
// One row per ad per day (level=ad). Single attempt — if the token can read
// account insights it can read ad insights too; a 4xx is a real error.
async function fetchAdInsights(
  baseUrl: string,
  adAccountId: string,
  accessToken: string,
  windowDays: number
): Promise<InsightRow[]> {
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - windowDays);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const timeRange = JSON.stringify({ since: fmt(start), until: fmt(today) });
  const q = `fields=${AD_FIELDS}&time_increment=1&time_range=${encodeURIComponent(timeRange)}&level=ad`;
  const url = `${baseUrl}/${adAccountId}/insights?${q}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(`ad insights HTTP ${r.status} ${JSON.stringify((body as { error?: unknown })?.error ?? body).slice(0, 300)}`);
  }
  return (body?.data ?? []) as InsightRow[];
}

// ── AD-LEVEL: ad identity + creative content ────────────────────────────────
type AdObject = {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  adset?: { name?: string };
  campaign?: { name?: string };
  creative?: {
    id?: string;
    thumbnail_url?: string;
    image_url?: string;
    title?: string;
    body?: string;
    video_id?: string;
    // deno-lint-ignore no-explicit-any
    object_story_spec?: any;
  };
};

async function fetchAdCreatives(
  baseUrl: string,
  adAccountId: string,
  accessToken: string
): Promise<AdObject[]> {
  const fields =
    'id,name,status,effective_status,adset{name},campaign{name},' +
    'creative{id,thumbnail_url,image_url,title,body,video_id,object_story_spec}';
  const out: AdObject[] = [];
  let url: string | null =
    `${baseUrl}/${adAccountId}/ads?fields=${encodeURIComponent(fields)}&limit=200`;
  let pages = 0;
  while (url && pages < 10) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await r.json();
    if (!r.ok) {
      throw new Error(`ads HTTP ${r.status} ${JSON.stringify((body as { error?: unknown })?.error ?? body).slice(0, 300)}`);
    }
    out.push(...((body?.data ?? []) as AdObject[]));
    url = body?.paging?.next ?? null;
    pages++;
  }
  return out;
}

// Pull a clean headline / body / image out of whatever creative shape Meta
// returns (single image, link ad, video ad, dynamic creative all differ).
function extractCreative(ad: AdObject) {
  const c = ad.creative ?? {};
  const oss = c.object_story_spec ?? {};
  const link = oss.link_data ?? {};
  const video = oss.video_data ?? {};
  const tmpl = link.child_attachments?.[0] ?? {};
  const headline =
    c.title || link.name || video.title || tmpl.name || '';
  const bodyText =
    c.body || link.message || video.message || tmpl.description || '';
  const image =
    c.image_url || c.thumbnail_url || link.picture || video.image_url || tmpl.picture || '';
  const thumb =
    c.thumbnail_url || c.image_url || link.picture || video.image_url || tmpl.picture || '';
  const videoId = c.video_id || video.video_id || link.video_id || null;
  // Where the ad's click sends the visitor. If this is wrong (e.g. /locations
  // instead of /trial), clicks rack up but signups don't — the classic
  // misrouted-ad pattern.
  const destUrl =
    link.link ||
    link.call_to_action?.value?.link ||
    video.call_to_action?.value?.link ||
    tmpl.link ||
    null;
  return {
    creative_id: c.id ?? null,
    image_url: image ? String(image) : null,
    thumbnail_url: thumb ? String(thumb) : null,
    headline: headline ? String(headline).slice(0, 500) : null,
    body: bodyText ? String(bodyText).slice(0, 2000) : null,
    video_id: videoId ? String(videoId) : null,
    destination_url: destUrl ? String(destUrl) : null,
  };
}

// For a video ad, turn the creative's video_id into a playable MP4 URL.
// Meta's `source` URLs are CDN-signed and rotate, so we re-fetch it every
// sync (the function runs every 6h, well inside the URL's lifetime).
async function fetchVideoSource(
  baseUrl: string,
  videoId: string,
  accessToken: string
): Promise<string | null> {
  try {
    const r = await fetch(`${baseUrl}/${videoId}?fields=source`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const b = await r.json();
    return b?.source ? String(b.source) : null;
  } catch {
    return null;
  }
}

// Meta's ad-preview iframe — the reliable way to actually render an ad with
// its video playing inline (Meta no longer exposes raw video source URLs for
// ad videos). Returns the iframe's src URL; refreshed every sync.
async function fetchAdPreview(
  baseUrl: string,
  adId: string,
  accessToken: string
): Promise<string | null> {
  try {
    const r = await fetch(
      `${baseUrl}/${adId}/previews?ad_format=MOBILE_FEED_STANDARD`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!r.ok) return null;
    const b = await r.json();
    const body = b?.data?.[0]?.body as string | undefined;
    if (!body) return null;
    const m = body.match(/src="([^"]+)"/);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  } catch {
    return null;
  }
}

// Sync per-ad metrics + creatives for one studio. Isolated from the
// account-level sync so a creative hiccup never blocks the main dashboard data.
async function syncAdLevel(
  // deno-lint-ignore no-explicit-any
  sb: any,
  acc: StudioRow,
  baseUrl: string,
  windowDays: number,
  dryRun: boolean,
  result: Record<string, unknown>
): Promise<void> {
  // 1. per-ad daily metrics
  const adRows = await fetchAdInsights(baseUrl, acc.ad_account_id, acc.access_token, windowDays);
  const adInsightUpserts = adRows
    .filter((r) => r.ad_id)
    .map((r) => {
      const leads = sumActionsAggregate(r.actions, 'omni_lead', LEAD_COMPONENTS);
      const purchases = sumActionsAggregate(r.actions, 'omni_purchase', PURCHASE_COMPONENTS);
      return {
        ad_id: r.ad_id,
        studio_slug: acc.studio_slug,
        date_start: r.date_start,
        spend_cents: Math.round(Number(r.spend ?? 0) * 100),
        impressions: Number(r.impressions ?? 0),
        reach: Number(r.reach ?? 0),
        clicks: Number(r.clicks ?? 0),
        inline_link_clicks: Number(r.inline_link_clicks ?? 0),
        ctr: Number(r.ctr ?? 0),
        cpm_cents: Math.round(Number(r.cpm ?? 0) * 100),
        frequency: Number(r.frequency ?? 0),
        leads,
        purchases,
        synced_at: new Date().toISOString(),
      };
    });

  // 2. ad identity + creative content (+ a playable MP4 URL for video ads)
  const ads = await fetchAdCreatives(baseUrl, acc.ad_account_id, acc.access_token);
  const adUpserts: Record<string, unknown>[] = [];
  const adRosterMeta: Array<{ name: string | null; status: string | null; destination: string | null }> = [];
  for (const ad of ads) {
    const cr = extractCreative(ad);
    // Legacy MP4 source (kept as a fallback; Meta returns null for most ads).
    let videoUrl: string | null = null;
    if (cr.video_id) {
      videoUrl = await fetchVideoSource(baseUrl, cr.video_id, acc.access_token);
    }
    // Meta ad-preview iframe — renders the real ad, video plays inline.
    const previewUrl = await fetchAdPreview(baseUrl, ad.id, acc.access_token);
    adRosterMeta.push({
      name: ad.name ?? null,
      status: (ad.effective_status ?? ad.status) ?? null,
      destination: cr.destination_url,
    });
    adUpserts.push({
      ad_id: ad.id,
      studio_slug: acc.studio_slug,
      ad_name: ad.name ?? null,
      adset_name: ad.adset?.name ?? null,
      campaign_name: ad.campaign?.name ?? null,
      // effective_status is the TRUE delivery state (accounts for paused
      // ad sets / campaigns); fall back to the ad's own switch.
      status: ad.effective_status ?? ad.status ?? null,
      creative_id: cr.creative_id,
      image_url: cr.image_url,
      thumbnail_url: cr.thumbnail_url,
      headline: cr.headline,
      body: cr.body,
      media_type: cr.video_id ? 'video' : 'image',
      video_url: videoUrl,
      preview_url: previewUrl,
      updated_at: new Date().toISOString(),
    });
  }

  result.ad_rows_returned = adRows.length;
  result.ads_returned = ads.length;

  // Status breakdown — answers "how many ads are ACTIVE" straight from Meta.
  const byStatus: Record<string, number> = {};
  for (const a of adUpserts) {
    const st = String(a.status || 'UNKNOWN');
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  result.ads_by_status = byStatus;

  if (dryRun) {
    result.ad_roster = adRosterMeta;
    result.dry_run_ad_sample = adUpserts.slice(0, 2);
    result.dry_run_ad_insight_sample = adInsightUpserts.slice(0, 2);
    return;
  }

  if (adUpserts.length > 0) {
    const { error } = await sb.from('meta_ads').upsert(adUpserts, { onConflict: 'ad_id' });
    if (error) throw new Error(`meta_ads upsert: ${error.message}`);
    result.ads_synced = adUpserts.length;
  }
  if (adInsightUpserts.length > 0) {
    const { error } = await sb
      .from('meta_ad_insights_daily')
      .upsert(adInsightUpserts, { onConflict: 'ad_id,date_start' });
    if (error) throw new Error(`meta_ad_insights_daily upsert: ${error.message}`);
    result.ad_rows_synced = adInsightUpserts.length;
  }
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

        const leads = sumActionsAggregate(row.actions, 'omni_lead', LEAD_COMPONENTS);
        const purchases = sumActionsAggregate(row.actions, 'omni_purchase', PURCHASE_COMPONENTS);
        const purchaseValueCents = Math.round(
          sumActionsAggregate(row.action_values, 'omni_purchase', PURCHASE_COMPONENTS) * 100
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

      // ── per-ad metrics + creatives ─────────────────────────────────────
      // Own try/catch: a creative-fetch failure must never blank out the
      // account-level data the rest of the dashboard depends on.
      try {
        await syncAdLevel(sb, acc, baseUrl, windowDays, dryRun, result);
      } catch (adErr: unknown) {
        result.ad_sync_error = String((adErr as Error).message ?? adErr);
      }
    } catch (e: unknown) {
      result.ok = false;
      result.error = String((e as Error).message ?? e);
    }

    // Persist this run so silent ad_sync_error failures stop being silent.
    // Best-effort — never let logging itself break the sync response.
    if (!dryRun) {
      try {
        await sb.from('meta_sync_runs').insert({
          studio_slug: acc.studio_slug,
          ok: result.ok === true && !result.ad_sync_error,
          window_days: windowDays,
          account_rows: typeof result.rows_synced === 'number' ? result.rows_synced : null,
          ad_rows: typeof result.ad_rows_synced === 'number' ? result.ad_rows_synced : null,
          ads_returned: typeof result.ads_returned === 'number' ? result.ads_returned : null,
          error: result.error ?? null,
          ad_sync_error: result.ad_sync_error ?? null,
          raw: result as unknown as Record<string, unknown>,
        });
      } catch (logErr) {
        // Surface but don't throw — diagnostic logging must never block the sync.
        console.error('meta_sync_runs insert failed:', (logErr as Error).message);
      }
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
