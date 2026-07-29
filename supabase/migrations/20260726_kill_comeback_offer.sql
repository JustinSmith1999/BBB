-- 20260726_kill_comeback_offer.sql
--
-- Per Justin (2026-07-26): kill the $29 one-week comeback offer entirely. It was
-- scheduled (comeback-offer-hourly) but has been silently failing to send; rather
-- than repair it, we're removing it so it can never fire — no $29 offer, ever.
--
-- Unschedules every comeback-related pg_cron job (the hourly offer plus any
-- comeback email follow-up job). The edge functions stay in the repo but are now
-- unreachable by any scheduler. Safe to re-run.

DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT jobname FROM cron.job WHERE jobname ILIKE '%comeback%'
  LOOP
    PERFORM cron.unschedule(j.jobname);
    RAISE NOTICE 'unscheduled cron job: %', j.jobname;
  END LOOP;
END $$;

-- Confirm nothing comeback-related remains scheduled (expect 0 rows).
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname ILIKE '%comeback%';
