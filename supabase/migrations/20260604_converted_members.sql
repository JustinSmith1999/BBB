-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: get_converted_members — per-customer member conversions
--
-- Powers the new /homebase Members view + the "MEMBER · CONVERTED" badge on
-- /homebase Board card modals. Uses the SAME bridge logic as
-- get_ad_spend_vs_revenue V7 (email → name → trial-sale proximity, 1:1
-- assignment, water/towel/snack/<$10 excluded), so the per-customer detail
-- here reconciles to the dashboard's member_revenue_usd / member_count totals.
--
-- One row per converted customer. Aggregates all post-trial non-noise sales
-- into a packages summary, with first + latest conversion dates.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_converted_members(text, date);

CREATE OR REPLACE FUNCTION public.get_converted_members(
  p_studio_slug text DEFAULT NULL,
  p_since       date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  studio_slug             text,
  customer_name           text,
  stripe_email            text,
  mb_email                text,
  mindbody_id             text,
  trial_paid_at           timestamptz,
  first_conversion_at     timestamptz,
  latest_conversion_at    timestamptz,
  days_to_convert         int,
  total_member_rev_usd    numeric,
  sale_count              int,
  packages                text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH
  trials_dedup AS (
    SELECT DISTINCT ON (studio_slug, lower(customer_email))
      studio_slug, lower(customer_email)::text AS email,
      customer_name, paid_at AS trial_paid_at
    FROM public.stripe_paid_mirror
    WHERE paid_at >= p_since::timestamptz
      AND customer_email IS NOT NULL AND customer_email <> ''
      AND (p_studio_slug IS NULL OR studio_slug = p_studio_slug)
    ORDER BY studio_slug, lower(customer_email), paid_at ASC
  ),
  email_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           c.mindbody_id, 1 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_clients c ON lower(c.email) = td.email
  ),
  name_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           c.mindbody_id, 2 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_clients c
      ON lower(c.first_name) = lower(NULLIF(split_part(td.customer_name, ' ', 1), ''))
     AND lower(c.last_name)  = lower(NULLIF(split_part(td.customer_name, ' ', -1), ''))
  ),
  prox_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           s.customer_mindbody_id AS mindbody_id, 3 AS priority,
           ABS(EXTRACT(EPOCH FROM (s.sale_date_time - td.trial_paid_at)))::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_sales s
      ON s.studio_slug = td.studio_slug
     AND COALESCE(lower(s.item_names), '') LIKE '%trial%'
     AND s.sale_date_time BETWEEN td.trial_paid_at - INTERVAL '3 days'
                              AND td.trial_paid_at + INTERVAL '3 days'
  ),
  cands AS (
    SELECT * FROM email_c
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
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%trial%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%water%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%towel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%snack%'
    GROUP BY fm.studio_slug, fm.customer_name, fm.email,
             fm.mindbody_id, fm.trial_paid_at
  )
  SELECT
    sr.studio_slug,
    sr.customer_name,
    sr.stripe_email,
    c.email AS mb_email,
    sr.mindbody_id,
    sr.trial_paid_at,
    sr.first_conversion_at,
    sr.latest_conversion_at,
    GREATEST(0, EXTRACT(DAY FROM (sr.first_conversion_at - sr.trial_paid_at))::int) AS days_to_convert,
    ROUND(sr.total_cents::numeric / 100.0, 2) AS total_member_rev_usd,
    sr.sale_count::int,
    sr.packages
  FROM sales_rollup sr
  LEFT JOIN public.mindbody_clients c ON c.mindbody_id = sr.mindbody_id
  ORDER BY sr.total_cents DESC, sr.first_conversion_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_converted_members(text, date) TO authenticated;

-- Sanity probe — should show 8 rows totaling $4,135.
SELECT * FROM public.get_converted_members();
