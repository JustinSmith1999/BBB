-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: Mirror per-studio Activity Sheets into the DB so we can
-- reconcile "sold per staff" vs "processed per MindBody" on the dashboard.
--
-- WHY
-- Today's audit caught 6 Astoria conversions Chris logged on his sheet
-- (Kathryn Greene, Kelvin De La Cruz, Roseann Boggs, Eliyani Jimenez,
-- Nicayra Toribio, Samantha Valbuena = $13,448 in committed member rev) that
-- have no membership transaction in MindBody yet. Same pattern likely exists
-- for WB/FM/BS. Owner dashboard needs visibility into both numbers — what
-- the desk SAYS happened vs what MB CONFIRMED — so Justin can chase drift.
--
-- WHAT
--   1. staff_sheet_entries table — one row per prospect, scoped by studio_slug
--   2. get_sheet_vs_db_reconciliation(p_studio) — drives the dashboard card
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_sheet_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_slug     text NOT NULL,
  start_date      date,
  end_date        date,
  prospect_name   text,
  phone           text,
  email           text,
  visit_type      text,
  referral_source text,
  joined          boolean,      -- "Joined Y/N" for FM/BS; derived from membership_sold for AS/WB
  joined_date     date,
  membership_sold text,         -- "Type Membership Sold" (AS/WB) or notes-derived (FM/BS)
  membership_value_usd numeric, -- "Membership Overall Value" (AS/WB) or NULL (FM/BS)
  staff_member    text,         -- "1st Contact" (AS/WB) or "Trainer" (FM/BS)
  notes           text,
  raw             jsonb,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_sheet_entries_studio_date
  ON public.staff_sheet_entries (studio_slug, start_date DESC);

GRANT SELECT ON public.staff_sheet_entries TO authenticated;


-- ── Reconciliation RPC: returns one row per sheet entry since launch ─────────
-- drift_verdict:
--   "matched"  — sheet says joined + MB has membership sale
--   "pending"  — sheet says joined but MB hasn't processed the charge yet
--   "ts_only"  — paid trial in DB but sheet doesn't mark as joined
--   "lost"     — sheet entry never even paid a trial in our DB
--   "open"     — paid trial, in window, no resolution yet
CREATE OR REPLACE FUNCTION public.get_sheet_vs_db_reconciliation(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  sheet_id              uuid,
  studio_slug           text,
  start_date            date,
  prospect_name         text,
  phone                 text,
  email                 text,
  visit_type            text,
  joined_per_sheet      boolean,
  membership_sold_label text,
  membership_value_usd  numeric,
  staff_member          text,
  in_trial_signups      boolean,
  trial_signups_id      uuid,
  trial_paid_status     text,
  mindbody_id           text,
  has_mb_membership_sale boolean,
  mb_membership_total_usd numeric,
  drift_verdict         text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH sheet AS (
    SELECT * FROM public.staff_sheet_entries
    WHERE start_date >= p_since
      AND (p_studio IS NULL OR studio_slug = p_studio)
  ),
  ts_match AS (
    -- Bridge sheet row to trial_signups by phone (normalized digits)
    SELECT DISTINCT ON (s.id)
      s.id AS sheet_id,
      t.id AS ts_id,
      t.payment_status,
      t.mindbody_id
    FROM sheet s
    LEFT JOIN public.trial_signups t
      ON regexp_replace(coalesce(t.phone, ''), '\D', '', 'g') =
         regexp_replace(coalesce(s.phone,  ''), '\D', '', 'g')
     AND length(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) >= 10
     AND t.deleted_at IS NULL
    ORDER BY s.id, t.payment_status NULLS LAST, t.payment_date DESC NULLS LAST
  ),
  mb_membership_sum AS (
    SELECT m.mindbody_id, SUM(ms.total_cents)::numeric / 100 AS total_usd
    FROM ts_match m
    JOIN public.mindbody_sales ms
      ON ms.customer_mindbody_id = m.mindbody_id
     AND ms.sale_date_time >= '2026-05-15'::timestamptz
     AND ms.total_cents >= 5000
     AND public.is_membership_purchase(ms.item_names)
    WHERE m.mindbody_id IS NOT NULL
    GROUP BY m.mindbody_id
  )
  SELECT
    s.id,
    s.studio_slug,
    s.start_date,
    s.prospect_name,
    s.phone,
    s.email,
    s.visit_type,
    -- joined_per_sheet = true if Y/N is true OR membership_sold is non-empty
    (s.joined IS TRUE OR (s.membership_sold IS NOT NULL AND s.membership_sold <> ''))
                                                       AS joined_per_sheet,
    s.membership_sold,
    s.membership_value_usd,
    s.staff_member,
    (m.ts_id IS NOT NULL)                              AS in_trial_signups,
    m.ts_id                                            AS trial_signups_id,
    m.payment_status                                   AS trial_paid_status,
    m.mindbody_id,
    (msum.total_usd IS NOT NULL)                       AS has_mb_membership_sale,
    COALESCE(msum.total_usd, 0)                        AS mb_membership_total_usd,
    CASE
      WHEN (s.joined IS TRUE OR (s.membership_sold IS NOT NULL AND s.membership_sold <> ''))
       AND msum.total_usd IS NOT NULL
         THEN 'matched'
      WHEN (s.joined IS TRUE OR (s.membership_sold IS NOT NULL AND s.membership_sold <> ''))
       AND msum.total_usd IS NULL
         THEN 'pending'
      WHEN m.payment_status = 'completed'
         THEN 'ts_only'
      WHEN m.ts_id IS NULL
         THEN 'lost'
      ELSE 'open'
    END AS drift_verdict
  FROM sheet s
  LEFT JOIN ts_match m  ON m.sheet_id = s.id
  LEFT JOIN mb_membership_sum msum ON msum.mindbody_id = m.mindbody_id
  ORDER BY s.start_date DESC NULLS LAST, s.prospect_name;
$$;

REVOKE ALL ON FUNCTION public.get_sheet_vs_db_reconciliation(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sheet_vs_db_reconciliation(text, date) TO authenticated;


SELECT 'staff_sheet_entries created · ready for first sync' AS status;
