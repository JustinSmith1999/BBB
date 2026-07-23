-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · Bump mindbody-capi-purchase-sync from once-daily to every 15 min.
--
-- Why: today's $1,999 Fresh Meadows PIF + $1,999 Bayside PIF + $499 × 2 sat
-- in mindbody_sales for HOURS without being pushed to Meta. The original cron
-- was 04:15 ET nightly — defensive, but wrong for a revenue-critical signal
-- pipeline. Meta's auto-bidder needs Purchase/Subscribe events to land
-- inside its 7-day attribution window AND quickly enough to influence today's
-- delivery decisions. Once a day is too slow.
--
-- 15 min cadence rationale:
--   • Function is idempotent (event_id = mb_<sale_id>, ok=true rows skipped)
--   • mindbody-sales-sync runs every 10 min, so MB sales land within 10 min
--   • 15 min cron picks them up within 25 min worst-case
--   • Meta CAPI rate limit ~10K events/hour — we're well under
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM cron.unschedule('mindbody-capi-purchase-sync')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mindbody-capi-purchase-sync');
END $$;

SELECT cron.schedule(
  'mindbody-capi-purchase-sync',
  '*/15 * * * *',
  $sql$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-capi-purchase-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name = 'service_role_jwt'),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('lookback_hours', 1)
    );
  $sql$
);

SELECT jobname, schedule, active
FROM cron.job
WHERE jobname = 'mindbody-capi-purchase-sync';
