-- 2026-06-22 · trial_starts_at column
--
-- WHY: Lucia paid 6/20 but Kiana set her trial to start 7/8 (she'll book closer
-- to that date). The /homebase "Xd left" countdown was reading from
-- payment_date — so for Lucia it would say "0 days left" by 7/4 when she
-- hasn't even started yet.
--
-- Fix: explicit trial_starts_at column. Defaults to payment_date for existing
-- rows (backfilled by this migration). Staff can override on the /homebase
-- card when a customer pre-pays for a future start. trial_ends_at is computed
-- as trial_starts_at + 14 days in the UI (kept lightweight — no generated
-- column so the read path doesn't need a migration to change the trial length
-- per package later).

ALTER TABLE trial_signups
  ADD COLUMN IF NOT EXISTS trial_starts_at timestamptz;

-- Backfill: every existing paid customer's trial started when they paid.
UPDATE trial_signups
   SET trial_starts_at = payment_date
 WHERE trial_starts_at IS NULL
   AND payment_status = 'completed'
   AND payment_date IS NOT NULL;

COMMENT ON COLUMN trial_signups.trial_starts_at IS
  'Actual trial start date. Defaults to payment_date but staff can override on /homebase when a customer pre-pays for a future start (e.g. paid 6/20 but trial begins 7/8). UI computes trial_ends_at = trial_starts_at + 14d.';

-- Lucia Castiblanco — Kiana 6/22 10:32am: trial begins 7/8 per in-studio convo.
UPDATE trial_signups
   SET trial_starts_at = '2026-07-08T00:00:00-04:00'::timestamptz
 WHERE id = '9623beac-3cf9-4325-825f-929d8d209f05';

-- Verify
SELECT name, payment_date, trial_starts_at,
       (trial_starts_at + interval '14 days') AS trial_ends_at
  FROM trial_signups
 WHERE id = '9623beac-3cf9-4325-825f-929d8d209f05';
