-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-08-25 · Re-create the meta-insights-sync cron job — it VANISHED.
--
-- Incident: owner dashboard showed $0 ad spend for 2 weeks ("is the dashboard
-- frozen?"). meta_insights_daily stopped at Aug 11. Manual invocation of the
-- edge function worked instantly (function + Meta tokens healthy), and
-- `select * from cron.job` showed NO meta-insights job at all — only
-- meta-breakdowns-sync-nightly (27) and meta-capi-member-conversion (34)
-- survived. The every-5-min job scheduled in
-- 20260611_bump_meta_insights_sync_to_5min.sql is simply gone (unscheduled by
-- something around Aug 11; exact culprit unknown — job_run_details had aged out).
--
-- This re-creates it identically, plus a sanity check that the vault secret it
-- depends on still exists (if that SELECT returns 0 rows, the job will run but
-- every call will 401 silently — fix the secret first).
-- ─────────────────────────────────────────────────────────────────────────────

-- 0. Sanity: the auth secret the job needs. MUST return 1 row.
SELECT name, created_at FROM vault.secrets WHERE name = 'service_role_jwt';

-- 1. Idempotent cleanup of any prior versions
DO $$
BEGIN
  PERFORM cron.unschedule('meta-insights-sync')      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'meta-insights-sync');
  PERFORM cron.unschedule('meta-insights-sync-6h')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'meta-insights-sync-6h');
  PERFORM cron.unschedule('meta-insights-sync-5min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'meta-insights-sync-5min');
END $$;

-- 2. Re-schedule: every 5 minutes, default window last_7 (self-heals gaps up to a week)
SELECT cron.schedule(
  'meta-insights-sync-5min',
  '*/5 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/meta-insights-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $sql$
);

-- 3. Verify it landed
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'meta-insights%';

-- 4. Run this again in ~10 minutes to confirm it is actually firing:
-- SELECT start_time, status, return_message FROM cron.job_run_details
-- WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'meta-insights-sync-5min')
-- ORDER BY start_time DESC LIMIT 3;
