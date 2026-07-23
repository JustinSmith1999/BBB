-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: Backfill source_category on the 17 null-source paid trials.
--
-- These rows landed via Stripe Checkout during the period when
-- stripe-webhook.source_category injection was silently broken. Each row has
-- a real stripe_session_id + a paid amount + a mindbody_id — they're
-- legitimate paid trials. Just need the label populated.
--
-- 16 stripe-backed rows → 'trial_form' (the canonical web Stripe label).
--  1 no-stripe row (Michelle Shieh, Bayside 5/15) → 'in_person'.
-- No notes added per Justin: just clean the data.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.trial_signups
SET source_category = 'trial_form'
WHERE source_category IS NULL
  AND stripe_session_id IS NOT NULL
  AND payment_status = 'completed'
  AND payment_date >= '2026-05-15'::timestamptz
  AND deleted_at IS NULL;

UPDATE public.trial_signups
SET source_category = 'in_person'
WHERE source_category IS NULL
  AND stripe_session_id IS NULL
  AND payment_status = 'completed'
  AND payment_date >= '2026-05-15'::timestamptz
  AND mindbody_id IS NOT NULL
  AND deleted_at IS NULL;

-- Verify zero null-source paid trials remain
SELECT 'Remaining null-source paid trials since launch:' AS check,
       COUNT(*) AS n
FROM public.trial_signups
WHERE source_category IS NULL
  AND payment_status = 'completed'
  AND payment_date >= '2026-05-15'::timestamptz
  AND deleted_at IS NULL;
