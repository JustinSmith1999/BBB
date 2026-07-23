-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-07-02 — QA data-trust fixes for the owner dashboard (/dashboard)
--
-- Fixes four verified live bugs:
--
--   1. CONVERSION RATE > 100% (Astoria showed 133%, "65 from trial · 0 direct")
--      get_converted_members seeds direct-membership signups (MT direct members,
--      walk-in direct memberships) with trial_paid_at = their MEMBERSHIP sale
--      time, so the client check Boolean(trial_paid_at) classified EVERY member
--      as "from trial". Fix: expose an explicit `from_trial` boolean — true ONLY
--      when there is evidence of a real $49/$29 trial payment (Stripe mirror,
--      MB trial sale, MT trial sale, or completed mt_app trial signup) dated at
--      or before the member's first membership purchase. Everyone else = direct.
--
--   2. TODAY TILE counted arbitrary charges ("Today: $5 · 1 Paid" — $5 is not a
--      $49/$29 product). get_daily_pulse counted every trial_signups row with
--      payment_status='completed', with no product/amount check. Fix: new
--      canonical helper trial_paid_amount_cents() — returns the trial amount in
--      cents (4900/2900) only when the payment is evidenced as a trial product,
--      NULL otherwise. Pulse "paid" counts + a new revenue_cents field both use
--      it. ET bucketing was already correct ((now() AT TIME ZONE
--      'America/New_York')::date) and is preserved — no CURRENT_DATE anywhere.
--
--   3. HEATMAP vs FUNNEL disagreement ("Paid trials · 52" vs funnel 49).
--      get_lead_conversion_heatmap bucketed paid by created_at (not
--      payment_date), skipped the legacy_archived / backfill-email filters that
--      get_funnel_health applies, and had no trial-product check. Fix: paid is
--      now bucketed by payment_date (ET), floored at launch (2026-05-15), with
--      the same exclusions and the same trial_paid_amount_cents() predicate.
--      Leads get the same legacy/backfill exclusions + launch floor.
--
--   4. BOTTOM LINE "Since launch" membership revenue inflated by the
--      pre-launch member base (Astoria: $108,867 / "ROAS 45601%").
--      get_converted_members' direct_mt_members seed here was copied from
--      20260627_mt_autopay_classifier.sql, which LACKS the batch-window
--      autopay exclusion added in 20260627_mt_autopay_batch_window.sql.
--      MT bills the whole legacy member base in nightly batches
--      (12:00–12:15 AM and 4:00–4:15 AM ET); with only one billing cycle of
--      MT history the prior-sale NOT EXISTS check can't fire, so every
--      legacy member's renewal seeded as a "new direct member since launch"
--      and their revenue landed in the Bottom Line. Fix: restore the
--      batch-window exclusion so only members whose FIRST (non-batch)
--      membership purchase is on/after launch count. ROAS display is fixed
--      client-side (multiple "4.5x", not a percent).
--
--   5. STALE SOURCE LABELS (post-Mariana-Tek cutover 2026-06-27).
--      v_paid_trials_with_path still labeled buckets "MindBody POS (in-person)"
--      / "MindBody Online widget" and dumped mt_app rows into "Unknown".
--      New labels: 'In-person (POS)', 'MT App', 'Form → In-person (POS)',
--      'Online widget (legacy MB)'. get_trial_sources now falls back to
--      source_category when utm_source is empty so mt_app / mb_pos rows reach
--      the client with a mappable value instead of "Direct / untagged".
--
-- All functions keep their existing signatures, grants and ET bucketing.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 0. Canonical "is this a paid TRIAL product" helper.
--    Returns the trial amount in cents when the row's completed payment is
--    evidenced as a real $49/$29 trial product; NULL for everything else
--    (arbitrary Stripe charges, disputed rows, non-trial products).
--    Shared by get_daily_pulse and get_lead_conversion_heatmap so the pulse
--    tiles and the heatmap can never disagree on what "Paid" means.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trial_paid_amount_cents(p public.trial_signups)
RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v int;
BEGIN
  IF p.payment_status IS DISTINCT FROM 'completed' THEN RETURN NULL; END IF;
  IF p.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  -- Brian Burns class: completed flag with zero payment evidence → not paid.
  IF p.verification_status = 'disputed'::public.payment_verification THEN RETURN NULL; END IF;

  -- (a) Real Stripe charge at exactly $49 / $29 (trial or comeback trial).
  SELECT m.amount_cents INTO v
    FROM public.stripe_paid_mirror m
   WHERE lower(m.customer_email) = lower(p.email)
     AND m.amount_cents IN (4900, 2900)
     AND m.stripe_charge_id NOT LIKE 'walkin_%'
     AND m.stripe_charge_id NOT LIKE 'walk_in_%'
     AND m.stripe_charge_id <> 'sync_heartbeat'
   ORDER BY m.paid_at ASC
   LIMIT 1;
  IF v IS NOT NULL THEN RETURN v; END IF;

  -- (b) MindBody POS trial sale at $49 / $29.
  IF p.mindbody_id IS NOT NULL THEN
    SELECT s.total_cents::int INTO v
      FROM public.mindbody_sales s
     WHERE s.customer_mindbody_id = p.mindbody_id
       AND lower(COALESCE(s.item_names, '')) LIKE '%trial%'
       AND s.total_cents IN (4900, 2900)
     ORDER BY s.sale_date_time ASC
     LIMIT 1;
    IF v IS NOT NULL THEN RETURN v; END IF;
  END IF;

  -- (c) Mariana Tek trial sale ("Two Weeks Trial" contract) at $49 / $29.
  SELECT s.total_cents::int INTO v
    FROM public.mariana_tek_sales s
   WHERE lower(COALESCE(s.customer_email, '')) = lower(p.email)
     AND s.total_cents IN (4900, 2900)
     AND (lower(COALESCE(s.item_names, '')) LIKE '%two weeks trial%'
          OR lower(COALESCE(s.item_names, '')) LIKE '%week trial%')
   ORDER BY s.sale_date_time ASC
   LIMIT 1;
  IF v IS NOT NULL THEN RETURN v; END IF;

  -- (d) Staff-logged trials with no payment-processor row of their own:
  --     MT-app signups and in-person POS entries (verified/provisional by the
  --     classifier trigger). Assume the standard $49 trial.
  IF COALESCE(p.source_category, '') IN
       ('mt_app', 'in_person', 'mb_pos', 'mb_direct', 'walk_in', 'walk-in') THEN
    RETURN 4900;
  END IF;

  RETURN NULL;  -- completed, but not evidenced as a trial product (e.g. a $5 charge)
END
$$;

GRANT EXECUTE ON FUNCTION public.trial_paid_amount_cents(public.trial_signups) TO authenticated, anon, service_role;


-- ═════════════════════════════════════════════════════════════════════════
-- 1. get_daily_pulse v3 — paid + revenue count ONLY trial products.
--    Adds revenue_cents to each window. ET bucketing preserved throughout.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_daily_pulse(p_studio text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today        date;
  v_yest         date;
  v_week_start   date;
  v_launch       date := '2026-05-15'::date;
  v_loc_id       uuid;

  v_today_spend  bigint := 0;
  v_yest_spend   bigint := 0;
  v_week_spend   bigint := 0;
  v_all_spend    bigint := 0;

  v_today_sign   int := 0;
  v_yest_sign    int := 0;
  v_week_sign    int := 0;
  v_all_sign     int := 0;

  v_today_paid   int := 0;
  v_yest_paid    int := 0;
  v_week_paid    int := 0;
  v_all_paid     int := 0;

  v_today_rev    bigint := 0;
  v_yest_rev     bigint := 0;
  v_week_rev     bigint := 0;
  v_all_rev      bigint := 0;
BEGIN
  -- ET wall-clock day — NEVER CURRENT_DATE (that's UTC on Supabase).
  v_today := (now() AT TIME ZONE 'America/New_York')::date;
  v_yest  := v_today - 1;
  v_week_start := v_today - EXTRACT(DOW FROM v_today)::int;

  SELECT l.id INTO v_loc_id FROM locations l
   WHERE lower(replace(l.name, ' ', '-')) = p_studio LIMIT 1;

  -- ── SPEND · meta_insights_daily.date_start is already a date, fine as-is.
  SELECT COALESCE(SUM(spend_cents),0) INTO v_today_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_today;
  SELECT COALESCE(SUM(spend_cents),0) INTO v_yest_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_yest;
  SELECT COALESCE(SUM(spend_cents),0) INTO v_week_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start >= v_week_start;
  SELECT COALESCE(SUM(spend_cents),0) INTO v_all_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start >= v_launch;

  -- ── LEADS · ET-extracted dates (unchanged from 2026-06-19 fix).
  SELECT COUNT(*) INTO v_today_sign FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND (created_at AT TIME ZONE 'America/New_York')::date = v_today
      AND (payment_status <> 'completed' OR payment_date IS NULL
           OR (payment_date AT TIME ZONE 'America/New_York')::date = v_today);

  SELECT COUNT(*) INTO v_yest_sign FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND (created_at AT TIME ZONE 'America/New_York')::date = v_yest
      AND (payment_status <> 'completed' OR payment_date IS NULL
           OR (payment_date AT TIME ZONE 'America/New_York')::date = v_yest);

  SELECT COUNT(*) INTO v_week_sign FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND (created_at AT TIME ZONE 'America/New_York')::date >= v_week_start;

  SELECT COUNT(*) INTO v_all_sign FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND (created_at AT TIME ZONE 'America/New_York')::date >= v_launch;

  -- ── PAID + REVENUE · 2026-07-02: only $49/$29 TRIAL products count.
  -- trial_paid_amount_cents() returns the evidenced trial amount or NULL, so
  -- arbitrary charges (a $5 card test, a retail item) no longer show as Paid.
  SELECT COUNT(*), COALESCE(SUM(q.amt),0) INTO v_today_paid, v_today_rev
    FROM (SELECT public.trial_paid_amount_cents(t) AS amt
            FROM trial_signups t
           WHERE t.location_id = v_loc_id AND t.deleted_at IS NULL
             AND t.payment_status = 'completed'
             AND (t.payment_date AT TIME ZONE 'America/New_York')::date = v_today) q
   WHERE q.amt IS NOT NULL;

  SELECT COUNT(*), COALESCE(SUM(q.amt),0) INTO v_yest_paid, v_yest_rev
    FROM (SELECT public.trial_paid_amount_cents(t) AS amt
            FROM trial_signups t
           WHERE t.location_id = v_loc_id AND t.deleted_at IS NULL
             AND t.payment_status = 'completed'
             AND (t.payment_date AT TIME ZONE 'America/New_York')::date = v_yest) q
   WHERE q.amt IS NOT NULL;

  SELECT COUNT(*), COALESCE(SUM(q.amt),0) INTO v_week_paid, v_week_rev
    FROM (SELECT public.trial_paid_amount_cents(t) AS amt
            FROM trial_signups t
           WHERE t.location_id = v_loc_id AND t.deleted_at IS NULL
             AND t.payment_status = 'completed'
             AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_week_start) q
   WHERE q.amt IS NOT NULL;

  SELECT COUNT(*), COALESCE(SUM(q.amt),0) INTO v_all_paid, v_all_rev
    FROM (SELECT public.trial_paid_amount_cents(t) AS amt
            FROM trial_signups t
           WHERE t.location_id = v_loc_id AND t.deleted_at IS NULL
             AND t.payment_status = 'completed'
             AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_launch) q
   WHERE q.amt IS NOT NULL;

  RETURN jsonb_build_object(
    'today',     jsonb_build_object('spend_cents', v_today_spend, 'signups', v_today_sign, 'paid', v_today_paid, 'revenue_cents', v_today_rev),
    'yesterday', jsonb_build_object('spend_cents', v_yest_spend,  'signups', v_yest_sign,  'paid', v_yest_paid,  'revenue_cents', v_yest_rev),
    'thisWeek',  jsonb_build_object('spend_cents', v_week_spend,  'signups', v_week_sign,  'paid', v_week_paid,  'revenue_cents', v_week_rev),
    'allTime',   jsonb_build_object('spend_cents', v_all_spend,   'signups', v_all_sign,   'paid', v_all_paid,   'revenue_cents', v_all_rev)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.get_daily_pulse(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_pulse(text) TO anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════
-- 2. get_lead_conversion_heatmap v2 — same predicate as the funnel tiles.
--    paid: payment_date (ET) bucketing, launch floor, legacy/backfill
--    exclusions, trial-product check. leads: legacy/backfill exclusions +
--    launch floor added.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_lead_conversion_heatmap(
  p_studio_slug text DEFAULT NULL,
  p_days        int  DEFAULT 30
)
RETURNS TABLE (
  studio_slug text,
  day         date,
  day_of_week int,   -- 0 = Sun … 6 = Sat
  lead_count  int,   -- form fills (paid + unpaid), since launch
  paid_count  int    -- $49/$29 trial products, by payment date, since launch
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (((now() AT TIME ZONE 'America/New_York')::date) - (p_days - 1))::date,
      ((now() AT TIME ZONE 'America/New_York')::date)::date,
      INTERVAL '1 day'
    )::date AS day
  ),
  studios AS (
    SELECT lower(replace(name, ' ', '-')) AS studio_slug, id AS location_id
    FROM public.locations
    WHERE p_studio_slug IS NULL
       OR lower(replace(name, ' ', '-')) = p_studio_slug
  ),
  daily_leads AS (
    SELECT
      s.studio_slug,
      ((t.created_at AT TIME ZONE 'America/New_York')::date) AS day,
      COUNT(*)::int AS lead_count
    FROM public.trial_signups t
    JOIN studios s ON s.location_id = t.location_id
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (t.created_at AT TIME ZONE 'America/New_York')::date
            >= GREATEST(
                 (((now() AT TIME ZONE 'America/New_York')::date) - (p_days - 1))::date,
                 DATE '2026-05-15')
    GROUP BY 1, 2
  ),
  -- Paid bucketed by PAYMENT date (ET), not form-fill date. This is the
  -- exact same predicate as get_funnel_health's "paid" column plus the
  -- trial-product check, so the heatmap total reconciles with the funnel.
  daily_paid AS (
    SELECT
      s.studio_slug,
      ((t.payment_date AT TIME ZONE 'America/New_York')::date) AS day,
      COUNT(*)::int AS paid_count
    FROM public.trial_signups t
    JOIN studios s ON s.location_id = t.location_id
    WHERE t.deleted_at IS NULL
      AND t.payment_status = 'completed'
      AND t.payment_date IS NOT NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (t.payment_date AT TIME ZONE 'America/New_York')::date
            >= GREATEST(
                 (((now() AT TIME ZONE 'America/New_York')::date) - (p_days - 1))::date,
                 DATE '2026-05-15')
      AND public.trial_paid_amount_cents(t) IS NOT NULL
    GROUP BY 1, 2
  )
  SELECT
    s.studio_slug,
    d.day,
    EXTRACT(DOW FROM d.day)::int AS day_of_week,
    COALESCE(dl.lead_count, 0) AS lead_count,
    COALESCE(dp.paid_count, 0) AS paid_count
  FROM studios s
  CROSS JOIN date_series d
  LEFT JOIN daily_leads dl ON dl.studio_slug = s.studio_slug AND dl.day = d.day
  LEFT JOIN daily_paid  dp ON dp.studio_slug = s.studio_slug AND dp.day = d.day
  ORDER BY s.studio_slug, d.day;
$$;

GRANT EXECUTE ON FUNCTION public.get_lead_conversion_heatmap(text, int) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════
-- 3. get_converted_members — adds `from_trial boolean` + restores the
--    autopay batch-window seed exclusion.
--    Body from 20260627_mt_autopay_classifier.sql with two changes:
--    (a) direct_mt_members re-gains the 12:00–12:15 AM / 4:00–4:15 AM ET
--        batch-window exclusion from 20260627_mt_autopay_batch_window.sql
--        (header bug #4 — legacy-base autopays inflated Membership Revenue);
--    (b) the final SELECT gains an evidence-based from_trial flag: true ONLY
--        when a real $49/$29 trial payment exists dated at/before
--        first_conversion_at.
--    (Direct seeds reuse the membership sale time as trial_paid_at, which is
--    why the client could not distinguish them before.)
--    Return type changes → DROP first (both historical signatures).
-- ═════════════════════════════════════════════════════════════════════════
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
  source_category         text,
  from_trial              boolean
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
  -- Only seed FIRST membership sale per customer (autopay renewals excluded).
  -- 2026-07-02 QA: restored the batch-window autopay exclusion from
  -- 20260627_mt_autopay_batch_window.sql (lost when this body was copied from
  -- the classifier version). Without it, the legacy pre-launch member base's
  -- nightly autopay batches (12:05 AM / 4:05 AM ET) seeded as "new direct
  -- members since launch" — the prior-sale NOT EXISTS can't catch them with
  -- only one billing cycle of MT history — inflating Membership Revenue on
  -- the Bottom Line card (Astoria showed $108,867 since launch).
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
      -- 2026-07-02 QA: EXCLUDE MT autopay batch windows (12:00–12:15 AM and
      -- 4:00–4:15 AM ET). Real new-member purchases never happen at those
      -- exact times; legacy-base renewals always do. Defense in depth with
      -- the prior-sale check below, which needs 2+ billing cycles to fire.
      AND NOT (
        (s.sale_date_time AT TIME ZONE 'America/New_York')::time >= '00:00'::time
        AND (s.sale_date_time AT TIME ZONE 'America/New_York')::time < '00:15'::time
      )
      AND NOT (
        (s.sale_date_time AT TIME ZONE 'America/New_York')::time >= '04:00'::time
        AND (s.sale_date_time AT TIME ZONE 'America/New_York')::time < '04:15'::time
      )
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
    COALESCE(spc.source_category, 'mt_direct_member') AS source_category,
    -- ── 2026-07-02 from_trial ──────────────────────────────────────────
    -- TRUE only when there is EVIDENCE of a real $49/$29 trial purchase
    -- dated at/before this member's first membership sale. Direct seeds
    -- reuse the membership timestamp as trial_paid_at, so trial_paid_at
    -- alone cannot distinguish trial converts from direct signups.
    (
      EXISTS (
        SELECT 1 FROM public.stripe_paid_mirror m
        WHERE lower(m.customer_email) = cr.stripe_email
          AND m.amount_cents IN (4900, 2900)
          AND m.stripe_charge_id NOT LIKE 'walkin_%'
          AND m.stripe_charge_id NOT LIKE 'walk_in_%'
          AND m.stripe_charge_id <> 'sync_heartbeat'
          AND m.paid_at <= cr.first_conversion_at
      )
      OR EXISTS (
        SELECT 1 FROM public.trial_signups t2
        WHERE lower(t2.email) = cr.stripe_email
          AND t2.deleted_at IS NULL
          AND t2.payment_status = 'completed'
          AND t2.source_category = 'mt_app'
          AND COALESCE(t2.payment_date, t2.created_at) <= cr.first_conversion_at
      )
      OR (cr.mindbody_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.mindbody_sales s5
        WHERE s5.customer_mindbody_id = cr.mindbody_id
          AND lower(COALESCE(s5.item_names, '')) LIKE '%trial%'
          AND s5.total_cents IN (4900, 2900)
          AND s5.sale_date_time <= cr.first_conversion_at
      ))
      OR EXISTS (
        SELECT 1 FROM public.mariana_tek_sales s6
        WHERE lower(COALESCE(s6.customer_email, '')) = cr.stripe_email
          AND s6.total_cents IN (4900, 2900)
          AND (lower(COALESCE(s6.item_names, '')) LIKE '%two weeks trial%'
               OR lower(COALESCE(s6.item_names, '')) LIKE '%week trial%')
          AND s6.sale_date_time <= cr.first_conversion_at
      )
    ) AS from_trial
  FROM combined_rollup cr
  LEFT JOIN public.mindbody_clients c ON c.mindbody_id = cr.mindbody_id
  LEFT JOIN source_per_customer spc   ON spc.email = cr.stripe_email
  ORDER BY cr.total_cents DESC, cr.first_conversion_at ASC;
$$;

-- Grants preserved exactly as they were (anon exposure is a known issue,
-- reported separately — not silently changed here to avoid breaking
-- frontdesk/other anon callers).
GRANT EXECUTE ON FUNCTION public.get_converted_members(date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_converted_members(date, text) TO anon;


-- ═════════════════════════════════════════════════════════════════════════
-- 4a. v_paid_trials_with_path — post-MT-cutover labels + mt_app / mb_pos.
--     Old buckets renamed:
--       'MindBody POS (in-person)' → 'In-person (POS)'
--       'Form → MindBody POS'      → 'Form → In-person (POS)'
--       'MindBody Online widget'   → 'Online widget (legacy MB)'
--     New bucket: 'MT App' (source_category = 'mt_app' — previously fell
--     into 'MindBody Online widget' or 'Unknown').
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_paid_trials_with_path AS
WITH stripe_emails AS (
  SELECT DISTINCT lower(customer_email) AS email
  FROM public.stripe_paid_mirror
  WHERE customer_email IS NOT NULL AND customer_email <> ''
)
SELECT
  ts.id,
  ts.name,
  ts.email,
  ts.location_id,
  lower(replace(l.name, ' ', '-')) AS studio_slug,
  ts.payment_date,
  ts.source_category,
  ts.stripe_session_id,
  ts.mindbody_id,
  ts.front_desk_stage,
  ts.utm_source,
  ts.utm_medium,
  ts.utm_campaign,
  CASE
    WHEN ts.source_category = 'legacy_archived'
      THEN 'Legacy backfill'
    WHEN ts.source_category = 'mt_app'
      THEN 'MT App'
    WHEN ts.source_category IN ('in_person', 'mb_pos', 'mb_direct', 'walk_in', 'walk-in')
      THEN 'In-person (POS)'
    WHEN lower(ts.email) IN (SELECT email FROM stripe_emails)
      THEN 'Stripe Checkout (web)'
    WHEN ts.stripe_session_id IS NOT NULL AND ts.mindbody_id IS NOT NULL
      THEN 'Form → In-person (POS)'
    WHEN ts.mindbody_id IS NOT NULL
      THEN 'Online widget (legacy MB)'
    ELSE 'Unknown'
  END AS purchase_path,
  -- True walk-in flag: in-person + no web touch (no stripe_session_id, no UTM).
  CASE
    WHEN ts.source_category IN ('in_person', 'mb_pos')
     AND ts.stripe_session_id IS NULL
     AND ts.utm_source IS NULL
      THEN true
    ELSE false
  END AS is_pure_walk_in,
  CASE
    WHEN ts.source_category IN ('in_person', 'mb_pos')
     AND ts.stripe_session_id IS NULL
      THEN 'Walk-in · ' || INITCAP(lower(replace(l.name, ' ', '-')))
    WHEN ts.source_category IN ('in_person', 'mb_pos')
     AND ts.stripe_session_id IS NOT NULL
      THEN COALESCE(INITCAP(ts.utm_source), 'Form') || ' → desk'
    WHEN ts.source_category = 'mt_app'
      THEN 'MT App · ' || INITCAP(lower(replace(l.name, ' ', '-')))
    WHEN ts.stripe_session_id IS NOT NULL
     AND lower(ts.email) NOT IN (SELECT email FROM stripe_emails)
     AND ts.mindbody_id IS NOT NULL
      THEN COALESCE(INITCAP(ts.utm_source), 'Form') || ' abandoned → desk'
    WHEN ts.utm_source IS NOT NULL
      THEN INITCAP(ts.utm_source) || ' → Stripe'
    WHEN ts.source_category = 'web_organic'
      THEN 'Organic → Stripe'
    WHEN ts.source_category = 'ad'
      THEN 'Ad → Stripe'
    WHEN ts.source_category = 'legacy_archived'
      THEN 'Legacy import'
    ELSE 'Unknown origin'
  END AS lead_origin
FROM public.trial_signups ts
JOIN public.locations l ON l.id = ts.location_id
WHERE ts.payment_status = 'completed'
  AND ts.payment_date   IS NOT NULL
  AND ts.deleted_at     IS NULL;

GRANT SELECT ON public.v_paid_trials_with_path TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════
-- 4b. get_trial_sources — fall back to source_category when utm_source is
--     empty so mt_app / mb_pos / in_person rows arrive at the client with a
--     mappable value instead of collapsing into "Direct / untagged".
--     Signature and return shape unchanged.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_trial_sources(p_studio text DEFAULT NULL)
RETURNS TABLE(source text, signups bigint, paid bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_anchor date := '2026-05-15'::date;
BEGIN
  RETURN QUERY
  WITH studio_signups AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      lower(t.email)                    AS email_norm,
      -- 2026-07-02: utm_source first, then source_category (mt_app, mb_pos,
      -- in_person, contact_form, …), then the generic bucket. The dashboard's
      -- normalizeSource() maps these raw category values to friendly labels.
      COALESCE(NULLIF(t.utm_source, ''), NULLIF(t.source_category, ''), 'Direct / untagged') AS source
    FROM trial_signups t
    JOIN locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (
        (t.created_at AT TIME ZONE 'America/New_York')::date >= v_anchor
        OR (t.payment_date IS NOT NULL AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor)
      )
      AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
  ),
  paid_emails AS (
    SELECT stripe_paid_mirror.studio_slug, lower(customer_email) AS email_norm
    FROM stripe_paid_mirror
    WHERE (paid_at AT TIME ZONE 'America/New_York')::date >= v_anchor
      AND (p_studio IS NULL OR stripe_paid_mirror.studio_slug = p_studio)
      AND customer_email IS NOT NULL
  )
  SELECT
    s.source,
    COUNT(DISTINCT s.email_norm || '|' || s.studio_slug)::bigint AS signups,
    COUNT(DISTINCT CASE
      WHEN EXISTS (SELECT 1 FROM paid_emails p
                    WHERE p.email_norm = s.email_norm AND p.studio_slug = s.studio_slug)
      THEN s.email_norm || '|' || s.studio_slug
    END)::bigint AS paid
  FROM studio_signups s
  GROUP BY 1
  ORDER BY signups DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_sources(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_sources(text) TO authenticated;

COMMIT;

-- ─── Post-flight verification ────────────────────────────────────────────
-- (1) Conversion numerator sanity — from_trial count must be <= paid trials:
--   SELECT studio_slug,
--          COUNT(*) FILTER (WHERE from_trial)      AS from_trial,
--          COUNT(*) FILTER (WHERE NOT from_trial)  AS direct
--   FROM public.get_converted_members() GROUP BY 1;
--   Expect Astoria from_trial well under 49 (was 65/65).
--
-- (2) Pulse only counts trial products now:
--   SELECT public.get_daily_pulse('astoria');
--   today.revenue_cents must be a multiple of 4900/2900 combos, never 500.
--
-- (3) Heatmap total vs funnel "Paid Trials" tile — these count DIFFERENT
--   populations by design and are NOT forced equal:
--     * Heatmap (get_lead_conversion_heatmap.paid_count) = ALL-channel paid
--       trials from trial_signups: Stripe web + in-person POS + Mariana Tek,
--       $49/$29 trial products, payment date ET, since launch, legacy/backfill
--       excluded.
--     * Funnel "Paid Trials" tile (get_ad_spend_vs_revenue.trial_count) =
--       Stripe-mirror payers only, deduped by email.
--   The heatmap total is therefore expected to run >= the funnel tile (it
--   includes in-person/MT trials the Stripe-only tile omits). The dashboard
--   labels the heatmap "Paid trials · all channels" and the caption explains
--   the gap, so a difference (e.g. 52 vs 49) is intentional, not a bug.
--     SELECT SUM(paid_count) FROM public.get_lead_conversion_heatmap(NULL, 60);
--     SELECT SUM(trial_count) FROM public.get_ad_spend_vs_revenue('2026-05-15');
--
-- (4) Purchase paths show MT App and no legacy labels:
--   SELECT purchase_path, COUNT(*) FROM public.v_paid_trials_with_path GROUP BY 1;
--
-- (5) Bottom Line membership revenue no longer includes the legacy base —
--   sum of member revenue per studio should drop sharply for Astoria
--   (was $108,867; expect low-thousands, consistent with weeks of real
--   post-launch joins) and no seeded member's first sale should sit in an
--   autopay batch window:
--     SELECT studio_slug, COUNT(*), SUM(total_member_rev_usd)
--     FROM public.get_converted_members() GROUP BY 1;
--     SELECT COUNT(*) FROM public.get_converted_members() g
--     WHERE (g.first_conversion_at AT TIME ZONE 'America/New_York')::time
--             < '00:15'::time
--        OR ((g.first_conversion_at AT TIME ZONE 'America/New_York')::time
--             >= '04:00'::time
--        AND (g.first_conversion_at AT TIME ZONE 'America/New_York')::time
--             < '04:15'::time);  -- expect near 0 (rollup may still include
--                                -- legit renewals of post-launch members)
