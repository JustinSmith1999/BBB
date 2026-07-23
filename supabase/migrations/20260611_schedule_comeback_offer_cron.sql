-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · Schedule comeback-offer-cron · hourly.
--
-- This cron sends the $29 / 1-week comeback offer to leads who:
--   • Started a $49 trial signup ≥ 7 days ago
--   • Didn't complete payment
--   • Haven't paid at ANY studio (Stripe mirror + MB sales cross-check)
--
-- Cadence per Justin (2026-06-11):
--   1. SMS first (via Twilio)
--   2. If 3 days pass with no conversion → follow-up email (via Resend)
--   3. Never again
--
-- Runs every hour at :07 — off-the-hour to avoid stacking with other crons.
-- Function is idempotent (per-row tracking columns) so re-runs are safe.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM cron.unschedule('comeback-offer-hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'comeback-offer-hourly');
END $$;

SELECT cron.schedule(
  'comeback-offer-hourly',
  '7 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/comeback-offer-cron',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $sql$
);

SELECT jobname, schedule, active
FROM cron.job
WHERE jobname = 'comeback-offer-hourly';
