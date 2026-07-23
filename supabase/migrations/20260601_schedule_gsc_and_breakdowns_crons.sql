-- ─────────────────────────────────────────────────────────────────────────────
-- Nightly cron for gsc-sync and meta-breakdowns-sync.
--
-- Both functions were deployed today and manually triggered:
--   • gsc-sync             → wrote 1,022 rows of Google Search data
--   • meta-breakdowns-sync → wrote 2,371 rows of Meta region/demo/placement
--
-- Without a cron, the dashboard cards will go stale. This migration:
--   • Drops any prior schedules with the same name (idempotent reruns)
--   • Schedules gsc-sync nightly at 04:15 UTC (00:15 ET) → 2-day GSC delay
--     means yesterday's data lands tonight
--   • Schedules meta-breakdowns-sync nightly at 04:30 UTC (00:30 ET) →
--     Meta finalizes attribution windows ~midnight
--
-- Both call the function via the bbb-test-2026-05-27 admin secret. The
-- functions are deployed with --no-verify-jwt so they accept the secret
-- header directly.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop existing schedules with the same name so this is idempotent.
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  FOR v_id IN
    SELECT jobid FROM cron.job
    WHERE jobname IN ('gsc-sync-nightly', 'meta-breakdowns-sync-nightly')
  LOOP
    PERFORM cron.unschedule(v_id);
  END LOOP;
END$$;


-- ── 1. gsc-sync: nightly at 04:15 UTC (00:15 ET) ─────────────────────────────
-- Pulls the last 28 days from Google Search Console each night. GSC has a
-- ~2-day data delay, so this catches anything that finalized overnight.
SELECT cron.schedule(
  'gsc-sync-nightly',
  '15 4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/gsc-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bbb-secret', 'bbb-test-2026-05-27'
    ),
    body := jsonb_build_object('days', 28),
    timeout_milliseconds := 180000
  );
  $$
);


-- ── 2. meta-breakdowns-sync: nightly at 04:30 UTC (00:30 ET) ─────────────────
-- Refreshes region/age_gender/placement breakdowns for all 4 studios in a
-- single call. last_14 window so the dashboard's audience cards always show
-- a rolling 2-week view.
SELECT cron.schedule(
  'meta-breakdowns-sync-nightly',
  '30 4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/meta-breakdowns-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bbb-secret', 'bbb-test-2026-05-27'
    ),
    body := jsonb_build_object('window', 'last_14'),
    timeout_milliseconds := 180000
  );
  $$
);


-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT jobname, schedule, active, jobid
FROM cron.job
WHERE jobname IN ('gsc-sync-nightly', 'meta-breakdowns-sync-nightly')
ORDER BY jobname;
