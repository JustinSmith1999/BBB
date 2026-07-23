-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10 21:30 ET · URGENT
-- Add missing `fbp` column to trial_signups.
--
-- ROOT CAUSE of today's zero-fill day:
-- create-trial-checkout was inserting fbp: <value> into trial_signups, which
-- silently failed with PGRST204 "Could not find the 'fbp' column". The catch
-- block at lines 415-417 swallowed the exception and proceeded to the CAPI
-- Lead fire, so we got: 16 ghost CAPI events + 7 leads-table rows + ZERO
-- trial_signups rows + ZERO Stripe Checkout sessions today.
--
-- Customer impact: every form submit since this hit prod silently failed at
-- the trial_signups stage. The customer got a JavaScript error or a redirect
-- to checkout that never loaded.
--
-- Why `fbc` works but `fbp` doesn't: an earlier migration added fbc only.
-- fbp was added to the code path more recently but the column migration
-- never landed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS fbp text;

COMMENT ON COLUMN public.trial_signups.fbp IS
  'Meta browser cookie _fbp value. Used for CAPI attribution. Added 2026-06-10 to fix silent insert failures.';

-- Force PostgREST to reload its schema cache so new column is immediately usable.
NOTIFY pgrst, 'reload schema';

SELECT 'fbp column added to trial_signups · schema reloaded' AS status;
