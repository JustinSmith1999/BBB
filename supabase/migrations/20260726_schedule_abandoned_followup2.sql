-- 20260726_schedule_abandoned_followup2.sql
--
-- FIX: abandoned-cart-followup-2 (the SECOND abandoned-checkout email — sent
-- ~24h after the first, when abandoned_email2_sent_at IS NULL) has existed since
-- launch but was NEVER scheduled. Same failure mode as the drip and the first
-- abandoned email: the function is fine, the cron.schedule() call was just never
-- written. So every abandoned checkout gets exactly one email and then silence.
-- This wires the missing job.
--
-- Idempotent: the function only selects rows with abandoned_email2_sent_at NULL
-- whose first email went out 24h–14d ago, and stamps abandoned_email2_sent_at on
-- send, so re-runs never double-email.
--
-- Runs every 30 min at :11 and :41 (off the other crons). Mirrors
-- 20260602_schedule_abandoned_cart_followup.sql. Run in the Supabase SQL editor
-- (project uracuwugpxqjfgtuobal). Safe to re-run.

DO $$
BEGIN
  PERFORM cron.unschedule('abandoned-cart-followup2-30min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'abandoned-cart-followup2-30min');
END $$;

SELECT cron.schedule(
  'abandoned-cart-followup2-30min',
  '11,41 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/abandoned-cart-followup-2',
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
WHERE jobname = 'abandoned-cart-followup2-30min';
