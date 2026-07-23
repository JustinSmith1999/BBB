-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-09: get_audience_comparison_all_studios — paid_real CTE switches to
--             stripe_paid_mirror SSOT.
--
-- BUG: The Studio-by-studio dashboard table (which calls this RPC) undercounts
-- paid trials because paid_real reads from trial_signups, but 6 customers
-- network-wide have a stripe_paid_mirror row WITHOUT a matching trial_signups
-- row. Stripe charged them, the webhook recovered them into the mirror, but
-- the trial_signups INSERT failed (or was soft-deleted). Dashboard shows 73
-- paid; Stripe says 79.
--
-- Earlier task #64 already moved get_launch_kpis, get_studio_overview,
-- get_daily_pulse, get_funnel_health to read from stripe_paid_mirror via
-- count_paid_canonical(). This RPC was missed in that pass — the audience
-- comparison still joins trial_signups directly.
--
-- FIX: Rewrite paid_real to count from stripe_paid_mirror. Same launch anchor,
-- same per-studio grouping. The total_paid_real column on the Studio-by-studio
-- table will now match the Pulse + Bottom Line tiles.
--
-- local_share (city-area-code share of paid customers) still needs phone data,
-- which only lives on trial_signups. We keep that CTE on trial_signups since:
--   (a) local_share is a percentage, not a count, so a 6-row gap moves it by
--       ~2% which is within noise;
--   (b) the Audience card that displayed Local % was removed in #211 anyway.
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
  -- ── CHANGED: paid_real now reads stripe_paid_mirror (canonical) ─────────
  -- Was joining trial_signups, which misses 6 network-wide where the row
  -- never made it into our DB but Stripe still charged the customer.
  paid_real AS (
    SELECT
      m.studio_slug,
      COUNT(*)::int AS n
    FROM public.stripe_paid_mirror m
    WHERE (m.paid_at AT TIME ZONE 'America/New_York')::date >= p_since
    GROUP BY m.studio_slug
  ),
  -- local_share still on trial_signups (needs phone column). Audience card
  -- that displayed Local % is hidden anyway (#211).
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

-- Sanity probe — total_paid_real should equal stripe_paid_mirror count per studio
SELECT studio_slug, total_paid_real, total_paid_meta
FROM public.get_audience_comparison_all_studios()
ORDER BY studio_slug;
