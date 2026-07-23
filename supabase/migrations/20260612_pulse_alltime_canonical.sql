-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Pulse "All time" + "This week" leads — canonical from trial_signups.
--
-- BUG: Bayside per-studio tile shows 26 leads while All Studios sum shows 8.
-- Raw trial_signups (post-May-15, not deleted): Bayside 29 / FM 36 / WB 74 /
-- AS 65 / NETWORK 204. Both dashboard numbers are wrong, and they're wrong
-- DIFFERENTLY — which is what frustrated Justin.
--
-- ROOT CAUSE: the dashboard currently sums `get_meta_daily_trend(p_studio,
-- p_days)` for the "This week" and "All time" pulse tiles. That RPC joins
-- through meta_insights_daily and undercounts because it only returns rows
-- for days where Meta ad insights synced. Per-studio + All Studios use the
-- same RPC but the sums diverge because of stale/missing ad-insights rows.
--
-- FIX: extend get_daily_pulse() to return three sections — today, thisWeek,
-- allTime — all reading lead counts straight from trial_signups. Spend stays
-- from meta_insights_daily (only place that lives). Paid stays from
-- trial_signups via payment_date (canonical).
-- ─────────────────────────────────────────────────────────────────────────────

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
  -- Sunday-of-this-week, ET-anchored.
  v_week_start := v_today - EXTRACT(DOW FROM v_today)::int;

  SELECT l.id INTO v_loc_id FROM locations l
   WHERE lower(replace(l.name, ' ', '-')) = p_studio LIMIT 1;

  -- ── SPEND · from meta_insights_daily ───────────────────────────────────
  SELECT COALESCE(SUM(spend_cents),0) INTO v_today_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_today;
  SELECT COALESCE(SUM(spend_cents),0) INTO v_yest_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_yest;
  SELECT COALESCE(SUM(spend_cents),0) INTO v_week_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start >= v_week_start;
  SELECT COALESCE(SUM(spend_cents),0) INTO v_all_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start >= v_launch;

  -- ── LEADS · from trial_signups (canonical SSOT) ────────────────────────
  -- TODAY — exclude backfill rows whose actual payment_date predates today.
  SELECT COUNT(*) INTO v_today_sign FROM trial_signups
    WHERE location_id = v_loc_id
      AND deleted_at IS NULL
      AND created_at >= v_today
      AND (payment_status <> 'completed' OR payment_date IS NULL OR (payment_date AT TIME ZONE 'America/New_York')::date = v_today);

  SELECT COUNT(*) INTO v_yest_sign FROM trial_signups
    WHERE location_id = v_loc_id
      AND deleted_at IS NULL
      AND created_at >= v_yest AND created_at < v_today
      AND (payment_status <> 'completed' OR payment_date IS NULL OR (payment_date AT TIME ZONE 'America/New_York')::date = v_yest);

  SELECT COUNT(*) INTO v_week_sign FROM trial_signups
    WHERE location_id = v_loc_id
      AND deleted_at IS NULL
      AND created_at >= v_week_start;

  SELECT COUNT(*) INTO v_all_sign FROM trial_signups
    WHERE location_id = v_loc_id
      AND deleted_at IS NULL
      AND created_at >= v_launch;

  -- ── PAID · from trial_signups.payment_date (canonical SSOT) ────────────
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

-- ── Sanity probe — verify Bayside now agrees with raw trial_signups ──────
SELECT 'bayside-after-fix' AS label, public.get_daily_pulse('bayside') AS pulse;
SELECT 'fresh-meadows-after-fix' AS label, public.get_daily_pulse('fresh-meadows') AS pulse;
SELECT 'astoria-after-fix' AS label, public.get_daily_pulse('astoria') AS pulse;
SELECT 'williamsburg-after-fix' AS label, public.get_daily_pulse('williamsburg') AS pulse;
