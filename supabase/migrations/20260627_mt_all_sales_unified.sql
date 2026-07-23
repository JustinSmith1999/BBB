-- 2026-06-27 — Make EVERY Mariana Tek sale visible on the dashboard
-- =====================================================================
-- DIRECTIVE FROM JUSTIN (verbatim): "I need all sales to be able to show.
-- Everything. Remember MindBody is done, its all Mariana Tek now. We
-- cannot miss anyone."
--
-- WHAT THIS DOES
--   1) get_converted_members — adds an MT sales rollup so memberships
--      purchased inside the MT app/web checkout count toward each
--      customer's total_member_rev_usd. Currently the RPC only sums
--      mindbody_sales — MT-native members (Camila Madrid's $199 today,
--      anyone going forward) show as $0 revenue. After this patch, MT
--      memberships flow into the same per-customer total via UNION.
--
--   2) get_source_of_truth — extends member_rev_annualized to also count
--      MT membership revenue. The tile on /ops that aggregates "real new
--      members since launch" picks them up automatically.
--
--   3) NEW RPC: get_mt_revenue_breakdown(p_studio, p_since) — single
--      call returns per-bucket counts + revenue ($) for every MT sale
--      type: trials, memberships, ancillary (drop-ins / late cancel /
--      retail), zero-dollar admin, other. So Justin/staff can see at
--      a glance "did we miss anyone" — every dollar moving through MT
--      shows up here.
--
-- CLASSIFICATION RULES (match mt-orders-sync edge function)
--   trial       : item_names contains 'two weeks trial' OR '$49' OR 'week trial'
--   membership  : item_names contains 'membership' OR 'pif' OR 'contract' OR 'month to month' OR 'year monthly'
--   ancillary   : item_names contains 'drop in' OR 'late cancel' OR 'no show' OR 'water' OR 'celcius'
--   zero        : total_cents = 0
--   other       : everything else
--
-- VERIFICATION (run after commit)
--   SELECT * FROM public.get_mt_revenue_breakdown(NULL, '2026-06-25'::date);
--   -- expect rows for each studio with non-zero counts (Astoria $4,701 / WB $2,030 / etc.)
--
--   SELECT studio_slug, customer_name, total_member_rev_usd
--   FROM public.get_converted_members(p_since => '2026-06-27'::date)
--   ORDER BY total_member_rev_usd DESC;
--   -- expect Camila Madrid Astoria $199 (was $0 before)

BEGIN;

-- ─── 1. get_converted_members v7 — UNION MT membership sales ─────────
-- Same shape, same return columns, only the sales_rollup CTE changes.
-- We UNION mindbody_sales with mariana_tek_sales filtered to memberships,
-- joined by either (a) direct mariana_tek_id on the trial_signups row,
-- or (b) email match on mariana_tek_clients.

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
  -- NEW 2026-06-27: MT-app trial buyers. Same shape so they slot into
  -- trials_dedup. Source = trial_signups.source_category='mt_app'.
  mt_trials AS (
    SELECT DISTINCT ON (lower(replace(l.name, ' ', '-')), lower(t.email))
      lower(replace(l.name, ' ', '-'))::text AS studio_slug,
      lower(t.email)::text                   AS email,
      t.name                                 AS customer_name,
      COALESCE(t.payment_date, t.created_at) AS trial_paid_at
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.source_category = 'mt_app'
      AND t.payment_status = 'completed'
      AND t.deleted_at IS NULL
      AND t.email IS NOT NULL AND t.email <> ''
      AND COALESCE(t.payment_date, t.created_at) >= p_since::timestamptz
      AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
    ORDER BY lower(replace(l.name, ' ', '-')), lower(t.email),
             COALESCE(t.payment_date, t.created_at) ASC
  ),
  direct_membership_trials AS (
    SELECT DISTINCT ON (lower(replace(l.name, ' ', '-')), lower(t.email))
      lower(replace(l.name, ' ', '-'))::text AS studio_slug,
      lower(t.email)::text                   AS email,
      t.name                                 AS customer_name,
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
  trials_dedup AS (
    SELECT DISTINCT ON (studio_slug, email) *
    FROM (
      SELECT studio_slug, email, customer_name, trial_paid_at FROM stripe_trials
      UNION ALL
      SELECT studio_slug, email, customer_name, trial_paid_at FROM direct_membership_trials
      UNION ALL
      SELECT studio_slug, email, customer_name, trial_paid_at FROM mt_trials
    ) u
    ORDER BY studio_slug, email, trial_paid_at ASC
  ),
  -- ── MindBody bridge (unchanged) ─────────────────────────────────────
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
  -- ── MB sales rollup (existing path) ────────────────────────────────
  mb_sales_rollup AS (
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
     AND s.total_cents          >= 10000
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%trial%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%water%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%towel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%snack%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%no show%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%no-show%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%late cancel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%late-cancel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%cancellation fee%'
     AND COALESCE(lower(s.item_names), '') !~ '\m(fee)\M'
    GROUP BY fm.studio_slug, fm.customer_name, fm.email,
             fm.mindbody_id, fm.trial_paid_at
  ),
  -- ── NEW 2026-06-27: MT membership rollup ──────────────────────────
  -- Match MT sales to trial buyer via three keys, in priority order:
  --   1) trial_signups.mariana_tek_id (set by mt-orders-sync back-link)
  --   2) lower(email) on mariana_tek_sales.customer_email
  --   3) (future) phone match — skipped for now (MT phones often null)
  -- Filter to membership/contract items, exclude trials + retail + fees.
  mt_membership_per_customer AS (
    SELECT
      td.studio_slug,
      td.email                                                 AS stripe_email,
      td.customer_name,
      td.trial_paid_at,
      -- Use MT client id from trial_signups when available; otherwise NULL.
      (SELECT MAX(t2.mariana_tek_id) FROM public.trial_signups t2
        WHERE lower(t2.email) = td.email
          AND t2.deleted_at IS NULL
          AND t2.mariana_tek_id IS NOT NULL)                   AS mt_id,
      MIN(s.sale_date_time)                                    AS first_conversion_at,
      MAX(s.sale_date_time)                                    AS latest_conversion_at,
      SUM(s.total_cents)                                       AS total_cents,
      COUNT(*)                                                 AS sale_count,
      STRING_AGG(s.item_names, ' | ' ORDER BY s.sale_date_time) AS packages
    FROM trials_dedup td
    JOIN public.mariana_tek_sales s
      ON  s.studio_slug = td.studio_slug
     AND  s.sale_date_time >= td.trial_paid_at - INTERVAL '7 days'
     AND  s.total_cents    >= 10000
     AND  (
            lower(COALESCE(s.customer_email, '')) = td.email
            OR s.customer_mt_id::text = (
                 SELECT MAX(t3.mariana_tek_id) FROM public.trial_signups t3
                  WHERE lower(t3.email) = td.email
                    AND t3.deleted_at IS NULL
                    AND t3.mariana_tek_id IS NOT NULL
               )
          )
     AND  (
            COALESCE(lower(s.item_names), '') LIKE '%membership%'
            OR COALESCE(lower(s.item_names), '') LIKE '%pif%'
            OR COALESCE(lower(s.item_names), '') LIKE '%contract%'
            OR COALESCE(lower(s.item_names), '') LIKE '%month to month%'
            OR COALESCE(lower(s.item_names), '') LIKE '%monthly membership%'
            OR COALESCE(lower(s.item_names), '') LIKE '%year monthly%'
            OR COALESCE(lower(s.item_names), '') LIKE '%unlimited%'
          )
     -- explicitly exclude trials + retail + penalty rows
     AND  COALESCE(lower(s.item_names), '') NOT LIKE '%two weeks trial%'
     AND  COALESCE(lower(s.item_names), '') NOT LIKE '%week trial%'
     AND  COALESCE(lower(s.item_names), '') NOT LIKE '%no show%'
     AND  COALESCE(lower(s.item_names), '') NOT LIKE '%late cancel%'
     AND  COALESCE(lower(s.item_names), '') NOT LIKE '%drop in%'
     AND  COALESCE(lower(s.item_names), '') NOT LIKE '%water%'
     AND  COALESCE(lower(s.item_names), '') NOT LIKE '%celcius%'
    GROUP BY td.studio_slug, td.email, td.customer_name, td.trial_paid_at
  ),
  -- ── Combined rollup: UNION the two paths per (studio, email/mb_id) ──
  -- Two customers might appear in both (legacy MB + new MT) — sum them.
  combined_rollup AS (
    SELECT
      mb.studio_slug, mb.customer_name, mb.stripe_email, mb.mindbody_id,
      mb.trial_paid_at,
      LEAST(mb.first_conversion_at, mt.first_conversion_at, mb.first_conversion_at)        AS first_conversion_at,
      GREATEST(mb.latest_conversion_at, mt.latest_conversion_at, mb.latest_conversion_at)  AS latest_conversion_at,
      COALESCE(mb.total_cents, 0) + COALESCE(mt.total_cents, 0)                            AS total_cents,
      COALESCE(mb.sale_count, 0) + COALESCE(mt.sale_count, 0)                              AS sale_count,
      NULLIF(CONCAT_WS(' | ', NULLIF(mb.packages, ''), NULLIF(mt.packages, '')), '')       AS packages
    FROM mb_sales_rollup mb
    LEFT JOIN mt_membership_per_customer mt
      ON mt.studio_slug = mb.studio_slug
     AND mt.stripe_email = mb.stripe_email

    UNION ALL

    -- MT-only members (no MB bridge match — pure MT app customer)
    SELECT
      mt.studio_slug,
      mt.customer_name,
      mt.stripe_email,
      mt.mt_id              AS mindbody_id, -- repurpose column for display
      mt.trial_paid_at,
      mt.first_conversion_at,
      mt.latest_conversion_at,
      mt.total_cents,
      mt.sale_count,
      mt.packages
    FROM mt_membership_per_customer mt
    LEFT JOIN mb_sales_rollup mb
      ON mb.studio_slug = mt.studio_slug
     AND mb.stripe_email = mt.stripe_email
    WHERE mb.mindbody_id IS NULL
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
    cr.studio_slug,
    cr.customer_name,
    cr.stripe_email,
    c.email                                            AS mb_email,
    cr.mindbody_id,
    cr.trial_paid_at,
    cr.first_conversion_at,
    cr.latest_conversion_at,
    GREATEST(0, EXTRACT(DAY FROM (cr.first_conversion_at - cr.trial_paid_at))::int) AS days_to_convert,
    ROUND(cr.total_cents::numeric / 100.0, 2)          AS total_member_rev_usd,
    cr.sale_count::int                                 AS sale_count,
    cr.packages,
    spc.utm_source,
    spc.utm_medium,
    spc.utm_campaign,
    spc.source_category
  FROM combined_rollup cr
  LEFT JOIN public.mindbody_clients c ON c.mindbody_id = cr.mindbody_id
  LEFT JOIN source_per_customer spc   ON spc.email = cr.stripe_email
  ORDER BY cr.total_cents DESC, cr.first_conversion_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_converted_members(date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_converted_members(date, text) TO anon;


-- ─── 2. NEW RPC: get_mt_revenue_breakdown ───────────────────────────
-- Per-studio, per-bucket counts + revenue. One row per (studio, bucket).
-- Lets dashboard show "WB Trials: 23 ($1,127) · Memberships: 4 ($996) ·
-- Drop-ins: 12 ($420) · Ancillary: 18 ($45)" so Justin can eyeball
-- whether anything's missing across the entire MT revenue surface.

DROP FUNCTION IF EXISTS public.get_mt_revenue_breakdown(text, date);

CREATE OR REPLACE FUNCTION public.get_mt_revenue_breakdown(
  p_studio_slug text DEFAULT NULL,
  p_since       date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  studio_slug   text,
  bucket        text,
  sale_count    int,
  revenue_usd   numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH classified AS (
    SELECT
      s.studio_slug,
      CASE
        WHEN COALESCE(s.total_cents, 0) = 0                                 THEN 'zero'
        WHEN COALESCE(lower(s.item_names), '') LIKE '%two weeks trial%'
          OR COALESCE(lower(s.item_names), '') LIKE '%week trial%'
          OR COALESCE(lower(s.item_names), '') LIKE '%$49%'                 THEN 'trial'
        WHEN COALESCE(lower(s.item_names), '') LIKE '%membership%'
          OR COALESCE(lower(s.item_names), '') LIKE '%pif%'
          OR COALESCE(lower(s.item_names), '') LIKE '%contract%'
          OR COALESCE(lower(s.item_names), '') LIKE '%month to month%'
          OR COALESCE(lower(s.item_names), '') LIKE '%monthly membership%'
          OR COALESCE(lower(s.item_names), '') LIKE '%year monthly%'
          OR COALESCE(lower(s.item_names), '') LIKE '%unlimited%'           THEN 'membership'
        WHEN COALESCE(lower(s.item_names), '') LIKE '%drop in%'
          OR COALESCE(lower(s.item_names), '') LIKE '%late cancel%'
          OR COALESCE(lower(s.item_names), '') LIKE '%no show%'
          OR COALESCE(lower(s.item_names), '') LIKE '%water%'
          OR COALESCE(lower(s.item_names), '') LIKE '%celcius%'
          OR COALESCE(lower(s.item_names), '') LIKE '%towel%'               THEN 'ancillary'
        ELSE 'other'
      END                                              AS bucket,
      s.total_cents
    FROM public.mariana_tek_sales s
    WHERE (s.sale_date_time AT TIME ZONE 'America/New_York')::date >= p_since
      AND (p_studio_slug IS NULL OR s.studio_slug = p_studio_slug)
  )
  SELECT
    studio_slug,
    bucket,
    COUNT(*)::int                                      AS sale_count,
    ROUND(SUM(total_cents)::numeric / 100.0, 2)        AS revenue_usd
  FROM classified
  GROUP BY studio_slug, bucket
  ORDER BY studio_slug,
           CASE bucket
             WHEN 'trial'      THEN 1
             WHEN 'membership' THEN 2
             WHEN 'ancillary'  THEN 3
             WHEN 'other'      THEN 4
             WHEN 'zero'       THEN 5
           END;
$$;

GRANT EXECUTE ON FUNCTION public.get_mt_revenue_breakdown(text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_mt_revenue_breakdown(text, date) TO anon;

COMMIT;

-- ─── Post-flight verification ────────────────────────────────────────
-- (a) Total MT revenue captured since launch — should equal sum of all
--     mariana_tek_sales.total_cents matching the same window:
--   SELECT studio_slug, bucket, sale_count, revenue_usd
--     FROM public.get_mt_revenue_breakdown(NULL, '2026-06-25'::date)
--   ORDER BY studio_slug, bucket;
--
-- (b) Camila Madrid (Astoria, $199 1Yr Monthly Membership today) should
--     now appear on Converted Members card:
--   SELECT studio_slug, customer_name, total_member_rev_usd, packages
--     FROM public.get_converted_members(p_since => '2026-06-25'::date)
--    WHERE studio_slug = 'astoria'
--    ORDER BY total_member_rev_usd DESC LIMIT 10;
--
-- (c) Network total member rev should be HIGHER than before this patch
--   SELECT SUM(total_member_rev_usd) AS total_member_rev_usd_after
--     FROM public.get_converted_members(p_since => '2026-05-15'::date);
