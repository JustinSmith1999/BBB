-- ─────────────────────────────────────────────────────────────────────────────
-- Expand trial_signups.source_category CHECK to allow the new tags that
-- stripe-webhook + create-trial-checkout started emitting on 2026-06-02:
--
--   trial_form              — form submitted via create-trial-checkout
--   stripe_checkout         — Stripe Checkout flow (no prior pending row)
--   stripe_payment_intent   — raw PaymentIntent (Payment Link / API)
--   stripe_reconcile        — backfill via reconcile SQL
--
-- The original constraint allowed only 'ad', 'web_organic', 'in_person',
-- 'legacy_archived'. My task #99 patch emitted new tags without updating
-- the constraint — meaning any genuine webhook insert with one of those
-- new tags would silently 23514 and the customer would be lost. Same class
-- of bug as the NULL .neq() filter from earlier today. Fail-loud over
-- fail-silent.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trial_signups_source_category_check'
  ) THEN
    ALTER TABLE public.trial_signups
      DROP CONSTRAINT trial_signups_source_category_check;
  END IF;
END$$;

ALTER TABLE public.trial_signups
  ADD CONSTRAINT trial_signups_source_category_check
  CHECK (source_category IN (
    'ad',
    'web_organic',
    'in_person',
    'legacy_archived',
    'trial_form',
    'stripe_checkout',
    'stripe_payment_intent',
    'stripe_reconcile'
  ));

-- Verify
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'trial_signups_source_category_check';
