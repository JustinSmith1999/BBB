-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: Re-sort /homebase board based on actual MB activity.
--
-- AUDIT FINDING
-- 25 paid trial customers are marked "lost" on /homebase but the MB data
-- says they took classes or became members:
--   • 3 became members but show as lost (Kassandra Reyes $169, Nataeliane
--     Dossantos $179, Yueyi Zhou $150 — all Astoria)
--   • 22 took 1+ classes but show as lost (Kelly Jorge 6 classes, Cambria
--     Ford 12, Mary K 9, etc.)
-- The auto-expire logic was age-based, not MB-activity-based.
--
-- ALSO: 8 direct-membership reclasses removed those customers from the
-- Converted Members card. Need to UNION them back in.
--
-- This migration:
--   1. Resorts front_desk_stage based on canonical MB data
--   2. Patches get_converted_members to UNION in direct_membership rows
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Resort front_desk_stage based on MB activity ─────────────────────────
-- Anyone with a real membership sale in MB → member.
-- Anyone with at least one signed_in visit → at least 'attended'.
-- We only OVERRIDE 'lost' / 'new_lead' / null stages.
-- We never demote ('paid' stays 'paid' if no visits yet, etc.).
WITH mb_activity AS (
  SELECT
    ts.id AS ts_id,
    ts.mindbody_id,
    -- Member if any membership purchase ≥$50 since launch
    EXISTS(
      SELECT 1 FROM public.mindbody_sales ms
      WHERE ms.customer_mindbody_id = ts.mindbody_id
        AND ms.sale_date_time >= '2026-05-15'::timestamptz
        AND ms.total_cents >= 5000
        AND public.is_membership_purchase(ms.item_names)
    ) AS is_member,
    -- Attended if any signed_in visit
    EXISTS(
      SELECT 1 FROM public.mindbody_visits mv
      WHERE mv.mindbody_client_id = ts.mindbody_id
        AND mv.signed_in IS TRUE
        AND mv.starts_at >= '2026-05-15'::timestamptz
    ) AS attended
  FROM public.trial_signups ts
  WHERE ts.payment_status = 'completed'
    AND ts.payment_date >= '2026-05-15'::timestamptz
    AND ts.deleted_at IS NULL
    AND ts.mindbody_id IS NOT NULL
)
UPDATE public.trial_signups ts
SET front_desk_stage = CASE
    WHEN m.is_member THEN 'member'
    WHEN m.attended  THEN 'attended'
    ELSE ts.front_desk_stage
  END
FROM mb_activity m
WHERE ts.id = m.ts_id
  AND (m.is_member OR m.attended)
  AND (ts.front_desk_stage IS NULL
       OR ts.front_desk_stage IN ('lost','new_lead','contacted','booked','paid'));


-- ── 2. Patch get_converted_members to include direct_membership rows ────────
-- After the 6/10 reclass, the 8 direct-membership buyers (Lauren Hernandez,
-- Manuela Tauscher, Roxanna Amaro, etc.) vanished from the Converted Members
-- card because that RPC starts from stripe_paid_mirror and they never had a
-- Stripe $49 trial. Extend trials_dedup to UNION direct_memberships in.

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
  -- Existing: $49 trial buyers (from Stripe mirror)
  stripe_trials AS (
    SELECT DISTINCT ON (studio_slug, lower(customer_email))
      studio_slug, lower(customer_email)::text AS email,
      customer_name, paid_at AS trial_paid_at
    FROM public.stripe_paid_mirror
    WHERE paid_at >= p_since::timestamptz
      AND customer_email IS NOT NULL AND customer_email <> ''
      AND (p_studio_slug IS NULL OR studio_slug = p_studio_slug)
    ORDER BY studio_slug, lower(customer_email), paid_at ASC
  ),
  -- NEW: direct-membership buyers (no Stripe trial, walked straight in)
  direct_trials AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      lower(coalesce(ts.email, ''))    AS email,
      ts.name                          AS customer_name,
      ts.payment_date                  AS trial_paid_at
    FROM public.trial_signups ts
    JOIN public.locations l ON l.id = ts.location_id
    WHERE ts.source_category = 'direct_membership'
      AND ts.deleted_at IS NULL
      AND ts.payment_date >= p_since::timestamptz
      AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
  ),
  trials_dedup AS (
    SELECT * FROM stripe_trials
    UNION ALL
    SELECT * FROM direct_trials
  ),
  email_c AS (
    SELECT td.studio_slug, td.email, td.customer_name, td.trial_paid_at,
           c.mindbody_id, 1 AS priority, 0::numeric AS tdiff
    FROM trials_dedup td
    JOIN public.mindbody_clients c ON lower(c.email) = td.email
    WHERE td.email <> ''
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
  -- NEW 4th tier: direct trial_signups.mindbody_id linkage
  direct_c AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      lower(coalesce(ts.email, ''))    AS email,
      ts.name                          AS customer_name,
      ts.payment_date                  AS trial_paid_at,
      ts.mindbody_id,
      4 AS priority,
      0::numeric AS tdiff
    FROM public.trial_signups ts
    JOIN public.locations l ON l.id = ts.location_id
    WHERE ts.source_category = 'direct_membership'
      AND ts.deleted_at IS NULL
      AND ts.mindbody_id IS NOT NULL
      AND ts.payment_date >= p_since::timestamptz
      AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
  ),
  cands AS (
    SELECT * FROM email_c
    UNION ALL SELECT * FROM name_c
    UNION ALL SELECT * FROM prox_c
    UNION ALL SELECT * FROM direct_c
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


-- ── 3. Verification: how did the re-sort change the board? ──────────────────
SELECT
  CASE
    WHEN l.name IS NULL THEN '?'
    ELSE l.name
  END AS studio,
  ts.front_desk_stage,
  COUNT(*) AS n
FROM public.trial_signups ts
JOIN public.locations l ON l.id = ts.location_id
WHERE ts.payment_status = 'completed'
  AND ts.payment_date >= '2026-05-15'::timestamptz
  AND ts.deleted_at IS NULL
GROUP BY l.name, ts.front_desk_stage
ORDER BY l.name, ts.front_desk_stage;
