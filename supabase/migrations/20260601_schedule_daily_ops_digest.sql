-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule the daily-ops-digest function to fire every morning at 6am ET.
--
-- 6am ET = 10am UTC during EDT (current, May–November)
--        = 11am UTC during EST (winter)
-- We schedule at 10am UTC — accept a 1-hour drift in winter rather than
-- maintain two schedules. Digest still arrives well before Justin's day starts.
--
-- ── Gate ────────────────────────────────────────────────────────────────────
-- The function ITSELF checks BBB_SEND_PATHS_ENABLED for "justin_daily_digest".
-- So the cron fires unconditionally, but the function no-ops until Justin adds
-- the path to the env var. That's the seatbelt.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('daily-ops-digest-6am-et');
EXCEPTION WHEN OTHERS THEN
  NULL;
END$$;

SELECT cron.schedule(
  'daily-ops-digest-6am-et',
  '0 10 * * *',  -- 10:00 UTC = 6am EDT (June-November) / 5am EST (December-March)
  $cron$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/daily-ops-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1),
          ''
        )
      ),
      body := '{}'::jsonb
    );
  $cron$
);

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT jobname, schedule, command
FROM cron.job
WHERE jobname LIKE '%digest%'
   OR jobname LIKE '%meta-insights%'
   OR jobname LIKE '%mindbody%'
ORDER BY jobname;
