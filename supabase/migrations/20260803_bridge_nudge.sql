-- 20260803_bridge_nudge.sql
-- "Almost-buyer" follow-up: the attribution bridge captures people who reach
-- account-creation on a trial page. If they don't purchase within 2 hours,
-- bridge-abandon-nudge emails them once. This migration adds the stamp column
-- and schedules the function every 30 minutes.
ALTER TABLE trial_signups
  ADD COLUMN IF NOT EXISTS bridge_nudge_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS bridge_nudge_error   text;

-- Schedule (idempotent: unschedule any prior copy first)
DO $$
BEGIN
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'bridge-abandon-nudge-30m';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
SELECT cron.schedule(
  'bridge-abandon-nudge-30m',
  '*/30 * * * *',
  $$ SELECT net.http_post(
       url    := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/bridge-abandon-nudge',
       headers:= jsonb_build_object('Content-Type','application/json','x-bbb-secret','bbb-test-2026-05-27'),
       body   := '{}'::jsonb
     ); $$
);
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'bridge-abandon-nudge-30m';
