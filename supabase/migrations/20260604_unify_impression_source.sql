-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: unify impression totals on meta_insights_daily across every
-- dashboard card.
--
-- BACKGROUND: We had two Meta-data tables driving impression counts:
--   1. meta_insights_daily        — canonical campaign-level totals
--   2. meta_breakdowns_daily      — same metrics, sliced by placement / age_gender
--
-- Meta's breakdown API drops small segments (impressions in segments under
-- their privacy floor). So summing meta_breakdowns_daily WHERE breakdown_type
-- = 'placement' returns a total that's 5–15% lower than meta_insights_daily
-- for the same window. Different cards used different tables → different
-- impression counts shown side-by-side on the dashboard.
--
-- FIX: get_audience_comparison_all_studios now pulls TOTALS from
-- meta_insights_daily (canonical), but still pulls best_placement and
-- best_age_gender from meta_breakdowns_daily (because those need the
-- breakdowns to exist by definition). One source of truth for the headline
-- numbers; breakdowns only consulted for "what's the top X" answers.
--
-- Anchor: 2026-05-15 (launch). Every since-launch card on the dashboard now
-- uses this date. The function signature is unchanged so the dashboard JS
-- doesn't need a rebuild.
-- ─────────────────────────────────────────────────────────────────────────────

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
  -- CANONICAL TOTALS — from meta_insights_daily (campaign aggregation).
  -- These match Studio Overview's headline numbers.
  WITH totals AS (
    SELECT
      i.studio_slug,
      SUM(i.impressions)::bigint                 AS total_impressions,
      SUM(i.clicks)::bigint                      AS total_clicks,
      ROUND(SUM(i.spend_cents)::numeric / 100.0, 2) AS total_spend_usd,
      SUM(i.leads)::bigint                       AS total_leads,
      SUM(i.purchases)::bigint                   AS total_paid_meta
    FROM public.meta_insights_daily i
    WHERE i.date_start >= p_since
    GROUP BY i.studio_slug
  ),
  -- BEST PLACEMENT — only meta_breakdowns_daily knows the placement axis.
  -- Use it for "top X" answers, never for totals.
  window_breakdowns AS (
    SELECT *
    FROM public.meta_breakdowns_daily
    WHERE date_start >= p_since
  ),
  best_placement_per_studio AS (
    SELECT DISTINCT ON (studio_slug)
      studio_slug,
      breakdown_value AS best_placement_raw,
      SUM(purchases) OVER (PARTITION BY studio_slug, breakdown_value) AS best_placement_paid
    FROM window_breakdowns
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
    FROM window_breakdowns
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

-- Sanity probe — these totals should now match get_studio_overview's
-- impressions / clicks / spend for each studio, since both pull from the
-- same table with the same launch anchor.
SELECT studio_slug, total_impressions, total_clicks, total_spend_usd
  FROM public.get_audience_comparison_all_studios()
ORDER BY studio_slug;
