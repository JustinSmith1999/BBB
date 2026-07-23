-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: Source of Truth migration
--
-- WHY
-- Audit found trial_signups has been catching everything: $49 web buyers,
-- $49 MB POS buyers, AND direct-membership buyers who never did a trial.
-- That last category was inflating paid-trial counts. 8 customers network-wide
-- are direct-to-membership and need to stop counting as $49 trials.
--
-- The 8 (already verified in MB + on activity sheets):
--   Astoria:      Roxanna Amaro (5/22 · 1 Year Monthly $189)
--   Williamsburg: Lauren Hernandez (6/7 · 12 Months PIF $1625)
--                 Manuela Tauscher (6/7 · 12 Months PIF $1625)
--   Fresh Meadows: Sabeena Valentin       (6/2 · 1 Year Monthly)
--                  Jenifer Blanco Hernandez (5/28 · 1 Year Monthly)
--                  Louise Karasakalides   (5/26 · 1 Year Monthly)
--                  Gus Karasakalides      (5/26 · 1 Year Monthly)
--                  Cristino Rivera        (5/20 · 3 Month Student)
--
-- WHAT
--   1. Expand source_category CHECK to allow 'direct_membership'
--   2. UPDATE those 8 rows from 'in_person' → 'direct_membership'
--   3. Build get_source_of_truth() RPC — per-studio canonical counts
--      with Stripe / MB-POS / sheet / direct-member splits
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Allow new source_category ────────────────────────────────────────────
ALTER TABLE public.trial_signups
  DROP CONSTRAINT IF EXISTS trial_signups_source_category_check;

ALTER TABLE public.trial_signups
  ADD CONSTRAINT trial_signups_source_category_check CHECK (
    source_category IS NULL OR source_category IN (
      'ad','organic','referral','direct',
      'web_organic','in_person','trial_form',
      'legacy_archived','contact_form',
      'stripe_checkout',                 -- already in live data
      'direct_membership'                -- NEW
    )
  );

-- ── 2. Reclass the 8 direct-membership buyers ───────────────────────────────
UPDATE public.trial_signups
SET source_category = 'direct_membership',
    front_desk_note = COALESCE(front_desk_note, '') ||
      CASE WHEN front_desk_note IS NULL OR front_desk_note = '' THEN '' ELSE ' · ' END ||
      'Reclassed 6/10 — never bought $49 trial, went straight to membership'
WHERE id IN (
  -- Astoria
  (SELECT id FROM public.trial_signups WHERE lower(name) LIKE 'roxanna amaro%'
      AND location_id = 'dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45' AND deleted_at IS NULL LIMIT 1),
  -- Williamsburg
  (SELECT id FROM public.trial_signups WHERE lower(name) LIKE 'lauren hernandez%'
      AND location_id = '80536b45-df0e-42d1-880c-e9301372e1cf' AND deleted_at IS NULL LIMIT 1),
  (SELECT id FROM public.trial_signups WHERE lower(name) LIKE 'manuela tausche%'
      AND location_id = '80536b45-df0e-42d1-880c-e9301372e1cf' AND deleted_at IS NULL LIMIT 1),
  -- Fresh Meadows
  (SELECT id FROM public.trial_signups WHERE lower(name) LIKE 'sabeena valentin%'
      AND location_id = '6bbbe077-bcc6-4d9d-a10b-7605c1484752' AND deleted_at IS NULL LIMIT 1),
  (SELECT id FROM public.trial_signups WHERE lower(name) LIKE 'jenifer blanco%'
      AND location_id = '6bbbe077-bcc6-4d9d-a10b-7605c1484752' AND deleted_at IS NULL LIMIT 1),
  (SELECT id FROM public.trial_signups WHERE lower(name) LIKE 'louise karasakalides%'
      AND location_id = '6bbbe077-bcc6-4d9d-a10b-7605c1484752' AND deleted_at IS NULL LIMIT 1),
  (SELECT id FROM public.trial_signups WHERE lower(name) LIKE 'gus karasakalides%'
      AND location_id = '6bbbe077-bcc6-4d9d-a10b-7605c1484752' AND deleted_at IS NULL LIMIT 1),
  (SELECT id FROM public.trial_signups WHERE lower(name) LIKE 'cristino rivera%'
      AND location_id = '6bbbe077-bcc6-4d9d-a10b-7605c1484752' AND deleted_at IS NULL LIMIT 1)
);

-- ── 3. Canonical "is this a paid trial" predicate ──────────────────────────
-- Used by all downstream paid-trial RPCs from this point forward.
-- A paid trial = trial_signups row that has payment_status='completed' AND
-- source_category IS NOT 'direct_membership' AND deleted_at IS NULL.
CREATE OR REPLACE FUNCTION public.is_paid_trial_row(
  p_payment_status text,
  p_source_category text,
  p_deleted_at timestamptz
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_payment_status = 'completed'
     AND p_deleted_at IS NULL
     AND COALESCE(p_source_category, '') <> 'direct_membership';
$$;


-- ── 4. get_source_of_truth() — the canonical per-studio scoreboard ─────────
-- Returns one row per studio with the canonical counts since launch.
-- Split by acquisition source so we can see exactly where each customer
-- came from. The "_combined" totals are what the dashboard should show.
DROP FUNCTION IF EXISTS public.get_source_of_truth(date);
CREATE FUNCTION public.get_source_of_truth(
  p_since date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  studio_slug              text,
  studio_name              text,
  -- $49 trial buyers
  paid_trials_stripe       int,    -- bought $49 via Stripe Checkout
  paid_trials_mb_pos       int,    -- bought $49 via MindBody POS (no stripe)
  paid_trials_total        int,    -- the combined number (the truth)
  trial_revenue_usd        numeric,
  -- Direct-to-membership buyers (never did $49 trial)
  direct_members           int,
  -- Converted members (came from a $49 trial → bought membership)
  converted_members        int,
  -- All members (direct + converted) and revenue (annualized)
  total_members            int,
  member_rev_annualized    numeric,
  -- Sheet visibility (how many of the trials show up on Chris/Devonte's sheet)
  trials_on_sheet          int,
  trials_off_sheet         int     -- trials we have that aren't on the sheet
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH locs AS (
    SELECT id AS location_id,
           lower(replace(name, ' ', '-')) AS slug,
           name
    FROM public.locations
  ),
  paid_trials AS (
    SELECT
      l.slug AS studio_slug,
      l.name AS studio_name,
      ts.id  AS ts_id,
      ts.name AS customer_name,
      ts.email,
      ts.phone,
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
    SELECT l.slug AS studio_slug, ts.id, ts.name, ts.email, ts.mindbody_id
    FROM public.trial_signups ts
    JOIN locs l ON l.location_id = ts.location_id
    WHERE ts.source_category = 'direct_membership'
      AND ts.deleted_at IS NULL
      AND ts.payment_date >= p_since::timestamptz
  ),
  sheet AS (
    SELECT s.studio_slug,
           regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') AS phone_digits,
           lower(coalesce(s.email, '')) AS email_lc
    FROM public.staff_sheet_entries s
    WHERE s.start_date >= p_since
  ),
  paid_trials_sheet_match AS (
    SELECT
      pt.studio_slug,
      pt.ts_id,
      EXISTS(
        SELECT 1 FROM sheet sh
        WHERE sh.studio_slug = pt.studio_slug
          AND (
            (length(regexp_replace(coalesce(pt.phone, ''), '\D', '', 'g')) >= 10
             AND regexp_replace(coalesce(pt.phone, ''), '\D', '', 'g') = sh.phone_digits)
            OR
            (pt.email IS NOT NULL AND sh.email_lc <> '' AND lower(pt.email) = sh.email_lc)
          )
      ) AS on_sheet
    FROM paid_trials pt
  )
  SELECT
    l.slug,
    l.name,
    -- Stripe trials
    COUNT(DISTINCT pt.ts_id) FILTER (
      WHERE pt.stripe_session_id IS NOT NULL
    )::int AS paid_trials_stripe,
    -- MB POS trials (no stripe session)
    COUNT(DISTINCT pt.ts_id) FILTER (
      WHERE pt.stripe_session_id IS NULL
        AND pt.source_category = 'in_person'
    )::int AS paid_trials_mb_pos,
    -- Total paid trials
    COUNT(DISTINCT pt.ts_id)::int AS paid_trials_total,
    (COUNT(DISTINCT pt.ts_id) * 49.0)::numeric AS trial_revenue_usd,
    -- Direct members
    COUNT(DISTINCT dm.id)::int AS direct_members,
    -- Converted members: paid a trial AND have an MB membership sale ≥$50
    COUNT(DISTINCT pt.ts_id) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM public.mindbody_sales ms
        WHERE ms.customer_mindbody_id = pt.mindbody_id
          AND ms.sale_date_time >= p_since::timestamptz
          AND ms.total_cents >= 5000
          AND public.is_membership_purchase(ms.item_names)
      )
    )::int AS converted_members,
    -- Total members
    (COUNT(DISTINCT dm.id)
      + COUNT(DISTINCT pt.ts_id) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM public.mindbody_sales ms
            WHERE ms.customer_mindbody_id = pt.mindbody_id
              AND ms.sale_date_time >= p_since::timestamptz
              AND ms.total_cents >= 5000
              AND public.is_membership_purchase(ms.item_names)
          )
        ))::int AS total_members,
    -- Member rev (sum of MB sales for converted + direct members) — annualized when "year" in item_names
    COALESCE((
      SELECT SUM(
        CASE
          WHEN lower(ms.item_names) LIKE '%year%' OR lower(ms.item_names) LIKE '%annual%'
            THEN ms.total_cents * 12
          ELSE ms.total_cents
        END
      )::numeric / 100
      FROM public.mindbody_sales ms
      WHERE ms.studio_slug = l.slug
        AND ms.sale_date_time >= p_since::timestamptz
        AND ms.total_cents >= 5000
        AND public.is_membership_purchase(ms.item_names)
    ), 0) AS member_rev_annualized,
    -- Sheet match counts
    COALESCE((
      SELECT COUNT(*) FROM paid_trials_sheet_match m
      WHERE m.studio_slug = l.slug AND m.on_sheet
    ), 0)::int AS trials_on_sheet,
    COALESCE((
      SELECT COUNT(*) FROM paid_trials_sheet_match m
      WHERE m.studio_slug = l.slug AND NOT m.on_sheet
    ), 0)::int AS trials_off_sheet
  FROM locs l
  LEFT JOIN paid_trials pt   ON pt.studio_slug = l.slug
  LEFT JOIN direct_members dm ON dm.studio_slug = l.slug
  GROUP BY l.slug, l.name
  ORDER BY l.slug;
$$;

REVOKE ALL ON FUNCTION public.get_source_of_truth(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_source_of_truth(date) TO authenticated;


-- ── 4b. Patch v_paid_trials_with_path so every dashboard card that reads it
--       also stops counting direct_membership rows. ───────────────────────────
-- Re-create the view from 20260610_purchase_paths.sql plus the new filter.
CREATE OR REPLACE VIEW public.v_paid_trials_with_path AS
WITH stripe_emails AS (
  SELECT DISTINCT lower(customer_email) AS email
  FROM public.stripe_paid_mirror
  WHERE customer_email IS NOT NULL AND customer_email <> ''
)
SELECT
  ts.id, ts.name, ts.email, ts.location_id,
  lower(replace(l.name, ' ', '-')) AS studio_slug,
  ts.payment_date, ts.source_category,
  ts.stripe_session_id, ts.mindbody_id, ts.front_desk_stage,
  ts.utm_source, ts.utm_medium, ts.utm_campaign,
  CASE
    WHEN ts.source_category = 'legacy_archived' THEN 'Legacy backfill'
    WHEN ts.source_category = 'in_person'       THEN 'MindBody POS (in-person)'
    WHEN lower(ts.email) IN (SELECT email FROM stripe_emails) THEN 'Stripe Checkout (web)'
    WHEN ts.stripe_session_id IS NOT NULL AND ts.mindbody_id IS NOT NULL THEN 'Form → MindBody POS'
    WHEN ts.mindbody_id IS NOT NULL THEN 'MindBody Online widget'
    ELSE 'Unknown'
  END AS purchase_path,
  CASE WHEN ts.source_category = 'in_person'
        AND ts.stripe_session_id IS NULL
        AND ts.utm_source IS NULL THEN true ELSE false END AS is_pure_walk_in,
  CASE
    WHEN ts.source_category = 'in_person' AND ts.stripe_session_id IS NULL
      THEN 'Walk-in · ' || INITCAP(lower(replace(l.name, ' ', '-')))
    WHEN ts.source_category = 'in_person' AND ts.stripe_session_id IS NOT NULL
      THEN COALESCE(INITCAP(ts.utm_source), 'Form') || ' → desk'
    WHEN ts.stripe_session_id IS NOT NULL
     AND lower(ts.email) NOT IN (SELECT email FROM stripe_emails)
     AND ts.mindbody_id IS NOT NULL
      THEN COALESCE(INITCAP(ts.utm_source), 'Form') || ' abandoned → desk'
    WHEN ts.utm_source IS NOT NULL THEN INITCAP(ts.utm_source) || ' → Stripe'
    WHEN ts.source_category = 'web_organic' THEN 'Organic → Stripe'
    WHEN ts.source_category = 'ad'          THEN 'Ad → Stripe'
    WHEN ts.source_category = 'legacy_archived' THEN 'Legacy import'
    ELSE 'Unknown origin'
  END AS lead_origin
FROM public.trial_signups ts
JOIN public.locations l ON l.id = ts.location_id
WHERE public.is_paid_trial_row(ts.payment_status, ts.source_category, ts.deleted_at)
  AND ts.payment_date IS NOT NULL;
  -- ↑ direct_membership rows are excluded via is_paid_trial_row

GRANT SELECT ON public.v_paid_trials_with_path TO authenticated;


-- ── 5. Verification probe ──────────────────────────────────────────────────
-- Expected after this migration runs:
--   astoria       paid_trials_total = 41 (was 42, -1 Roxanna)
--   williamsburg  paid_trials_total = 40 (was 42, -2 Lauren+Manuela)
--   fresh-meadows paid_trials_total = 15 (was 20, -5)
--   bayside       paid_trials_total =  8 (unchanged)
--   NETWORK paid trials = 104 (was 112)
--   NETWORK direct_members = 8

SELECT 'After-cleanup counts:' AS step;
SELECT studio_slug, paid_trials_total, paid_trials_stripe, paid_trials_mb_pos,
       direct_members, converted_members, total_members,
       ROUND(member_rev_annualized) AS member_rev_usd,
       trials_on_sheet, trials_off_sheet
FROM public.get_source_of_truth('2026-05-15'::date);
