-- ─────────────────────────────────────────────────────────────────────────────
-- Meta audience breakdowns — where Meta is actually serving your ads.
--
-- Pulls region/dma + age × gender + placement breakdowns from Meta Marketing
-- API. Joined with converter geography from trial_signups (phone area code)
-- to surface "Meta served HERE / converters came from THERE" mismatch.
--
-- Populated by the meta-breakdowns-sync edge function (runs nightly).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.meta_breakdowns_daily (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_slug       text NOT NULL,
  date_start        date NOT NULL,
  breakdown_type    text NOT NULL,   -- 'region' | 'age_gender' | 'placement'
  breakdown_value   text NOT NULL,   -- e.g. 'New York', '35-44|female', 'instagram|reels|mobile'
  spend_cents       int  NOT NULL DEFAULT 0,
  impressions       int  NOT NULL DEFAULT 0,
  clicks            int  NOT NULL DEFAULT 0,
  leads             int  NOT NULL DEFAULT 0,
  purchases         int  NOT NULL DEFAULT 0,
  raw               jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS meta_breakdowns_daily_uidx
  ON public.meta_breakdowns_daily (studio_slug, date_start, breakdown_type, breakdown_value);

CREATE INDEX IF NOT EXISTS meta_breakdowns_studio_type_idx
  ON public.meta_breakdowns_daily (studio_slug, breakdown_type, date_start DESC);

COMMENT ON TABLE public.meta_breakdowns_daily IS
  'Per-studio, per-day Meta ad delivery broken down by region, age×gender, and placement. Populated by meta-breakdowns-sync.';


-- ── RPC: get_meta_audience_breakdown ──────────────────────────────────────
-- Returns aggregated audience breakdown for a studio over the last N days,
-- grouped by breakdown_type so the dashboard can render 3 tables in one call.
DROP FUNCTION IF EXISTS public.get_meta_audience_breakdown(text, int);

CREATE OR REPLACE FUNCTION public.get_meta_audience_breakdown(
  p_studio text,
  p_days   int DEFAULT 14
)
RETURNS TABLE (
  breakdown_type   text,
  breakdown_value  text,
  spend_usd        numeric,
  impressions      bigint,
  clicks           bigint,
  leads            bigint,
  purchases        bigint,
  ctr_pct          numeric,
  share_of_impressions_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH window_data AS (
    SELECT *
    FROM public.meta_breakdowns_daily
    WHERE studio_slug = p_studio
      AND date_start >= ((now() AT TIME ZONE 'America/New_York')::date - p_days)
  ),
  totals_by_type AS (
    SELECT breakdown_type, SUM(impressions)::numeric AS total_impr
    FROM window_data
    GROUP BY breakdown_type
  ),
  agg AS (
    SELECT
      breakdown_type,
      breakdown_value,
      SUM(spend_cents)::numeric / 100.0 AS spend_usd,
      SUM(impressions)::bigint           AS impressions,
      SUM(clicks)::bigint                AS clicks,
      SUM(leads)::bigint                 AS leads,
      SUM(purchases)::bigint             AS purchases
    FROM window_data
    GROUP BY breakdown_type, breakdown_value
  )
  SELECT
    a.breakdown_type,
    a.breakdown_value,
    ROUND(a.spend_usd, 2)                                           AS spend_usd,
    a.impressions,
    a.clicks,
    a.leads,
    a.purchases,
    CASE WHEN a.impressions > 0
         THEN ROUND(100.0 * a.clicks / a.impressions, 2) ELSE 0 END AS ctr_pct,
    CASE WHEN t.total_impr > 0
         THEN ROUND(100.0 * a.impressions / t.total_impr, 1) ELSE 0 END AS share_of_impressions_pct
  FROM agg a
  JOIN totals_by_type t ON t.breakdown_type = a.breakdown_type
  ORDER BY a.breakdown_type, a.impressions DESC;
$$;

REVOKE ALL ON FUNCTION public.get_meta_audience_breakdown(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_audience_breakdown(text, int) TO authenticated;


-- ── RPC: get_converter_geography(p_studio) ────────────────────────────────
-- Pulls the area code of every paid trial customer at this studio since
-- launch. Lets the dashboard show "Meta served here, but real converters
-- came from here" side by side.
DROP FUNCTION IF EXISTS public.get_converter_geography(text);

CREATE OR REPLACE FUNCTION public.get_converter_geography(p_studio text)
RETURNS TABLE (
  area_code      text,
  area_label     text,
  paid_count     int,
  share_pct      numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH rows AS (
    SELECT
      CASE
        WHEN t.phone ~ '^\+1[0-9]{10}$' THEN SUBSTRING(t.phone, 3, 3)
        WHEN t.phone ~ '^[0-9]{10}$'    THEN SUBSTRING(t.phone, 1, 3)
        ELSE NULL
      END AS area_code
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.payment_status = 'completed'
      AND t.payment_date >= '2026-05-15'::date
      AND t.deleted_at IS NULL
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND lower(replace(l.name, ' ', '-')) = p_studio
  ),
  agg AS (
    SELECT area_code, COUNT(*)::int AS n
    FROM rows
    WHERE area_code IS NOT NULL
    GROUP BY area_code
  ),
  total AS (SELECT COALESCE(SUM(n), 0)::numeric AS t FROM agg)
  SELECT
    a.area_code,
    CASE a.area_code
      WHEN '718' THEN 'Brooklyn / Queens'
      WHEN '347' THEN 'Brooklyn / Queens / Bronx'
      WHEN '917' THEN 'NYC Mobile'
      WHEN '929' THEN 'NYC Mobile'
      WHEN '646' THEN 'Manhattan'
      WHEN '212' THEN 'Manhattan'
      WHEN '516' THEN 'Nassau County'
      WHEN '631' THEN 'Suffolk County'
      ELSE 'Out of NYC'
    END AS area_label,
    a.n  AS paid_count,
    CASE WHEN (SELECT t FROM total) > 0
         THEN ROUND(100.0 * a.n / (SELECT t FROM total), 1)
         ELSE 0 END AS share_pct
  FROM agg a
  ORDER BY a.n DESC;
$$;

REVOKE ALL ON FUNCTION public.get_converter_geography(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_converter_geography(text) TO authenticated;


-- ── RPC: get_audience_comparison_all_studios ──────────────────────────────
-- One row per studio with aggregate audience metrics for the All Studios
-- dashboard. Lets owners see who's winning at impressions, CTR, CAC, local
-- targeting, and which placement is each studio's workhorse — all in one
-- glance.
DROP FUNCTION IF EXISTS public.get_audience_comparison_all_studios(int);

CREATE OR REPLACE FUNCTION public.get_audience_comparison_all_studios(p_days int DEFAULT 14)
RETURNS TABLE (
  studio_slug          text,
  total_impressions    bigint,
  total_clicks         bigint,
  total_spend_usd      numeric,
  total_leads          bigint,
  total_paid_meta      bigint,    -- Meta-attributed purchases (the breakdown sees them)
  total_paid_real      int,       -- actual paid trials in our DB since launch (truth)
  ctr_pct              numeric,
  cac_usd              numeric,
  local_share_pct      numeric,
  best_placement       text,
  best_placement_paid  bigint,
  best_age_gender      text,
  best_age_gender_paid bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH window_data AS (
    SELECT *
    FROM public.meta_breakdowns_daily
    WHERE date_start >= ((now() AT TIME ZONE 'America/New_York')::date - p_days)
  ),
  -- Aggregate metrics: pick any single breakdown_type to total because all 3
  -- breakdowns sum to the same per-studio totals. We use placement because
  -- it has the most rows (highest granularity → safest aggregate).
  totals AS (
    SELECT
      studio_slug,
      SUM(impressions)::bigint                 AS total_impressions,
      SUM(clicks)::bigint                      AS total_clicks,
      ROUND(SUM(spend_cents)::numeric / 100.0, 2) AS total_spend_usd,
      SUM(leads)::bigint                       AS total_leads,
      SUM(purchases)::bigint                   AS total_paid_meta
    FROM window_data
    WHERE breakdown_type = 'placement'
    GROUP BY studio_slug
  ),
  -- "Best placement" = the placement with the most actual paid conversions.
  -- Tiebreaker: impressions (in case multiple placements have same paid count).
  best_placement_per_studio AS (
    SELECT DISTINCT ON (studio_slug)
      studio_slug,
      breakdown_value AS best_placement_raw,
      SUM(purchases) OVER (PARTITION BY studio_slug, breakdown_value) AS best_placement_paid
    FROM window_data
    WHERE breakdown_type = 'placement'
    ORDER BY studio_slug,
             SUM(purchases) OVER (PARTITION BY studio_slug, breakdown_value) DESC NULLS LAST,
             SUM(impressions) OVER (PARTITION BY studio_slug, breakdown_value) DESC
  ),
  -- "Best age × gender" = the cell with most paid conversions, tiebreak by impr.
  best_age_gender_per_studio AS (
    SELECT DISTINCT ON (studio_slug)
      studio_slug,
      breakdown_value AS best_age_gender_raw,
      SUM(purchases) OVER (PARTITION BY studio_slug, breakdown_value) AS best_age_gender_paid
    FROM window_data
    WHERE breakdown_type = 'age_gender'
    ORDER BY studio_slug,
             SUM(purchases) OVER (PARTITION BY studio_slug, breakdown_value) DESC NULLS LAST,
             SUM(impressions) OVER (PARTITION BY studio_slug, breakdown_value) DESC
  ),
  -- Real paid trials from our DB (truth, includes ones Meta CAPI missed)
  paid_real AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      COUNT(*)::int AS n
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.payment_status = 'completed'
      AND t.payment_date >= '2026-05-15'::date
      AND t.deleted_at IS NULL
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
    GROUP BY 1
  ),
  -- Local-share percentage — % of paid customers with NYC area codes
  local_share AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      ROUND(
        100.0 * COUNT(*) FILTER (
          WHERE SUBSTRING(t.phone FROM '\+1([0-9]{3})') IN ('718','347','917','929')
        )::numeric
        / NULLIF(COUNT(*), 0),
        1
      ) AS local_share_pct
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.payment_status = 'completed'
      AND t.payment_date >= '2026-05-15'::date
      AND t.deleted_at IS NULL
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
    GROUP BY 1
  )
  SELECT
    t.studio_slug,
    t.total_impressions,
    t.total_clicks,
    t.total_spend_usd,
    t.total_leads,
    t.total_paid_meta,
    COALESCE(pr.n, 0)                  AS total_paid_real,
    CASE WHEN t.total_impressions > 0
         THEN ROUND(100.0 * t.total_clicks / t.total_impressions, 2)
         ELSE 0 END                    AS ctr_pct,
    CASE WHEN COALESCE(pr.n, 0) > 0 AND t.total_spend_usd > 0
         THEN ROUND(t.total_spend_usd / pr.n, 2)
         ELSE NULL END                 AS cac_usd,
    ls.local_share_pct,
    bp.best_placement_raw              AS best_placement,
    bp.best_placement_paid::bigint     AS best_placement_paid,
    bag.best_age_gender_raw            AS best_age_gender,
    bag.best_age_gender_paid::bigint   AS best_age_gender_paid
  FROM totals t
  LEFT JOIN best_placement_per_studio bp  ON bp.studio_slug = t.studio_slug
  LEFT JOIN best_age_gender_per_studio bag ON bag.studio_slug = t.studio_slug
  LEFT JOIN paid_real pr                  ON pr.studio_slug = t.studio_slug
  LEFT JOIN local_share ls                ON ls.studio_slug = t.studio_slug
  ORDER BY t.total_paid_meta DESC NULLS LAST, t.total_impressions DESC;
$$;

REVOKE ALL ON FUNCTION public.get_audience_comparison_all_studios(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_audience_comparison_all_studios(int) TO authenticated;


-- ── Initial check ──────────────────────────────────────────────────────────
SELECT 'breakdown_table' AS report, COUNT(*) AS rows FROM public.meta_breakdowns_daily;
SELECT 'converter_geo_preview' AS report, * FROM public.get_converter_geography('astoria');
SELECT 'audience_comparison' AS report, * FROM public.get_audience_comparison_all_studios(14);
