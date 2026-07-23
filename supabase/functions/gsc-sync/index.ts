// Supabase Edge Function: gsc-sync
//
// Pulls Search Analytics data from Google Search Console for the property
// https://betterbodybootcamp.com and writes it into gsc_search_performance.
// Runs daily via pg_cron (or manual POST).
//
// AUTH: OAuth 2.0 refresh-token flow. We use OAuth instead of a service
// account JSON because the betterbodybootcamp.com Workspace has the
// `iam.disableServiceAccountKeyCreation` org policy enforced (Google's
// "Secure by Default" rollout). The refresh token is generated once via
// the OAuth Playground using a GCP OAuth client — see README.
//
// REQUIRED SUPABASE SECRETS:
//   GSC_CLIENT_ID       — OAuth 2.0 client ID from GCP (ends in .apps.googleusercontent.com)
//   GSC_CLIENT_SECRET   — OAuth 2.0 client secret from GCP
//   GSC_REFRESH_TOKEN   — Refresh token from the OAuth Playground exchange
//   SUPABASE_URL        — set automatically
//   SUPABASE_SERVICE_ROLE_KEY — set automatically
//
// DEPLOY:
//   supabase functions deploy gsc-sync --no-verify-jwt
//
// POST body (optional):
//   { days?: number,     // how many days back to fetch (default 28)
//     dry_run?: boolean } // log results, don't write
//
// API doc:
//   https://developers.google.com/webmaster-tools/v1/searchanalytics/query

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

// GSC supports two property formats. We try sc-domain first, then URL-prefix.
const SITE_URL_DOMAIN = 'sc-domain:betterbodybootcamp.com';
const SITE_URL_PREFIX = 'https://betterbodybootcamp.com/';

// ─────────────────────────────────────────────────────────────────────────────
// OAuth: trade the long-lived refresh token for a short-lived access token.
// Tokens are ~1 hour TTL; we mint a fresh one each invocation, no caching.
// ─────────────────────────────────────────────────────────────────────────────
async function getAccessToken(): Promise<string> {
  const clientId     = Deno.env.get('GSC_CLIENT_ID')     ?? '';
  const clientSecret = Deno.env.get('GSC_CLIENT_SECRET') ?? '';
  const refreshToken = Deno.env.get('GSC_REFRESH_TOKEN') ?? '';
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing one of GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN Supabase secrets',
    );
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { access_token?: string; error_description?: string };
  if (!body.access_token) {
    throw new Error(`Token refresh returned no access_token: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch Search Analytics rows from GSC.
// ─────────────────────────────────────────────────────────────────────────────
type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

async function fetchAnalytics(
  token: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
): Promise<GscRow[]> {
  const allRows: GscRow[] = [];
  let startRow = 0;
  const rowLimit = 25000;

  while (true) {
    const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ['date', 'query', 'page'],
        rowLimit,
        startRow,
        dataState: 'final',
      }),
    });
    if (!res.ok) {
      throw new Error(`GSC query failed for ${siteUrl}: ${res.status} ${await res.text()}`);
    }
    const body = await res.json() as { rows?: GscRow[] };
    const rows = body.rows ?? [];
    allRows.push(...rows);
    if (rows.length < rowLimit) break;
    startRow += rowLimit;
    if (startRow > 100000) break; // safety
  }
  return allRows;
}

// Bucket each GSC page URL into a studio slug. Anything that doesn't match
// a per-studio URL pattern rolls up under '_all'.
function pageToStudio(page: string): string {
  const p = page.toLowerCase();
  if (/\/(locations|trial|schedule)\/astoria/.test(p))        return 'astoria';
  if (/\/(locations|trial|schedule)\/bayside/.test(p))        return 'bayside';
  if (/\/(locations|trial|schedule)\/fresh-meadows/.test(p))  return 'fresh-meadows';
  if (/\/(locations|trial|schedule)\/williamsburg/.test(p))   return 'williamsburg';
  return '_all';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let body: { days?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const days = Math.max(1, Math.min(90, body.days ?? 28));
  const dryRun = !!body.dry_run;

  // GSC has a ~2-day data delay, so end date is yesterday.
  const end = new Date(Date.now() - 24 * 3600 * 1000);
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const startDate = fmt(start);
  const endDate = fmt(end);

  try {
    const token = await getAccessToken();

    // Try sc-domain first; fall back to URL-prefix on 403/404.
    let rows: GscRow[] = [];
    let propertyUsed = SITE_URL_DOMAIN;
    try {
      rows = await fetchAnalytics(token, SITE_URL_DOMAIN, startDate, endDate);
    } catch (e) {
      const msg = String(e);
      if (msg.includes('403') || msg.includes('404')) {
        propertyUsed = SITE_URL_PREFIX;
        rows = await fetchAnalytics(token, SITE_URL_PREFIX, startDate, endDate);
      } else {
        throw e;
      }
    }

    if (dryRun) {
      return json({
        ok: true,
        dry_run: true,
        property: propertyUsed,
        date_range: { startDate, endDate },
        row_count: rows.length,
        sample: rows.slice(0, 5),
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const dbRows = rows.map((r) => {
      const [date, query, page] = r.keys;
      return {
        date,
        studio_slug: pageToStudio(page),
        query,
        page,
        impressions: Math.round(r.impressions ?? 0),
        clicks: Math.round(r.clicks ?? 0),
        ctr: Number((r.ctr ?? 0).toFixed(4)),
        position: Number((r.position ?? 0).toFixed(2)),
      };
    });

    // Chunked upserts — Supabase REST defaults to ~1MB payloads.
    const CHUNK = 500;
    let written = 0;
    for (let i = 0; i < dbRows.length; i += CHUNK) {
      const chunk = dbRows.slice(i, i + CHUNK);
      const { error } = await supabase
        .from('gsc_search_performance')
        .upsert(chunk, { onConflict: 'date,studio_slug,query,page', ignoreDuplicates: false });
      if (error) throw new Error(`upsert chunk ${i}: ${error.message}`);
      written += chunk.length;
    }

    return json({
      ok: true,
      property: propertyUsed,
      date_range: { startDate, endDate },
      rows_fetched: rows.length,
      rows_written: written,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
