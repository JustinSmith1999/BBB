-- Add abandoned-cart tracking column to trial_signups.
-- Used by the abandoned-cart-followup Edge Function to dedupe sends.

ALTER TABLE trial_signups
ADD COLUMN IF NOT EXISTS abandoned_email_sent_at TIMESTAMP WITH TIME ZONE;

-- Optional: index for fast lookups of unsent pending signups
CREATE INDEX IF NOT EXISTS idx_trial_signups_abandoned_pending
  ON trial_signups (created_at)
  WHERE payment_status = 'pending' AND abandoned_email_sent_at IS NULL;
