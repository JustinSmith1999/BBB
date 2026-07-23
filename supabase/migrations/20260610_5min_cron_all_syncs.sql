-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: 5-minute cron cadence for every source-of-truth sync.
--
-- Justin: "Pull info from all the sheets, stripe, and mindbody every few
-- minutes to keep all consistency."
--
-- Schedules:
--   • sheet-sync-astoria        — every 5 min  (CSV pulls, cheap)
--   • sync-stripe-paid-mirror   — every 5 min  (already on cron, verify)
--   • mindbody-sales-sync       — every 10 min (rate-limit aware)
--   • mindbody-visits-sync      — every 10 min
--   • mindbody-clients-sync     — every 30 min (slower-changing data)
--
-- The vault.secrets table stores the service_role_jwt used by pg_net.
-- ─────────────────────────────────────────────────────────────────────────────

-- Unschedule any old versions of these jobs first (idempotent)
DO $$
DECLARE
  job_name text;
BEGIN
  FOR job_name IN
    SELECT jobname FROM cron.job
    WHERE jobname IN (
      'sheet-sync-5min',
      'stripe-paid-mirror-5min',
      'mindbody-sales-10min',
      'mindbody-visits-10min',
      'mindbody-clients-30min'
    )
  LOOP
    PERFORM cron.unschedule(job_name);
  END LOOP;
END $$;


-- 1. Activity sheets (all 4 studios) — every 5 minutes
SELECT cron.schedule(
  'sheet-sync-5min',
  '*/5 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sheet-sync-astoria',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $sql$
);

-- 2. Stripe paid mirror — every 5 minutes
SELECT cron.schedule(
  'stripe-paid-mirror-5min',
  '*/5 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-stripe-paid-mirror',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{"since":"2026-05-15"}'::jsonb
    );
  $sql$
);

-- 3. MindBody sales — every 10 minutes (API rate-limit aware)
SELECT cron.schedule(
  'mindbody-sales-10min',
  '*/10 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-sales-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{"lookback_days":30}'::jsonb
    );
  $sql$
);

-- 4. MindBody visits — every 10 minutes
SELECT cron.schedule(
  'mindbody-visits-10min',
  '*/10 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-visits-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{"lookback_days":14,"concurrency":3}'::jsonb
    );
  $sql$
);

-- 5. MindBody clients — every 30 minutes
SELECT cron.schedule(
  'mindbody-clients-30min',
  '*/30 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-clients-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $sql$
);


-- Verify
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname IN (
  'sheet-sync-5min',
  'stripe-paid-mirror-5min',
  'mindbody-sales-10min',
  'mindbody-visits-10min',
  'mindbody-clients-30min'
)
ORDER BY jobname;
