-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule meta-insights-sync (was NEVER scheduled — root cause of #38)
--
-- The function exists, the OPS_LEDGER claims it runs every 6h, and the
-- get_ops_validity RPC checks v_meta_last as if it were running. But no
-- cron.schedule() call was ever created for it. The function only ran when
-- Justin (or Claude) hit it manually, which is why meta_ad_insights_daily
-- has been empty/stale: the writer was never invoked.
--
-- This migration:
--   1. Schedules meta-insights-sync every 6 hours (at :17 — offset from
--      mindbody's :07 so they don't both hammer pg_net at the same minute)
--   2. Creates a meta_sync_runs log table so the silent ad_sync_error path
--      in the function stops being silent
--   3. Adds a SECURITY DEFINER RPC to read the latest run for /ops
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── 1. Log table ────────────────────────────────────────────────────────────
-- One row per studio per sync attempt. ad_sync_error is the field that
-- meta-insights-sync currently swallows; persisting it here makes failures
-- visible on /ops instead of evaporating in an unread HTTP response body.
CREATE TABLE IF NOT EXISTS public.meta_sync_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at          timestamptz NOT NULL DEFAULT now(),
  studio_slug     text NOT NULL,
  ok              boolean NOT NULL,
  window_days     int,
  account_rows    int,
  ad_rows         int,
  ads_returned    int,
  error           text,
  ad_sync_error   text,
  raw             jsonb
);

CREATE INDEX IF NOT EXISTS meta_sync_runs_studio_ran_at_idx
  ON public.meta_sync_runs (studio_slug, ran_at DESC);

CREATE INDEX IF NOT EXISTS meta_sync_runs_ran_at_idx
  ON public.meta_sync_runs (ran_at DESC);

-- Keep the table small: drop entries older than 30 days.
-- (Cleanup is best-effort; can also be scheduled separately.)
DELETE FROM public.meta_sync_runs WHERE ran_at < now() - interval '30 days';


-- ── 2. RPC: latest run summary per studio ───────────────────────────────────
DROP FUNCTION IF EXISTS public.get_meta_sync_status();

CREATE OR REPLACE FUNCTION public.get_meta_sync_status()
RETURNS TABLE (
  studio_slug    text,
  last_ran_at    timestamptz,
  ok             boolean,
  ad_rows        int,
  ads_returned   int,
  error          text,
  ad_sync_error  text,
  age_hours      numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (r.studio_slug)
    r.studio_slug,
    r.ran_at AS last_ran_at,
    r.ok,
    r.ad_rows,
    r.ads_returned,
    r.error,
    r.ad_sync_error,
    ROUND(EXTRACT(EPOCH FROM (now() - r.ran_at)) / 3600.0, 1) AS age_hours
  FROM public.meta_sync_runs r
  ORDER BY r.studio_slug, r.ran_at DESC;
$$;

REVOKE ALL ON FUNCTION public.get_meta_sync_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_sync_status() TO authenticated;


-- ── 3. Schedule the cron ────────────────────────────────────────────────────
-- Idempotent: drop any prior schedule with the same name first.
DO $$
BEGIN
  PERFORM cron.unschedule('meta-insights-sync-6h');
EXCEPTION WHEN OTHERS THEN
  NULL;
END$$;

SELECT cron.schedule(
  'meta-insights-sync-6h',
  '17 */6 * * *',  -- every 6h at :17 (offset from mindbody at :07)
  $cron$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/meta-insights-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1),
          ''
        )
      ),
      body := jsonb_build_object('window', 'last_7')
    );
  $cron$
);

-- ── 4. Verification ─────────────────────────────────────────────────────────
-- After running, this should show meta-insights-sync-6h in the list.
SELECT jobname, schedule, command
FROM cron.job
WHERE jobname LIKE '%meta%' OR jobname LIKE '%mindbody%'
ORDER BY jobname;
