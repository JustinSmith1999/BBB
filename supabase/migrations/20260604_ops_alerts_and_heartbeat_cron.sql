-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: ops_alerts table + stripe-webhook-heartbeat cron schedule
--
-- ops_alerts tracks one row per alert key (e.g. 'stripe_webhook_heartbeat')
-- so the heartbeat edge function can suppress re-alerts inside a cooldown
-- window. Single source of truth for "have we already paged Justin about
-- this in the last hour?"
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ops_alerts (
  key             text PRIMARY KEY,
  last_status     text,
  last_alerted_at timestamptz,
  last_seen_at    timestamptz DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.ops_alerts TO authenticated;

-- Schedule the heartbeat: every 15 min.
SELECT cron.unschedule('stripe-webhook-heartbeat')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-webhook-heartbeat');

SELECT cron.schedule(
  'stripe-webhook-heartbeat',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/stripe-webhook-heartbeat',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb
  );
  $$
);

-- Sanity probe
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'stripe-webhook-heartbeat';
