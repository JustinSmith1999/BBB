-- 2026-06-19 05:00 ET — Mey Navarro bug fix.
-- get_daily_pulse compared `created_at (timestamptz) >= v_today (date)`.
-- Postgres coerces the date to UTC midnight in that comparison, so everything
-- from 8pm ET prior day onward got bucketed as "today."
--
-- Mey filled the form 22:52 ET 6/18 → 02:52 UTC 6/19. UTC midnight comparison
-- said she's "today (6/19)". ET date check would correctly say "yesterday (6/18)."
--
-- Fix: replace every timestamp range comparison with explicit ET-date extraction
-- so the bucket matches the wall-clock day in NY.

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
BEGIN
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

  -- ── LEADS · USE ET-extracted date, not raw timestamp comparison.
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

  -- ── PAID · payment_date already gets correct ET extraction
  SELECT COUNT(*) INTO v_today_paid FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND payment_status = 'completed'
      AND (payment_date AT TIME ZONE 'America/New_York')::date = v_today;

  SELECT COUNT(*) INTO v_yest_paid FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND payment_status = 'completed'
      AND (payment_date AT TIME ZONE 'America/New_York')::date = v_yest;

  SELECT COUNT(*) INTO v_week_paid FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND payment_status = 'completed'
      AND (payment_date AT TIME ZONE 'America/New_York')::date >= v_week_start;

  SELECT COUNT(*) INTO v_all_paid FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND payment_status = 'completed'
      AND (payment_date AT TIME ZONE 'America/New_York')::date >= v_launch;

  RETURN jsonb_build_object(
    'today',     jsonb_build_object('spend_cents', v_today_spend, 'signups', v_today_sign, 'paid', v_today_paid),
    'yesterday', jsonb_build_object('spend_cents', v_yest_spend,  'signups', v_yest_sign,  'paid', v_yest_paid),
    'thisWeek',  jsonb_build_object('spend_cents', v_week_spend,  'signups', v_week_sign,  'paid', v_week_paid),
    'allTime',   jsonb_build_object('spend_cents', v_all_spend,   'signups', v_all_sign,   'paid', v_all_paid)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.get_daily_pulse(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_pulse(text) TO anon, authenticated;
