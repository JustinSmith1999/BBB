-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-24 · trial_signups unique constraint per (studio, email)
--
-- WHY: 4 duplicate inserts in the last 24h (Lielle 3x, Nina/Yoandra/Sneha 2x
-- each) because stripe-webhook AND paid-trials-realtime-monitor both insert
-- new "completed" rows when their lookup-for-the-pending-row fails. No
-- database-level guard exists. This adds one.
--
-- Scope: case-insensitive email + location_id, only for non-deleted rows.
-- Partial unique index lets soft-deleted dupes coexist with the live row,
-- which matters because our recovery pattern is "soft-delete dup + keep
-- the one with stripe_session_id."
--
-- ROLLBACK: DROP INDEX IF EXISTS trial_signups_email_per_studio_uidx;
-- ─────────────────────────────────────────────────────────────────────────────

-- Safety check FIRST — bail if there are any existing un-merged dupes.
-- This block raises a clean error message rather than letting the CREATE
-- INDEX below fail with a less useful "could not create unique index" error.
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT location_id, lower(email)
      FROM public.trial_signups
     WHERE deleted_at IS NULL
       AND email IS NOT NULL
     GROUP BY location_id, lower(email)
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot add unique constraint: % duplicate (location_id, email) pairs still exist. Run the duplicate-merge SQL first.', dup_count;
  END IF;
END $$;

-- Create the partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS trial_signups_email_per_studio_uidx
  ON public.trial_signups (location_id, lower(email))
  WHERE deleted_at IS NULL AND email IS NOT NULL;

COMMENT ON INDEX public.trial_signups_email_per_studio_uidx IS
  'One live trial_signups row per (studio, email). Prevents stripe-webhook + paid-trials-realtime-monitor from inserting duplicate completed rows when their lookup-for-pending-row fails. Soft-deleted rows are excluded so the merge pattern (soft-delete dup, keep canonical) still works.';

-- Verify
SELECT 'unique_constraint_present' AS check,
       EXISTS(
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'trial_signups_email_per_studio_uidx'
       ) AS present;
