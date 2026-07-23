-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · Bump pg_net timeout on every cron we've installed.
--
-- ROOT CAUSE of today's dashboard-staleness investigation:
-- pg_cron calls net.http_post() which queues the HTTP call asynchronously.
-- pg_net has a default per-request timeout (~5 seconds). Our Edge Functions
-- regularly take 15-30 seconds because they hit external APIs (Meta, MindBody,
-- Stripe, Twilio). When pg_net's timeout fires, the request is aborted —
-- pg_cron sees "request queued = succeeded" but the function never completes,
-- so the DB never gets updated.
--
-- pg_net._http_response evidence:
--   • Most rows have status_code = NULL (timeout)
--   • Only fast functions (return < 5s) show status_code = 200
--
-- Fix: rewrite each cron's net.http_post call with timeout_milliseconds := 60000.
-- 60 seconds is plenty for the slowest function (mindbody-clients-sync).
--
-- This migration re-installs every 5-min / 10-min / 15-min cron with the
-- timeout parameter. Daily / nightly crons (where 5s is enough) are left alone.
-- ─────────────────────────────────────────────────────────────────────────────

-- Reusable helper that unschedules then schedules a job with proper timeout.
DO $$
DECLARE
  rec record;
  url text;
  body text;
BEGIN
  -- Each row: jobname, http url, request body (JSON string)
  FOR rec IN
    SELECT * FROM (VALUES
      ('meta-insights-sync-5min',          'meta-insights-sync',          '{}',                              '*/5 * * * *'),
      ('sheet-sync-5min',                  'sheet-sync-astoria',          '{}',                              '*/5 * * * *'),
      ('sheet-sync-watchdog',              NULL,                          NULL,                              NULL), -- handled via RPC, no http
      ('stripe-paid-mirror-5min',          'sync-stripe-paid-mirror',     '{"since":"2026-05-15"}',          '*/5 * * * *'),
      ('sync-stripe-paid-mirror-5min',     'sync-stripe-paid-mirror',     '{"since":"2026-05-15"}',          '*/5 * * * *'),
      ('refresh_dashboard_kpis_5min',      NULL,                          NULL,                              NULL), -- internal RPC, no http
      ('mindbody-sales-10min',             'mindbody-sales-sync',         '{"lookback_days":30}',            '*/10 * * * *'),
      ('mindbody-visits-10min',            'mindbody-visits-sync',        '{"lookback_days":7}',             '*/10 * * * *'),
      ('mindbody-clients-30min',           'mindbody-clients-sync',       '{"since":"2026-05-15"}',          '*/30 * * * *'),
      ('mindbody-capi-purchase-sync',      'mindbody-capi-purchase-sync', '{"lookback_hours":1}',            '*/15 * * * *'),
      ('comeback-offer-hourly',            'comeback-offer-cron',         '{}',                              '7 * * * *'),
      ('abandoned-cart-followup-30min',    'abandoned-cart-followup',     '{}',                              '*/30 * * * *'),
      ('mindbody-visits-sync-hourly',      'mindbody-visits-sync',        '{"lookback_days":2}',             '7 * * * *'),
      ('mindbody-trial-sync-hourly',       'mindbody-trial-sync',         '{}',                              '10 * * * *'),
      ('stripe-webhook-heartbeat',         'stripe-webhook-heartbeat',    '{}',                              '*/15 * * * *'),
      ('vapi-calls-sync-15min',            'vapi-calls-sync',             '{}',                              '*/15 * * * *'),
      ('bbb_meta_insights_sync',           NULL,                          NULL,                              NULL)  -- duplicate of meta-insights-sync-5min, KILL
    ) AS t(jobname, fn, body, sched)
  LOOP
    -- Unschedule if exists (idempotent)
    PERFORM cron.unschedule(rec.jobname)
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = rec.jobname);

    -- Skip rows with NULL fn (those are either RPC-only or duplicates we want to kill)
    IF rec.fn IS NULL THEN
      CONTINUE;
    END IF;

    -- Re-schedule with 60s pg_net timeout
    EXECUTE format(
      $f$
      SELECT cron.schedule(
        %L,
        %L,
        $C$
        SELECT net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
            'Content-Type', 'application/json'
          ),
          body := %L::jsonb,
          timeout_milliseconds := 60000
        );
        $C$
      );
      $f$,
      rec.jobname,
      rec.sched,
      'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/' || rec.fn,
      rec.body
    );

    RAISE NOTICE 'Re-scheduled % (% s timeout)', rec.jobname, 60;
  END LOOP;
END $$;

-- Re-create the RPC-only jobs (no http call, no timeout concern)
SELECT cron.unschedule('refresh_dashboard_kpis_5min')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh_dashboard_kpis_5min');
SELECT cron.schedule(
  'refresh_dashboard_kpis_5min',
  '*/5 * * * *',
  $sql$ SELECT public.refresh_dashboard_kpis(); $sql$
);

SELECT cron.unschedule('sheet-sync-watchdog')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sheet-sync-watchdog');
SELECT cron.schedule(
  'sheet-sync-watchdog',
  '2-59/5 * * * *',
  $sql$ SELECT public.check_sheet_sync_health(); $sql$
);

-- Verify — show every active cron with its schedule
SELECT jobname, schedule, active
FROM cron.job
ORDER BY jobname;
