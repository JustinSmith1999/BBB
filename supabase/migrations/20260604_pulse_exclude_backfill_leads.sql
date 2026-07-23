-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: get_daily_pulse — exclude webhook-backfill rows from today's
-- "leads" counter.
--
-- Bug: Misbah Ali paid May 31. The stripe-webhook was dead between June 1–4,
-- so her row never made it into trial_signups. When we resent her event today
-- (after the fix), the now-healthy webhook inserted her row with
--   created_at = NOW()                 (today)
--   payment_date = 2026-05-31 23:43    (original event.created)
--   payment_status = 'completed'
-- The "Today" tile counted her as 1 lead because created_at is today, even
-- though she's not a new form fill — she's a stale completed payment that
-- just arrived in our DB.
--
-- Fix: today's-leads count excludes rows that are already completed and whose
-- payment_date is earlier than today. Those are webhook backfills, not real
-- new form submissions.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_daily_pulse(p_studio text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today        date;
  v_yest         date;
  v_loc_id       uuid;
  v_today_spend  bigint := 0;
  v_yest_spend   bigint := 0;
  v_today_sign   int    := 0;
  v_yest_sign    int    := 0;
  v_today_paid   int    := 0;
  v_yest_paid    int    := 0;
BEGIN
  v_today := (now() AT TIME ZONE 'America/New_York')::date;
  v_yest  := v_today - 1;

  SELECT l.id INTO v_loc_id FROM locations l
   WHERE lower(replace(l.name, ' ', '-')) = p_studio LIMIT 1;

  SELECT COALESCE(SUM(spend_cents),0) INTO v_today_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_today;
  SELECT COALESCE(SUM(spend_cents),0) INTO v_yest_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_yest;

  -- TODAY'S LEADS — exclude webhook backfills (completed payments whose actual
  -- payment_date predates today; created_at is today only because that's when
  -- the row landed in our DB).
  SELECT COUNT(*) INTO v_today_sign FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND COALESCE(source_category,'') <> 'legacy_archived'
      AND COALESCE(email,'') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (created_at AT TIME ZONE 'America/New_York')::date = v_today
      AND NOT (
            payment_status = 'completed'
        AND payment_date IS NOT NULL
        AND (payment_date AT TIME ZONE 'America/New_York')::date < v_today
      );

  -- YESTERDAY'S LEADS — same exclusion, anchored on yesterday.
  SELECT COUNT(*) INTO v_yest_sign FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND COALESCE(source_category,'') <> 'legacy_archived'
      AND COALESCE(email,'') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (created_at AT TIME ZONE 'America/New_York')::date = v_yest
      AND NOT (
            payment_status = 'completed'
        AND payment_date IS NOT NULL
        AND (payment_date AT TIME ZONE 'America/New_York')::date < v_yest
      );

  -- PAID FROM STRIPE SSOT — unchanged
  v_today_paid := public.count_paid_canonical(p_studio, v_today, v_today)::int;
  v_yest_paid  := public.count_paid_canonical(p_studio, v_yest,  v_yest)::int;

  RETURN jsonb_build_object(
    'today',     jsonb_build_object('spend_cents', v_today_spend, 'signups', v_today_sign, 'paid', v_today_paid),
    'yesterday', jsonb_build_object('spend_cents', v_yest_spend,  'signups', v_yest_sign,  'paid', v_yest_paid),
    'truth_source', 'stripe_paid_mirror'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_pulse(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_pulse(text) TO authenticated;

-- Sanity probe — Fresh Meadows today should drop from 1 leads → 0.
SELECT 'fresh-meadows after fix' AS label,
       public.get_daily_pulse('fresh-meadows') AS pulse;
