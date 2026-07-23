-- ─────────────────────────────────────────────────────────────────────────────
-- Google Business Profile analytics — schema, RPCs, MoM comparison.
--
-- WHAT THIS GIVES OWNERS:
--   "This month I had 1,247 people see my listing in Maps + Search,
--    63 of them called or got directions. Last month was 982 / 47.
--    +27% impressions, +34% calls. The work is paying off."
--
-- DATA SOURCE: Google Business Profile Performance API
--   businessprofileperformance.googleapis.com/v1/locations/{id}:fetchMultiDailyMetricsTimeSeries
--
-- METRICS CAPTURED (per studio per day):
--   BUSINESS_IMPRESSIONS_DESKTOP_MAPS    } combined = "total impressions"
--   BUSINESS_IMPRESSIONS_DESKTOP_SEARCH  }
--   BUSINESS_IMPRESSIONS_MOBILE_MAPS     }
--   BUSINESS_IMPRESSIONS_MOBILE_SEARCH   }
--   CALL_CLICKS                          } "how many called the studio"
--   BUSINESS_DIRECTION_REQUESTS          } "how many asked for directions"
--   WEBSITE_CLICKS                       } "how many clicked through to site"
--   BUSINESS_BOOKINGS                    } usually 0 — not wired through MindBody
--   BUSINESS_CONVERSATIONS               } GBP chat messages, usually 0
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add GBP location identifiers to locations table ───────────────────────
-- The Business Profile Performance API needs each location's full identifier:
--   accounts/{accountId}/locations/{locationId}
-- Justin fills these in once per studio via the GBP admin console.
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS gbp_account_id text,
  ADD COLUMN IF NOT EXISTS gbp_location_id text;

COMMENT ON COLUMN public.locations.gbp_account_id IS
  'Numeric Google Business Profile account ID. Find in https://business.google.com URL: accounts/123456789... → that 123456789 part.';
COMMENT ON COLUMN public.locations.gbp_location_id IS
  'Numeric Google Business Profile location ID. Different per studio. From the location detail URL.';


-- ── 2. Daily metrics table ───────────────────────────────────────────────────
-- One row per (studio_slug, metric_date). Stores all metrics in one row for
-- easy MoM math. Compose totals like impressions = sum of all 4 BUSINESS_
-- IMPRESSIONS_* columns at query time.
CREATE TABLE IF NOT EXISTS public.gbp_daily (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_slug                 text NOT NULL,
  metric_date                 date NOT NULL,
  impressions_desktop_maps    int NOT NULL DEFAULT 0,
  impressions_desktop_search  int NOT NULL DEFAULT 0,
  impressions_mobile_maps     int NOT NULL DEFAULT 0,
  impressions_mobile_search   int NOT NULL DEFAULT 0,
  call_clicks                 int NOT NULL DEFAULT 0,
  direction_requests          int NOT NULL DEFAULT 0,
  website_clicks              int NOT NULL DEFAULT 0,
  bookings                    int NOT NULL DEFAULT 0,
  conversations               int NOT NULL DEFAULT 0,
  raw                         jsonb,
  synced_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gbp_daily_studio_date_uidx
  ON public.gbp_daily (studio_slug, metric_date);

CREATE INDEX IF NOT EXISTS gbp_daily_date_idx
  ON public.gbp_daily (metric_date DESC);


-- ── 3. RPC: get_gbp_mom_comparison(p_studio) ─────────────────────────────────
-- Returns this month so far AND the same-day-of-month range last month for an
-- apples-to-apples comparison. If we're on day 6 of June, it compares
-- June 1-6 to May 1-6 — not full-May which would be unfair.
DROP FUNCTION IF EXISTS public.get_gbp_mom_comparison(text);

CREATE OR REPLACE FUNCTION public.get_gbp_mom_comparison(p_studio text DEFAULT NULL)
RETURNS TABLE (
  studio_slug            text,
  this_month_start       date,
  this_month_through     date,
  last_month_start       date,
  last_month_through     date,
  impressions_this       int,
  impressions_last       int,
  impressions_delta_pct  numeric,
  calls_this             int,
  calls_last             int,
  calls_delta_pct        numeric,
  directions_this        int,
  directions_last        int,
  directions_delta_pct   numeric,
  website_this           int,
  website_last           int,
  website_delta_pct      numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      date_trunc('month', (now() AT TIME ZONE 'America/New_York'))::date  AS this_month_start,
      ((now() AT TIME ZONE 'America/New_York'))::date                     AS this_month_through,
      (date_trunc('month', (now() AT TIME ZONE 'America/New_York')) - interval '1 month')::date AS last_month_start,
      -- Apples-to-apples: same number of days into last month as we are into
      -- this month. date + int adds days; timestamp + int doesn't work — so
      -- cast the timestamp to date FIRST, then add the day delta.
      (date_trunc('month', (now() AT TIME ZONE 'America/New_York')) - interval '1 month')::date
        + ((now() AT TIME ZONE 'America/New_York')::date
           - date_trunc('month', (now() AT TIME ZONE 'America/New_York'))::date)
      AS last_month_through
  ),
  this_window AS (
    SELECT
      g.studio_slug,
      COALESCE(SUM(g.impressions_desktop_maps + g.impressions_desktop_search
                 + g.impressions_mobile_maps  + g.impressions_mobile_search), 0)::int AS impressions,
      COALESCE(SUM(g.call_clicks), 0)::int        AS calls,
      COALESCE(SUM(g.direction_requests), 0)::int AS directions,
      COALESCE(SUM(g.website_clicks), 0)::int     AS website
    FROM public.gbp_daily g, bounds b
    WHERE g.metric_date >= b.this_month_start
      AND g.metric_date <= b.this_month_through
      AND (p_studio IS NULL OR g.studio_slug = p_studio)
    GROUP BY g.studio_slug
  ),
  last_window AS (
    SELECT
      g.studio_slug,
      COALESCE(SUM(g.impressions_desktop_maps + g.impressions_desktop_search
                 + g.impressions_mobile_maps  + g.impressions_mobile_search), 0)::int AS impressions,
      COALESCE(SUM(g.call_clicks), 0)::int        AS calls,
      COALESCE(SUM(g.direction_requests), 0)::int AS directions,
      COALESCE(SUM(g.website_clicks), 0)::int     AS website
    FROM public.gbp_daily g, bounds b
    WHERE g.metric_date >= b.last_month_start
      AND g.metric_date <= b.last_month_through
      AND (p_studio IS NULL OR g.studio_slug = p_studio)
    GROUP BY g.studio_slug
  ),
  studios AS (
    SELECT DISTINCT lower(replace(l.name, ' ', '-')) AS studio_slug
    FROM public.locations l
    WHERE l.is_active = true
      AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
  ),
  pct AS (
    SELECT
      s.studio_slug,
      b.this_month_start, b.this_month_through, b.last_month_start, b.last_month_through,
      COALESCE(t.impressions, 0) AS impressions_this,
      COALESCE(l.impressions, 0) AS impressions_last,
      COALESCE(t.calls, 0)       AS calls_this,
      COALESCE(l.calls, 0)       AS calls_last,
      COALESCE(t.directions, 0)  AS directions_this,
      COALESCE(l.directions, 0)  AS directions_last,
      COALESCE(t.website, 0)     AS website_this,
      COALESCE(l.website, 0)     AS website_last
    FROM studios s
    CROSS JOIN bounds b
    LEFT JOIN this_window t ON t.studio_slug = s.studio_slug
    LEFT JOIN last_window l ON l.studio_slug = s.studio_slug
  )
  SELECT
    studio_slug,
    this_month_start, this_month_through, last_month_start, last_month_through,
    impressions_this, impressions_last,
    CASE WHEN impressions_last > 0
         THEN ROUND(100.0 * (impressions_this - impressions_last)::numeric / impressions_last, 1)
         ELSE NULL END AS impressions_delta_pct,
    calls_this, calls_last,
    CASE WHEN calls_last > 0
         THEN ROUND(100.0 * (calls_this - calls_last)::numeric / calls_last, 1)
         ELSE NULL END AS calls_delta_pct,
    directions_this, directions_last,
    CASE WHEN directions_last > 0
         THEN ROUND(100.0 * (directions_this - directions_last)::numeric / directions_last, 1)
         ELSE NULL END AS directions_delta_pct,
    website_this, website_last,
    CASE WHEN website_last > 0
         THEN ROUND(100.0 * (website_this - website_last)::numeric / website_last, 1)
         ELSE NULL END AS website_delta_pct
  FROM pct
  ORDER BY studio_slug;
$$;

REVOKE ALL ON FUNCTION public.get_gbp_mom_comparison(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gbp_mom_comparison(text) TO authenticated;


-- ── 4. RPC: get_gbp_daily_series(p_studio, p_days) ────────────────────────────
-- For the 28-day sparkline. Returns one row per (studio, date) with rolled-up
-- totals. Zeroes filled for days where the sync hasn't landed yet.
DROP FUNCTION IF EXISTS public.get_gbp_daily_series(text, int);

CREATE OR REPLACE FUNCTION public.get_gbp_daily_series(
  p_studio text DEFAULT NULL,
  p_days   int  DEFAULT 28
)
RETURNS TABLE (
  studio_slug   text,
  metric_date   date,
  impressions   int,
  calls         int,
  directions    int,
  website       int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    g.studio_slug,
    g.metric_date,
    (g.impressions_desktop_maps + g.impressions_desktop_search
     + g.impressions_mobile_maps  + g.impressions_mobile_search)::int AS impressions,
    g.call_clicks::int        AS calls,
    g.direction_requests::int AS directions,
    g.website_clicks::int     AS website
  FROM public.gbp_daily g
  WHERE g.metric_date >= ((now() AT TIME ZONE 'America/New_York')::date - p_days)
    AND (p_studio IS NULL OR g.studio_slug = p_studio)
  ORDER BY g.studio_slug, g.metric_date;
$$;

REVOKE ALL ON FUNCTION public.get_gbp_daily_series(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gbp_daily_series(text, int) TO authenticated;


-- ── 5. Initial visibility ─────────────────────────────────────────────────────
-- Will return rows with zero values until gbp-sync runs. That's the empty
-- state the dashboard card will render as "Connect GBP" / "no data yet".
SELECT 'mom_preview' AS report, * FROM public.get_gbp_mom_comparison();

-- Tell Justin which locations still need GBP IDs.
SELECT 'locations_needing_setup' AS report,
       name AS studio,
       CASE WHEN gbp_account_id IS NULL OR gbp_location_id IS NULL
            THEN 'NEEDS gbp_account_id + gbp_location_id'
            ELSE 'ready' END AS status,
       gbp_account_id, gbp_location_id
FROM public.locations
WHERE is_active = true
ORDER BY name;
