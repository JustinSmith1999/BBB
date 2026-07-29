-- 20260726_schedule_onboarding_drip.sql
--
-- FIX: the trial onboarding email drip (trial-onboarding-sequence: day1, day2,
-- day14, winback) was written to "run hourly via Cron" — but the cron.schedule()
-- call was never made. So the sequence has never fired for ANYONE, website or
-- app. Every paid trial gets the day-0 welcome (from stripe-webhook / the MT
-- welcome batch) and then silence. This wires the missing hourly job.
--
-- The function is idempotent (each step stamps its own *_sent_at column and only
-- selects rows inside its time window with that column NULL), so re-runs and a
-- backfill of the current in-window trials are safe — nobody gets double-emailed.
--
-- Runs hourly at :23 (off-the-hour to avoid stacking with the other crons:
-- comeback :07, digest :00, syncs */5). Follows the exact pattern of
-- 20260611_schedule_comeback_offer_cron.sql.
--
-- Run in the Supabase SQL editor (project uracuwugpxqjfgtuobal). Safe to re-run.

DO $$
BEGIN
  PERFORM cron.unschedule('trial-onboarding-drip-hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'trial-onboarding-drip-hourly');
END $$;

SELECT cron.schedule(
  'trial-onboarding-drip-hourly',
  '23 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/trial-onboarding-sequence',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $sql$
);

SELECT jobname, schedule, active
FROM cron.job
WHERE jobname = 'trial-onboarding-drip-hourly';
