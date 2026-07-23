-- ─────────────────────────────────────────────────────────────────────────────
-- contact_form_submissions — every inquiry from the website contact form,
-- captured at submit time so the owner dashboard can show "who asked about
-- monthly?" without scraping inboxes.
--
-- Why a dedicated table: the existing email_log only records that an email
-- was sent (and Resend webhook events). It doesn't keep the message body,
-- doesn't separate contact-form leads from other emails, and doesn't
-- structure name/phone for per-studio dashboard rendering.
--
-- Truth source: send-contact-email function inserts on every form submit.
-- Classification: asked_about_monthly is a simple keyword scan, stored as a
-- boolean so the dashboard doesn't have to reclassify on every page load.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contact_form_submissions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Submitter
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT NULL,
  message               TEXT NOT NULL,
  -- Studio they're asking about (best-effort lookup — falls back to NULL
  -- when the visitor didn't pick a studio)
  location_id           UUID NULL REFERENCES public.locations(id) ON DELETE SET NULL,
  location_label        TEXT NULL,   -- raw string from the form (e.g. "Fresh Meadows")
  -- Classification
  asked_about_monthly   BOOLEAN NOT NULL DEFAULT FALSE,
  asked_about_trial     BOOLEAN NOT NULL DEFAULT FALSE,
  asked_about_pricing   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Operational state — staff can mark these "handled" when they've replied
  handled_at            TIMESTAMPTZ NULL,
  handled_by            TEXT NULL,
  -- Where it came from / where it went
  resend_email_id       TEXT NULL,   -- the Resend message id for the staff alert email
  studio_mailbox        TEXT NULL,   -- which inbox got the alert
  -- Raw form payload for forensic reference
  raw                   JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_form_studio_recent
  ON public.contact_form_submissions (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_form_monthly
  ON public.contact_form_submissions (asked_about_monthly, created_at DESC)
  WHERE asked_about_monthly = TRUE;

ALTER TABLE public.contact_form_submissions ENABLE ROW LEVEL SECURITY;

-- Read access — owner dashboard + /homebase staff
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='contact_form_submissions' AND policyname='cfs_read_authenticated'
  ) THEN
    CREATE POLICY "cfs_read_authenticated"
      ON public.contact_form_submissions FOR SELECT
      TO anon, authenticated USING (true);
  END IF;
END$$;


-- ── classify_contact_form_message ───────────────────────────────────────────
-- Pure-text scan. Returns { monthly, trial, pricing } booleans. Used by the
-- send-contact-email function at insert time and also exposed as a SQL
-- function so a backfill job (if Justin ever wants one) can re-classify
-- historical rows.
CREATE OR REPLACE FUNCTION public.classify_contact_form_message(p_message TEXT)
RETURNS TABLE(
  asked_about_monthly BOOLEAN,
  asked_about_trial   BOOLEAN,
  asked_about_pricing BOOLEAN
)
LANGUAGE sql IMMUTABLE
AS $$
  -- Case-insensitive scan of the message for indicator phrases. Bias toward
  -- recall over precision — a borderline "asked about pricing" misfire on
  -- the dashboard is fine; missing a real "asked about monthly" is not.
  WITH m AS (SELECT lower(COALESCE(p_message, '')) AS msg)
  SELECT
    EXISTS (
      SELECT 1 FROM m
      WHERE msg ~ '(monthly|membership|members(hip)?|month[- ]to[- ]month|ongoing|long[- ]term|continue after|permanent member|sign up permanently)'
    )                                                                    AS asked_about_monthly,
    EXISTS (
      SELECT 1 FROM m
      WHERE msg ~ '(trial|\$49|two[- ]week|2[- ]?week|first class|try.*class|try.*bbb|try it out)'
    )                                                                    AS asked_about_trial,
    EXISTS (
      SELECT 1 FROM m
      WHERE msg ~ '(price|pricing|cost|how much|rates?|fees?|\$[0-9])'
    )                                                                    AS asked_about_pricing
$$;
GRANT EXECUTE ON FUNCTION public.classify_contact_form_message(TEXT) TO anon, authenticated;


-- ── get_contact_form_leads — per-studio recent inquiries for the dashboard ─
-- Returns the most recent N submissions for a studio (slug). Includes the
-- classification booleans + handled state so the card can render a clean
-- list with a "📅 asked about monthly" tag.
CREATE OR REPLACE FUNCTION public.get_contact_form_leads(
  p_studio TEXT,
  p_limit  INT DEFAULT 50
)
RETURNS TABLE(
  id                    UUID,
  created_at            TIMESTAMPTZ,
  name                  TEXT,
  email                 TEXT,
  phone                 TEXT,
  message               TEXT,
  asked_about_monthly   BOOLEAN,
  asked_about_trial     BOOLEAN,
  asked_about_pricing   BOOLEAN,
  handled_at            TIMESTAMPTZ,
  handled_by            TEXT,
  studio_name           TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    c.id,
    c.created_at,
    c.name,
    c.email,
    c.phone,
    c.message,
    c.asked_about_monthly,
    c.asked_about_trial,
    c.asked_about_pricing,
    c.handled_at,
    c.handled_by,
    l.name AS studio_name
  FROM public.contact_form_submissions c
  LEFT JOIN public.locations l ON l.id = c.location_id
  WHERE
    -- Match by location slug OR location label (handles legacy NULL location_id)
    (
      l.id IS NOT NULL
      AND lower(replace(l.name, ' ', '-')) = lower(p_studio)
    )
    OR (
      l.id IS NULL
      AND lower(replace(COALESCE(c.location_label, ''), ' ', '-')) = lower(p_studio)
    )
  ORDER BY c.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;
GRANT EXECUTE ON FUNCTION public.get_contact_form_leads(TEXT, INT) TO anon, authenticated;


-- ── mark_contact_form_handled — staff can clear an inquiry from the list ──
CREATE OR REPLACE FUNCTION public.mark_contact_form_handled(
  p_id   UUID,
  p_by   TEXT DEFAULT NULL
)
RETURNS public.contact_form_submissions
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  UPDATE public.contact_form_submissions
     SET handled_at = now(),
         handled_by = p_by
   WHERE id = p_id
  RETURNING *;
$$;
GRANT EXECUTE ON FUNCTION public.mark_contact_form_handled(UUID, TEXT) TO authenticated;


-- ── Sanity check ────────────────────────────────────────────────────────────
SELECT
  to_regclass('public.contact_form_submissions') AS table_present,
  (SELECT COUNT(*) FROM public.contact_form_submissions) AS row_count;
