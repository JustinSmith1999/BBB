-- 2026-06-19 — TWO critical CM card fixes Justin caught at 5am:
--
-- BUG A (Suleydy Ramos / WB):
--   Suleydy showed as CONVERTED MEMBER with $30 — that $30 is 2× $15 NO SHOW FEES,
--   not membership revenue. The RPC excluded trial/water/towel/snack via NOT LIKE
--   filters but had NO filter for "no show fee" / "late cancel fee" / generic fee
--   line items. Adding those filters here.
--
-- BUG B (6 invisible FM customers):
--   Oksana, Sabeena, Jenifer Blanco Hernandez, Gus Karasakalides, Louise
--   Karasakalides, Cristino Rivera are all tagged CONVERTED MEMBER on /homebase
--   and have converted_to_member=true on trial_signups, but they NEVER appear on
--   the dashboard Converted Members card because the RPC starts from
--   stripe_paid_mirror — which only contains $49/$29 Stripe trial purchases.
--   These 6 customers bought their MEMBERSHIP directly without buying the trial
--   first. So they're invisible.
--
--   Fix: UNION a second trials seed — every trial_signups row with
--   converted_to_member=true AND source_category IN ('direct_membership',
--   'mb_direct', 'walk_in', 'in_person') AND payment_status='completed' AND a
--   mindbody_id. This treats their trial_signups row as the "trial" seed so the
--   downstream mindbody_sales rollup still works.

DROP FUNCTION IF EXISTS public.get_converted_members(text, date);
DROP FUNCTION IF EXISTS public.get_converted_members(date, text);

CREATE OR REPLACE FUNCTION public.get_converted_members(
  p_since         date DEFAULT '2026-05-15'::date,
  p_studio_slug   text DEFAULT NULL
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
  packages                text,
  utm_source              text,
  utm_medium              text,
  utm_campaign            text,
  source_category         text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH
  -- A. The original trial seed: Stripe $49/$29 trial buyers
  stripe_trials AS (
    SELECT DISTINCT ON (studio_slug, lower(customer_email))
      studio_slug,
      lower(customer_email)::text AS email,
      customer_name,
      paid_at AS trial_paid_at
    FROM public.stripe_paid_mirror
    WHERE paid_at >= p_since::timestamptz
      AND customer_email IS NOT NULL AND customer_email <> ''
      AND (p_studio_slug IS NULL OR studio_slug = p_studio_slug)
    ORDER BY studio_slug, lower(customer_email), paid_at ASC
  ),
  -- B. NEW seed: direct-membership customers who never bought $49 trial.
  --    These live ONLY in trial_signups (manually backfilled or sheet-synced).
  direct_membership_trials AS (
    SELECT DISTINCT ON (lower(replace(l.name, ' ', '-')), lower(t.email))
      lower(replace(l.name, ' ', '-'))::text AS studio_slug,
      lower(t.email)::text AS email,
      t.name AS customer_name,
      COALESCE(t.payment_date, t.created_at) AS trial_paid_at
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.converted_to_member = true
      AND t.payment_status = 'completed'
      AND t.deleted_at IS NULL
      AND t.email IS NOT NULL AND t.email <> ''
      AND t.mindbody_id IS NOT NULL
      AND COALESCE(t.payment_date, t.created_at) >= p_since::timestamptz
      AND COALESCE(t.source_category, '') IN
            ('direct_membership', 'mb_direct', 'walk_in', 'in_person', 'walk-in')
      AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
    ORDER BY lower(replace(l.name, ' ', '-')), lower(t.email),
             COALESCE(t.payment_date, t.created_at) ASC
  ),
  -- C. Combined seed: stripe trials first (richer attribution), then direct
  --    memberships filling the gap. Dedupe by (studio, email).
  trials_dedup AS (
    SELECT DISTINCT ON (studio_slug, email) *
    FROM (
      SELECT studio_slug, email, customer_name, trial_paid_at FROM stripe_trials
      UNION ALL
      SELECT studio_slug, email, customer_name, trial_paid_at FROM direct_membership_trials
    ) u
    ORDER BY studio_slug, email, trial_paid_at ASC
  ),
  direct_link_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           t.mindbody_id, 0 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.trial_signups t
      ON lower(t.email) = td.email
     AND t.mindbody_id IS NOT NULL
     AND t.deleted_at IS NULL
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
     AND s.sale_date_time       >= fm.trial_paid_at - INTERVAL '7 days'
     AND s.total_cents          >= 10000  -- ≥ $100 (was $10) excludes fees
     -- Exclude $49/$29 trial line items
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%trial%'
     -- Exclude retail
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%water%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%towel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%snack%'
     -- NEW: exclude penalty/fee line items (Bug A — Suleydy Ramos)
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%no show%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%no-show%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%late cancel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%late-cancel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%cancellation fee%'
     AND COALESCE(lower(s.item_names), '') !~ '\m(fee)\M'
    GROUP BY fm.studio_slug, fm.customer_name, fm.email,
             fm.mindbody_id, fm.trial_paid_at
  ),
  source_per_customer AS (
    SELECT DISTINCT ON (lower(t.email))
      lower(t.email)            AS email,
      t.utm_source,
      t.utm_medium,
      t.utm_campaign,
      t.source_category
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
    c.email AS mb_email,
    sr.mindbody_id,
    sr.trial_paid_at,
    sr.first_conversion_at,
    sr.latest_conversion_at,
    GREATEST(0, EXTRACT(DAY FROM (sr.first_conversion_at - sr.trial_paid_at))::int) AS days_to_convert,
    ROUND(sr.total_cents::numeric / 100.0, 2) AS total_member_rev_usd,
    sr.sale_count::int,
    sr.packages,
    spc.utm_source,
    spc.utm_medium,
    spc.utm_campaign,
    spc.source_category
  FROM sales_rollup sr
  LEFT JOIN public.mindbody_clients c ON c.mindbody_id = sr.mindbody_id
  LEFT JOIN source_per_customer spc   ON spc.email = sr.stripe_email
  ORDER BY sr.total_cents DESC, sr.first_conversion_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_converted_members(date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_converted_members(date, text) TO anon;
