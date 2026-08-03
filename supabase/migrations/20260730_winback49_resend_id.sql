-- 20260730_winback49_resend_id.sql
-- Stores the Resend email id per winback send so the tracking sheet can pull
-- delivery/open status from Resend's API. Safe to re-run.
ALTER TABLE trial_signups
  ADD COLUMN IF NOT EXISTS winback49_resend_id text;
