-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-24 · Disable auto-expire-to-lost. Paid customers default to New Lead.
--
-- WHY: Justin 2026-06-24 — "Anyone who paid for a trial shouldn't get moved to
-- lost. Put everyone in New Lead until they are put into lost manually."
--
-- The 2026-06-08 migration scheduled a nightly cron that auto-moved any paid
-- trial 14+ days old into 'lost' if they hadn't converted. That's now wrong —
-- staff wants to keep working stale leads forever rather than auto-bucketing
-- them. Lost should be a manual decision only.
--
-- Changes:
--   1. Unschedule expire-stale-trials-nightly
--   2. Replace expire_stale_trials() with a no-op so any leftover calls don't
--      error (some code may still reference the function name).
--   3. Restore every paid + non-converted + currently-Lost row back to
--      new_lead. ASSUMPTION: most rows in Lost right now were placed there by
--      the cron, not by staff. If staff truly Lost'd someone, they can move
--      them back manually with one drag — better than leaving cron-victims
--      stranded in Lost.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Unschedule the nightly cron (safe if already unscheduled)
DO $$
BEGIN
  PERFORM cron.unschedule('expire-stale-trials-nightly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-stale-trials-nightly');
EXCEPTION WHEN OTHERS THEN NULL;
END$$;

-- 2. Replace the function with a no-op (returns empty result set so any
--    leftover callers don't get a function-not-found error).
CREATE OR REPLACE FUNCTION public.expire_stale_trials()
RETURNS TABLE(
  studio_slug    TEXT,
  expired_count  INT,
  cutoff         TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Intentionally a no-op as of 2026-06-24. Auto-expire was disabled because
  -- paid customers should stay in New Lead indefinitely until staff manually
  -- moves them to Lost. See migration header for full reasoning.
  RETURN QUERY SELECT NULL::TEXT, 0, now() WHERE FALSE;
END;
$$;

COMMENT ON FUNCTION public.expire_stale_trials() IS
  'No-op as of 2026-06-24. Auto-expire was disabled per Justin — paid customers must NEVER auto-move to Lost. Kept as no-op shim so prior callers don''t error.';

-- 3. Restore auto-Lost'd customers back to New Lead.
--    Scope: paid trials currently in Lost who never converted to member +
--    aren't soft-deleted. These are the cron's prior victims.
WITH restored AS (
  UPDATE public.trial_signups
     SET front_desk_stage = 'new_lead',
         front_desk_updated_at = now()
   WHERE payment_status = 'completed'
     AND front_desk_stage = 'lost'
     AND COALESCE(converted_to_member, FALSE) = FALSE
     AND deleted_at IS NULL
  RETURNING id, name, location_id
)
SELECT
  'restored_from_lost_to_new_lead' AS action,
  count(*) AS total_restored
FROM restored;

-- 4. Verify
SELECT 'cron_state' AS check,
       (SELECT count(*) FROM cron.job WHERE jobname = 'expire-stale-trials-nightly') AS expire_cron_scheduled,
       (SELECT count(*) FROM public.trial_signups
          WHERE payment_status = 'completed'
            AND front_desk_stage = 'lost'
            AND COALESCE(converted_to_member, FALSE) = FALSE
            AND deleted_at IS NULL) AS paid_still_in_lost;
-- Expected: expire_cron_scheduled = 0, paid_still_in_lost = 0
