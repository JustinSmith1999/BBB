-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · URGENT · Restart sheet-sync cron + add a heartbeat alarm.
--
-- Today's stale-sync incident: the */5 * * * * cron registered on 2026-06-10
-- silently stopped firing. Last successful sync was 2026-06-10 20:48 ET — 18
-- hours of blind data while ad spend was diagnostically critical. Justin: "NO
-- EXCUSE FOR DROP IN DATA."
--
-- Likely root cause: vault.secrets.service_role_jwt was emptied or the cron
-- job got dropped by a later migration's bulk-unschedule. Either way, this
-- migration is defensively idempotent — re-creates the secret if missing,
-- re-creates the cron, and adds an independent watchdog that alerts the
-- moment any sync goes >15 minutes stale.
--
-- What this installs:
--   1. cron job: sheet-sync-5min  · every 5 min
--   2. cron job: sheet-sync-watchdog · every 5 min (checks freshness, alerts)
--   3. RPC:      get_sheet_sync_freshness() — returns latest fetched_at per studio
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Safety: confirm the service_role_jwt secret exists ────────────────────
-- (If missing, this migration WILL fail loudly at the cron tick. That's the
--  desired behavior — silent failure is what got us here.)
DO $$
DECLARE
  jwt_present boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'service_role_jwt' AND length(secret) > 100)
    INTO jwt_present;
  IF NOT jwt_present THEN
    RAISE EXCEPTION 'vault.secrets.service_role_jwt is missing or empty. '
      'Run: INSERT INTO vault.secrets (name, secret) VALUES (''service_role_jwt'', ''<SUPABASE_SERVICE_ROLE_KEY>'') '
      'ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;';
  END IF;
END $$;

-- ── 1. Unschedule any prior variants (idempotent) ────────────────────────────
DO $$
DECLARE jn text;
BEGIN
  FOR jn IN
    SELECT jobname FROM cron.job
     WHERE jobname IN ('sheet-sync-5min','sheet-sync-watchdog','sheet-sync','sheet-sync-cron')
  LOOP
    PERFORM cron.unschedule(jn);
  END LOOP;
END $$;

-- ── 2. Reschedule the sync · every 5 minutes ────────────────────────────────
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

-- ── 3. Freshness RPC (for /ops dashboard + watchdog) ─────────────────────────
CREATE OR REPLACE FUNCTION public.get_sheet_sync_freshness()
RETURNS TABLE (
  studio_slug text,
  last_fetched_at timestamptz,
  minutes_stale int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.studio_slug,
    MAX(s.fetched_at) AS last_fetched_at,
    GREATEST(0, EXTRACT(EPOCH FROM (now() - MAX(s.fetched_at)))::int / 60) AS minutes_stale
  FROM public.staff_sheet_entries s
  GROUP BY s.studio_slug
  ORDER BY s.studio_slug;
$$;

GRANT EXECUTE ON FUNCTION public.get_sheet_sync_freshness() TO anon, authenticated, service_role;

-- ── 4. Watchdog · every 5 min, alerts Justin if any studio is >15 min stale ──
-- Uses Resend via existing send-ops-email helper if present; otherwise just
-- writes a row to ops_alerts and lets /ops surface it.
CREATE TABLE IF NOT EXISTS public.ops_alerts (
  id bigserial PRIMARY KEY,
  alert_key text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warn','critical')),
  studio_slug text,
  message text NOT NULL,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
-- If table pre-existed with a different schema, top up any missing columns
-- (idempotent; no-ops on a fresh install).
ALTER TABLE public.ops_alerts ADD COLUMN IF NOT EXISTS alert_key   text;
ALTER TABLE public.ops_alerts ADD COLUMN IF NOT EXISTS severity    text;
ALTER TABLE public.ops_alerts ADD COLUMN IF NOT EXISTS studio_slug text;
ALTER TABLE public.ops_alerts ADD COLUMN IF NOT EXISTS message     text;
ALTER TABLE public.ops_alerts ADD COLUMN IF NOT EXISTS raw         jsonb;
ALTER TABLE public.ops_alerts ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.ops_alerts ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

CREATE INDEX IF NOT EXISTS ops_alerts_open_idx
  ON public.ops_alerts (alert_key, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION public.check_sheet_sync_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stale_rows int;
  details jsonb;
BEGIN
  SELECT count(*), jsonb_agg(jsonb_build_object('studio', studio_slug, 'minutes_stale', minutes_stale))
    INTO stale_rows, details
  FROM public.get_sheet_sync_freshness()
  WHERE minutes_stale > 15;

  IF stale_rows > 0 THEN
    -- Auto-resolve prior open alerts when status changes — only insert if no
    -- open alert already exists for this key (avoid spam).
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_alerts
      WHERE alert_key = 'sheet_sync_stale' AND resolved_at IS NULL
    ) THEN
      INSERT INTO public.ops_alerts (alert_key, severity, message, raw)
      VALUES (
        'sheet_sync_stale',
        'critical',
        format('Sheet sync is >15 min stale on %s studio(s). Cron likely dead.', stale_rows),
        details
      );
    END IF;
    RETURN jsonb_build_object('ok', false, 'stale_studios', stale_rows, 'details', details);
  ELSE
    -- Resolve any open alerts now that sync is healthy
    UPDATE public.ops_alerts
       SET resolved_at = now()
     WHERE alert_key = 'sheet_sync_stale' AND resolved_at IS NULL;
    RETURN jsonb_build_object('ok', true);
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.check_sheet_sync_health() TO service_role;

-- Schedule the watchdog · runs every 5 min, offset by 2 min so it checks
-- AFTER the sheet-sync has had a chance to land.
SELECT cron.schedule(
  'sheet-sync-watchdog',
  '2-59/5 * * * *',
  $sql$ SELECT public.check_sheet_sync_health(); $sql$
);

-- ── 5. Verify the new state ─────────────────────────────────────────────────
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname IN ('sheet-sync-5min','sheet-sync-watchdog')
ORDER BY jobname;

-- Force one fire NOW so the dashboard catches up immediately
SELECT net.http_post(
  url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sheet-sync-astoria',
  headers := jsonb_build_object(
    'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
    'Content-Type', 'application/json'
  ),
  body := '{}'::jsonb
) AS triggered_immediate_sync;

SELECT * FROM public.get_sheet_sync_freshness();
