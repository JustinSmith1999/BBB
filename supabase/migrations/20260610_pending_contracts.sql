-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: Pending Contracts surface — paper signed but not in MindBody.
--
-- AUDIT FINDING: 5 Astoria customers have "Contract Signed = TRUE" on Chris's
-- activity sheet ($8,459 in commitments) but ZERO of them have a MB autopay
-- schedule set up. Their trials end 6/15-6/21. Without MB entry, no autopay
-- triggers → no revenue. This card surfaces them with countdown timers.
--
-- WHAT
--   1. Add contract_signed boolean column to staff_sheet_entries
--   2. Build get_pending_contracts() RPC that JOINs sheet + MB + trial dates
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.staff_sheet_entries
  ADD COLUMN IF NOT EXISTS contract_signed boolean;

-- Migrate existing data: parse from raw jsonb csv_row[13]
-- (Column 13 in STRAT format = "Contract Signed" TRUE/FALSE text)
UPDATE public.staff_sheet_entries
SET contract_signed = CASE
    WHEN raw->'csv_row'->>13 ILIKE 'TRUE'  THEN true
    WHEN raw->'csv_row'->>13 ILIKE 'FALSE' THEN false
    ELSE NULL
  END
WHERE studio_slug IN ('astoria','williamsburg')
  AND raw IS NOT NULL;


-- ── RPC: Pending Contracts surface ──────────────────────────────────────────
-- Returns one row per paper-signed-but-not-in-MB customer with countdown.
DROP FUNCTION IF EXISTS public.get_pending_contracts();
DROP FUNCTION IF EXISTS public.get_pending_contracts(text);
CREATE FUNCTION public.get_pending_contracts(
  p_studio_slug text DEFAULT NULL  -- NULL = all studios
)
RETURNS TABLE (
  studio_slug              text,
  customer_name            text,
  membership_sold          text,
  membership_value_usd     numeric,
  staff_member             text,
  contract_signed          boolean,
  trial_paid_date          date,
  trial_end_date           date,
  days_until_trial_end     int,
  mindbody_id              text,
  mb_has_membership_sale   boolean,
  status                   text,  -- 'urgent_expired' | 'urgent_this_week' | 'pending' | 'lead_open'
  ts_id                    uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH sheet_signed AS (
    -- Customers where staff logged a sale on the sheet
    SELECT
      s.studio_slug,
      s.prospect_name,
      s.phone,
      s.start_date AS trial_paid_date,
      COALESCE(s.end_date, s.start_date + INTERVAL '14 days')::date AS trial_end_date,
      s.membership_sold,
      s.membership_value_usd,
      s.staff_member,
      s.contract_signed,
      CASE
        WHEN length(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) = 11
         AND left(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'), 1) = '1'
          THEN right(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'), 10)
        ELSE regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')
      END AS phone10
    FROM public.staff_sheet_entries s
    WHERE s.start_date >= '2026-05-15'
      AND (p_studio_slug IS NULL OR s.studio_slug = p_studio_slug)
      AND (
        s.contract_signed IS TRUE
        OR (s.membership_sold IS NOT NULL AND s.membership_sold <> '')
      )
  ),
  bridge AS (
    -- Match sheet to trial_signups via phone, pick up mindbody_id
    SELECT DISTINCT ON (sh.studio_slug, sh.prospect_name)
      sh.*,
      ts.id           AS ts_id,
      ts.mindbody_id  AS ts_mindbody_id
    FROM sheet_signed sh
    LEFT JOIN public.trial_signups ts
      ON regexp_replace(coalesce(ts.phone, ''), '\D', '', 'g') LIKE '%' || sh.phone10
     AND length(sh.phone10) = 10
     AND ts.deleted_at IS NULL
    ORDER BY sh.studio_slug, sh.prospect_name, ts.payment_date DESC NULLS LAST
  )
  SELECT
    b.studio_slug,
    b.prospect_name AS customer_name,
    b.membership_sold,
    b.membership_value_usd,
    b.staff_member,
    b.contract_signed,
    b.trial_paid_date,
    b.trial_end_date,
    (b.trial_end_date - CURRENT_DATE)::int AS days_until_trial_end,
    b.ts_mindbody_id AS mindbody_id,
    EXISTS(
      SELECT 1 FROM public.mindbody_sales ms
      WHERE ms.customer_mindbody_id = b.ts_mindbody_id
        AND ms.sale_date_time >= '2026-05-15'::timestamptz
        AND ms.total_cents >= 5000
        AND public.is_membership_purchase(ms.item_names)
    ) AS mb_has_membership_sale,
    CASE
      -- MB already has it → done, don't show
      WHEN EXISTS(
        SELECT 1 FROM public.mindbody_sales ms
        WHERE ms.customer_mindbody_id = b.ts_mindbody_id
          AND ms.sale_date_time >= '2026-05-15'::timestamptz
          AND ms.total_cents >= 5000
          AND public.is_membership_purchase(ms.item_names)
      ) THEN 'in_mb'
      -- Contract signed, trial already ended → MUST enter NOW
      WHEN b.contract_signed IS TRUE AND b.trial_end_date < CURRENT_DATE
        THEN 'urgent_expired'
      -- Contract signed, trial ends within 7 days → enter this week
      WHEN b.contract_signed IS TRUE AND b.trial_end_date <= CURRENT_DATE + INTERVAL '7 days'
        THEN 'urgent_this_week'
      -- Contract signed, plenty of runway
      WHEN b.contract_signed IS TRUE
        THEN 'pending'
      -- Type sold listed but contract NOT signed → still selling
      ELSE 'lead_open'
    END AS status,
    b.ts_id
  FROM bridge b
  WHERE NOT EXISTS(
    -- Hide ones already processed in MB
    SELECT 1 FROM public.mindbody_sales ms
    WHERE ms.customer_mindbody_id = b.ts_mindbody_id
      AND ms.sale_date_time >= '2026-05-15'::timestamptz
      AND ms.total_cents >= 5000
      AND public.is_membership_purchase(ms.item_names)
  )
  ORDER BY
    CASE
      WHEN b.contract_signed IS TRUE AND b.trial_end_date < CURRENT_DATE THEN 1
      WHEN b.contract_signed IS TRUE AND b.trial_end_date <= CURRENT_DATE + INTERVAL '7 days' THEN 2
      WHEN b.contract_signed IS TRUE THEN 3
      ELSE 4
    END,
    b.trial_end_date ASC;
$$;

REVOKE ALL ON FUNCTION public.get_pending_contracts(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pending_contracts(text) TO authenticated;


-- Verification
SELECT studio_slug, customer_name, membership_sold,
       contract_signed, trial_end_date, days_until_trial_end, status,
       ROUND(membership_value_usd)::int AS value
FROM public.get_pending_contracts(NULL);
