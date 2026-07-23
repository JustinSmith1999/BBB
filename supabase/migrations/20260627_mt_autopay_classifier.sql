-- 2026-06-27 — Distinguish first-time membership signup vs autopay renewal
-- =====================================================================
-- BUG FOUND VIA LIVE QA OF MT ADMIN:
--   MT admin Orders - Local Time report shows 106 orders for 6/24-6/27.
--   Our /api/orders/ endpoint returns 97 orders total since cutover.
--   On inspection ALL 106 in MT admin are dated 12:05 AM 6/26 with product
--   SKU = "year-monthly-m-memberships-624" (1-year-monthly cohort) and
--   "months-monthly-memberships-451" (multi-month cohort). These are
--   AUTOPAY RENEWAL BATCH charges — MT bills every customer on their
--   monthly commitment at midnight.
--
--   Our get_mt_revenue_breakdown was treating EVERY membership line as a
--   NEW signup. This over-counted "new memberships" by including monthly
--   recurring charges from existing members. Same issue in get_converted_
--   members seed — pulling autopay renewals as if they were new members.
--
-- FIX
--   At read time (not write time — keeps mariana_tek_sales as raw truth),
--   for each membership-classified sale, check if this customer has any
--   PRIOR membership sale at the same studio. If yes → bucket='autopay'.
--   If no → bucket='membership' (real new signup).
--
--   Same logic also applied to converted-members seed so autopay renewals
--   don't pollute the Converted Members card.
--
-- VERIFICATION (run after commit):
--   SELECT * FROM public.get_mt_revenue_breakdown(NULL, '2026-06-25'::date)
--   ORDER BY studio_slug, bucket;
--   Expect new "autopay" bucket; "membership" bucket should drop sharply.

BEGIN;

-- ── 1. get_mt_revenue_breakdown v2: 'autopay' as 6th bucket ──────────
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
      s.customer_mt_id,
      s.sale_date_time,
      CASE
        WHEN COALESCE(s.total_cents, 0) = 0                                 THEN 'zero'
        -- Trial detection first (specific). $49 Two Weeks Trial is technically
        -- a "Membership Contract" in MT, but we want it bucketed as a trial.
        WHEN COALESCE(lower(s.item_names), '') LIKE '%two weeks trial%'
          OR COALESCE(lower(s.item_names), '') LIKE '%week trial%'
          OR COALESCE(lower(s.item_names), '') LIKE '%$49%'                 THEN 'trial'
        -- Membership-classified rows need autopay-vs-new distinction below.
        WHEN COALESCE(lower(s.item_names), '') LIKE '%membership%'
          OR COALESCE(lower(s.item_names), '') LIKE '%pif%'
          OR COALESCE(lower(s.item_names), '') LIKE '%contract%'
          OR COALESCE(lower(s.item_names), '') LIKE '%month to month%'
          OR COALESCE(lower(s.item_names), '') LIKE '%monthly membership%'
          OR COALESCE(lower(s.item_names), '') LIKE '%year monthly%'
          OR COALESCE(lower(s.item_names), '') LIKE '%unlimited%'           THEN 'membership_or_autopay'
        WHEN COALESCE(lower(s.item_names), '') LIKE '%drop in%'
          OR COALESCE(lower(s.item_names), '') LIKE '%late cancel%'
          OR COALESCE(lower(s.item_names), '') LIKE '%no show%'
          OR COALESCE(lower(s.item_names), '') LIKE '%water%'
          OR COALESCE(lower(s.item_names), '') LIKE '%celcius%'
          OR COALESCE(lower(s.item_names), '') LIKE '%towel%'               THEN 'ancillary'
        ELSE 'other'
      END                                              AS raw_bucket,
      s.total_cents
    FROM public.mariana_tek_sales s
    WHERE (s.sale_date_time AT TIME ZONE 'America/New_York')::date >= p_since
      AND (p_studio_slug IS NULL OR s.studio_slug = p_studio_slug)
  ),
  -- Split membership_or_autopay into 'autopay' vs 'membership' based on
  -- whether this customer has a PRIOR membership/contract sale at the
  -- same studio. First-time = new signup. Second+ = autopay renewal.
  bucketed AS (
    SELECT
      c.studio_slug,
      c.total_cents,
      CASE
        WHEN c.raw_bucket <> 'membership_or_autopay' THEN c.raw_bucket
        WHEN c.customer_mt_id IS NULL                THEN 'membership'
        WHEN EXISTS (
          SELECT 1
            FROM public.mariana_tek_sales s2
           WHERE s2.customer_mt_id = c.customer_mt_id
             AND s2.studio_slug    = c.studio_slug
             AND s2.sale_date_time < c.sale_date_time
             AND (
                COALESCE(lower(s2.item_names), '') LIKE '%membership%'
                OR COALESCE(lower(s2.item_names), '') LIKE '%pif%'
                OR COALESCE(lower(s2.item_names), '') LIKE '%contract%'
                OR COALESCE(lower(s2.item_names), '') LIKE '%month to month%'
                OR COALESCE(lower(s2.item_names), '') LIKE '%monthly membership%'
                OR COALESCE(lower(s2.item_names), '') LIKE '%year monthly%'
                OR COALESCE(lower(s2.item_names), '') LIKE '%unlimited%'
             )
             AND COALESCE(lower(s2.item_names), '') NOT LIKE '%two weeks trial%'
             AND COALESCE(lower(s2.item_names), '') NOT LIKE '%week trial%'
        ) THEN 'autopay'
        ELSE 'membership'
      END AS bucket
    FROM classified c
  )
  SELECT
    studio_slug,
    bucket,
    COUNT(*)::int                                      AS sale_count,
    ROUND(SUM(total_cents)::numeric / 100.0, 2)        AS revenue_usd
  FROM bucketed
  GROUP BY studio_slug, bucket
  ORDER BY studio_slug,
           CASE bucket
             WHEN 'trial'      THEN 1
             WHEN 'membership' THEN 2
             WHEN 'autopay'    THEN 3
             WHEN 'ancillary'  THEN 4
             WHEN 'other'      THEN 5
             WHEN 'zero'       THEN 6
           END;
$$;

GRANT EXECUTE ON FUNCTION public.get_mt_revenue_breakdown(text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_mt_revenue_breakdown(text, date) TO anon;

-- ── 2. get_converted_members v9 — exclude autopay from direct_mt_members
-- Previous version seeded EVERY MT membership sale as a "new member". This
-- pulled autopay renewals into the Converted Members card. Patch: in the
-- direct_mt_members CTE, only seed customers whose FIRST membership sale
-- at the studio is this row (no prior). For each customer, that's a single
-- row — the actual signup event.

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
  -- ── PATCHED 2026-06-27 — only seed FIRST membership sale per customer ──
  -- DISTINCT ON (studio, email) ordered by sale_date_time ASC gives us
  -- the earliest membership sale for each customer — the signup event.
  -- Subsequent monthly autopay charges are excluded from the seed.
  direct_mt_members AS (
    SELECT DISTINCT ON (s.studio_slug, lower(COALESCE(s.customer_email, '')))
      s.studio_slug                                                                AS studio_slug,
      lower(COALESCE(s.customer_email, ''))::text                                  AS email,
      NULLIF(TRIM(CONCAT_WS(' ', s.customer_first_name, s.customer_last_name)),'') AS customer_name,
      s.sale_date_time                                                              AS trial_paid_at
    FROM public.mariana_tek_sales s
    WHERE (s.sale_date_time AT TIME ZONE 'America/New_York')::date >= p_since
      AND s.customer_email IS NOT NULL AND s.customer_email <> ''
      AND s.total_cents >= 10000
      AND (
        COALESCE(lower(s.item_names), '') LIKE '%membership%'
        OR COALESCE(lower(s.item_names), '') LIKE '%pif%'
        OR COALESCE(lower(s.item_names), '') LIKE '%contract%'
        OR COALESCE(lower(s.item_names), '') LIKE '%month to month%'
        OR COALESCE(lower(s.item_names), '') LIKE '%monthly membership%'
        OR COALESCE(lower(s.item_names), '') LIKE '%year monthly%'
        OR COALESCE(lower(s.item_names), '') LIKE '%unlimited%'
      )
      AND COALESCE(lower(s.item_names), '') NOT LIKE '%two weeks trial%'
      AND COALESCE(lower(s.item_names), '') NOT LIKE '%week trial%'
      AND COALESCE(lower(s.item_names), '') NOT LIKE '%no show%'
      AND COALESCE(lower(s.item_names), '') NOT LIKE '%late cancel%'
      AND COALESCE(lower(s.item_names), '') NOT LIKE '%drop in%'
      AND (p_studio_slug IS NULL OR s.studio_slug = p_studio_slug)
      -- AUTOPAY EXCLUSION: only include this row if customer has NO prior
      -- membership sale at this studio. The DISTINCT ON ASC already returns
      -- earliest per customer, but we double-check there's no earlier one
      -- before the p_since window either (would mean they were a member
      -- before the window started — not a new convert).
      AND NOT EXISTS (
        SELECT 1
          FROM public.mariana_tek_sales s2
         WHERE s2.customer_mt_id = s.customer_mt_id
           AND s2.customer_mt_id IS NOT NULL
           AND s2.studio_slug    = s.studio_slug
           AND s2.sale_date_time < s.sale_date_time
           AND (
             COALESCE(lower(s2.item_names), '') LIKE '%membership%'
             OR COALESCE(lower(s2.item_names), '') LIKE '%pif%'
             OR COALESCE(lower(s2.item_names), '') LIKE '%contract%'
             OR COALESCE(lower(s2.item_names), '') LIKE '%month to month%'
             OR COALESCE(lower(s2.item_names), '') LIKE '%monthly membership%'
             OR COALESCE(lower(s2.item_names), '') LIKE '%year monthly%'
             OR COALESCE(lower(s2.item_names), '') LIKE '%unlimited%'
           )
           AND COALESCE(lower(s2.item_names), '') NOT LIKE '%two weeks trial%'
           AND COALESCE(lower(s2.item_names), '') NOT LIKE '%week trial%'
      )
    ORDER BY s.studio_slug, lower(COALESCE(s.customer_email, '')), s.sale_date_time ASC
  ),
  trials_dedup AS (
    SELECT DISTINCT ON (studio_slug, email) *
    FROM (
      SELECT studio_slug, email, customer_name, trial_paid_at FROM stripe_trials
      UNION ALL
      SELECT studio_slug, email, customer_name, trial_paid_at FROM direct_membership_trials
      UNION ALL
      SELECT studio_slug, email, customer_name, trial_paid_at FROM mt_trials
      UNION ALL
      SELECT studio_slug, email, customer_name, trial_paid_at FROM direct_mt_members
    ) u
    WHERE email IS NOT NULL AND email <> ''
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
  -- MT membership rollup — sum ALL membership sales for the matched customer
  -- (including autopays, since those ARE real revenue from that member).
  -- The autopay filter only applies to the SEED, not the rollup.
  mt_sales_rollup AS (
    SELECT
      td.studio_slug,
      td.customer_name,
      td.email                                  AS stripe_email,
      td.trial_paid_at,
      MIN(s.sale_date_time)                     AS first_conversion_at,
      MAX(s.sale_date_time)                     AS latest_conversion_at,
      SUM(s.total_cents)                        AS total_cents,
      COUNT(*)                                  AS sale_count,
      STRING_AGG(s.item_names, ' | ' ORDER BY s.sale_date_time) AS packages
    FROM trials_dedup td
    JOIN public.mariana_tek_sales s
      ON s.studio_slug = td.studio_slug
     AND lower(COALESCE(s.customer_email, '')) = td.email
     AND s.sale_date_time >= td.trial_paid_at - INTERVAL '7 days'
     AND s.total_cents    >= 10000
     AND (
       COALESCE(lower(s.item_names), '') LIKE '%membership%'
       OR COALESCE(lower(s.item_names), '') LIKE '%pif%'
       OR COALESCE(lower(s.item_names), '') LIKE '%contract%'
       OR COALESCE(lower(s.item_names), '') LIKE '%month to month%'
       OR COALESCE(lower(s.item_names), '') LIKE '%monthly membership%'
       OR COALESCE(lower(s.item_names), '') LIKE '%year monthly%'
       OR COALESCE(lower(s.item_names), '') LIKE '%unlimited%'
     )
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%two weeks trial%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%week trial%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%no show%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%late cancel%'
     AND COALESCE(lower(s.item_names), '') NOT LIKE '%drop in%'
    GROUP BY td.studio_slug, td.customer_name, td.email, td.trial_paid_at
  ),
  combined_rollup AS (
    SELECT
      COALESCE(mb.studio_slug, mt.studio_slug)        AS studio_slug,
      COALESCE(mb.customer_name, mt.customer_name)    AS customer_name,
      COALESCE(mb.stripe_email, mt.stripe_email)      AS stripe_email,
      mb.mindbody_id                                  AS mindbody_id,
      COALESCE(mb.trial_paid_at, mt.trial_paid_at)    AS trial_paid_at,
      LEAST(COALESCE(mb.first_conversion_at, mt.first_conversion_at),
            COALESCE(mt.first_conversion_at, mb.first_conversion_at))   AS first_conversion_at,
      GREATEST(COALESCE(mb.latest_conversion_at, mt.latest_conversion_at),
               COALESCE(mt.latest_conversion_at, mb.latest_conversion_at)) AS latest_conversion_at,
      COALESCE(mb.total_cents, 0) + COALESCE(mt.total_cents, 0)         AS total_cents,
      COALESCE(mb.sale_count, 0)  + COALESCE(mt.sale_count, 0)          AS sale_count,
      NULLIF(CONCAT_WS(' | ', NULLIF(mb.packages, ''), NULLIF(mt.packages, '')), '')   AS packages
    FROM mb_sales_rollup mb
    FULL OUTER JOIN mt_sales_rollup mt
      ON mt.studio_slug  = mb.studio_slug
     AND mt.stripe_email = mb.stripe_email
    WHERE (COALESCE(mb.total_cents,0) + COALESCE(mt.total_cents,0)) > 0
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
    COALESCE(spc.source_category, 'mt_direct_member') AS source_category
  FROM combined_rollup cr
  LEFT JOIN public.mindbody_clients c ON c.mindbody_id = cr.mindbody_id
  LEFT JOIN source_per_customer spc   ON spc.email = cr.stripe_email
  ORDER BY cr.total_cents DESC, cr.first_conversion_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_converted_members(date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_converted_members(date, text) TO anon;

COMMIT;

-- ─── Post-flight verification ────────────────────────────────────────
-- (a) Breakdown should show 'autopay' as new bucket, 'membership' count lower:
--   SELECT * FROM public.get_mt_revenue_breakdown(NULL, '2026-06-25');
--
-- (b) Converted Members card row count should DROP (autopay renewals removed):
--   SELECT COUNT(*) FROM public.get_converted_members(p_since => '2026-06-25');
--   Expected: ~5-10 (not 30 — autopay renewals filtered out)
--
-- (c) Bayside today (was 6 false-positive new memberships at 4:05 AM):
--   SELECT * FROM public.get_mt_revenue_breakdown('bayside', '2026-06-27');
--   Expected: membership=0 (or very low), autopay=6 (the 4:05 AM batch)
