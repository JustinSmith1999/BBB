-- 2026-06-19 — Payment verification classifier.
--
-- THE PROBLEM:
-- Multiple ingestion paths flag trial_signups.payment_status='completed':
--   1. Stripe webhook on checkout.session.completed (verified, real money)
--   2. Sheet sync from staff Google Sheets (unverified — typos, premature flags)
--   3. Manual backfills via mb_direct / walk_in / in_person source_category
--   4. FBP-bug victim panic-flagging (broken — Brian Burns class)
-- None of these cross-check against the source of truth (Stripe charge + MB sale).
-- Result: owners see 120 "paid" rows but trust them less than 100% because some are wrong.
--
-- THE FIX:
-- Add a verification_status column with 4 levels graded against actual evidence:
--   VERIFIED    — Stripe charge in mirror OR MB $49/$29 trial sale exists
--   PROVISIONAL — Staff flagged paid in last 48h via mb_direct/walk_in/in_person
--                 (gives owners time to log in MB without false alarms)
--   DISPUTED    — payment_status=completed but NO Stripe charge AND NO MB sale
--                 AND older than 48h (Brian Burns class — should NOT count)
--   UNVERIFIED  — payment_status != completed (still in lead pipeline)
--
-- /homebase sorts cards VERIFIED → PROVISIONAL → DISPUTED → UNVERIFIED.
-- Dashboard "Paid Trials" counter excludes DISPUTED by default.
-- Cards render a small badge so staff can see why each is classified that way.

DO $$ BEGIN
  CREATE TYPE public.payment_verification AS ENUM
    ('verified', 'provisional', 'disputed', 'unverified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS verification_status public.payment_verification;

-- Helper: classify a single row.
CREATE OR REPLACE FUNCTION public.classify_payment_verification(p_row public.trial_signups)
RETURNS public.payment_verification
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_has_stripe   boolean := false;
  v_has_mb_trial boolean := false;
  v_paid_age_h   numeric := 0;
BEGIN
  IF p_row.payment_status IS NULL OR p_row.payment_status <> 'completed' THEN
    RETURN 'unverified'::public.payment_verification;
  END IF;

  -- Has a real Stripe charge AT OR AFTER 5/15/26 launch?
  SELECT EXISTS (
    SELECT 1 FROM public.stripe_paid_mirror m
    WHERE lower(m.customer_email) = lower(p_row.email)
      AND m.stripe_charge_id NOT LIKE 'walkin_%'
      AND m.stripe_charge_id NOT LIKE 'walk_in_%'
      AND m.stripe_charge_id <> 'sync_heartbeat'
      AND m.amount_cents BETWEEN 2500 AND 5500  -- $25-$55 covers $29/$49 trial
      AND m.paid_at >= '2026-05-15T00:00:00Z'::timestamptz
  ) INTO v_has_stripe;

  -- Has a real MB $49/$29 trial sale AT OR AFTER 5/15/26 launch?
  IF p_row.mindbody_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.mindbody_sales s
      WHERE s.customer_mindbody_id = p_row.mindbody_id
        AND lower(s.item_names) LIKE '%trial%'
        AND s.total_cents BETWEEN 2500 AND 5500
        AND s.sale_date_time >= '2026-05-15T00:00:00Z'::timestamptz
    ) INTO v_has_mb_trial;
  END IF;

  IF v_has_stripe OR v_has_mb_trial THEN
    RETURN 'verified'::public.payment_verification;
  END IF;

  -- No evidence but staff flagged recently via walk-in/in-person path.
  -- Give them 48h grace period to log the sale in MB.
  IF COALESCE(p_row.source_category, '') IN
       ('mb_direct', 'walk_in', 'in_person', 'walk-in', 'direct_membership') THEN
    v_paid_age_h := EXTRACT(EPOCH FROM (now() - COALESCE(p_row.payment_date, p_row.created_at))) / 3600.0;
    IF v_paid_age_h <= 48 THEN
      RETURN 'provisional'::public.payment_verification;
    END IF;
  END IF;

  -- payment_status='completed' but no evidence and not a recent walk-in
  -- → almost certainly wrong (form-fill that never paid, e.g. Brian Burns).
  RETURN 'disputed'::public.payment_verification;
END
$$;

GRANT EXECUTE ON FUNCTION public.classify_payment_verification(public.trial_signups) TO authenticated, anon, service_role;

-- Trigger: keep verification_status fresh on every INSERT/UPDATE.
CREATE OR REPLACE FUNCTION public.trial_signups_set_verification_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.verification_status := public.classify_payment_verification(NEW);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_trial_signups_set_verification ON public.trial_signups;
CREATE TRIGGER trg_trial_signups_set_verification
  BEFORE INSERT OR UPDATE OF payment_status, payment_date, mindbody_id, email, source_category
  ON public.trial_signups
  FOR EACH ROW
  EXECUTE FUNCTION public.trial_signups_set_verification_status();

-- Backfill every existing row right now.
UPDATE public.trial_signups t
   SET verification_status = public.classify_payment_verification(t)
 WHERE deleted_at IS NULL;

-- Read-back summary so we can see the distribution after this lands.
DO $$
DECLARE
  v_ver  int;
  v_prov int;
  v_disp int;
  v_unv  int;
BEGIN
  SELECT COUNT(*) FILTER (WHERE verification_status = 'verified'),
         COUNT(*) FILTER (WHERE verification_status = 'provisional'),
         COUNT(*) FILTER (WHERE verification_status = 'disputed'),
         COUNT(*) FILTER (WHERE verification_status = 'unverified')
    INTO v_ver, v_prov, v_disp, v_unv
    FROM public.trial_signups
   WHERE deleted_at IS NULL;
  RAISE NOTICE 'CLASSIFIER RESULTS — verified=% provisional=% disputed=% unverified=%',
    v_ver, v_prov, v_disp, v_unv;
END $$;
