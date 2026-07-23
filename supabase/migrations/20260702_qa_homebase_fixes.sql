-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-07-02 · QA fixes for /homebase (frontdesk.html). Idempotent.
--
-- Context: the payment-verification classifier (20260619) scans Stripe +
-- MindBody only. Mariana Tek purchases therefore get stamped
-- 'disputed'/'unverified' and the Kanban dumps them into Abandoned Checkout
-- with a red "⚠ UNVERIFIED" badge, even though a real MT sale exists.
-- frontdesk.html already suppresses the badge when trial_signups has a
-- mariana_tek_id, but many MT purchases never got that id backfilled — their
-- only proof lives in mariana_tek_sales, which anon can't read (RLS, no anon
-- SELECT policy by design; see 20260623_mariana_tek_cutover.sql).
--
-- This RPC gives /homebase (anon key) a privacy-minimal cross-check: the set
-- of trial_signups ids for the studio that have a matching Mariana Tek sale,
-- matched by mariana_tek_id OR (case-insensitive) email. It returns ONLY ids
-- — no sale details, no PII beyond what the board already has.
--
-- Client usage (frontdesk.html · loadMtSaleMap):
--   sb.rpc('get_homebase_mt_verified', { p_location_id: <uuid> })
--   → rows { trial_id uuid }; badge + isPaid() treat membership as
--     MT-verified (suppress UNVERIFIED, keep the card in the paid funnel).
--
-- NOTE: the proper long-term fix is teaching the verification classifier
-- (trial_signups_set_verification_status) to scan mariana_tek_sales so rows
-- get stamped 'verified' at write time. This RPC is the read-side bridge
-- until that lands.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_homebase_mt_verified(p_location_id uuid)
RETURNS TABLE(trial_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT t.id AS trial_id
  FROM public.trial_signups t
  WHERE t.location_id = p_location_id
    AND t.deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.mariana_tek_sales s
      WHERE
        (t.mariana_tek_id IS NOT NULL AND s.customer_mt_id = t.mariana_tek_id)
        OR (
          t.email IS NOT NULL
          AND s.customer_email IS NOT NULL
          AND lower(s.customer_email) = lower(t.email)
        )
    );
$$;

-- Homebase signs in with per-studio credentials client-side but talks to
-- PostgREST as anon — same grant pattern as get_homebase_at_risk /
-- get_homebase_unpaid_status.
REVOKE ALL ON FUNCTION public.get_homebase_mt_verified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_mt_verified(uuid) TO anon, authenticated;

-- Sanity checks:
-- SELECT count(*) FROM public.get_homebase_mt_verified('5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7'::uuid); -- bayside
-- SELECT t.name, t.verification_status, t.payment_status
--   FROM public.trial_signups t
--   JOIN public.get_homebase_mt_verified('5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7'::uuid) v ON v.trial_id = t.id
--  WHERE t.verification_status IN ('disputed','unverified');
