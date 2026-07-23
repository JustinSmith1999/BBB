-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-03: get_audience_comparison_all_studios returned a 14-day window,
-- which undercounted impressions, clicks and spend by ~20% vs since-launch
-- numbers in meta_insights_daily. The dashboard's per-studio attribution
-- table inherited that shortfall and Trial P/L numbers looked too optimistic.
--
-- This migration:
--   1. Drops the old int-days signature
--   2. Replaces it with a DATE-based signature defaulting to launch (2026-05-15)
--   3. Keeps the same return columns so dashboard JS keeps working — just
--      pass { p_since: '2026-05-15' } instead of { p_days: 14 }
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_audience_comparison_all_studios(int);
DROP FUNCTION IF EXISTS public.get_audience_comparison_all_studios(date);

CREATE OR REPLACE FUNCTION public.get_audience_comparison_all_studios(
  p_since date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  studio_slug          text,
  total_impressions    bigint,
  total_clicks         bigint,
  total_spend_usd      numeric,
  total_leads          bigint,
  total_paid_meta      bigint,
  total_paid_real      int,
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
    WHERE date_start >= p_since
  ),
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
  paid_real AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      COUNT(*)::int AS n
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.payment_status = 'completed'
      AND t.payment_date >= p_since
      AND t.deleted_at IS NULL
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
    GROUP BY 1
  ),
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
      AND t.payment_date >= p_since
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

REVOKE ALL ON FUNCTION public.get_audience_comparison_all_studios(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_audience_comparison_all_studios(date) TO authenticated;

-- Sanity check — should return totals close to meta_insights_daily for the
-- same window, not undercount by 20%.
SELECT 'audience_comparison_since_launch' AS report, * FROM public.get_audience_comparison_all_studios();
