-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule probe-mindbody to run nightly + alert if MindBody creds break.
--
-- Runs at 3:00 AM ET (07:00 UTC) every day. The function returns 500 if any
-- studio's token request fails, so cron.job_run_details captures the failure
-- and /ops or daily-ops-digest can surface it. (Eventually we'll wire a
-- direct alert path; for now the run-details log is the signal.)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'probe-mindbody-daily-3am-et') THEN
    PERFORM cron.unschedule('probe-mindbody-daily-3am-et');
  END IF;
END$$;

SELECT cron.schedule(
  'probe-mindbody-daily-3am-et',
  '0 7 * * *',
  $cron$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/probe-mindbody',
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
 WHERE jobname = 'probe-mindbody-daily-3am-et';
