-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: STOP COUNTING PENALTY FEES AS MEMBERSHIP REVENUE.
--
-- BUG
-- get_ad_spend_vs_revenue + get_converted_members were treating any MB sale
-- >= $10 that wasn't "trial / water / towel / snack" as membership revenue.
-- That swept in:
--   • NO SHOW FEE $15        42×  $630
--   • LATE CANCEL            75×  $750
--   • LATE CANCEL · LATE CANCEL  2×  $40
--   • Cancellation Fee        2×  $398
--   Total polluted member revenue: ~$1,818 across Astoria + WB.
-- A "no show" customer who paid a $15 fee is NOT a member — they're getting
-- charged a penalty for missing class. Counting it inflates the dashboard
-- Bottom Line, fakes converted-member counts, and corrupts ROAS math.
--
-- FIX
-- Centralized predicate `is_membership_purchase(item_names)` used by both
-- RPCs. One source of truth for "what counts as a membership purchase."
-- Add 'no show', 'late cancel', 'cancel fee', 'cancellation' to the exclude
-- list. Real memberships (1 Year Monthly, 12 Months PIF, Month to Month,
-- Personal Training, Conversion Membership, etc.) still match.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Centralized predicate ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_membership_purchase(p_item_names text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT
    p_item_names IS NOT NULL
    AND COALESCE(lower(p_item_names), '') NOT LIKE '%trial%'
    AND COALESCE(lower(p_item_names), '') NOT LIKE '%water%'
    AND COALESCE(lower(p_item_names), '') NOT LIKE '%towel%'
    AND COALESCE(lower(p_item_names), '') NOT LIKE '%snack%'
    -- 2026-06-10: penalty fees are NOT memberships
    AND COALESCE(lower(p_item_names), '') NOT LIKE '%no show%'
    AND COALESCE(lower(p_item_names), '') NOT LIKE '%late cancel%'
    AND COALESCE(lower(p_item_names), '') NOT LIKE '%cancel fee%'
    AND COALESCE(lower(p_item_names), '') NOT LIKE '%cancellation%';
$$;

GRANT EXECUTE ON FUNCTION public.is_membership_purchase(text) TO authenticated;


-- ── 2. Rewrite get_ad_spend_vs_revenue.member_rev_per_customer ──────────────
DROP FUNCTION IF EXISTS public.get_ad_spend_vs_revenue(date);

CREATE FUNCTION public.get_ad_spend_vs_revenue(p_since date DEFAULT '2026-05-15'::date)
RETURNS TABLE (
  studio_slug         text,
  ad_spend_usd        numeric,
  trial_count         int,
  trial_revenue_usd   numeric,
  member_count        int,
  member_revenue_usd  numeric,
  total_revenue_usd   numeric,
  net_pl_usd          numeric,
  roas                numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH
  studios AS (
    SELECT lower(replace(name, ' ', '-')) AS studio_slug, id AS location_id
    FROM public.locations
  ),
  spend AS (
    SELECT m.studio_slug, ROUND(SUM(m.spend_cents)::numeric / 100.0, 2) AS ad_spend_usd
    FROM public.meta_insights_daily m
    WHERE m.date_start >= p_since
    GROUP BY m.studio_slug
  ),
  trials_dedup AS (
    SELECT DISTINCT ON (s.studio_slug, lower(ts.email))
      s.studio_slug,
      lower(ts.email)::text                                          AS email,
      ts.name                                                        AS customer_name,
      4900                                                           AS amount_cents,
      ts.payment_date                                                AS trial_paid_at,
      ts.mindbody_id                                                 AS ts_mindbody_id
    FROM public.trial_signups ts
    JOIN studios s ON s.location_id = ts.location_id
    WHERE ts.payment_status = 'completed'
      AND ts.payment_date   IS NOT NULL
      AND ts.email          IS NOT NULL AND ts.email <> ''
      AND ts.deleted_at     IS NULL
      AND (ts.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
    ORDER BY s.studio_slug, lower(ts.email), ts.payment_date ASC
  ),
  trials AS (
    SELECT studio_slug,
      COUNT(*)::int AS trial_count,
      ROUND(SUM(amount_cents)::numeric / 100.0, 2) AS trial_revenue_usd
    FROM trials_dedup
    GROUP BY studio_slug
  ),
  direct_link AS (
    SELECT studio_slug, email, trial_paid_at, ts_mindbody_id AS mindbody_id,
           1 AS priority, 0::numeric AS time_diff_sec
    FROM trials_dedup
    WHERE ts_mindbody_id IS NOT NULL
  ),
  email_link AS (
    SELECT td.studio_slug, td.email, td.trial_paid_at, c.mindbody_id,
           2 AS priority, 0::numeric AS time_diff_sec
    FROM trials_dedup td
    JOIN public.mindbody_clients c ON lower(c.email) = td.email
  ),
  name_link AS (
    SELECT td.studio_slug, td.email, td.trial_paid_at, c.mindbody_id,
           3 AS priority, 0::numeric AS time_diff_sec
    FROM trials_dedup td
    JOIN public.mindbody_clients c
      ON lower(c.first_name) = lower(NULLIF(split_part(td.customer_name, ' ', 1), ''))
     AND lower(c.last_name)  = lower(NULLIF(split_part(td.customer_name, ' ', -1), ''))
  ),
  proximity_link AS (
    SELECT td.studio_slug, td.email, td.trial_paid_at, s.customer_mindbody_id AS mindbody_id,
           4 AS priority,
           ABS(EXTRACT(EPOCH FROM (s.sale_date_time - td.trial_paid_at)))::numeric AS time_diff_sec
    FROM trials_dedup td
    JOIN public.mindbody_sales s
      ON s.studio_slug = td.studio_slug
     AND COALESCE(lower(s.item_names), '') LIKE '%trial%'
     AND s.sale_date_time BETWEEN td.trial_paid_at - INTERVAL '3 days' AND td.trial_paid_at + INTERVAL '3 days'
  ),
  candidates AS (
    SELECT * FROM direct_link
    UNION ALL SELECT * FROM email_link
    UNION ALL SELECT * FROM name_link
    UNION ALL SELECT * FROM proximity_link
  ),
  best_per_trial AS (
    SELECT DISTINCT ON (studio_slug, email)
      studio_slug, email, trial_paid_at, mindbody_id, priority, time_diff_sec
    FROM candidates
    WHERE mindbody_id IS NOT NULL
    ORDER BY studio_slug, email, priority ASC, time_diff_sec ASC
  ),
  final_matches AS (
    SELECT DISTINCT ON (studio_slug, mindbody_id)
      studio_slug, email, trial_paid_at, mindbody_id
    FROM best_per_trial
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
     AND public.is_membership_purchase(s.item_names)   -- ← penalty fees out
    GROUP BY m.studio_slug, m.email
    HAVING SUM(s.total_cents) > 0
  ),
  member_rev AS (
    SELECT studio_slug, COUNT(*)::int AS member_count,
      ROUND(SUM(rev_cents)::numeric / 100.0, 2) AS member_revenue_usd
    FROM member_rev_per_customer GROUP BY studio_slug
  )
  SELECT
    s.studio_slug                                                            AS studio_slug,
    COALESCE(sp.ad_spend_usd, 0)                                             AS ad_spend_usd,
    COALESCE(tr.trial_count, 0)                                              AS trial_count,
    COALESCE(tr.trial_revenue_usd, 0)                                        AS trial_revenue_usd,
    COALESCE(mr.member_count, 0)                                             AS member_count,
    COALESCE(mr.member_revenue_usd, 0)                                       AS member_revenue_usd,
    COALESCE(tr.trial_revenue_usd, 0) + COALESCE(mr.member_revenue_usd, 0)   AS total_revenue_usd,
    COALESCE(tr.trial_revenue_usd, 0) + COALESCE(mr.member_revenue_usd, 0)
      - COALESCE(sp.ad_spend_usd, 0)                                         AS net_pl_usd,
    CASE WHEN COALESCE(sp.ad_spend_usd, 0) > 0
         THEN ROUND(((COALESCE(tr.trial_revenue_usd, 0) + COALESCE(mr.member_revenue_usd, 0)) / sp.ad_spend_usd) * 100, 1)
         ELSE NULL END                                                       AS roas
  FROM studios s
  LEFT JOIN spend       sp ON sp.studio_slug = s.studio_slug
  LEFT JOIN trials      tr ON tr.studio_slug = s.studio_slug
  LEFT JOIN member_rev  mr ON mr.studio_slug = s.studio_slug
  WHERE s.studio_slug IN ('astoria','williamsburg','fresh-meadows','bayside')
  ORDER BY 8 DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.get_ad_spend_vs_revenue(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_spend_vs_revenue(date) TO authenticated;


-- ── 3. Patch get_converted_members.sales_rollup the same way ────────────────
-- Pull the existing function body, swap its four NOT LIKE clauses for the
-- centralized predicate. Touches sales_rollup CTE only. The signature is the
-- same but PostgreSQL refuses to CREATE OR REPLACE a function whose OUT
-- parameters changed shape since the previous deploy — explicit DROP first.
DROP FUNCTION IF EXISTS public.get_converted_members(text, date);
DROP FUNCTION IF EXISTS public.get_converted_members(text);
DROP FUNCTION IF EXISTS public.get_converted_members();

CREATE OR REPLACE FUNCTION public.get_converted_members(
  p_studio_slug text DEFAULT NULL,
  p_since       date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  studio_slug             text,
  customer_name           text,
  stripe_email            text,
  mindbody_id             text,
  trial_paid_at           timestamptz,
  first_conversion_at     timestamptz,
  latest_conversion_at    timestamptz,
  total_member_rev_usd    numeric,
  sale_count              bigint,
  packages                text,
  utm_source              text,
  utm_medium              text,
  utm_campaign            text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH
  -- SSOT: union Stripe-paid (web checkout) with in-person paid-trial rows
  -- (POS walk-ins, direct memberships). Pre-2026-06-10 this only read
  -- stripe_paid_mirror — in-person buyers like Lauren Hernandez + Manuela
  -- Tauscher who bought 12-Month PIF direct at the desk weren't showing up
  -- on Converted Members even though their MB membership purchases existed.
  trials_dedup AS (
    SELECT DISTINCT ON (studio_slug, lower(email))
      studio_slug, lower(email)::text AS email,
      customer_name, trial_paid_at
    FROM (
      -- Stripe path
      SELECT studio_slug, customer_email AS email,
             customer_name, paid_at AS trial_paid_at
      FROM public.stripe_paid_mirror
      WHERE customer_email IS NOT NULL AND customer_email <> ''
      UNION ALL
      -- In-person / direct paid trial path
      SELECT lower(replace(l.name, ' ', '-'))   AS studio_slug,
             ts.email,
             ts.name                            AS customer_name,
             ts.payment_date                    AS trial_paid_at
      FROM public.trial_signups ts
      JOIN public.locations l ON l.id = ts.location_id
      WHERE ts.payment_status = 'completed'
        AND ts.payment_date   IS NOT NULL
        AND ts.email          IS NOT NULL AND ts.email <> ''
        AND ts.deleted_at     IS NULL
        AND ts.source_category = 'in_person'
    ) u
    WHERE trial_paid_at >= p_since::timestamptz
      AND (p_studio_slug IS NULL OR studio_slug = p_studio_slug)
    ORDER BY studio_slug, lower(email), trial_paid_at ASC
  ),
  direct_link_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           t.mindbody_id, 1 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.trial_signups t
      ON lower(t.email) = td.email
     AND t.mindbody_id IS NOT NULL
  ),
  email_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           c.mindbody_id, 2 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_clients c ON lower(c.email) = td.email
  ),
  name_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           c.mindbody_id, 3 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_clients c
      ON lower(c.first_name) = lower(NULLIF(split_part(td.customer_name, ' ', 1), ''))
     AND lower(c.last_name)  = lower(NULLIF(split_part(td.customer_name, ' ', -1), ''))
  ),
  prox_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           s.customer_mindbody_id AS mindbody_id, 4 AS priority,
           ABS(EXTRACT(EPOCH FROM (s.sale_date_time - td.trial_paid_at)))::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_sales s
      ON s.studio_slug = td.studio_slug
     AND COALESCE(lower(s.item_names), '') LIKE '%trial%'
     AND s.sale_date_time BETWEEN td.trial_paid_at - INTERVAL '3 days'
                              AND td.trial_paid_at + INTERVAL '3 days'
  ),
  cands AS (
    SELECT * FROM direct_link_c
    UNION ALL SELECT * FROM email_c
    UNION ALL SELECT * FROM name_c
    UNION ALL SELECT * FROM prox_c
  ),
  best_per_stripe AS (
    SELECT DISTINCT ON (studio_slug, email)
      studio_slug, email, customer_name, trial_paid_at, mindbody_id, priority, tdiff
    FROM cands
    WHERE mindbody_id IS NOT NULL
    ORDER BY studio_slug, email, priority, tdiff
  ),
  final_matches AS (
    SELECT DISTINCT ON (studio_slug, mindbody_id)
      studio_slug, email, customer_name, trial_paid_at, mindbody_id
    FROM best_per_stripe
    ORDER BY studio_slug, mindbody_id, priority, tdiff
  ),
  sales_rollup AS (
    SELECT
      fm.studio_slug, fm.customer_name, fm.email AS stripe_email,
      fm.mindbody_id, fm.trial_paid_at,
      MIN(s.sale_date_time) AS first_conversion_at,
      MAX(s.sale_date_time) AS latest_conversion_at,
      SUM(s.total_cents)    AS total_cents,
      COUNT(*)              AS sale_count,
      STRING_AGG(s.item_names, ' | ' ORDER BY s.sale_date_time) AS packages
    FROM final_matches fm
    JOIN public.mindbody_sales s
      ON s.customer_mindbody_id = fm.mindbody_id
     AND s.studio_slug          = fm.studio_slug
     AND s.sale_date_time       >= fm.trial_paid_at
     AND s.total_cents          >= 1000
     AND public.is_membership_purchase(s.item_names)   -- ← penalty fees out
    GROUP BY fm.studio_slug, fm.customer_name, fm.email,
             fm.mindbody_id, fm.trial_paid_at
    HAVING SUM(s.total_cents) > 0
  ),
  source_per_customer AS (
    SELECT DISTINCT ON (lower(t.email))
      lower(t.email)            AS email,
      t.utm_source,
      t.utm_medium,
      t.utm_campaign
    FROM public.trial_signups t
    WHERE t.payment_status = 'completed'
      AND t.deleted_at IS NULL
      AND t.email IS NOT NULL
    ORDER BY lower(t.email), t.payment_date DESC NULLS LAST, t.created_at DESC
  )
  SELECT
    sr.studio_slug,
    sr.customer_name,
    sr.stripe_email,
    sr.mindbody_id,
    sr.trial_paid_at,
    sr.first_conversion_at,
    sr.latest_conversion_at,
    ROUND(sr.total_cents::numeric / 100.0, 2) AS total_member_rev_usd,
    sr.sale_count,
    sr.packages,
    sp.utm_source,
    sp.utm_medium,
    sp.utm_campaign
  FROM sales_rollup sr
  LEFT JOIN source_per_customer sp ON sp.email = sr.stripe_email
  ORDER BY sr.studio_slug, sr.first_conversion_at DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.get_converted_members(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_converted_members(text, date) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION
-- Expected: Astoria member_revenue should drop slightly (was including some
-- $15 no-show fees from 4-5 of our trial customers). Member count may drop
-- by 1-3 if their ONLY post-trial charges were penalty fees.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'after fix' AS label, studio_slug, member_count, member_revenue_usd, net_pl_usd
FROM public.get_ad_spend_vs_revenue();
