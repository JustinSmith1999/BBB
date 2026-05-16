# Multi-Location Stripe Setup - Complete Guide

## Overview
Your trial signup system now supports **separate Stripe accounts for each location**. Each location (Bayside, Astoria, etc.) can have its own Stripe credentials, allowing payments to go to different Stripe accounts.

## What Was Implemented

### 1. Database Schema Updates
- Added Stripe credentials to the `locations` table:
  - `stripe_publishable_key` - Public key for frontend (pk_test_... or pk_live_...)
  - `stripe_secret_key` - Secret key for backend processing (sk_test_... or sk_live_...)
  - `stripe_webhook_secret` - Webhook signing secret (whsec_...)

### 2. Edge Functions Created/Updated

#### `get-location-stripe-key` (NEW)
- **Purpose**: Fetches the publishable Stripe key for a specific location
- **Called by**: Frontend when loading the trial signup page
- **Returns**: Stripe publishable key for the location

#### `create-trial-checkout` (UPDATED)
- **Purpose**: Creates Stripe checkout session using location-specific credentials
- **Flow**:
  1. Receives locationId from frontend
  2. Fetches location's Stripe secret key from database
  3. Creates checkout session with that location's Stripe account
  4. Returns session ID to frontend

#### `stripe-webhook` (UPDATED)
- **Purpose**: Receives Stripe payment webhooks and saves customer data
- **Flow**:
  1. Receives webhook from Stripe
  2. Extracts locationId from webhook metadata
  3. Fetches location's webhook secret from database
  4. Verifies webhook signature with location-specific secret
  5. Saves trial signup data to database

### 3. Frontend Updates
- Modified `LocationTrialSignup.tsx` to:
  - Fetch location-specific Stripe publishable key on page load
  - Use that key to initialize Stripe.js
  - Display error if Stripe not configured for location

### 4. Trial Signups Table Updates
- Added fields to store complete customer data:
  - `address`, `city`, `zip_code`, `country`
  - `newsletter_opted_in` (boolean)
  - `stripe_session_id` (unique, links to Stripe)
  - `payment_status` (pending/completed)
  - `payment_date` (timestamp)

## Manual Setup Steps

### Step 1: Apply Database Migrations

Run this SQL in your Supabase SQL Editor:
https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new

```sql
-- Add Stripe credentials to locations table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'stripe_publishable_key'
  ) THEN
    ALTER TABLE locations ADD COLUMN stripe_publishable_key text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'stripe_secret_key'
  ) THEN
    ALTER TABLE locations ADD COLUMN stripe_secret_key text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'stripe_webhook_secret'
  ) THEN
    ALTER TABLE locations ADD COLUMN stripe_webhook_secret text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_locations_stripe_keys ON locations(id) WHERE stripe_secret_key IS NOT NULL;

-- Add trial signup fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'address'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN address text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'city'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN city text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'zip_code'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN zip_code text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'country'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN country text DEFAULT 'US';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'newsletter_opted_in'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN newsletter_opted_in boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'stripe_session_id'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN stripe_session_id text UNIQUE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'payment_status'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN payment_status text DEFAULT 'pending';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trial_signups' AND column_name = 'payment_date'
  ) THEN
    ALTER TABLE trial_signups ADD COLUMN payment_date timestamptz;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trial_signups_stripe_session ON trial_signups(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_trial_signups_payment_status ON trial_signups(payment_status);
CREATE INDEX IF NOT EXISTS idx_trial_signups_email ON trial_signups(email);
```

### Step 2: Deploy Edge Functions

Deploy all three functions using the Supabase CLI:

```bash
# Deploy the new function to get location Stripe keys
supabase functions deploy get-location-stripe-key --no-verify-jwt

# Deploy the updated checkout function
supabase functions deploy create-trial-checkout --no-verify-jwt

# Deploy the updated webhook function
supabase functions deploy stripe-webhook --no-verify-jwt
```

### Step 3: Add Stripe Credentials for Each Location

For each location, you need to:

1. Get the Stripe credentials from each location's Stripe account
2. Update the location in your database

#### For Bayside:

```sql
UPDATE locations
SET
  stripe_publishable_key = 'pk_test_YOUR_BAYSIDE_KEY',
  stripe_secret_key = 'sk_test_YOUR_BAYSIDE_SECRET',
  stripe_webhook_secret = 'whsec_YOUR_BAYSIDE_WEBHOOK_SECRET'
WHERE name = 'Bayside';
```

#### For Astoria:

```sql
UPDATE locations
SET
  stripe_publishable_key = 'pk_test_YOUR_ASTORIA_KEY',
  stripe_secret_key = 'sk_test_YOUR_ASTORIA_SECRET',
  stripe_webhook_secret = 'whsec_YOUR_ASTORIA_WEBHOOK_SECRET'
WHERE name = 'Astoria';
```

**Repeat for Fresh Meadows and Williamsburg**

### Step 4: Configure Stripe Webhooks

For **EACH** Stripe account (Bayside, Astoria, etc.):

1. Log into that location's Stripe Dashboard
2. Go to: Developers → Webhooks
3. Click "Add endpoint"
4. Set the endpoint URL to:
   ```
   https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/stripe-webhook
   ```
5. Select event to listen for:
   - ✅ `checkout.session.completed`
6. Save the endpoint
7. Copy the webhook signing secret (starts with `whsec_`)
8. Update that location's `stripe_webhook_secret` in the database

**IMPORTANT**: Each Stripe account needs its own webhook pointing to the same endpoint URL. The webhook handler will automatically route to the correct location based on the metadata.

## How It Works

### User Journey:
1. **User visits** → `/locations/bayside/trial`
2. **Frontend loads** → Fetches Bayside's Stripe publishable key
3. **User fills form** → All data collected (name, email, phone, address, etc.)
4. **User submits** → Data sent to `create-trial-checkout` with Bayside's locationId
5. **Checkout created** → Using Bayside's Stripe account credentials
6. **User pays** → Payment goes to Bayside's Stripe account
7. **Webhook fires** → Stripe sends event to webhook endpoint
8. **Webhook processes** → Extracts locationId, verifies with Bayside's webhook secret
9. **Data saved** → Complete customer info saved to `trial_signups` table

### Technical Flow:

```
Frontend (LocationTrialSignup.tsx)
  ↓
  Fetches: get-location-stripe-key?locationId=xxx
  ↓
  Initializes Stripe.js with location-specific publishable key
  ↓
  User submits form
  ↓
  Calls: create-trial-checkout
    - Fetches location's stripe_secret_key from database
    - Creates session with that Stripe account
  ↓
  Stripe redirects to payment page (location-specific account)
  ↓
  User completes payment
  ↓
  Stripe webhook → stripe-webhook function
    - Extracts locationId from metadata
    - Fetches location's stripe_webhook_secret
    - Verifies signature
    - Saves customer data to database
```

## Data Collected Per Trial Signup

For each successful trial signup, you'll have:

- Full name
- Email address
- Phone number
- Full street address
- City
- ZIP code
- Country
- Newsletter opt-in status
- Associated location
- Stripe session ID
- Payment status
- Payment date/time

## Testing

### Test with Bayside:

1. Make sure Bayside has Stripe credentials in the database
2. Go to: http://localhost:5173/locations/bayside/trial
3. Fill out the form with test data
4. Use Stripe test card: `4242 4242 4242 4242`
5. Check that:
   - Payment goes to Bayside's Stripe account
   - Data appears in `trial_signups` table
   - All fields are populated

### Test with Multiple Locations:

Repeat the same test for Astoria, Fresh Meadows, and Williamsburg to verify each location uses its own Stripe account.

## Security Notes

- **Never expose secret keys**: The `stripe_secret_key` and `stripe_webhook_secret` are only accessed server-side
- **Publishable keys are safe**: The `stripe_publishable_key` can be safely sent to the frontend
- **RLS policies**: Ensure your `locations` table has proper Row Level Security
- **Webhook verification**: Each webhook is verified with the location-specific secret

## Troubleshooting

### "Stripe not configured for this location"
- Check that the location has `stripe_publishable_key` and `stripe_secret_key` set in the database

### Webhook not saving data
- Verify the webhook secret is correct for that location
- Check the webhook URL is exactly: `https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/stripe-webhook`
- Make sure `checkout.session.completed` event is selected in Stripe webhook settings
- Check Supabase function logs for errors

### Payment works but no data saved
- Check that locationId is being passed correctly in the checkout metadata
- Verify the stripe-webhook function is deployed
- Check Stripe webhook logs in the Stripe dashboard for delivery failures

## Next Steps

1. Apply the database migrations
2. Deploy the three edge functions
3. Add Stripe credentials for each location
4. Set up webhooks in each Stripe account
5. Test each location's trial signup flow
6. Go live!

Your trial signup system is now fully multi-tenant and ready to handle separate Stripe accounts per location!
