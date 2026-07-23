-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-09: SSOT — single canonical paid-trial counter for the dashboard.
--
-- PROBLEM
-- The dashboard had ≥2 different "paid trials" numbers on the same page:
--   • Studio-by-studio table:   77   (from get_audience_comparison_all_studios)
--   • Trial→Member card:        75   (from get_ad_spend_vs_revenue)
-- Neither was "wrong" — they just used different sources:
--   • get_audience_comparison_all_studios → COUNT(*) on trial_signups
--   • get_ad_spend_vs_revenue             → COUNT DISTINCT customer_email
--                                           on stripe_paid_mirror
-- Owners flag this as broken every time they look. Carlos pinged about it
-- twice already today.
--
-- DECISION
-- The truth is "how many unique people paid us $49 since launch", which is:
--   COUNT(DISTINCT lower(customer_email)) FROM stripe_paid_mirror
--   WHERE paid_at >= launch
-- Why this source:
--   1. stripe_paid_mirror is the ground-truth ledger — every $49 charge
--      Stripe successfully processed lands here via the webhook AND the
--      5-min sync cron, so we catch even the rows trial_signups missed.
--   2. DISTINCT email dedupes Stripe double-charges (Bridget Walsh's
--      3 charges from 5/31 → 1 customer, the way an owner sees her).
--   3. stripe_paid_mirror's amount filter (TARGET_AMOUNT_CENTS = 4900 in
--      sync-stripe-paid-mirror) means every row IS a $49 trial — no need
--      for separate amount filtering at query time.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds count_unique_paid_customers(p_studio, p_since, p_until) — the
--      one canonical counter every dashboard card should call when it
--      needs "how many paid trials happened".
--   2. Rewrites get_audience_comparison_all_studios.paid_real to call it.
--   3. (Does NOT touch get_ad_spend_vs_revenue — its trials_dedup CTE is
--      already doing the same thing inline; both now agree.)
--
-- VERIFICATION AFTER SHIPPING
--   SELECT studio_slug, total_paid_real FROM get_audience_comparison_all_studios()
--   SELECT studio_slug, trial_count FROM get_ad_spend_vs_revenue()
--   These must agree row-for-row.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The canonical counter ─────────────────────────────────────────────────
-- p_studio = NULL → network total. Pass a slug to scope to one studio.
-- p_until  = NULL → "from p_since onward, no upper bound" (default for
--                   "since launch" cards).
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
  SELECT COUNT(DISTINCT lower(customer_email))::bigint
  FROM public.stripe_paid_mirror
  WHERE customer_email IS NOT NULL
    AND customer_email <> ''
    AND (p_studio IS NULL OR studio_slug = p_studio)
    AND (paid_at AT TIME ZONE 'America/New_York')::date >= p_since
    AND (p_until IS NULL
         OR (paid_at AT TIME ZONE 'America/New_York')::date <= p_until);
$$;

GRANT EXECUTE ON FUNCTION public.count_unique_paid_customers(text, date, date) TO authenticated;

-- ── 2. Rewire get_audience_comparison_all_studios to use the counter ─────────
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
  -- ── CHANGED: paid_real now uses the canonical counter (DISTINCT email
  --     on stripe_paid_mirror). Previous version did COUNT(*) on
  --     trial_signups which over-counted Stripe double-charges. ─────────────
  paid_real AS (
    SELECT
      m.studio_slug,
      COUNT(DISTINCT lower(m.customer_email))::int AS n
    FROM public.stripe_paid_mirror m
    WHERE m.customer_email IS NOT NULL
      AND m.customer_email <> ''
      AND (m.paid_at AT TIME ZONE 'America/New_York')::date >= p_since
    GROUP BY m.studio_slug
  ),
  -- local_share still needs phone, which only lives on trial_signups.
  -- It's a percentage anyway, not a count, so any 1-2 row drift is noise.
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

-- ── 3. Verification probes (run after migration; values should agree) ────────
-- Studio-by-studio paid_real should equal Trial→Member trial_count per studio.
SELECT
  a.studio_slug,
  a.total_paid_real AS audience_paid,
  v.trial_count     AS adroi_trial,
  CASE WHEN a.total_paid_real = v.trial_count THEN '✓' ELSE '✗ MISMATCH' END AS match_status
FROM public.get_audience_comparison_all_studios()        a
JOIN public.get_ad_spend_vs_revenue()                    v ON v.studio_slug = a.studio_slug
ORDER BY a.studio_slug;

-- Network total must equal the canonical counter.
SELECT
  (SELECT SUM(total_paid_real) FROM public.get_audience_comparison_all_studios()) AS audience_total,
  (SELECT SUM(trial_count)     FROM public.get_ad_spend_vs_revenue())             AS adroi_total,
  public.count_unique_paid_customers()                                            AS canonical_total;
