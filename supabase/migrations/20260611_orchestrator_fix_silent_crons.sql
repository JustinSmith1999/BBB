-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 NIGHT · EMERGENCY · Replace ALL broken pg_net cron jobs with a
-- single-orchestrator-per-tier model.
--
-- Today's evidence: dashboard data 6+ hours stale despite this morning's
-- "timeout_milliseconds := 60000" migration. pg_cron reports "succeeded" but
-- the actual HTTP calls don't complete because pg_net's worker queue backs
-- up under load (23 net.http_post calls fired simultaneously at xx:05/xx:10).
--
-- The fix:
--   1. ALL old per-function crons → unscheduled.
--   2. Five new crons (every5, every10, every15, every30, hourly) → each
--      calls ONE function: sync-orchestrator with a tier parameter.
--   3. The orchestrator function fans out internally with Promise.all and
--      AbortController timeouts. pg_net only ever sees ONE outbound call per
--      cron tick instead of 23 — queue saturation eliminated.
--
-- Also: bump pg_net.timeout GUC to 60s globally as a belt+suspenders.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Verify the JWT secret is set (loud-fail if missing) ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'service_role_jwt' AND length(secret) > 100
  ) THEN
    RAISE EXCEPTION 'vault.secrets.service_role_jwt is missing — paste the service-role JWT first';
  END IF;
END $$;

-- ── 1. (removed) pg_net.ttl / ALTER SYSTEM ─────────────────────────────────
-- The Supabase SQL editor wraps statements in a transaction, and ALTER SYSTEM
-- cannot run inside one. The real fix below (orchestrator pattern) does the
-- heavy lifting — pg_net only ever sees ONE outbound HTTP call per cron tick
-- instead of 20+, so the worker queue can't back up. We don't need the GUC.

-- ── 2. Unschedule EVERY old HTTP-firing cron we've installed today ──────────
-- Keep RPC-only crons (refresh_dashboard_kpis_5min, sheet-sync-watchdog) —
-- those don't go through pg_net so they're fine.
DO $$
DECLARE jn text;
BEGIN
  FOR jn IN
    SELECT jobname FROM cron.job
     WHERE jobname IN (
       'meta-insights-sync-5min', 'meta-insights-sync', 'meta-insights-sync-6h', 'bbb_meta_insights_sync',
       'sheet-sync-5min',
       'stripe-paid-mirror-5min', 'sync-stripe-paid-mirror-5min',
       'mindbody-sales-10min', 'mindbody-visits-10min', 'mindbody-clients-30min',
       'mindbody-visits-sync-hourly', 'mindbody-trial-sync-hourly',
       'mindbody-capi-purchase-sync',
       'abandoned-cart-followup-30min',
       'stripe-webhook-heartbeat',
       'vapi-calls-sync-15min',
       'comeback-offer-hourly',
       -- in case any of these were tried earlier today
       'sync-orch-every5', 'sync-orch-every10', 'sync-orch-every15', 'sync-orch-every30', 'sync-orch-hourly'
     )
  LOOP
    PERFORM cron.unschedule(jn);
  END LOOP;
END $$;

-- ── 3. Schedule the 5 new orchestrator crons ────────────────────────────────
-- Each cron only fires ONE net.http_post per tick. The orchestrator function
-- fans out to its tier's downstream functions in parallel.
SELECT cron.schedule(
  'sync-orch-every5',
  '*/5 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-orchestrator',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{"tier":"every5"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $sql$
);

SELECT cron.schedule(
  'sync-orch-every10',
  '*/10 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-orchestrator',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{"tier":"every10"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $sql$
);

SELECT cron.schedule(
  'sync-orch-every15',
  '*/15 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-orchestrator',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{"tier":"every15"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $sql$
);

SELECT cron.schedule(
  'sync-orch-every30',
  '*/30 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-orchestrator',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{"tier":"every30"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $sql$
);

SELECT cron.schedule(
  'sync-orch-hourly',
  '7 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-orchestrator',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{"tier":"hourly"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $sql$
);

-- ── 4. Verify — show what's now active ──────────────────────────────────────
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname LIKE 'sync-orch-%'
   OR jobname IN ('refresh_dashboard_kpis_5min', 'sheet-sync-watchdog')
ORDER BY jobname;
