-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: get_converted_members — add utm_source per converted member.
--
-- Justin: "We need to be able to track what lead source led to which
-- conversion." Per-row utm_source so the dashboard Converted Members table
-- can show a Source column (Website / Instagram / Facebook / Meta Ads / etc).
--
-- Source-of-truth for utm_source is trial_signups.utm_source. We join the
-- converted-members output to trial_signups by email and pick the most
-- recent paid row (a customer can have multiple rows — pending duplicate
-- form fills, or a paid row from each campaign). most-recent-paid wins.
--
-- Current data on the 8 converted members (live, 6/4):
--   Astoria   · Fabiola Martinez   · utm_source=facebook  utm_medium=cpc
--   Astoria   · Elisabete Viveiros · NULL (web_organic)
--   Astoria   · Helena Vojak       · NULL
--   Astoria   · Yueyi Zhou         · NULL (web_organic)
--   Bayside   · Mariana Castano    · utm_source=ads
--   Bayside   · Yi Jiang           · utm_source=ads
--   FM        · Henessey Perez     · utm_source=ads
--   FM        · Varsha Srivastava  · utm_source=instagram
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
  packages                text,
  utm_source              text,
  utm_medium              text,
  utm_campaign            text
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
  ),
  -- NEW: pick the most-recent paid trial_signups row per customer email
  -- so we can pull its utm_source/medium/campaign. Customers may have
  -- multiple rows (form-fill dupes, repeat payers) — most recent paid wins.
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
    spc.utm_campaign
  FROM sales_rollup sr
  LEFT JOIN public.mindbody_clients c ON c.mindbody_id = sr.mindbody_id
  LEFT JOIN source_per_customer spc   ON spc.email = sr.stripe_email
  ORDER BY sr.total_cents DESC, sr.first_conversion_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_converted_members(text, date) TO authenticated;

-- Sanity probe — 8 rows, source populated for 5 of them.
SELECT studio_slug, customer_name, utm_source, utm_medium, utm_campaign,
       total_member_rev_usd
FROM public.get_converted_members()
ORDER BY studio_slug, customer_name;
