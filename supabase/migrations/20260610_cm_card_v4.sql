-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: Converted Members card v4 — fix two bugs surfaced by audit:
--
--   1. trials_dedup only pulled from stripe_paid_mirror — in-person POS
--      trials (Kassandra Reyes, Nataeliane Dossantos, Raymond Pimentel)
--      never got bridged even though their MB membership sales line up.
--   2. DISTINCT ON (studio_slug, email) collapsed direct-membership rows
--      with empty emails — killed 5 FM direct members (Sabeena, Cristino,
--      Gus, Louise, Jenifer) because they walked in without giving email.
--
-- v4 starts from trial_signups (the canonical paid + direct source) and
-- dedupes by a stable customer key that falls back to name when email's blank.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_converted_members(text, date);

CREATE FUNCTION public.get_converted_members(
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
  -- v4 source-of-truth: every trial_signup that's a paid trial OR direct
  -- membership, dedupe by stable key (email if present, else lower-name).
  all_trials AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      ts.id   AS ts_id,
      ts.name AS customer_name,
      ts.email,
      ts.phone,
      ts.payment_date AS trial_paid_at,
      ts.source_category,
      ts.mindbody_id  AS ts_mindbody_id,
      -- dedup key: email if non-empty, else normalized name
      CASE
        WHEN ts.email IS NOT NULL AND ts.email <> '' THEN lower(ts.email)
        ELSE 'name:' || regexp_replace(lower(coalesce(ts.name, '')), '\s+', ' ', 'g')
      END AS dedup_key
    FROM public.trial_signups ts
    JOIN public.locations l ON l.id = ts.location_id
    WHERE ts.deleted_at IS NULL
      AND ts.payment_date >= p_since::timestamptz
      AND (
        public.is_paid_trial_row(ts.payment_status, ts.source_category, ts.deleted_at)
        OR ts.source_category = 'direct_membership'
      )
      AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
  ),
  trials_dedup AS (
    SELECT DISTINCT ON (studio_slug, dedup_key) *
    FROM all_trials
    ORDER BY studio_slug, dedup_key, trial_paid_at ASC
  ),
  -- 4-tier MB bridge (priority order: ts.mindbody_id > email > name > prox)
  ts_mb_c AS (
    SELECT studio_slug, dedup_key, customer_name, email, trial_paid_at,
           ts_mindbody_id AS mindbody_id, 1 AS priority, 0::numeric AS tdiff
    FROM trials_dedup
    WHERE ts_mindbody_id IS NOT NULL
  ),
  email_c AS (
    SELECT td.studio_slug, td.dedup_key, td.customer_name, td.email, td.trial_paid_at,
           c.mindbody_id, 2 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_clients c
      ON td.email IS NOT NULL AND td.email <> ''
     AND lower(c.email) = lower(td.email)
  ),
  name_c AS (
    SELECT td.studio_slug, td.dedup_key, td.customer_name, td.email, td.trial_paid_at,
           c.mindbody_id, 3 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_clients c
      ON lower(c.first_name) = lower(NULLIF(split_part(td.customer_name, ' ', 1), ''))
     AND lower(c.last_name)  = lower(NULLIF(split_part(td.customer_name, ' ', -1), ''))
  ),
  prox_c AS (
    SELECT td.studio_slug, td.dedup_key, td.customer_name, td.email, td.trial_paid_at,
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
    SELECT * FROM ts_mb_c
    UNION ALL SELECT * FROM email_c
    UNION ALL SELECT * FROM name_c
    UNION ALL SELECT * FROM prox_c
  ),
  best_per_trial AS (
    SELECT DISTINCT ON (studio_slug, dedup_key)
      studio_slug, dedup_key, customer_name, email, trial_paid_at, mindbody_id, priority, tdiff
    FROM cands
    WHERE mindbody_id IS NOT NULL
    ORDER BY studio_slug, dedup_key, priority, tdiff
  ),
  final_matches AS (
    SELECT DISTINCT ON (studio_slug, mindbody_id)
      studio_slug, dedup_key, customer_name, email, trial_paid_at, mindbody_id
    FROM best_per_trial
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
     AND s.sale_date_time       >= p_since::timestamptz
     AND s.total_cents          >= 5000
     AND public.is_membership_purchase(s.item_names)
    GROUP BY fm.studio_slug, fm.customer_name, fm.email,
             fm.mindbody_id, fm.trial_paid_at
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
      AND t.email <> ''
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


-- Verification: should jump from 14 → 24 customers
SELECT studio_slug, COUNT(*) AS n, SUM(total_member_rev_usd) AS rev_usd
FROM public.get_converted_members(NULL, '2026-05-15'::date)
GROUP BY studio_slug
ORDER BY studio_slug;
