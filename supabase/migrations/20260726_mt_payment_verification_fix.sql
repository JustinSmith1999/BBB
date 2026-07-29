-- 20260726_mt_payment_verification_fix.sql
--
-- FIX: the payment-verification classifier (20260619) only checked Stripe and
-- MindBody for proof of payment. Since the June 2026 Mariana Tek cutover, every
-- real MT purchase (app, buy-widget, front desk) had NO Stripe charge and NO
-- MindBody sale, so the classifier stamped it 'disputed' by default — and the
-- dashboard "Paid Trials" counter drops 'disputed' rows, silently undercounting
-- every MT-app paid trial. The /homebase board then had to band-aid over it by
-- suppressing the false badge for mt_app rows.
--
-- This adds Mariana Tek as a third proof source (the current system of record):
--   • a matching mariana_tek_sales row ($25+, at/after launch), matched by MT
--     customer id or email, OR
--   • the row was created by the MT order sync itself (source_category='mt_app')
-- → verified.
-- Then it reclassifies the affected rows so the existing 'disputed' pileup clears.
--
-- Run in the Supabase SQL editor (project uracuwugpxqjfgtuobal). Safe to re-run.

CREATE OR REPLACE FUNCTION public.classify_payment_verification(p_row public.trial_signups)
RETURNS public.payment_verification
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_has_stripe   boolean := false;
  v_has_mb_trial boolean := false;
  v_has_mt       boolean := false;
  v_paid_age_h   numeric := 0;
BEGIN
  IF p_row.payment_status IS NULL OR p_row.payment_status <> 'completed' THEN
    RETURN 'unverified'::public.payment_verification;
  END IF;

  -- Has a real Stripe charge AT OR AFTER 5/15/26 launch? (legacy website path)
  SELECT EXISTS (
    SELECT 1 FROM public.stripe_paid_mirror m
    WHERE lower(m.customer_email) = lower(p_row.email)
      AND m.stripe_charge_id NOT LIKE 'walkin_%'
      AND m.stripe_charge_id NOT LIKE 'walk_in_%'
      AND m.stripe_charge_id <> 'sync_heartbeat'
      AND m.amount_cents BETWEEN 2500 AND 5500  -- $25-$55 covers $29/$49 trial
      AND m.paid_at >= '2026-05-15T00:00:00Z'::timestamptz
  ) INTO v_has_stripe;

  -- Has a real MB $49/$29 trial sale AT OR AFTER 5/15/26 launch? (legacy)
  IF p_row.mindbody_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.mindbody_sales s
      WHERE s.customer_mindbody_id = p_row.mindbody_id
        AND lower(s.item_names) LIKE '%trial%'
        AND s.total_cents BETWEEN 2500 AND 5500
        AND s.sale_date_time >= '2026-05-15T00:00:00Z'::timestamptz
    ) INTO v_has_mb_trial;
  END IF;

  -- Has a real Mariana Tek sale AT OR AFTER launch? (CURRENT system of record)
  -- Match on MT customer id or email; any real paid sale ($25+) is proof —
  -- covers both the $49 trial and membership purchases made through MT.
  IF p_row.mariana_tek_id IS NOT NULL OR p_row.email IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.mariana_tek_sales mt
      WHERE (
          (p_row.mariana_tek_id IS NOT NULL AND mt.customer_mt_id = p_row.mariana_tek_id)
          OR (p_row.email IS NOT NULL AND lower(mt.customer_email) = lower(p_row.email))
        )
        AND mt.total_cents >= 2500
        AND COALESCE(mt.sale_date_time, mt.synced_at) >= '2026-05-15T00:00:00Z'::timestamptz
    ) INTO v_has_mt;
  END IF;

  -- Proven paid in ANY system, OR the row was created by the MT order sync
  -- itself (mt_app = ingested from a real Mariana Tek order) → verified.
  IF v_has_stripe OR v_has_mb_trial OR v_has_mt
     OR COALESCE(p_row.source_category, '') = 'mt_app' THEN
    RETURN 'verified'::public.payment_verification;
  END IF;

  -- No evidence but staff flagged recently via walk-in/in-person path.
  -- Give them 48h grace period to log the sale.
  IF COALESCE(p_row.source_category, '') IN
       ('mb_direct', 'walk_in', 'in_person', 'walk-in', 'direct_membership') THEN
    v_paid_age_h := EXTRACT(EPOCH FROM (now() - COALESCE(p_row.payment_date, p_row.created_at))) / 3600.0;
    IF v_paid_age_h <= 48 THEN
      RETURN 'provisional'::public.payment_verification;
    END IF;
  END IF;

  -- payment_status='completed' but no evidence anywhere and not a recent
  -- walk-in → almost certainly a form-fill that never paid.
  RETURN 'disputed'::public.payment_verification;
END
$$;

GRANT EXECUTE ON FUNCTION public.classify_payment_verification(public.trial_signups)
  TO authenticated, anon, service_role;

-- ── Backfill: reclassify the affected rows now so the pileup clears ──────────
-- Scoped to rows that could have been mislabeled (currently disputed/unverified,
-- MT-linked, or MT/membership origins). The BEFORE trigger also keeps this
-- fresh on every future insert/update.
DO $$
DECLARE
  before_disputed int;
  after_disputed  int;
  reclassified    int;
BEGIN
  SELECT COUNT(*) INTO before_disputed
    FROM public.trial_signups
    WHERE deleted_at IS NULL AND verification_status = 'disputed';

  UPDATE public.trial_signups AS t
  SET verification_status = public.classify_payment_verification(t)
  WHERE t.deleted_at IS NULL
    AND (
      t.verification_status IN ('disputed', 'unverified')
      OR t.source_category IN ('mt_app', 'direct_membership')
      OR t.mariana_tek_id IS NOT NULL
    );
  GET DIAGNOSTICS reclassified = ROW_COUNT;

  SELECT COUNT(*) INTO after_disputed
    FROM public.trial_signups
    WHERE deleted_at IS NULL AND verification_status = 'disputed';

  RAISE NOTICE 'MT verification fix — rows reclassified=%, disputed before=%, disputed after=%',
    reclassified, before_disputed, after_disputed;
END $$;
