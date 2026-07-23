-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Contact form → Email Lead → Trial conversion attribution.
--
-- Three problems we're solving:
--   1. Contact form submissions hit contact_submissions only. They don't
--      appear in the leads table where the dashboard reads from, so they
--      aren't counted as "Email Leads."
--   2. When a contact-form submitter later pays a $49 trial, there's no
--      link back to the original contact form — we lose the conversion
--      attribution and the studio gets no credit.
--   3. Names from contact_submissions don't auto-split into first/last,
--      so /homebase + dashboard tiles can't show clean per-customer rows.
--
-- The fix (all server-side, zero front-end change required):
--   - Mirror every contact_submissions INSERT into leads as
--     source='contact_form', stage='inquiry'.
--   - Add lead_source + lead_id columns to trial_signups so we can record
--     "this paid trial originally came from a contact form filed N days ago."
--   - Add a trigger on trial_signups INSERT/UPDATE that matches by email
--     or last-10 phone digits against leads, and stamps the attribution.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Extend trial_signups with attribution columns ───────────────────────
ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS lead_source TEXT,
  ADD COLUMN IF NOT EXISTS lead_id     UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_attribution_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_trial_signups_lead_source
  ON public.trial_signups (lead_source) WHERE lead_source IS NOT NULL;

COMMENT ON COLUMN public.trial_signups.lead_source IS
  'If this customer had a prior leads row (contact form, schedule request, etc.) at conversion time, that source is recorded here for credit attribution. Backfilled by trigger.';

-- ── 2. Mirror contact_submissions → leads on every insert ──────────────────
CREATE OR REPLACE FUNCTION public.contact_submissions_to_leads()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_studio_slug TEXT;
  v_first       TEXT;
  v_last        TEXT;
  v_phone_e164  TEXT;
BEGIN
  -- Derive studio_slug from the location_id (LOWER + dash form, matches the
  -- rest of the codebase's slug convention).
  SELECT LOWER(REPLACE(l.name, ' ', '-'))
    INTO v_studio_slug
    FROM public.locations l
   WHERE l.id = NEW.location_id;

  -- Split full name on first space (best-effort).
  v_first := split_part(COALESCE(NEW.name, ''), ' ', 1);
  v_last  := NULLIF(regexp_replace(COALESCE(NEW.name, ''), '^[^ ]+ *', ''), '');

  -- Normalize phone to E.164-ish (+1 + 10 digits) when possible.
  v_phone_e164 := CASE
    WHEN NEW.phone IS NULL OR length(regexp_replace(NEW.phone, '\D', '', 'g')) < 10 THEN NULL
    WHEN length(regexp_replace(NEW.phone, '\D', '', 'g')) = 10
      THEN '+1' || regexp_replace(NEW.phone, '\D', '', 'g')
    WHEN length(regexp_replace(NEW.phone, '\D', '', 'g')) = 11
      THEN '+' || regexp_replace(NEW.phone, '\D', '', 'g')
    ELSE NEW.phone
  END;

  -- Insert into leads. Use ON CONFLICT to handle re-submits gracefully —
  -- if the same email+studio shows up again, we just refresh last_touch_at.
  INSERT INTO public.leads (
    full_name, first_name, last_name,
    email, phone,
    source, stage, studio_slug,
    last_touch_at, notes, meta
  ) VALUES (
    NEW.name, v_first, v_last,
    LOWER(NEW.email), v_phone_e164,
    'contact_form', 'inquiry', v_studio_slug,
    NEW.created_at,
    'Contact form submission via /contact. Message: ' || COALESCE(NEW.message, '(empty)'),
    jsonb_build_object(
      'contact_submission_id', NEW.id,
      'message', NEW.message,
      'location_id', NEW.location_id,
      'captured_at', NEW.created_at
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contact_submissions_to_leads ON public.contact_submissions;
CREATE TRIGGER trg_contact_submissions_to_leads
  AFTER INSERT ON public.contact_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.contact_submissions_to_leads();

-- ── 3. On trial_signups create, find + credit prior lead ──────────────────
-- Matches on lower(email) OR last-10 digits of phone (most reliable cross-
-- channel signal — contact form + paid trial often have different name
-- spellings but the same phone or email).
CREATE OR REPLACE FUNCTION public.trial_signups_attribute_lead()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_lead RECORD;
  v_phone_last10 TEXT;
BEGIN
  -- Only run on INSERT (not every update) and only if lead_source isn't
  -- already set (don't clobber an explicit assignment from a form).
  IF NEW.lead_source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_phone_last10 := right(regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g'), 10);

  -- Find the MOST RECENT lead matching by email or phone.
  -- Prefer contact_form > schedule-request > other.
  SELECT id, source
    INTO v_lead
    FROM public.leads
   WHERE (LOWER(email) = LOWER(NEW.email) AND email IS NOT NULL)
      OR (length(v_phone_last10) = 10 AND right(regexp_replace(phone, '\D', '', 'g'), 10) = v_phone_last10)
   ORDER BY
     CASE source
       WHEN 'contact_form' THEN 0
       WHEN 'schedule-request-' || NEW.studio_slug THEN 1   -- legacy: schedule requests with study slug suffix
       ELSE 2
     END,
     last_touch_at DESC
   LIMIT 1;

  IF v_lead.id IS NOT NULL THEN
    NEW.lead_source         := v_lead.source;
    NEW.lead_id             := v_lead.id;
    NEW.lead_attribution_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trial_signups_attribute_lead ON public.trial_signups;
CREATE TRIGGER trg_trial_signups_attribute_lead
  BEFORE INSERT ON public.trial_signups
  FOR EACH ROW
  EXECUTE FUNCTION public.trial_signups_attribute_lead();

-- ── 4. Backfill — credit existing trial_signups against existing leads ────
-- (Useful if any contact form submitters later signed up before this trigger.)
UPDATE public.trial_signups ts
   SET lead_source = l.source,
       lead_id     = l.id,
       lead_attribution_at = now()
  FROM public.leads l
 WHERE ts.lead_source IS NULL
   AND (
     (LOWER(l.email) = LOWER(ts.email) AND l.email IS NOT NULL AND ts.email IS NOT NULL)
     OR (
       length(regexp_replace(COALESCE(ts.phone, ''), '\D', '', 'g')) >= 10
       AND right(regexp_replace(ts.phone, '\D', '', 'g'), 10) = right(regexp_replace(l.phone, '\D', '', 'g'), 10)
     )
   );

-- ── 5. RPC for dashboard: contact-form leads + conversion rate ────────────
DROP FUNCTION IF EXISTS public.get_contact_form_leads_v2(text);
CREATE OR REPLACE FUNCTION public.get_contact_form_leads_v2(p_studio_slug TEXT)
RETURNS TABLE(
  studio_slug   TEXT,
  total_leads          INTEGER,
  leads_today          INTEGER,
  leads_this_week      INTEGER,
  converted_to_paid    INTEGER,
  conversion_rate_pct  NUMERIC,
  revenue_cents        INTEGER,
  recent_list          JSONB
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH ldata AS (
    SELECT l.*
    FROM public.leads l
    WHERE l.source = 'contact_form'
      AND l.studio_slug = p_studio_slug
  ),
  -- trial_signups doesn't carry a price column; amounts live in
  -- stripe_paid_mirror. We left-join it so 'converted' rows can use the
  -- actual Stripe-paid amount (handles $49 trial vs $29 comeback correctly).
  conv AS (
    SELECT
      ts.id,
      ts.lead_id,
      ts.payment_status,
      COALESCE(spm.amount_cents, 4900) AS revenue_cents
    FROM public.trial_signups ts
    LEFT JOIN public.stripe_paid_mirror spm
           ON LOWER(spm.customer_email) = LOWER(ts.email)
    WHERE ts.lead_source = 'contact_form'
  )
  SELECT
    p_studio_slug,
    (SELECT COUNT(*) FROM ldata)::INTEGER,
    (SELECT COUNT(*) FROM ldata WHERE created_at >= (CURRENT_DATE AT TIME ZONE 'America/New_York'))::INTEGER,
    (SELECT COUNT(*) FROM ldata WHERE created_at >= date_trunc('week', CURRENT_DATE AT TIME ZONE 'America/New_York'))::INTEGER,
    (SELECT COUNT(DISTINCT lead_id) FROM conv WHERE payment_status = 'completed' AND lead_id IN (SELECT id FROM ldata))::INTEGER,
    CASE
      WHEN (SELECT COUNT(*) FROM ldata) = 0 THEN 0
      ELSE ROUND(
        100.0 * (SELECT COUNT(DISTINCT lead_id) FROM conv WHERE payment_status = 'completed' AND lead_id IN (SELECT id FROM ldata))
        / (SELECT COUNT(*) FROM ldata),
        1
      )
    END,
    (SELECT COALESCE(SUM(revenue_cents), 0) FROM conv WHERE payment_status = 'completed' AND lead_id IN (SELECT id FROM ldata))::INTEGER,
    (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id',           l.id,
        'full_name',    l.full_name,
        'email',        l.email,
        'phone',        l.phone,
        'created_at',   l.created_at,
        'converted',    EXISTS(SELECT 1 FROM conv WHERE conv.lead_id = l.id AND conv.payment_status = 'completed'),
        'message',      l.meta->>'message'
      ) ORDER BY l.created_at DESC), '[]'::jsonb)
      FROM ldata l
      LIMIT 25
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_contact_form_leads_v2(TEXT) TO anon, authenticated;
