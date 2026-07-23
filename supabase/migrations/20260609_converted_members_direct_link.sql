-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-09: get_converted_members — add direct_link_c candidate matcher.
--
-- WHY: The 3 existing matchers (email, name, sale-proximity) all fail when
-- the Stripe-paid email differs from the MindBody account email. Example
-- found 6/9: Hannah Turner paid as media.hjt@gmail.com but her MB contact
-- email is hannahjaneturner12@gmail.com. The email-join misses her entirely.
--
-- Williamsburg diagnostic showed only 6 of 26 paid-trial emails ever match
-- in mindbody_clients by email. The other 20 may genuinely not be in MB,
-- but a chunk are almost certainly email-mismatches like Hannah.
--
-- FIX: When stripe-webhook successfully resolves a trial_signup to its MB
-- client_id (now done by the layered lookup in mindbody-create-trial-client),
-- it writes that ID to trial_signups.mindbody_id. This is the AUTHORITATIVE
-- link — much more reliable than guessing from email/name/proximity. The
-- RPC should consult it first.
--
-- New priority 0 candidate `direct_link_c` joins:
--   stripe_paid_mirror.customer_email
--     → trial_signups.email
--     → trial_signups.mindbody_id (the canonical link)
--
-- This catches:
--   - Hannah-style email-mismatch cases (her stripe email = trial_signups
--     email = media.hjt, and trial_signups.mindbody_id = 100012489 points
--     directly to the MB record regardless of MB's contact email)
--   - All our 4 manually-backfilled Williamsburg/Astoria customers
--   - Future returning customers caught by the new local-email + local-phone
--     duplicate-detection layers in mindbody-create-trial-client
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
  -- ── NEW priority-0 matcher ────────────────────────────────────────────
  -- Use the canonical trial_signups.mindbody_id link when available. This
  -- catches email-mismatch cases the other 3 matchers miss.
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
     AND s.sale_date_time       >= fm.trial_paid_at
     AND s.total_cents          >= 1000
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%trial%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%water%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%towel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%snack%'
    GROUP BY fm.studio_slug, fm.customer_name, fm.email,
             fm.mindbody_id, fm.trial_paid_at
  ),
  -- Pick the most-recent paid trial_signups row per customer email so we
  -- can pull its utm_source/medium/campaign.
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

-- Sanity probe — row count per studio, with the new direct_link_c included
SELECT studio_slug, count(*) AS converted_count
FROM public.get_converted_members()
GROUP BY studio_slug
ORDER BY studio_slug;
