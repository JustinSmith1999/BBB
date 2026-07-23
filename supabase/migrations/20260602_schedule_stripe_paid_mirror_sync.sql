-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule sync-stripe-paid-mirror to run every 5 minutes.
--
-- 2026-06-02 post-mortem: the original mirror migration described the cron
-- ("every 5 min via pg_cron") but the cron.schedule() call was never written.
-- Net effect: stripe_paid_mirror stayed EMPTY since launch — every "Stripe
-- truth" count read zero. 14 paying customers across the 4 studios never
-- got trial_signups rows and never appeared on /homebase. Same failure
-- mode caught earlier for meta-insights-sync (task #74) and gsc-sync (#93).
--
-- This migration:
--   1. Drops any prior schedule with the same name (idempotent reruns)
--   2. Schedules sync-stripe-paid-mirror every 5 min with 24h lookback
--   3. Verifies the schedule landed
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_id BIGINT;
BEGIN
  FOR v_id IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'sync-stripe-paid-mirror-5min'
  LOOP
    PERFORM cron.unschedule(v_id);
  END LOOP;
END$$;

-- Every 5 min — pull last 24h of Stripe $49 PaymentIntents into the mirror.
-- 24h lookback gives us a generous safety net against transient API failures.
SELECT cron.schedule(
  'sync-stripe-paid-mirror-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-stripe-paid-mirror?hours=24',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bbb-secret', 'bbb-test-2026-05-27'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Verify
SELECT jobname, schedule, active, jobid
FROM cron.job
WHERE jobname = 'sync-stripe-paid-mirror-5min';
