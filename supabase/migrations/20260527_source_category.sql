-- ─────────────────────────────────────────────────────────────────────────────
-- source_category tagging for trial_signups (May 27 2026)
--
-- Honest source attribution so the owner dashboard stops lying about which
-- conversions came from ads vs everywhere else. CPM denominator on the
-- dashboard reads only `source_category = 'ad'` rows — no legacy data
-- pollutes the ad performance numbers.
--
-- Four categories:
--   ad             — Meta-attributed: came through /trial Checkout flow with
--                    utm_source in ('facebook','instagram'). The only rows
--                    that count toward ad CPM / cost-per-trial.
--   web_organic    — /trial Checkout flow with no UTM tag (typed URL, word
--                    of mouth, referrals). Real customers, not ad-driven.
--   in_person      — Sourced from mindbody_sales sync (walk-ins, phone-ins,
--                    POS sales). Will populate once the sales-sync runs.
--   legacy_archived — Anything from before May 15 / Pancham's PaymentIntent
--                    flow / manual imports. Hidden from the owner dashboard
--                    by default but kept in the DB for audit.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS source_category text;

CREATE INDEX IF NOT EXISTS trial_signups_source_category_idx
  ON public.trial_signups (source_category)
  WHERE source_category IS NOT NULL;


-- ── Backfill rules (Justin's direction May 27 2026) ─────────────────────────
-- Everything that flowed through an ad-driven channel — old PaymentIntent
-- funnel OR the new /trial Checkout with Meta UTMs — counts as `ad`. The only
-- rows that DON'T count as ads:
--   - Direct /trial signups with no UTM at all  → web_organic
--   - Manual imports (no Stripe session at all) → legacy_archived
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. AD — any of:
--    (a) `cs_` Checkout Session + utm_source in (facebook, instagram)
--    (b) `pi_` PaymentIntent (every row from the old ads-driven flow)
--    (c) utm_source = 'ads' (legacy ad tag, regardless of session format)
UPDATE public.trial_signups
   SET source_category = 'ad'
 WHERE payment_status = 'completed'
   AND created_at >= '2026-05-15'::date
   AND (
     (stripe_session_id LIKE 'cs_%' AND lower(coalesce(utm_source, '')) IN ('facebook', 'instagram'))
     OR stripe_session_id LIKE 'pi_%'
     OR lower(coalesce(utm_source, '')) = 'ads'
   );

-- 2. WEB_ORGANIC — Stripe Checkout with NO UTM tag at all (typed URL, word
--    of mouth, referrals). Real customers, but not driven by ad spend.
UPDATE public.trial_signups
   SET source_category = 'web_organic'
 WHERE payment_status = 'completed'
   AND created_at >= '2026-05-15'::date
   AND stripe_session_id LIKE 'cs_%'
   AND coalesce(utm_source, '') = ''
   AND source_category IS NULL;

-- 3. LEGACY_ARCHIVED — only rows with NO Stripe session at all (manual
--    imports, comps, or ghost data). Two rows network-wide.
UPDATE public.trial_signups
   SET source_category = 'legacy_archived'
 WHERE payment_status = 'completed'
   AND source_category IS NULL;

-- 4. Pending rows (abandoned checkout) — same rules but for the funnel view.
UPDATE public.trial_signups
   SET source_category = 'ad'
 WHERE payment_status <> 'completed'
   AND (
     lower(coalesce(utm_source, '')) IN ('facebook', 'instagram', 'ads')
     OR stripe_session_id LIKE 'pi_%'
   )
   AND source_category IS NULL;

UPDATE public.trial_signups
   SET source_category = 'web_organic'
 WHERE payment_status <> 'completed'
   AND coalesce(utm_source, '') = ''
   AND source_category IS NULL;

UPDATE public.trial_signups
   SET source_category = 'legacy_archived'
 WHERE source_category IS NULL;


-- ── Constrain values going forward ──────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trial_signups_source_category_check'
  ) THEN
    ALTER TABLE public.trial_signups
      ADD CONSTRAINT trial_signups_source_category_check
      CHECK (source_category IN ('ad', 'web_organic', 'in_person', 'legacy_archived'));
  END IF;
END$$;


-- ── Sanity check ────────────────────────────────────────────────────────────
-- After running, this should show the cohort breakdown per studio.
-- SELECT l.name, ts.source_category, ts.payment_status, COUNT(*)
-- FROM public.trial_signups ts
-- JOIN public.locations l ON l.id = ts.location_id
-- WHERE ts.created_at >= '2026-05-15'
-- GROUP BY l.name, ts.source_category, ts.payment_status
-- ORDER BY l.name, ts.source_category;
