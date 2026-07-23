-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · Schedule mindbody-capi-purchase-sync nightly.
--
-- Context: today we discovered Meta had been starving WB's campaign ($2.84
-- spend by 9 AM) because the auto-bidder saw a week of $1,481 ad spend with
-- only 4 attributed Purchases. Real conversions were ~30+ across all studios,
-- but in-person MindBody sales never fired Purchase CAPI events. Manual
-- one-shot backfill fixed it; this cron makes it permanent.
--
-- Function: mindbody-capi-purchase-sync (deployed --no-verify-jwt)
--   - Pulls mindbody_sales from last 36h (intentional 12h overlap w/ prior run)
--   - Joins mindbody_clients for email + phone PII
--   - Trial ($49) → CAPI Purchase. Membership (≥$100) → CAPI Subscribe + LTV.
--   - Idempotent via event_id = mb_<sale_id> — safe to re-run any time.
--
-- Schedule:  04:15 ET = 08:15 UTC, daily.
--   Runs 15 min after mindbody-sales-sync (typically 04:00 ET) so it has
--   yesterday's MB sales mirrored before scanning them.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT cron.unschedule('mindbody-capi-purchase-sync')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mindbody-capi-purchase-sync');

SELECT cron.schedule(
  'mindbody-capi-purchase-sync',
  '15 8 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-capi-purchase-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('lookback_hours', 36)
  );
  $$
);

SELECT jobname, schedule, active
FROM cron.job
WHERE jobname = 'mindbody-capi-purchase-sync';
