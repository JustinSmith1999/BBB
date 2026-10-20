-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule daily-lead-digest: yesterday's unworked leads, to each studio, 7am ET.
--
-- Built 2026-10-19. Justin: "Remember to send these every single day" and
-- "how can I have this run without the app?"
--
-- WHY pg_cron AND NOT A CLAUDE SCHEDULED TASK: a Claude task only fires while
-- the desktop app is open, so a closed laptop at 7am means the studios get
-- nothing that morning. This runs on Supabase's servers. Same mechanism as the
-- ten jobs already in cron.job (abandoned-cart every 30 min, the 5-minute
-- syncs, daily-ops-digest at 6am).
--
-- 7am ET = 11:00 UTC during EDT (March–November)
--        = 12:00 UTC during EST (winter)
-- Scheduled at 11:00 UTC. In winter it lands at 6am ET instead of 7am, which
-- is early rather than late, so the list is still waiting when the desk opens.
-- This matches the existing daily-ops-digest comment, which accepts the same
-- one-hour drift rather than maintaining two schedules.
--
-- AUTH: this function gates on x-bbb-secret, like gsc-sync and
-- meta-breakdowns-sync, not on the service_role JWT that daily-ops-digest uses.
-- Passing the wrong one gives a silent 401 and the studios simply never hear.
--
-- NO DATE IN THE BODY ON PURPOSE: the function defaults to yesterday in
-- America/New_York. Pinning a date here would freeze the digest on one day.
--
-- SAFE TO RE-RUN: the unschedule block below removes any previous version of
-- the job first, so applying this twice does not create two jobs that would
-- email every studio twice each morning.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('daily-lead-digest-7am-et');
EXCEPTION WHEN OTHERS THEN
  NULL;
END$$;

SELECT cron.schedule(
  'daily-lead-digest-7am-et',
  '0 11 * * *',  -- 11:00 UTC = 7am EDT (Mar-Nov) / 6am EST (Dec-Mar)
  $cron$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/daily-lead-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-bbb-secret', 'bbb-test-2026-05-27'
      ),
      body := jsonb_build_object('dry_run', false),
      timeout_milliseconds := 180000
    );
  $cron$
);

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect exactly ONE row named daily-lead-digest-7am-et.
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'daily-lead-digest-7am-et';

-- After the first 7am run, confirm it actually fired and returned 200:
--   SELECT j.jobname, r.status, r.return_message, r.start_time
--   FROM cron.job_run_details r
--   JOIN cron.job j USING (jobid)
--   WHERE j.jobname = 'daily-lead-digest-7am-et'
--   ORDER BY r.start_time DESC
--   LIMIT 5;
