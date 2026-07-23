-- ─────────────────────────────────────────────────────────────────────────────
-- Timezone fix: every dashboard "today" / "yesterday" date comparison must
-- be calendar-rooted in America/New_York, not the Postgres session timezone
-- (Supabase = UTC). After 8 PM EDT, UTC has already rolled to tomorrow, so
-- the old CURRENT_DATE-based logic was returning $0 / no leads for the whole
-- studio "today" panel.
--
-- Symptom Justin reported (May 29, 2026 @ 8:11 PM EDT):
--   • All dashboards show $0 spend, no leads, no sales for today.
--
-- Pattern applied throughout:
--   CURRENT_DATE                 →  (now() AT TIME ZONE 'America/New_York')::date
--   created_at::date             →  (created_at AT TIME ZONE 'America/New_York')::date
--   meta date_start = CURRENT_DATE → same — Meta accounts also report in ET
--   '2026-05-15'::date launch boundary stays as-is (date literals are fine)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. get_daily_pulse — yesterday & today numbers for the top strip ────────
CREATE OR REPLACE FUNCTION public.get_daily_pulse(p_studio text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed text[];
  v_loc_id  uuid;
  v_today   date;
  v_yest    date;
  v_today_spend bigint;
  v_yest_spend  bigint;
  v_today_sign  int;
  v_yest_sign   int;
  v_today_paid  int;
  v_yest_paid   int;
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;
  IF NOT (p_studio = ANY(v_allowed)) THEN
    RETURN jsonb_build_object('blocked', true);
  END IF;

  -- NY-calendar today/yesterday, regardless of DB session tz.
  v_today := (now() AT TIME ZONE 'America/New_York')::date;
  v_yest  := v_today - 1;

  SELECT l.id INTO v_loc_id
  FROM locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  SELECT COALESCE(SUM(spend_cents), 0) INTO v_today_spend
  FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_today;
  SELECT COALESCE(SUM(spend_cents), 0) INTO v_yest_spend
  FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_yest;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE payment_status = 'completed')
  INTO v_today_sign, v_today_paid
  FROM trial_signups
  WHERE location_id = v_loc_id
    AND (created_at AT TIME ZONE 'America/New_York')::date = v_today
    AND deleted_at IS NULL;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE payment_status = 'completed')
  INTO v_yest_sign, v_yest_paid
  FROM trial_signups
  WHERE location_id = v_loc_id
    AND (created_at AT TIME ZONE 'America/New_York')::date = v_yest
    AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'today', jsonb_build_object('spend_cents', v_today_spend, 'signups', v_today_sign, 'paid', v_today_paid),
    'yesterday', jsonb_build_object('spend_cents', v_yest_spend, 'signups', v_yest_sign, 'paid', v_yest_paid)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_pulse(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_pulse(text) TO authenticated;


-- ── 2. get_meta_daily_trend — last N days strip, ET-rooted ──────────────────
-- DROP first because the live function has 6 OUT columns (day, spend_cents,
-- impressions, clicks, trial_signups, paid_trials) and CREATE OR REPLACE
-- can't change OUT-parameter shape. We preserve the 6-column contract that
-- callers (loadDailyPulse 7d strip + any future chart) depend on.
DROP FUNCTION IF EXISTS public.get_meta_daily_trend(text, int);

CREATE FUNCTION public.get_meta_daily_trend(p_studio text, p_days int DEFAULT 14)
RETURNS TABLE(
  day           date,
  spend_cents   bigint,
  impressions   bigint,
  clicks        bigint,
  trial_signups int,
  paid_trials   int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_loc_id  uuid;
  v_today   date;
  v_start   date;
BEGIN
  v_today := (now() AT TIME ZONE 'America/New_York')::date;
  v_start := GREATEST(v_today - (p_days - 1), '2026-05-15'::date);

  SELECT l.id INTO v_loc_id
  FROM locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  RETURN QUERY
  WITH cal AS (
    SELECT generate_series(v_start, v_today, '1 day'::interval)::date AS day
  ),
  meta AS (
    -- Qualify every column with the table alias `m`. Without that, Postgres
    -- can't tell `spend_cents` apart from the OUT parameter of the same name
    -- and bails out with "column reference is ambiguous" (SQLSTATE 42702).
    SELECT
      m.date_start                  AS day,
      SUM(m.spend_cents)::bigint    AS spend_cents,
      SUM(m.impressions)::bigint    AS impressions,
      SUM(m.clicks)::bigint         AS clicks
    FROM meta_insights_daily m
    WHERE m.studio_slug = p_studio
      AND m.date_start >= v_start
    GROUP BY 1
  ),
  signups AS (
    SELECT (t.created_at AT TIME ZONE 'America/New_York')::date AS day,
           COUNT(*)::int AS trial_signups,
           COUNT(*) FILTER (WHERE t.payment_status = 'completed')::int AS paid_trials
    FROM trial_signups t
    WHERE t.location_id = v_loc_id
      AND (t.created_at AT TIME ZONE 'America/New_York')::date >= v_start
      AND t.deleted_at IS NULL
    GROUP BY 1
  )
  SELECT
    cal.day,
    COALESCE(meta.spend_cents, 0)             AS spend_cents,
    COALESCE(meta.impressions, 0)             AS impressions,
    COALESCE(meta.clicks, 0)                  AS clicks,
    COALESCE(signups.trial_signups, 0)        AS trial_signups,
    COALESCE(signups.paid_trials, 0)          AS paid_trials
  FROM cal
  LEFT JOIN meta    ON meta.day    = cal.day
  LEFT JOIN signups ON signups.day = cal.day
  ORDER BY cal.day;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_meta_daily_trend(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_daily_trend(text, int) TO authenticated;


-- Quick sanity (run after deploy):
--   SELECT (now() AT TIME ZONE 'America/New_York')::date AS ny_today,
--          CURRENT_DATE                                  AS pg_session_date;
--   SELECT public.get_daily_pulse('bayside');
--   SELECT * FROM public.get_meta_daily_trend('bayside', 7);
