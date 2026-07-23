-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · $29 1-Week Comeback Offer · schema + price wiring
--
-- Flow: leads who started a trial signup but didn't complete within 7 days get
-- a $29 / 7-day comeback offer via SMS, then email 3 days later if no convert.
--
-- This migration:
--   1. Adds `stripe_comeback_price_id` to locations + populates the 4 IDs
--      created via Stripe API on 2026-06-11.
--   2. Adds tracking columns to trial_signups so the cron is idempotent and
--      the dashboard can attribute comeback conversions correctly.
--   3. Extends the source_category CHECK to accept 'comeback_form'.
--   4. Adds a follow-up flag to leads (Twilio SMS sent / Resend email sent).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. locations: add Stripe comeback price ─────────────────────────────────
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS stripe_comeback_price_id text;

COMMENT ON COLUMN public.locations.stripe_comeback_price_id IS
  'Stripe price_id for the $29 / 1-week comeback offer. Created 2026-06-11.';

UPDATE public.locations SET stripe_comeback_price_id = CASE
  WHEN name = 'Astoria'       THEN 'price_1ThAZ3BWwuqvKmt1pNNcRL0k'
  WHEN name = 'Bayside'       THEN 'price_1ThAZ3Cq9Nh4WwhSSmydV6Ld'
  WHEN name = 'Fresh Meadows' THEN 'price_1ThAZ4I3UZVjGNrBDaknqiFI'
  WHEN name = 'Williamsburg'  THEN 'price_1ThAZ4LjlX8j0xc8mMC4BUzR'
  ELSE stripe_comeback_price_id
END
WHERE name IN ('Astoria','Bayside','Fresh Meadows','Williamsburg');

-- ── 2. trial_signups: comeback cadence + outcome tracking ───────────────────
-- We track on the ORIGINAL abandoned trial_signups row so:
--   • The cron knows whether SMS was sent (idempotency)
--   • The cron knows whether the 3-day email already went out
--   • We can attribute the comeback conversion back to the original lead
ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS comeback_sms_sent_at      timestamptz,
  ADD COLUMN IF NOT EXISTS comeback_sms_sid          text,
  ADD COLUMN IF NOT EXISTS comeback_sms_error        text,
  ADD COLUMN IF NOT EXISTS comeback_email_sent_at    timestamptz,
  ADD COLUMN IF NOT EXISTS comeback_email_id         text,
  ADD COLUMN IF NOT EXISTS comeback_email_error      text,
  ADD COLUMN IF NOT EXISTS comeback_clicked_at       timestamptz,
  ADD COLUMN IF NOT EXISTS comeback_converted_at     timestamptz,
  ADD COLUMN IF NOT EXISTS comeback_stripe_session_id text;

COMMENT ON COLUMN public.trial_signups.comeback_sms_sent_at IS
  'When the $29 comeback SMS was sent. NULL = eligible if abandoned >7d.';
COMMENT ON COLUMN public.trial_signups.comeback_email_sent_at IS
  'When the follow-up comeback EMAIL was sent. Only fires 3+ days after SMS.';
COMMENT ON COLUMN public.trial_signups.comeback_converted_at IS
  'When this lead bought the $29 comeback (closes the loop).';

-- Reportable: helper view for the dashboard card
CREATE OR REPLACE VIEW public.comeback_funnel_v AS
  SELECT
    t.id                            AS original_signup_id,
    t.location_id,
    l.name                          AS studio_name,
    t.name                          AS customer_name,
    t.email                         AS customer_email,
    t.created_at                    AS original_abandoned_at,
    t.comeback_sms_sent_at,
    t.comeback_email_sent_at,
    t.comeback_clicked_at,
    t.comeback_converted_at,
    t.comeback_stripe_session_id,
    CASE
      WHEN t.comeback_converted_at IS NOT NULL THEN 'converted'
      WHEN t.comeback_email_sent_at IS NOT NULL THEN 'email_sent'
      WHEN t.comeback_sms_sent_at IS NOT NULL  THEN 'sms_sent'
      ELSE 'eligible_or_pending'
    END AS comeback_stage
  FROM public.trial_signups t
  JOIN public.locations l ON l.id = t.location_id
  WHERE t.deleted_at IS NULL;

GRANT SELECT ON public.comeback_funnel_v TO anon, authenticated, service_role;

-- ── 3. source_category: accept 'comeback_form' for downstream rows ──────────
DO $$
DECLARE
  ck text;
BEGIN
  SELECT conname INTO ck
  FROM pg_constraint
  WHERE conrelid = 'public.trial_signups'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%source_category%';
  IF ck IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.trial_signups DROP CONSTRAINT %I', ck);
  END IF;
END $$;

-- Include EVERY value currently in trial_signups (audited 2026-06-11) plus
-- the new comeback_form for the $29 / 1-week flow. Adding-only — never
-- removing existing values from the allow-list so the constraint can't
-- retroactively invalidate any row.
ALTER TABLE public.trial_signups
  ADD CONSTRAINT trial_signups_source_category_chk
  CHECK (source_category IS NULL OR source_category IN (
    -- form-driven
    'trial_form','special_form','resign_form','comeback_form',
    -- in-person & POS
    'mb_direct','in_person','direct_membership','manual',
    -- sheet / front-desk surfaces
    'sheet','sheet_backfill','walk_in','member_referral',
    -- promos
    'groupon','external_paid','reactivation',
    -- ad attribution
    'ad','web_organic',
    -- raw Stripe checkout (no prior pending row)
    'stripe_checkout',
    -- historical bucket — pre-cutover rows we don't re-label
    'legacy_archived'
  ));

-- ── 4. Verify ───────────────────────────────────────────────────────────────
SELECT name, stripe_comeback_price_id FROM public.locations ORDER BY name;
