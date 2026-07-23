-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-03: per-studio "Ad ROI · Dollars Spent vs Dollars Earned"
--
-- V7 — V6 + exclude noise sales (water/towel/snacks, anything under $10).
-- Williamsburg "1 member / $1" came from a $1 water purchase; Astoria $2,599
-- also likely included accumulated water sales. Real membership revenue starts
-- at $30 (drop-in) and up, so a $10 floor + item-name exclusion is safe.
--
-- V6 — three-tier bridge (email → name → trial-sale proximity), 1:1 assignment.
--
-- Why V6: V5 (email-only) under-counted by ~50%+ because customers frequently
-- use different emails at Stripe vs MindBody (existing members redeeming the
-- trial deal, typos, work vs personal). V4 used time-proximity but collided
-- when multiple trials happened the same day at the same studio.
--
-- V6 strategy:
--   1. Email match (mindbody_clients.email = stripe.email) — highest confidence
--   2. Name match (mindbody_clients.first_name + last_name = stripe.customer_name)
--   3. Trial-sale proximity: find a $49 trial sale at the same studio within
--      ±3 days of the Stripe payment — bridges customers with no MB email
--      AND no name match (rare but happens).
--
-- Two DISTINCT ON passes guarantee 1:1 assignment:
--   - stripe_best_match: each Stripe (studio, email) gets ONE mindbody_id
--   - final_matches: each MB (studio, mindbody_id) gets ONE Stripe customer
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_ad_spend_vs_revenue(date);

CREATE OR REPLACE FUNCTION public.get_ad_spend_vs_revenue(p_since date DEFAULT '2026-05-15'::date)
RETURNS TABLE (studio_slug text, ad_spend_usd numeric, trial_count int, trial_revenue_usd numeric,
  member_count int, member_revenue_usd numeric, total_revenue_usd numeric, net_pl_usd numeric, roas numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH
  studios AS (
    SELECT lower(replace(name, ' ', '-')) AS studio_slug FROM public.locations
  ),
  spend AS (
    SELECT m.studio_slug, ROUND(SUM(m.spend_cents)::numeric / 100.0, 2) AS ad_spend_usd
    FROM public.meta_insights_daily m
    WHERE m.date_start >= p_since GROUP BY m.studio_slug
  ),
  trials_dedup AS (
    SELECT DISTINCT ON (studio_slug, lower(customer_email))
      studio_slug, lower(customer_email)::text AS email,
      customer_name, amount_cents, paid_at AS trial_paid_at
    FROM public.stripe_paid_mirror
    WHERE paid_at >= p_since::timestamptz
      AND customer_email IS NOT NULL AND customer_email <> ''
    ORDER BY studio_slug, lower(customer_email), paid_at ASC
  ),
  trials AS (
    SELECT studio_slug, COUNT(*)::int AS trial_count,
      ROUND(SUM(amount_cents)::numeric / 100.0, 2) AS trial_revenue_usd
    FROM trials_dedup GROUP BY studio_slug
  ),
  -- BRIDGE 1: email match
  email_candidates AS (
    SELECT td.studio_slug, td.email, td.trial_paid_at, c.mindbody_id,
           1 AS priority, 0::numeric AS time_diff_sec
    FROM trials_dedup td
    JOIN public.mindbody_clients c ON lower(c.email) = td.email
  ),
  -- BRIDGE 2: first+last name match
  name_candidates AS (
    SELECT td.studio_slug, td.email, td.trial_paid_at, c.mindbody_id,
           2 AS priority, 0::numeric AS time_diff_sec
    FROM trials_dedup td
    JOIN public.mindbody_clients c
      ON lower(c.first_name) = lower(NULLIF(split_part(td.customer_name, ' ', 1), ''))
     AND lower(c.last_name)  = lower(NULLIF(split_part(td.customer_name, ' ', -1), ''))
  ),
  -- BRIDGE 3: same-studio trial sale within ±3 days
  proximity_candidates AS (
    SELECT td.studio_slug, td.email, td.trial_paid_at, s.customer_mindbody_id AS mindbody_id,
           3 AS priority,
           ABS(EXTRACT(EPOCH FROM (s.sale_date_time - td.trial_paid_at)))::numeric AS time_diff_sec
    FROM trials_dedup td
    JOIN public.mindbody_sales s
      ON s.studio_slug = td.studio_slug
     AND COALESCE(lower(s.item_names), '') LIKE '%trial%'
     AND s.sale_date_time BETWEEN td.trial_paid_at - INTERVAL '3 days' AND td.trial_paid_at + INTERVAL '3 days'
  ),
  candidate_matches AS (
    SELECT * FROM email_candidates
    UNION ALL SELECT * FROM name_candidates
    UNION ALL SELECT * FROM proximity_candidates
  ),
  stripe_best_match AS (
    SELECT DISTINCT ON (studio_slug, email)
      studio_slug, email, trial_paid_at, mindbody_id, priority, time_diff_sec
    FROM candidate_matches
    WHERE mindbody_id IS NOT NULL
    ORDER BY studio_slug, email, priority ASC, time_diff_sec ASC
  ),
  final_matches AS (
    SELECT DISTINCT ON (studio_slug, mindbody_id)
      studio_slug, email, trial_paid_at, mindbody_id
    FROM stripe_best_match
    ORDER BY studio_slug, mindbody_id, priority ASC, time_diff_sec ASC
  ),
  member_rev_per_customer AS (
    SELECT m.studio_slug, m.email, SUM(s.total_cents)::bigint AS rev_cents
    FROM final_matches m
    JOIN public.mindbody_sales s
      ON s.customer_mindbody_id = m.mindbody_id
     AND s.studio_slug          = m.studio_slug
     AND s.sale_date_time       >= m.trial_paid_at
     AND s.total_cents          >= 1000
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%trial%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%water%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%towel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%snack%'
    GROUP BY m.studio_slug, m.email
    HAVING SUM(s.total_cents) > 0
  ),
  member_rev AS (
    SELECT studio_slug, COUNT(*)::int AS member_count,
      ROUND(SUM(rev_cents)::numeric / 100.0, 2) AS member_revenue_usd
    FROM member_rev_per_customer GROUP BY studio_slug
  )
  SELECT
    s.studio_slug                                                              AS studio_slug,
    COALESCE(sp.ad_spend_usd, 0)                                               AS ad_spend_usd,
    COALESCE(tr.trial_count, 0)                                                AS trial_count,
    COALESCE(tr.trial_revenue_usd, 0)                                          AS trial_revenue_usd,
    COALESCE(mr.member_count, 0)                                               AS member_count,
    COALESCE(mr.member_revenue_usd, 0)                                         AS member_revenue_usd,
    COALESCE(tr.trial_revenue_usd, 0) + COALESCE(mr.member_revenue_usd, 0)     AS total_revenue_usd,
    COALESCE(tr.trial_revenue_usd, 0) + COALESCE(mr.member_revenue_usd, 0)
      - COALESCE(sp.ad_spend_usd, 0)                                           AS net_pl_usd,
    CASE WHEN COALESCE(sp.ad_spend_usd, 0) > 0
         THEN ROUND(((COALESCE(tr.trial_revenue_usd, 0) + COALESCE(mr.member_revenue_usd, 0)) / sp.ad_spend_usd) * 100, 1)
         ELSE NULL END                                                         AS roas
  FROM studios s
  LEFT JOIN spend       sp ON sp.studio_slug = s.studio_slug
  LEFT JOIN trials      tr ON tr.studio_slug = s.studio_slug
  LEFT JOIN member_rev  mr ON mr.studio_slug = s.studio_slug
  ORDER BY 8 DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.get_ad_spend_vs_revenue(date) TO authenticated;

SELECT * FROM public.get_ad_spend_vs_revenue();
