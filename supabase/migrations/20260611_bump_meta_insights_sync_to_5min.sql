-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · Bump meta-insights-sync from every-6-hours to every-5-minutes.
--
-- Today's dashboard-stale incident: meta-insights-sync last ran at 8:17 AM ET,
-- so when Justin checked at 11:00 AM the dashboard showed $17 spent while live
-- Meta API showed $40. 3-hour staleness during an active recovery window is
-- unacceptable — Justin needs to monitor in near-real-time.
--
-- Rate-limit math:
--   4 ad accounts × ~3 small queries per studio × 288 runs/day = ~3,500 calls/day
--   Meta's standard tier limit is 200 API calls per hour per user, but each
--   ad-account query counts independently. We're well under any reasonable cap.
--
-- The function is idempotent (UPSERT on (studio_slug, date_start, ad_id)) so
-- running it every 5 min is safe — re-runs just overwrite with fresh numbers.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- Unschedule any prior versions (idempotent)
  PERFORM cron.unschedule('meta-insights-sync')        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'meta-insights-sync');
  PERFORM cron.unschedule('meta-insights-sync-6h')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'meta-insights-sync-6h');
  PERFORM cron.unschedule('meta-insights-sync-5min')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'meta-insights-sync-5min');
END $$;

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

-- Verify the new schedule landed
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname LIKE 'meta-insights%'
ORDER BY jobname;
