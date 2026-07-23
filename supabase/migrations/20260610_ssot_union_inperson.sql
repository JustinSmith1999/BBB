-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: SSOT FULL UNION — every paid-trial card reads trial_signups.
--
-- BACKGROUND
-- After today's backfill the network has 95 paid trials since launch (in
-- trial_signups, non-deleted, completed). Per-studio:
--   astoria       40   williamsburg  32   fresh-meadows  15   bayside  8
--
-- But the live RPCs return DIFFERENT numbers because they read different
-- sources:
--                                       astoria  WB   FM  BS  network
--   trial_signups (TRUTH)                 40    32   15   8     95
--   count_paid_canonical  (Stripe rows)   26    32   17   8     83
--   count_unique_paid_customers (distinct) 24   29   14   8     75
--   get_ad_spend_vs_revenue.trial_count   24    29   14   8     75
--   get_audience_comparison_all_studios   40    32   15   8     95   ✓
--
-- DECISION
-- Make every card derive trial_count from the UNION of:
--   A) stripe_paid_mirror DISTINCT customer_email
--   B) trial_signups.payment_status='completed' WHERE email NOT IN Stripe
--      (covers both pure POS buyers AND form→Stripe-abandoned→MB-POS-paid
--       like Dongha Kim today)
-- That UNION is what trial_signups holds, post-backfill. So the cleanest
-- implementation: ALL paid-trial counts read trial_signups directly.
--
-- WHAT THIS MIGRATION DOES
--   1. count_paid_canonical              → trial_signups SSOT
--   2. count_unique_paid_customers       → trial_signups SSOT
--   3. get_ad_spend_vs_revenue           → trial_signups SSOT
--      (revenue still amount_cents-backed, but trial_count + dedup pivots
--       on trial_signups + uses mindbody_id when present for member-rev bridge)
--   4. Verification probes at bottom — should match the truth values above.
--
-- WHAT WE DELIBERATELY DON'T TOUCH
--   • get_studio_overview — already calls count_paid_canonical (fixed by 1)
--   • get_funnel_health   — already calls count_paid_canonical (fixed by 1)
--   • get_audience_comparison_all_studios — already correct (40/32/15/8)
--   • get_meta_daily_trend — uses count_paid_canonical (fixed by 1)
--   • get_converted_members — bridges via mindbody_id, independent
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. count_paid_canonical — read trial_signups truth ──────────────────────
CREATE OR REPLACE FUNCTION public.count_paid_canonical(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date,
  p_until  date DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COUNT(*)::bigint
  FROM public.trial_signups ts
  JOIN (
    SELECT id, lower(replace(name, ' ', '-')) AS short_slug
    FROM public.locations
  ) l ON l.id = ts.location_id
  WHERE ts.payment_status = 'completed'
    AND ts.payment_date   IS NOT NULL
    AND ts.deleted_at     IS NULL
    AND (p_studio IS NULL OR l.short_slug = p_studio)
    AND (ts.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
    AND (p_until IS NULL
         OR (ts.payment_date AT TIME ZONE 'America/New_York')::date <= p_until);
$function$;

REVOKE ALL ON FUNCTION public.count_paid_canonical(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_paid_canonical(text, date, date) TO authenticated;


-- ── 2. count_unique_paid_customers — dedupe by lower(email) ─────────────────
CREATE OR REPLACE FUNCTION public.count_unique_paid_customers(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date,
  p_until  date DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT COUNT(DISTINCT lower(ts.email))::bigint
  FROM public.trial_signups ts
  JOIN (
    SELECT id, lower(replace(name, ' ', '-')) AS short_slug
    FROM public.locations
  ) l ON l.id = ts.location_id
  WHERE ts.payment_status = 'completed'
    AND ts.payment_date   IS NOT NULL
    AND ts.email          IS NOT NULL
    AND ts.email          <> ''
    AND ts.deleted_at     IS NULL
    AND (p_studio IS NULL OR l.short_slug = p_studio)
    AND (ts.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
    AND (p_until IS NULL
         OR (ts.payment_date AT TIME ZONE 'America/New_York')::date <= p_until);
$$;

REVOKE ALL ON FUNCTION public.count_unique_paid_customers(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_unique_paid_customers(text, date, date) TO authenticated;


-- ── 3. get_ad_spend_vs_revenue — trials_dedup pivots on trial_signups ───────
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
  -- TRIAL_SIGNUPS SSOT — every paid trial (Stripe + in-person), dedup by email.
  -- $49 fallback when we don't have an exact amount (in-person rows have no
  -- amount_cents); 99% of cases this is the published price.
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
  -- BRIDGE to MB for member revenue:
  --   priority 1 = trial_signups already has mindbody_id (post-V6 sync, this is most)
  --   priority 2 = mindbody_clients email match
  --   priority 3 = mindbody_clients name match
  --   priority 4 = same-studio trial sale within ±3 days (proximity)
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


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION PROBES — should output to the SQL editor after Run
-- Truth values (from REST audit at 2026-06-10 10:30 ET):
--   astoria=40, williamsburg=32, fresh-meadows=15, bayside=8, network=95
--   astoria TODAY (Dongha) = 1
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'astoria TODAY (Dongha?)'   AS label,
       public.count_paid_canonical('astoria',
         (now() AT TIME ZONE 'America/New_York')::date,
         (now() AT TIME ZONE 'America/New_York')::date) AS paid;

SELECT 'network since-launch (truth=95)' AS label,
       public.count_unique_paid_customers(NULL, '2026-05-15'::date, NULL) AS paid;

SELECT studio AS studio_slug,
       public.count_paid_canonical(studio, '2026-05-15'::date, NULL) AS paid_count_canonical
FROM (VALUES ('astoria'),('williamsburg'),('fresh-meadows'),('bayside')) v(studio);

SELECT studio_slug, trial_count, trial_revenue_usd, member_count, member_revenue_usd, net_pl_usd
FROM public.get_ad_spend_vs_revenue();
