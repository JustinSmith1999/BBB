/*
  # MindBody Activation Tables

  1. New Tables
    - `mindbody_oauth_tokens`
      - `id` (uuid, primary key)
      - `authorization_code` (text) - OAuth authorization code from MindBody
      - `access_token` (text) - OAuth access token (populated after exchange)
      - `refresh_token` (text) - OAuth refresh token
      - `token_type` (text) - Token type (typically "Bearer")
      - `expires_at` (timestamptz) - Token expiration time
      - `state` (text) - OAuth state parameter for security
      - `status` (text) - Status: pending, active, expired, revoked
      - `received_at` (timestamptz) - When authorization code was received
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `mindbody_webhook_events`
      - `id` (uuid, primary key)
      - `event_type` (text) - Type of webhook event
      - `payload` (jsonb) - Full webhook payload
      - `signature` (text) - MindBody signature for verification
      - `processed` (boolean) - Whether event has been processed
      - `processed_at` (timestamptz) - When event was processed
      - `error` (text) - Any error during processing
      - `received_at` (timestamptz) - When webhook was received
      - `created_at` (timestamptz)

  2. Security
    - Enable RLS on both tables
    - Only service role can access these tables (no public access)
*/

CREATE TABLE IF NOT EXISTS mindbody_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_code text,
  access_token text,
  refresh_token text,
  token_type text DEFAULT 'Bearer',
  expires_at timestamptz,
  state text,
  status text DEFAULT 'pending',
  received_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mindbody_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  signature text,
  processed boolean DEFAULT false,
  processed_at timestamptz,
  error text,
  received_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE mindbody_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mindbody_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only access to oauth tokens"
  ON mindbody_oauth_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role only access to webhook events"
  ON mindbody_webhook_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_status ON mindbody_oauth_tokens(status);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_created_at ON mindbody_oauth_tokens(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON mindbody_webhook_events(processed, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON mindbody_webhook_events(event_type);
