-- 20260730_winback49_columns.sql
-- Win-back campaign per Chris (2026-07-30): "$49 two weeks — come back" to ALL
-- old unconverted leads, all 4 studios. Email first, SMS follow-up 3+ days
-- later. Replaces the killed $29 comeback offer (20260726_kill_comeback_offer)
-- with fresh idempotency columns so old comeback state can't confuse sends.
-- Run in the Supabase SQL editor. Safe to re-run.

ALTER TABLE trial_signups
  ADD COLUMN IF NOT EXISTS winback49_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS winback49_email_error   text,
  ADD COLUMN IF NOT EXISTS winback49_sms_sent_at   timestamptz,
  ADD COLUMN IF NOT EXISTS winback49_sms_sid       text,
  ADD COLUMN IF NOT EXISTS winback49_sms_error     text,
  ADD COLUMN IF NOT EXISTS winback49_converted_at  timestamptz;

-- No cron here on purpose: sends are manual invocations of the winback-49
-- edge function (dry_run default) so nothing can fire silently.
