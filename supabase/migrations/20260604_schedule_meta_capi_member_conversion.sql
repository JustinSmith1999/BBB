-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: schedule meta-capi-member-conversion nightly.
--
-- Fires CAPI Subscribe events for newly-converted members (paid-trial → bought
-- a non-trial package). Tells Meta's algorithm which trial customers actually
-- become real members so it can optimize lookalikes for quality.
--
-- Cron: 03:00 ET = 07:00 UTC, every day. The function is idempotent (dedupes
-- via capi_events.event_id) so running it daily is safe — only NEW conversions
-- get an event.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT cron.unschedule('meta-capi-member-conversion')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'meta-capi-member-conversion');

SELECT cron.schedule(
  'meta-capi-member-conversion',
  '0 7 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/meta-capi-member-conversion',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb
  );
  $$
);

SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'meta-capi-member-conversion';
