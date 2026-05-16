# Trial Signup Form - Complete Setup Instructions

## Overview
Your trial signup form now collects ALL customer data (name, email, phone, address, city, zip, country, newsletter preference) and stores it in Supabase when payment succeeds.

## What Was Implemented

### 1. Database Schema Updates
- Created migration file: `temp_migration.sql`
- Adds these fields to `trial_signups` table:
  - `address` - Street address
  - `city` - City name
  - `zip_code` - Postal code
  - `country` - Country code (defaults to 'US')
  - `newsletter_opted_in` - Newsletter preference (boolean)
  - `stripe_session_id` - Links to Stripe payment (unique)
  - `payment_status` - Payment state (defaults to 'pending')
  - `payment_date` - When payment completed

### 2. Stripe Webhook Handler
- Created: `supabase/functions/stripe-webhook/index.ts`
- Listens for `checkout.session.completed` events
- Automatically saves all customer data to Supabase when payment succeeds
- Includes proper CORS headers for webhook calls

### 3. Updated Checkout Flow
- Modified: `supabase/functions/create-trial-checkout/index.ts`
- Now passes newsletter preference to Stripe metadata
- Modified: `src/pages/LocationTrialSignup.tsx`
- Frontend now sends newsletter preference to checkout

## Manual Steps Required

### Step 1: Apply Database Migration

Run this SQL in your Supabase SQL Editor:
https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new

```sql
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

### Step 2: Deploy Stripe Webhook Function

You'll need to deploy the stripe-webhook function using the Supabase CLI:

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

### Step 3: Update Existing Checkout Function

Redeploy the updated create-trial-checkout function:

```bash
supabase functions deploy create-trial-checkout --no-verify-jwt
```

### Step 4: Configure Stripe Webhook

1. Go to your Stripe Dashboard: https://dashboard.stripe.com/webhooks
2. Click "Add endpoint"
3. Set the endpoint URL to:
   ```
   https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/stripe-webhook
   ```
4. Select these events to listen for:
   - `checkout.session.completed`
5. Copy the webhook signing secret
6. Add it to your Supabase project secrets as `STRIPE_WEBHOOK_SECRET`:
   - Go to: https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/settings/functions
   - Add secret: `STRIPE_WEBHOOK_SECRET` with the value from Stripe

### Step 5: Test the Flow

1. Go to your Bayside location trial page
2. Fill out the complete form with test data
3. Complete a test payment using Stripe test card: `4242 4242 4242 4242`
4. Check your Supabase `trial_signups` table to verify all data was saved

## How It Works

1. **User fills out form** → All data collected (name, email, phone, address, city, zip, country, newsletter)
2. **User clicks submit** → Data sent to `create-trial-checkout` edge function
3. **Stripe checkout created** → Customer data stored in Stripe session metadata
4. **User completes payment** → Stripe sends webhook to your `stripe-webhook` function
5. **Webhook receives event** → Extracts data from session metadata
6. **Data saved to Supabase** → Complete record inserted into `trial_signups` table

## Data You'll Collect

For each trial signup, you'll now have:
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

This matches exactly what you're collecting in your hosted form!
