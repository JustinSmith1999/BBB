// Supabase Edge Function: gbp-sync
//
// Pulls daily Google Business Profile performance metrics for each studio's
// GBP location and writes to gbp_daily. Mirrors the OAuth pattern from
// gsc-sync since both APIs share Google's OAuth 2.0 system — but they use
// DIFFERENT scopes, so they need DIFFERENT refresh tokens.
//
// AUTH: OAuth 2.0 refresh-token flow (same reasoning as gsc-sync — the
// betterbodybootcamp.com Workspace enforces iam.disableServiceAccountKeyCreation).
//
// REQUIRED SUPABASE SECRETS:
//   GBP_CLIENT_ID       — OAuth 2.0 client ID (CAN be the same as GSC_CLIENT_ID
//                         IF you request both scopes when generating the refresh)
//   GBP_CLIENT_SECRET   — OAuth 2.0 client secret (same caveat)
//   GBP_REFRESH_TOKEN   — Refresh token from OAuth Playground exchange with
//                         scope: https://www.googleapis.com/auth/business.manage
//
// REQUIRED DB STATE (set once per studio):
//   locations.gbp_account_id  — numeric account ID from GBP admin
//   locations.gbp_location_id — numeric location ID per studio
//
// DEPLOY:
//   supabase functions deploy gbp-sync --no-verify-jwt --project-ref uracuwugpxqjfgtuobal
//
// POST body (optional):
//   { days?: number,     // default 35 (covers a full month + last-month tail for MoM)
//     dry_run?: boolean,  // log results, don't write
//     studio_slug?: string } // only sync one studio
//
// API doc:
//   https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries

// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// The 9 daily metrics the API supports. We pull the ones meaningful for a
// fitness studio. BUSINESS_FOOD_* are restaurant-only and skipped.
const METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "CALL_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
  "WEBSITE_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_CONVERSATIONS",
] as const;

// Map API metric names → gbp_daily column names so the upsert payload is clean.
const METRIC_COL: Record<string, string> = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS:   "impressions_desktop_maps",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "impressions_desktop_search",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS:    "impressions_mobile_maps",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH:  "impressions_mobile_search",
  CALL_CLICKS:                         "call_clicks",
  BUSINESS_DIRECTION_REQUESTS:         "direction_requests",
  WEBSITE_CLICKS:                      "website_clicks",
  BUSINESS_BOOKINGS:                   "bookings",
  BUSINESS_CONVERSATIONS:              "conversations",
};

// ─────────────────────────────────────────────────────────────────────────────
// OAuth: exchange long-lived refresh token for a short-lived access token.
// Each location can have its own refresh token (different Google account per
// studio owner — Carlos vs Steve/Chris). Falls back to the env var
// GBP_REFRESH_TOKEN if a location's gbp_refresh_token is NULL.
// ─────────────────────────────────────────────────────────────────────────────
async function getAccessToken(refreshTokenOverride?: string | null): Promise<string> {
  const clientId     = Deno.env.get("GBP_CLIENT_ID")     ?? "";
  const clientSecret = Deno.env.get("GBP_CLIENT_SECRET") ?? "";
  const refreshToken = refreshTokenOverride && refreshTokenOverride.trim() !== ""
    ? refreshTokenOverride
    : (Deno.env.get("GBP_REFRESH_TOKEN") ?? "");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing one of GBP_CLIENT_ID / GBP_CLIENT_SECRET / refresh_token (env or per-location). Use OAuth Playground with scope https://www.googleapis.com/auth/business.manage",
    );
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`OAuth token exchange failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.access_token as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch metrics for one studio location across a date range.
// API endpoint:
//   GET /v1/locations/{locationId}:fetchMultiDailyMetricsTimeSeries
// Returns one TimeSeries per requested metric, each with daily values.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLocationMetrics(
  accessToken: string,
  accountId: string,
  locationId: string,
  startDate: string,
  endDate: string,
): Promise<Record<string, Record<string, number>>> {
  // Build query string: metrics list + date range (YYYY-MM-DD)
  const params = new URLSearchParams();
  for (const m of METRICS) params.append("dailyMetrics", m);
  params.append("dailyRange.start_date.year",  startDate.slice(0, 4));
  params.append("dailyRange.start_date.month", String(parseInt(startDate.slice(5, 7), 10)));
  params.append("dailyRange.start_date.day",   String(parseInt(startDate.slice(8, 10), 10)));
  params.append("dailyRange.end_date.year",    endDate.slice(0, 4));
  params.append("dailyRange.end_date.month",   String(parseInt(endDate.slice(5, 7), 10)));
  params.append("dailyRange.end_date.day",     String(parseInt(endDate.slice(8, 10), 10)));

  const url = `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await r.json();
  if (!r.ok) throw new Error(`GBP API HTTP ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);

  // Response shape:
  //   { multiDailyMetricTimeSeries: [
  //       { dailyMetricTimeSeries:
  //           { dailyMetric: "CALL_CLICKS",
  //             timeSeries: { datedValues: [{ date: {year,month,day}, value: "12" }, ...] }
  //           }
  //       },
  //       ... one entry per metric
  //   ] }
  const byMetricByDate: Record<string, Record<string, number>> = {};
  const series = body?.multiDailyMetricTimeSeries ?? [];
  for (const entry of series) {
    const dm = entry?.dailyMetricTimeSeries;
    if (!dm) continue;
    const metricName = dm.dailyMetric as string;
    const dated = dm.timeSeries?.datedValues ?? [];
    const perDate: Record<string, number> = {};
    for (const d of dated) {
      const y = d.date?.year;
      const m = String(d.date?.month ?? 0).padStart(2, "0");
      const day = String(d.date?.day ?? 0).padStart(2, "0");
      const iso = `${y}-${m}-${day}`;
      perDate[iso] = Number(d.value ?? 0);
    }
    byMetricByDate[metricName] = perDate;
  }
  return byMetricByDate;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const body = req.method === "POST"
    ? (await req.json().catch(() => ({}))) as { days?: number; dry_run?: boolean; studio_slug?: string }
    : {};
  const days = Math.max(1, Math.min(540, body.days ?? 35));  // 540 is API max
  const dryRun = !!body.dry_run;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Pull locations that have a GBP location ID set. The Business Profile
  // Performance API only needs the location ID (not account ID) — the legacy
  // GMB v4 API required both, but the new endpoint takes just /locations/{id}.
  // gbp_refresh_token is per-location (different Google account per studio
  // owner); NULL means fall back to the env-var GBP_REFRESH_TOKEN.
  let locQuery = sb.from("locations")
    .select("name, gbp_account_id, gbp_location_id, gbp_refresh_token, is_active")
    .eq("is_active", true)
    .not("gbp_location_id", "is", null);
  const { data: locations, error: locErr } = await locQuery;
  if (locErr) return json({ ok: false, error: `locations query: ${locErr.message}` }, 500);

  // Studios with missing IDs — surface so Justin knows what to fix.
  const { data: allLocations } = await sb.from("locations")
    .select("name, gbp_location_id, is_active")
    .eq("is_active", true);
  const missingSetup = (allLocations ?? [])
    .filter((l) => !l.gbp_location_id)
    .map((l) => l.name);

  if (!locations || locations.length === 0) {
    return json({
      ok: false,
      reason: "no locations have gbp_location_id set",
      missing_setup: missingSetup,
      next_action: "In Supabase Studio → locations → fill gbp_location_id per studio. Find IDs from business.google.com URL when viewing each location.",
    });
  }

  // Date window — last N days through yesterday (GBP rarely has same-day data).
  const today = new Date();
  const end   = new Date(today);
  end.setUTCDate(today.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (days - 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const startStr = fmt(start);
  const endStr   = fmt(end);

  const perStudio: Record<string, unknown>[] = [];

  // Cache access tokens by refresh token — re-using the access token across
  // studios that share a refresh token (same Google account) avoids
  // unnecessary OAuth round-trips.
  const accessTokenCache: Record<string, string> = {};
  async function tokenFor(refreshToken: string | null | undefined): Promise<string> {
    const key = refreshToken && refreshToken.trim() !== "" ? refreshToken : "__env__";
    if (accessTokenCache[key]) return accessTokenCache[key];
    const t = await getAccessToken(refreshToken);
    accessTokenCache[key] = t;
    return t;
  }

  for (const loc of locations) {
    const studioSlug = String(loc.name).toLowerCase().replace(/\s+/g, "-");
    if (body.studio_slug && studioSlug !== body.studio_slug) continue;
    const result: Record<string, unknown> = {
      studio_slug: studioSlug,
      gbp_location_id: loc.gbp_location_id,
      using_per_location_token: !!loc.gbp_refresh_token,
      start: startStr,
      end: endStr,
    };

    try {
      const accessToken = await tokenFor(loc.gbp_refresh_token as string | null);
      const metricsByDate = await fetchLocationMetrics(
        accessToken,
        String(loc.gbp_account_id),
        String(loc.gbp_location_id),
        startStr,
        endStr,
      );

      // Pivot: { date -> { col -> value } }
      const byDate: Record<string, Record<string, number>> = {};
      for (const [metric, perDate] of Object.entries(metricsByDate)) {
        const col = METRIC_COL[metric];
        if (!col) continue;
        for (const [iso, val] of Object.entries(perDate)) {
          if (!byDate[iso]) byDate[iso] = {};
          byDate[iso][col] = val;
        }
      }

      // Build upsert rows.
      const rows = Object.entries(byDate).map(([iso, cols]) => ({
        studio_slug: studioSlug,
        metric_date: iso,
        impressions_desktop_maps:   cols.impressions_desktop_maps ?? 0,
        impressions_desktop_search: cols.impressions_desktop_search ?? 0,
        impressions_mobile_maps:    cols.impressions_mobile_maps ?? 0,
        impressions_mobile_search:  cols.impressions_mobile_search ?? 0,
        call_clicks:                cols.call_clicks ?? 0,
        direction_requests:         cols.direction_requests ?? 0,
        website_clicks:             cols.website_clicks ?? 0,
        bookings:                   cols.bookings ?? 0,
        conversations:              cols.conversations ?? 0,
        synced_at: new Date().toISOString(),
      }));

      result.days_returned = rows.length;
      if (dryRun) {
        result.dry_run_sample = rows.slice(0, 3);
      } else if (rows.length > 0) {
        const { error: upErr } = await sb.from("gbp_daily").upsert(rows, {
          onConflict: "studio_slug,metric_date",
        });
        if (upErr) throw new Error(`upsert: ${upErr.message}`);
        result.rows_upserted = rows.length;
      }
      result.ok = true;
    } catch (e) {
      result.ok = false;
      result.error = (e as Error).message;
    }
    perStudio.push(result);
  }

  return json({
    ok: true,
    days,
    start: startStr,
    end: endStr,
    studios_processed: perStudio.length,
    missing_setup: missingSetup,
    per_studio: perStudio,
  });
});
