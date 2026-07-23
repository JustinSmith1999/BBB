-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10 (v2): Fix three accuracy issues in get_source_of_truth():
--
--   1. converted_members under-counted — aligned to get_converted_members'
--      4-tier match (mindbody_id, email, normalized name) instead of just
--      direct mindbody_id.
--   2. On-sheet count under-counted — phone normalization now strips leading
--      "1" from 11-digit US numbers so "+19173499826" matches "9173499826".
--   3. Member rev over-annualized — PIF / "paid in full" / "annual contract"
--      packages were getting ×12 alongside monthly packages. Now ONLY packages
--      whose item_names contains 'monthly' (and 'year' or 'annual') get ×12.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_source_of_truth(date);

CREATE FUNCTION public.get_source_of_truth(
  p_since date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  studio_slug              text,
  studio_name              text,
  paid_trials_stripe       int,
  paid_trials_mb_pos       int,
  paid_trials_total        int,
  trial_revenue_usd        numeric,
  direct_members           int,
  converted_members        int,
  total_members            int,
  member_rev_annualized    numeric,
  trials_on_sheet          int,
  trials_off_sheet         int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH locs AS (
    SELECT id AS location_id,
           lower(replace(name, ' ', '-')) AS slug,
           name
    FROM public.locations
  ),
  -- Reusable phone-normalize: digits-only, strip leading "1" if 11 digits
  -- (matches BBB customer base where everyone is in NANP).
  paid_trials AS (
    SELECT
      l.slug AS studio_slug,
      ts.id  AS ts_id,
      ts.name AS customer_name,
      ts.email,
      CASE
        WHEN length(regexp_replace(coalesce(ts.phone, ''), '\D', '', 'g')) = 11
         AND left(regexp_replace(coalesce(ts.phone, ''), '\D', '', 'g'), 1) = '1'
          THEN right(regexp_replace(coalesce(ts.phone, ''), '\D', '', 'g'), 10)
        ELSE regexp_replace(coalesce(ts.phone, ''), '\D', '', 'g')
      END AS phone10,
      ts.source_category,
      ts.stripe_session_id,
      ts.mindbody_id,
      ts.payment_date
    FROM public.trial_signups ts
    JOIN locs l ON l.location_id = ts.location_id
    WHERE public.is_paid_trial_row(ts.payment_status, ts.source_category, ts.deleted_at)
      AND (ts.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
  ),
  direct_members AS (
    SELECT l.slug AS studio_slug, ts.id, ts.name
    FROM public.trial_signups ts
    JOIN locs l ON l.location_id = ts.location_id
    WHERE ts.source_category = 'direct_membership'
      AND ts.deleted_at IS NULL
      AND ts.payment_date >= p_since::timestamptz
  ),
  -- Sheet rows normalized the same way
  sheet AS (
    SELECT s.studio_slug,
           CASE
             WHEN length(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) = 11
              AND left(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'), 1) = '1'
               THEN right(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'), 10)
             ELSE regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')
           END AS phone10,
           lower(coalesce(s.email, '')) AS email_lc
    FROM public.staff_sheet_entries s
    WHERE s.start_date >= p_since
  ),
  -- 4-tier converted-members match (aligns with get_converted_members):
  --   tier 1: direct mindbody_id linkage on trial_signups
  --   tier 2: email match against mindbody_clients
  --   tier 3: normalized name match against mindbody_clients
  --   then verify a membership sale exists for that mindbody_id since launch.
  membership_sales_per_studio AS (
    SELECT ms.studio_slug,
           ms.customer_mindbody_id,
           SUM(
             CASE
               WHEN lower(coalesce(ms.item_names, '')) LIKE '%monthly%'
                AND (lower(coalesce(ms.item_names, '')) LIKE '%year%'
                  OR lower(coalesce(ms.item_names, '')) LIKE '%annual%'
                  OR lower(coalesce(ms.item_names, '')) LIKE '%12 month%')
                 THEN ms.total_cents * 12
               ELSE ms.total_cents
             END
           ) AS rev_cents
    FROM public.mindbody_sales ms
    WHERE ms.sale_date_time >= p_since::timestamptz
      AND ms.total_cents >= 5000
      AND public.is_membership_purchase(ms.item_names)
    GROUP BY ms.studio_slug, ms.customer_mindbody_id
  ),
  ts_match_mb_ids AS (
    -- For each paid_trial, find the matched mindbody_id via 3 tiers
    SELECT
      pt.studio_slug,
      pt.ts_id,
      COALESCE(
        pt.mindbody_id,
        (SELECT mc.mindbody_id FROM public.mindbody_clients mc
          WHERE lower(mc.email) = lower(pt.email)
            AND mc.studio_slug = pt.studio_slug
          LIMIT 1),
        (SELECT mc.mindbody_id FROM public.mindbody_clients mc
          WHERE regexp_replace(lower(coalesce(mc.first_name,'') || coalesce(mc.last_name,'')), '[^a-z]', '', 'g')
              = regexp_replace(lower(pt.customer_name), '[^a-z]', '', 'g')
            AND mc.studio_slug = pt.studio_slug
          LIMIT 1)
      ) AS mb_id
    FROM paid_trials pt
  ),
  converted AS (
    SELECT DISTINCT t.studio_slug, t.ts_id
    FROM ts_match_mb_ids t
    JOIN membership_sales_per_studio m
      ON m.studio_slug = t.studio_slug
     AND m.customer_mindbody_id = t.mb_id
    WHERE t.mb_id IS NOT NULL
  ),
  -- Sheet match per paid_trial
  paid_trials_sheet_match AS (
    SELECT
      pt.studio_slug,
      pt.ts_id,
      EXISTS(
        SELECT 1 FROM sheet sh
        WHERE sh.studio_slug = pt.studio_slug
          AND (
            (length(pt.phone10) = 10 AND pt.phone10 = sh.phone10)
            OR
            (pt.email IS NOT NULL AND sh.email_lc <> '' AND lower(pt.email) = sh.email_lc)
          )
      ) AS on_sheet
    FROM paid_trials pt
  )
  SELECT
    l.slug,
    l.name,
    COUNT(DISTINCT pt.ts_id) FILTER (
      WHERE pt.stripe_session_id IS NOT NULL
    )::int AS paid_trials_stripe,
    COUNT(DISTINCT pt.ts_id) FILTER (
      WHERE pt.stripe_session_id IS NULL
        AND pt.source_category = 'in_person'
    )::int AS paid_trials_mb_pos,
    COUNT(DISTINCT pt.ts_id)::int AS paid_trials_total,
    (COUNT(DISTINCT pt.ts_id) * 49.0)::numeric AS trial_revenue_usd,
    COUNT(DISTINCT dm.id)::int AS direct_members,
    COALESCE((SELECT COUNT(*) FROM converted c WHERE c.studio_slug = l.slug), 0)::int AS converted_members,
    (COUNT(DISTINCT dm.id)
      + COALESCE((SELECT COUNT(*) FROM converted c WHERE c.studio_slug = l.slug), 0))::int AS total_members,
    COALESCE((
      SELECT SUM(rev_cents)::numeric / 100
      FROM membership_sales_per_studio m WHERE m.studio_slug = l.slug
    ), 0) AS member_rev_annualized,
    COALESCE((
      SELECT COUNT(*) FROM paid_trials_sheet_match m
      WHERE m.studio_slug = l.slug AND m.on_sheet
    ), 0)::int AS trials_on_sheet,
    COALESCE((
      SELECT COUNT(*) FROM paid_trials_sheet_match m
      WHERE m.studio_slug = l.slug AND NOT m.on_sheet
    ), 0)::int AS trials_off_sheet
  FROM locs l
  LEFT JOIN paid_trials pt    ON pt.studio_slug = l.slug
  LEFT JOIN direct_members dm ON dm.studio_slug = l.slug
  GROUP BY l.slug, l.name
  ORDER BY l.slug;
$$;

REVOKE ALL ON FUNCTION public.get_source_of_truth(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_source_of_truth(date) TO authenticated;


-- Verification
SELECT studio_slug, paid_trials_total, paid_trials_stripe, paid_trials_mb_pos,
       direct_members, converted_members, total_members,
       ROUND(member_rev_annualized) AS member_rev_usd,
       trials_on_sheet, trials_off_sheet
FROM public.get_source_of_truth('2026-05-15'::date);
