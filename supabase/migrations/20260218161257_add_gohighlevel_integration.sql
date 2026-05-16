/*
  # Add GoHighLevel Integration Support

  ## Summary
  This migration adds GoHighLevel webhook integration capabilities to enable automated workflow triggers when trial signups are purchased.

  ## Changes

  ### 1. Locations Table
  - Adds `gohighlevel_webhook_url` (text, nullable) - Stores the GHL automation webhook URL for each location
  - Adds `gohighlevel_api_key` (text, nullable) - Optional API key for authenticated webhook calls

  ### 2. Trial Signups Table
  - Adds `gohighlevel_sent` (boolean, default false) - Tracks whether the GHL webhook was successfully sent
  - Adds `gohighlevel_sent_at` (timestamptz, nullable) - Records when the webhook was successfully sent
  - Adds `gohighlevel_error` (text, nullable) - Stores error messages if webhook delivery fails
  - Adds `gohighlevel_retry_count` (integer, default 0) - Tracks number of retry attempts

  ## Security
  - No RLS changes needed as existing policies remain in effect
  - Sensitive webhook URLs and API keys are stored in the locations table with existing RLS protection

  ## Notes
  - Each location can have its own GoHighLevel automation webhook
  - Error tracking enables troubleshooting and manual retry functionality
  - Retry counter helps prevent infinite retry loops
*/

-- Add GoHighLevel fields to locations table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'gohighlevel_webhook_url'
  ) THEN
    ALTER TABLE locations ADD COLUMN gohighlevel_webhook_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'gohighlevel_api_key'
  ) THEN
    ALTER TABLE locations ADD COLUMN gohighlevel_api_key text;
  END IF;
END $$;

-- Add GoHighLevel tracking fields to trial_signups table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'gohighlevel_sent'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN gohighlevel_sent boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'gohighlevel_sent_at'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN gohighlevel_sent_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'gohighlevel_error'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN gohighlevel_error text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'gohighlevel_retry_count'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN gohighlevel_retry_count integer DEFAULT 0;
  END IF;
END $$;