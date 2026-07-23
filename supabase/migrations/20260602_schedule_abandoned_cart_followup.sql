-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule abandoned-cart-followup to actually run.
--
-- The function has existed since launch but was NEVER scheduled. Same failure
-- mode as the stripe_paid_mirror sync (caught earlier today): code describes
-- a recurring job, the cron.schedule() call was never made.
--
-- Effect: 5 unpaid leads from 6/1 never received their recovery email.
-- Likely a much bigger backlog hidden behind manual one-off invocations.
--
-- Cadence: every 30 minutes. Function caps at 100 candidates per run and the
-- 1h–14d candidate window is wide, so 30-min checks are plenty. Each row
-- bears a markPersonHandled flag so duplicates are impossible.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'abandoned-cart-followup-30min') THEN
    PERFORM cron.unschedule('abandoned-cart-followup-30min');
  END IF;
END$$;

SELECT cron.schedule(
  'abandoned-cart-followup-30min',
  '*/30 * * * *',
  $cron$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/abandoned-cart-followup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1),
          ''
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cron$
);

-- Verify
SELECT jobid, jobname, schedule, active
  FROM cron.job
 WHERE jobname = 'abandoned-cart-followup-30min';
