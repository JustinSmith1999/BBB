-- 2026-06-27 — MT-app trial visibility on every dashboard counter
-- =====================================================================
-- WHY
-- mt-orders-sync (deployed earlier today) writes $49 in-MT-app trials
-- into trial_signups with source_category='mt_app'. Most dashboard RPCs
-- already read from trial_signups (get_daily_pulse, get_launch_kpis,
-- get_studio_overview, get_funnel_health) — so they pick up mt_app
-- buyers automatically.
--
-- EXCEPTION: count_unique_paid_customers + get_audience_comparison_all_
-- studios still read from stripe_paid_mirror, which only contains BBB-
-- Stripe charges. mt_app buyers paid through MT's Stripe Connect, so
-- they're INVISIBLE to those two surfaces. The All-Studios Audience
-- Comparison card under-counts paid trials for every studio with even
-- one mt_app buyer.
--
-- VERIFIED VIA LIVE PROBE 2026-06-27 16:30 ET
--   trial_signups: Angelo Nunez (WB, 16:04, mt_app, completed) ✓
--   stripe_paid_mirror for Angelo: NO ROW (he paid via MT, not BBB)
--   get_daily_pulse('williamsburg') today.paid=1 ✓ counts Angelo
--   count_unique_paid_customers() — WOULD NOT count Angelo
--
-- FIX
-- Switch the source of truth from stripe_paid_mirror → trial_signups
-- for these two counters. trial_signups is already the SSOT per
-- task #245 ("rewire EVERY card RPC to trial_signups truth").
--
-- Filters applied (match every other dashboard RPC):
--   deleted_at IS NULL
--   payment_status = 'completed'
--   payment_date IS NOT NULL
--   COALESCE(source_category, '') <> 'legacy_archived'
--   COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
--   (payment_date AT TIME ZONE 'America/New_York')::date >= p_since
--
-- ROLLBACK: re-run with the previous stripe_paid_mirror-based body
--           (see migration 20260609_ssot_paid_trials_canonical.sql).

BEGIN;

-- ── 1. The canonical counter — now reads trial_signups ──────────────
CREATE OR REPLACE FUNCTION public.count_unique_paid_customers(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date,
  p_until  date DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT COUNT(DISTINCT lower(t.email))::bigint
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
   WHERE t.deleted_at IS NULL
     AND t.payment_status  = 'completed'
     AND t.payment_date IS NOT NULL
     AND COALESCE(t.source_category, '') <> 'legacy_archived'
     AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
     AND t.email IS NOT NULL
     AND t.email <> ''
     AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
     AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
     AND (p_until IS NULL
          OR (t.payment_date AT TIME ZONE 'America/New_York')::date <= p_until);
$$;

GRANT EXECUTE ON FUNCTION public.count_unique_paid_customers(text, date, date) TO authenticated;

-- ── 2. Rewire get_audience_comparison_all_studios.paid_real ─────────
-- Same change — replace stripe_paid_mirror CTE with trial_signups so
-- the All-Studios Audience Comparison card includes mt_app buyers.
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
SET search_path = public, pg_catalog
AS $$
  WITH totals AS (
    SELECT
      i.studio_slug,
      SUM(i.impressions)::bigint                     AS total_impressions,
      SUM(i.clicks)::bigint                          AS total_clicks,
      ROUND(SUM(i.spend_cents)::numeric / 100.0, 2)  AS total_spend_usd,
      SUM(i.leads)::bigint                           AS total_leads,
      SUM(i.purchases)::bigint                       AS total_paid_meta
    FROM public.meta_insights_daily i
    WHERE i.date_start >= p_since
    GROUP BY i.studio_slug
  ),
  window_breakdowns AS (
    SELECT * FROM public.meta_breakdowns_daily WHERE date_start >= p_since
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
  -- ── CHANGED 2026-06-27: paid_real now reads trial_signups SSOT.
  --     Replaces stripe_paid_mirror lookup so mt_app buyers (paid via
  --     MT's Stripe Connect, never hit BBB Stripe) get counted. ──────
  paid_real AS (
    SELECT
      lower(replace(l.name, ' ', '-'))                AS studio_slug,
      COUNT(DISTINCT lower(t.email))::int             AS n
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND t.payment_status  = 'completed'
      AND t.payment_date IS NOT NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND t.email IS NOT NULL
      AND t.email <> ''
      AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
    GROUP BY 1
  ),
  -- local_share unchanged — uses phone, only on trial_signups anyway.
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

COMMIT;

-- ─── Verification (run after commit) ─────────────────────────────────
-- (a) Network total paid since launch — should match get_daily_pulse sum:
--   SELECT public.count_unique_paid_customers();
--
-- (b) Per-studio cross-check — paid_real should agree with get_launch_kpis
--   SELECT
--     a.studio_slug,
--     a.total_paid_real,
--     (public.get_launch_kpis(a.studio_slug)->>'paid_trials')::int AS kpi_paid
--   FROM public.get_audience_comparison_all_studios() a
--   ORDER BY 1;
--
-- (c) Angelo Nunez (WB) — must now be counted:
--   SELECT public.count_unique_paid_customers('williamsburg');
--   (count should be one higher than before this migration)
