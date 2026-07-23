-- 20260606_trial_signups_mindbody_id.sql
--
-- Adds the column that closes the loop between a Stripe-paid trial and the
-- MindBody client created for that customer.
--
-- Why this exists: mindbody-create-trial-client (deployed 2026-06-06) calls
-- MB AddClient on every paid Stripe checkout, then persists the returned
-- Client.Id back to this column so:
--   1. The function is idempotent — re-runs skip rows that already have a
--      mindbody_id, preventing duplicate MB accounts.
--   2. /homebase + the owner dashboard can deep-link to the MB client
--      record from any trial row.
--   3. The ad-ROI bridge (mindbody_clients.email join) has a faster path
--      via direct id when present.
--
-- Backfill: rows that already have an entry in mindbody_clients matching
-- the trial's email get their mindbody_id populated now, so the
-- one-time backfill pass on 75+ historical paid trials picks each row up
-- exactly once.

ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS mindbody_id text;

-- Quick lookup when surfacing /homebase + reporting joins.
CREATE INDEX IF NOT EXISTS trial_signups_mindbody_id_idx
  ON public.trial_signups (mindbody_id)
  WHERE mindbody_id IS NOT NULL;

-- Backfill from the existing mindbody_clients bridge table where the email
-- already maps to a known MB id. Belt-and-suspenders for the live function:
-- if a customer pays in Stripe and the next mindbody-clients-sync cron
-- happens to pick them up first, this column is populated from that side
-- instead of via the AddClient call.
UPDATE public.trial_signups t
   SET mindbody_id = c.mindbody_id
  FROM public.mindbody_clients c
 WHERE t.mindbody_id IS NULL
   AND lower(t.email) = lower(c.email)
   AND c.mindbody_id IS NOT NULL;

-- Sanity probe — how many rows just got linked.
SELECT
  COUNT(*) FILTER (WHERE mindbody_id IS NOT NULL) AS linked,
  COUNT(*) FILTER (WHERE mindbody_id IS NULL AND payment_status IN ('completed','paid')) AS paid_unlinked,
  COUNT(*) AS total
FROM public.trial_signups
WHERE deleted_at IS NULL;
