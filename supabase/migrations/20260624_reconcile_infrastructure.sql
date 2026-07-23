-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-24 · Stripe-reconcile + dup-detector infrastructure
--
-- WHY: We just had 4 paid customers in 24h whose welcomes / MB-links / CAPI
-- events didn't fire automatically (Lielle + Nina + Yoandra + Sneha). The
-- realtime monitor was the only safety net and it was failing silently. This
-- migration sets up:
--
--   1. ops_reconcile_runs — heartbeat for stripe-reconcile (every 15 min)
--   2. ops_dup_detections — every (location_id, email) group that has >1 live
--                           row, surfaced for the daily digest
--   3. ops_dup_detection_runs — heartbeat for dup-detector (hourly)
--   4. pg_cron schedules for stripe-reconcile, dup-detector, daily-ops-digest
--   5. RPCs for /ops dashboard: get_reconcile_health(), get_dup_health()
--
-- ROLLBACK:
--   SELECT cron.unschedule('stripe-reconcile-15min');
--   SELECT cron.unschedule('dup-detector-hourly');
--   SELECT cron.unschedule('daily-ops-digest-8am-et');
--   DROP TABLE IF EXISTS public.ops_reconcile_runs, public.ops_dup_detections, public.ops_dup_detection_runs;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Heartbeat tables ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ops_reconcile_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at              timestamptz NOT NULL DEFAULT now(),
  candidates_checked  int DEFAULT 0,
  actions_taken       jsonb,
  error               text
);
CREATE INDEX IF NOT EXISTS ops_reconcile_runs_ran_at_idx
  ON public.ops_reconcile_runs (ran_at DESC);

ALTER TABLE public.ops_reconcile_runs ENABLE ROW LEVEL SECURITY;
-- No anon SELECT — read via SECURITY DEFINER RPC below.

CREATE TABLE IF NOT EXISTS public.ops_dup_detections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at     timestamptz NOT NULL DEFAULT now(),
  email           text NOT NULL,
  location_id     uuid NOT NULL REFERENCES public.locations(id),
  row_ids         uuid[],
  group_size      int,
  UNIQUE (email, location_id)
);
CREATE INDEX IF NOT EXISTS ops_dup_detections_detected_at_idx
  ON public.ops_dup_detections (detected_at DESC);

ALTER TABLE public.ops_dup_detections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ops_dup_detection_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at            timestamptz NOT NULL DEFAULT now(),
  dup_groups_found  int DEFAULT 0,
  error             text
);
CREATE INDEX IF NOT EXISTS ops_dup_detection_runs_ran_at_idx
  ON public.ops_dup_detection_runs (ran_at DESC);

ALTER TABLE public.ops_dup_detection_runs ENABLE ROW LEVEL SECURITY;

-- ── 2. Health RPCs for /ops dashboard ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_reconcile_health()
RETURNS TABLE (
  last_run_at         timestamptz,
  minutes_since_run   numeric,
  status              text,        -- 'healthy' / 'lagging' / 'silent'
  candidates_last_run int,
  actions_last_run    jsonb,
  last_error          text,
  runs_24h            bigint,
  errors_24h          bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH last_run AS (
    SELECT ran_at, candidates_checked, actions_taken, error
      FROM public.ops_reconcile_runs
     ORDER BY ran_at DESC LIMIT 1
  )
  SELECT
    (SELECT ran_at FROM last_run),
    EXTRACT(EPOCH FROM (now() - (SELECT ran_at FROM last_run)))/60.0,
    CASE
      WHEN (SELECT ran_at FROM last_run) IS NULL THEN 'silent'
      WHEN now() - (SELECT ran_at FROM last_run) > interval '30 minutes' THEN 'silent'
      WHEN now() - (SELECT ran_at FROM last_run) > interval '20 minutes' THEN 'lagging'
      ELSE 'healthy'
    END,
    (SELECT candidates_checked FROM last_run),
    (SELECT actions_taken FROM last_run),
    (SELECT error FROM last_run),
    (SELECT count(*) FROM public.ops_reconcile_runs WHERE ran_at > now() - interval '24 hours'),
    (SELECT count(*) FROM public.ops_reconcile_runs WHERE ran_at > now() - interval '24 hours' AND error IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION public.get_dup_health()
RETURNS TABLE (
  last_run_at        timestamptz,
  minutes_since_run  numeric,
  status             text,
  active_dup_groups  bigint,
  newest_dup_at      timestamptz,
  newest_dup_email   text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH last_run AS (
    SELECT ran_at FROM public.ops_dup_detection_runs
     ORDER BY ran_at DESC LIMIT 1
  ),
  active AS (
    SELECT email, detected_at
      FROM public.ops_dup_detections
     WHERE group_size > 1
     ORDER BY detected_at DESC
  )
  SELECT
    (SELECT ran_at FROM last_run),
    EXTRACT(EPOCH FROM (now() - (SELECT ran_at FROM last_run)))/60.0,
    CASE
      WHEN (SELECT ran_at FROM last_run) IS NULL THEN 'silent'
      WHEN now() - (SELECT ran_at FROM last_run) > interval '2 hours' THEN 'silent'
      ELSE 'healthy'
    END,
    (SELECT count(*) FROM active),
    (SELECT detected_at FROM active LIMIT 1),
    (SELECT email FROM active LIMIT 1);
$$;

REVOKE ALL ON FUNCTION public.get_reconcile_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_reconcile_health() TO service_role;
REVOKE ALL ON FUNCTION public.get_dup_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_dup_health() TO service_role;

-- ── 3. Reconcile-summary RPC for daily digest ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_reconcile_digest_24h()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'runs_24h',           (SELECT count(*) FROM public.ops_reconcile_runs WHERE ran_at > now() - interval '24 hours'),
    'errors_24h',         (SELECT count(*) FROM public.ops_reconcile_runs WHERE ran_at > now() - interval '24 hours' AND error IS NOT NULL),
    'created_trial_rows', COALESCE((SELECT sum((actions_taken->>'created_trial_rows')::int) FROM public.ops_reconcile_runs WHERE ran_at > now() - interval '24 hours'), 0),
    'welcomes_sent',      COALESCE((SELECT sum((actions_taken->>'welcomes_sent')::int) FROM public.ops_reconcile_runs WHERE ran_at > now() - interval '24 hours'), 0),
    'mb_accounts_linked', COALESCE((SELECT sum((actions_taken->>'mb_accounts_linked')::int) FROM public.ops_reconcile_runs WHERE ran_at > now() - interval '24 hours'), 0),
    'capi_events_fired',  COALESCE((SELECT sum((actions_taken->>'capi_events_fired')::int) FROM public.ops_reconcile_runs WHERE ran_at > now() - interval '24 hours'), 0),
    'active_dup_groups',  (SELECT count(*) FROM public.ops_dup_detections WHERE group_size > 1),
    'newest_dup',         (SELECT jsonb_build_object('email', email, 'detected_at', detected_at, 'group_size', group_size)
                             FROM public.ops_dup_detections WHERE group_size > 1
                            ORDER BY detected_at DESC LIMIT 1)
  );
$$;

REVOKE ALL ON FUNCTION public.get_reconcile_digest_24h() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_reconcile_digest_24h() TO service_role;

-- ── 4. Cron schedules ────────────────────────────────────────────────────
-- 15-minute reconcile (offset to :03 so it doesn't collide with on-the-15 syncs)
SELECT cron.schedule(
  'stripe-reconcile-15min',
  '3,18,33,48 * * * *',
  $$SELECT net.http_post(
    url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/stripe-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bbb-secret', 'bbb-test-2026-05-27',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body := jsonb_build_object('lookback_days', 7)
  ) AS request_id;$$
);

-- Hourly dup-detector
SELECT cron.schedule(
  'dup-detector-hourly',
  '7 * * * *',
  $$SELECT net.http_post(
    url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/dup-detector',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bbb-secret', 'bbb-test-2026-05-27',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body := jsonb_build_object('lookback_hours', 24)
  ) AS request_id;$$
);

-- Daily digest at 12:00 UTC = 8:00 AM ET (DST) / 7:00 AM EST
SELECT cron.schedule(
  'daily-ops-digest-8am-et',
  '0 12 * * *',
  $$SELECT net.http_post(
    url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/daily-ops-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bbb-secret', 'bbb-test-2026-05-27',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body := jsonb_build_object('include_reconcile_section', true)
  ) AS request_id;$$
);

-- ── 5. Silence alarm — SMS Justin if reconcile dies ──────────────────────
-- Runs every 10 min. Calls the existing twilio-sms function ONLY if the
-- safety net has been silent for 30+ minutes AND we haven't already alerted
-- in the last hour (prevents SMS spam during outages).
CREATE TABLE IF NOT EXISTS public.ops_silence_alarms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alarmed_at      timestamptz NOT NULL DEFAULT now(),
  monitor         text NOT NULL,    -- 'stripe-reconcile' / 'dup-detector'
  minutes_silent  numeric,
  message         text
);
CREATE INDEX IF NOT EXISTS ops_silence_alarms_at_idx
  ON public.ops_silence_alarms (alarmed_at DESC);

CREATE OR REPLACE FUNCTION public.check_reconcile_silence_and_alarm()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_last_run    timestamptz;
  v_mins        numeric;
  v_last_alarm  timestamptz;
  v_result      jsonb;
BEGIN
  SELECT ran_at INTO v_last_run
    FROM public.ops_reconcile_runs ORDER BY ran_at DESC LIMIT 1;

  IF v_last_run IS NULL THEN
    v_mins := 99999;
  ELSE
    v_mins := EXTRACT(EPOCH FROM (now() - v_last_run))/60.0;
  END IF;

  -- Only alarm if silent 30+ min
  IF v_mins < 30 THEN
    RETURN jsonb_build_object('ok', true, 'status', 'healthy', 'minutes_silent', v_mins);
  END IF;

  -- And only if we haven't already alarmed in the past hour
  SELECT alarmed_at INTO v_last_alarm
    FROM public.ops_silence_alarms
   WHERE monitor = 'stripe-reconcile'
   ORDER BY alarmed_at DESC LIMIT 1;

  IF v_last_alarm IS NOT NULL AND (now() - v_last_alarm) < interval '1 hour' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'silent_but_already_alarmed', 'minutes_silent', v_mins);
  END IF;

  -- Fire alarm. Log first so we don't double-fire if SMS POST hangs.
  INSERT INTO public.ops_silence_alarms (monitor, minutes_silent, message)
  VALUES ('stripe-reconcile', v_mins,
          format('stripe-reconcile silent for %s min. Last successful run: %s', round(v_mins)::text, COALESCE(v_last_run::text, 'NEVER')));

  -- SMS Justin via the existing twilio-sms send function. Body kept short.
  PERFORM net.http_post(
    url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/twilio-sms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bbb-secret', 'bbb-test-2026-05-27'
    ),
    body := jsonb_build_object(
      'to_phone',  '+19178825020',  -- TODO: confirm Justin's cell on first deploy
      'body',      format('BBB safety net SILENT %s min. stripe-reconcile cron may be dead. Check Supabase logs.', round(v_mins)::text),
      'sent_by',   'silence_alarm',
      'send_path', 'reconcile_silence_alarm'
    )
  );

  RETURN jsonb_build_object('ok', true, 'status', 'alarmed', 'minutes_silent', v_mins);
END;
$$;

REVOKE ALL ON FUNCTION public.check_reconcile_silence_and_alarm() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_reconcile_silence_and_alarm() TO service_role;

COMMENT ON FUNCTION public.check_reconcile_silence_and_alarm() IS
  'Pg_cron-driven silence detector. Runs every 10 min. SMS-alarms Justin if stripe-reconcile has been silent for 30+ min AND no prior alarm in last hour. Justin must confirm the phone number in the function body before this is live.';

SELECT cron.schedule(
  'reconcile-silence-watchdog-10min',
  '*/10 * * * *',
  $$SELECT public.check_reconcile_silence_and_alarm();$$
);

-- ── 6. Verify ────────────────────────────────────────────────────────────
SELECT 'reconcile_infra' AS check,
       (SELECT count(*) FROM information_schema.tables
          WHERE table_schema='public' AND table_name IN ('ops_reconcile_runs','ops_dup_detections','ops_dup_detection_runs','ops_silence_alarms')) AS tables_present,
       (SELECT count(*) FROM cron.job
          WHERE jobname IN ('stripe-reconcile-15min','dup-detector-hourly','daily-ops-digest-8am-et','reconcile-silence-watchdog-10min')) AS crons_scheduled;
