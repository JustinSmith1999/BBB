/**
 * meta-ad-snapshot — admin-only one-shot pull of Meta ad state + insights
 * for all 4 BBB studios. Designed for "show me everything" requests.
 *
 * Auth: shared header `x-bbb-secret: bbb-test-2026-05-27` (no JWT verify).
 * Deploy with `--no-verify-jwt`.
 *
 * Query params:
 *   days=14            lookback window for insights (default 14)
 *
 * For each studio returns:
 *   - account_status (1=ACTIVE, 2=DISABLED, 3=UNSETTLED, 7=PENDING, 9=BANNED, etc.)
 *   - 14d totals: spend, impressions, clicks, leads (Meta-tracked), purchases,
 *     cost per lead, cost per purchase
 *   - per-campaign tree: campaign → adsets → ads, each with status +
 *     effective_status + 14d insights
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bbb-Secret, X-Client-Info, Apikey",
};

const ADMIN_SECRET = "bbb-test-2026-05-27";

const STUDIOS: { slug: string; name: string; adAccount: string; tokenEnv: string }[] = [
  { slug: "williamsburg",  name: "Williamsburg",  adAccount: "act_26739874695621849", tokenEnv: "META_TOKEN_WILLIAMSBURG" },
  { slug: "astoria",       name: "Astoria",       adAccount: "act_1367835402069398",  tokenEnv: "META_TOKEN_ASTORIA" },
  { slug: "bayside",       name: "Bayside",       adAccount: "act_4298533693762953",  tokenEnv: "META_TOKEN_BAYSIDE" },
  { slug: "fresh-meadows", name: "Fresh Meadows", adAccount: "act_1301162772160251",  tokenEnv: "META_TOKEN_FRESH_MEADOWS" },
];

const FB_VERSION = "v19.0";

async function fbGet(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`https://graph.facebook.com/${FB_VERSION}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  const body = await r.json();
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

// Sum action values where action_type matches one of `types`. Meta returns
// `actions` array per ad with { action_type, value }.
function sumActions(actions: any[] | undefined, types: string[]): number {
  if (!actions) return 0;
  let sum = 0;
  for (const a of actions) {
    if (types.includes(a.action_type)) sum += Number(a.value) || 0;
  }
  return sum;
}

function pickInsights(insightsRow: any) {
  if (!insightsRow) return null;
  const spend = Number(insightsRow.spend) || 0;
  const impressions = Number(insightsRow.impressions) || 0;
  const clicks = Number(insightsRow.clicks) || 0;
  const actions = insightsRow.actions || [];
  const leads = sumActions(actions, ["lead", "offsite_conversion.fb_pixel_lead"]);
  const purchases = sumActions(actions, ["purchase", "offsite_conversion.fb_pixel_purchase"]);
  const initiates = sumActions(actions, ["initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"]);
  return {
    spend: +spend.toFixed(2),
    impressions, clicks,
    ctr: impressions > 0 ? +(clicks / impressions * 100).toFixed(2) : 0,
    leads, purchases, initiates,
    cost_per_lead: leads > 0 ? +(spend / leads).toFixed(2) : null,
    cost_per_purchase: purchases > 0 ? +(spend / purchases).toFixed(2) : null,
  };
}

async function snapshotStudio(s: typeof STUDIOS[0], days: number) {
  const token = Deno.env.get(s.tokenEnv);
  if (!token) return { studio: s.slug, error: `missing env var ${s.tokenEnv}` };

  const datePreset = days <= 7 ? "last_7d" : days <= 14 ? "last_14d" : days <= 30 ? "last_30d" : "last_90d";

  try {
    // Account status
    const acct = await fbGet(s.adAccount, token, { fields: "name,account_status,disable_reason,balance,amount_spent" });

    // Account-level rollup (totals across everything in window)
    const acctInsightsRes = await fbGet(`${s.adAccount}/insights`, token, {
      fields: "spend,impressions,clicks,actions",
      date_preset: datePreset,
    });
    const acctTotals = pickInsights((acctInsightsRes.data || [])[0]);

    // Full campaign tree with per-ad insights in one shot. Filter to non-archived
    // so we don't pull years of dead campaigns.
    const camp = await fbGet(`${s.adAccount}/campaigns`, token, {
      fields: [
        "id,name,status,effective_status,objective,daily_budget,lifetime_budget",
        `insights.date_preset(${datePreset}){spend,impressions,clicks,actions}`,
        // Adsets nested under each campaign
        "adsets{id,name,status,effective_status,daily_budget,lifetime_budget,targeting{geo_locations,age_min,age_max,publisher_platforms,facebook_positions,instagram_positions,audience_network_positions,messenger_positions,flexible_spec,interests}," +
        `insights.date_preset(${datePreset}){spend,impressions,clicks,actions},` +
        // Ads nested under each adset. Pull object_story_spec to learn which
        // Facebook Page owns the ad — that's what shows at the top of every ad
        // in feed (the page name + avatar). Mismatched page name → confused
        // customer → bounce.
        "ads{id,name,status,effective_status,creative{id,name,thumbnail_url,object_story_spec{page_id,instagram_actor_id},effective_object_story_id}," +
        `insights.date_preset(${datePreset}){spend,impressions,clicks,actions}}}`,
      ].join(","),
      filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE","PAUSED","CAMPAIGN_PAUSED","ADSET_PAUSED","WITH_ISSUES","PENDING_REVIEW","DISAPPROVED","PENDING_BILLING_INFO","IN_PROCESS"] }]),
      limit: "100",
    });

    // Restructure for clean output
    const campaigns = (camp.data || []).map((c: any) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      effective_status: c.effective_status,
      objective: c.objective,
      daily_budget_usd: c.daily_budget ? +(c.daily_budget / 100).toFixed(2) : null,
      insights: pickInsights((c.insights?.data || [])[0]),
      adsets: (c.adsets?.data || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        effective_status: a.effective_status,
        daily_budget_usd: a.daily_budget ? +(a.daily_budget / 100).toFixed(2) : null,
        placements: a.targeting?.publisher_platforms ?? null,
        audience_network_on: (a.targeting?.publisher_platforms || []).includes("audience_network"),
        facebook_positions: a.targeting?.facebook_positions ?? null,
        instagram_positions: a.targeting?.instagram_positions ?? null,
        audience_network_positions: a.targeting?.audience_network_positions ?? null,
        age_range: a.targeting ? `${a.targeting.age_min ?? "?"}-${a.targeting.age_max ?? "?"}` : null,
        geo: a.targeting?.geo_locations ?? null,
        interest_groups: a.targeting?.flexible_spec ?? null,
        insights: pickInsights((a.insights?.data || [])[0]),
        ads: (a.ads?.data || []).map((ad: any) => ({
          id: ad.id,
          name: ad.name,
          status: ad.status,
          effective_status: ad.effective_status,
          creative_name: ad.creative?.name,
          // Page that owns the ad (what shows at the top of the ad in feed).
          // Resolved to a name after we gather all unique page_ids below.
          page_id: ad.creative?.object_story_spec?.page_id ?? null,
          instagram_actor_id: ad.creative?.object_story_spec?.instagram_actor_id ?? null,
          insights: pickInsights((ad.insights?.data || [])[0]),
        })),
      })),
    }));

    // Count active vs paused
    let activeAds = 0, pausedAds = 0, issueAds = 0;
    for (const c of campaigns) for (const a of c.adsets || []) for (const ad of a.ads || []) {
      const es = ad.effective_status;
      if (es === "ACTIVE") activeAds++;
      else if (es?.includes("PAUSED")) pausedAds++;
      else issueAds++;
    }

    // ── Resolve page_id → page_name for every ad in this studio ──────────────
    // The Page name + avatar are what customers see at the top of the ad in feed.
    // If Bayside ads are running from a "Better Body HQ" page, that's a brand
    // mismatch the customer can't reconcile on the landing page. Gather unique
    // page_ids and look them up once each.
    const uniquePageIds = new Set<string>();
    for (const c of campaigns) for (const a of c.adsets || []) for (const ad of a.ads || []) {
      if (ad.page_id) uniquePageIds.add(String(ad.page_id));
    }
    const pageById: Record<string, { name: string; verification_status?: string; link?: string }> = {};
    for (const pid of uniquePageIds) {
      try {
        const p = await fbGet(pid, token, { fields: "name,verification_status,link,username" });
        pageById[pid] = {
          name: p.name ?? "(unknown)",
          verification_status: p.verification_status,
          link: p.link,
        };
      } catch (_) {
        pageById[pid] = { name: "(lookup failed)" };
      }
    }
    // Inject page_name into every ad
    for (const c of campaigns) for (const a of c.adsets || []) for (const ad of a.ads || []) {
      ad.page_name = ad.page_id ? (pageById[ad.page_id]?.name ?? null) : null;
    }
    // Studio-level summary: which Page(s) are running ads here?
    const pagesUsed = Object.entries(pageById).map(([id, p]) => ({ page_id: id, ...p }));

    return {
      studio: s.slug,
      name: s.name,
      ad_account: s.adAccount,
      account_status: acct.account_status,
      account_disable_reason: acct.disable_reason,
      balance: acct.balance,
      window_days: days,
      totals_window: acctTotals,
      ads_active: activeAds,
      ads_paused: pausedAds,
      ads_with_issues: issueAds,
      pages_used: pagesUsed,
      campaigns,
    };
  } catch (err) {
    return { studio: s.slug, error: err instanceof Error ? err.message : String(err) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const secret = req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret");
  if (secret !== ADMIN_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "bad secret" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || "14")));

  const results = await Promise.all(STUDIOS.map(s => snapshotStudio(s, days)));

  return new Response(JSON.stringify({ ok: true, window_days: days, studios: results }, null, 2), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
