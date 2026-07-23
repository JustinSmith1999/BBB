-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule netlify-analytics-sync nightly at 3:30 AM ET (07:30 UTC).
-- Pulls last 30 days. Idempotent — re-running yesterday refreshes the row.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'netlify-analytics-sync-nightly') THEN
    PERFORM cron.unschedule('netlify-analytics-sync-nightly');
  END IF;
END$$;

SELECT cron.schedule(
  'netlify-analytics-sync-nightly',
  '30 7 * * *',
  $cron$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/netlify-analytics-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1),
          ''
        )
      ),
      body := jsonb_build_object('days', 30),
      timeout_milliseconds := 120000
    );
  $cron$
);

SELECT jobid, jobname, schedule, active
  FROM cron.job
 WHERE jobname = 'netlify-analytics-sync-nightly';
