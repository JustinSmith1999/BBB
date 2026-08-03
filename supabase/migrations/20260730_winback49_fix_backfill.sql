-- 20260730_winback49_fix_backfill.sql
-- RUN THIS BEFORE ANY OTHER WINBACK SEND.
--
-- What happened (2026-07-30 evening): the live blast sent 103 emails, but the
-- winback49_resend_id column from 20260730_winback49_resend_id.sql had not
-- been created yet, so every post-send UPDATE (which included that column)
-- failed — leaving winback49_email_sent_at NULL on all rows. Without this
-- backfill, re-running the sender would DOUBLE-EMAIL all 103 recipients.
--
-- 1) Create the missing column (same as the earlier migration; safe re-run).
ALTER TABLE trial_signups
  ADD COLUMN IF NOT EXISTS winback49_resend_id text;

-- 2) Backfill the "email sent" stamp for everyone the blast attempted.
--    This matches the sender's exact eligibility window. Stamping the 14
--    paid-skipped rows too is harmless (the paid guard excludes them before
--    any send), but we exclude the 2 rate-limited failures so the next run
--    retries their email instead of skipping to SMS.
UPDATE trial_signups
SET winback49_email_sent_at = now()
WHERE payment_status NOT IN ('completed','attribution_only')
  AND deleted_at IS NULL
  AND winback49_converted_at IS NULL
  AND winback49_email_sent_at IS NULL
  AND winback49_email_error IS NULL          -- keep the 2 failures retryable
  AND email IS NOT NULL
  AND created_at <= now() - interval '14 days';

-- 3) Show the outcome (expect ~117 stamped, 2 with errors left NULL).
SELECT count(*) FILTER (WHERE winback49_email_sent_at IS NOT NULL) AS stamped,
       count(*) FILTER (WHERE winback49_email_error IS NOT NULL)   AS failed_pending_retry
FROM trial_signups
WHERE deleted_at IS NULL;
