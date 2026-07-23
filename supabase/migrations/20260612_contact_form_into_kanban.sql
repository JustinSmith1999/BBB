-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Contact-form leads land directly on /homebase Kanban.
--
-- Background: Justin wants /contact form submissions (e.g. Laura Castineiras)
-- to appear in the SAME "Abandoned Checkout" Kanban column as trial-form
-- abandoners — distinguished by an "Inquired about pricing" badge — instead
-- of a separate Inquiries strip. Staff work one queue, not two.
--
-- What this migration does:
--   1. Expands the trial_signups.source_category CHECK constraint to allow
--      'contact_form' so contact submitters can be stored there.
--   2. Replaces the contact_submissions_to_leads trigger function with one
--      that mirrors contact_submissions into BOTH leads (for attribution
--      chain — preserves prior behavior) AND trial_signups (so the row
--      surfaces on /homebase). The trial_signups insert uses:
--           source_category = 'contact_form'
--           payment_status  = 'pending'
--           front_desk_stage = 'new_lead'
--           front_desk_note  = the submission's message
--      That bucket logic in frontdesk.html (`buckets.unpaid.push(r)`)
--      already routes unpaid + new_lead rows into Abandoned Checkout, so
--      no client-side change is needed for placement — only badge cosmetics.
--   3. Backfills existing contact_submissions into trial_signups (idempotent).
--
-- Safe to re-run: ON CONFLICT NOTHING + NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Idempotent prereqs (in case sibling migrations weren't run) ─────────
-- leads.first_name / last_name / contacted_at columns
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name  TEXT,
  ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ;

-- ── 0b. Patch the existing trial_signups_attribute_lead trigger ───────────
-- The prior migration 20260612_contact_form_lead_attribution.sql shipped a
-- trial_signups BEFORE-INSERT trigger that referenced NEW.studio_slug — but
-- trial_signups never had that column (it carries location_id). Every insert
-- into trial_signups (including this migration's backfill) currently fails
-- with: ERROR 42703 record "new" has no field "studio_slug".
-- Fix: derive studio_slug locally from NEW.location_id.
CREATE OR REPLACE FUNCTION public.trial_signups_attribute_lead()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_lead RECORD;
  v_phone_last10 TEXT;
  v_studio_slug  TEXT;
BEGIN
  -- Only run on INSERT (not every update) and only if lead_source isn't
  -- already set (don't clobber an explicit assignment from a form).
  IF NEW.lead_source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_phone_last10 := right(regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g'), 10);

  -- Derive studio_slug locally from NEW.location_id (trial_signups has no
  -- studio_slug column).
  SELECT LOWER(REPLACE(l.name, ' ', '-'))
    INTO v_studio_slug
    FROM public.locations l
   WHERE l.id = NEW.location_id;

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
       WHEN 'schedule-request-' || v_studio_slug THEN 1
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

-- Make sure lead_source / lead_id / lead_attribution_at columns exist on
-- trial_signups (idempotent — these came from the same prior migration).
ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS lead_source         TEXT,
  ADD COLUMN IF NOT EXISTS lead_id             UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_attribution_at TIMESTAMPTZ;


-- ── 1. Expand source_category CHECK to allow 'contact_form' ────────────────
-- Drop ALL known variant names so whichever one is live gets removed.
ALTER TABLE public.trial_signups
  DROP CONSTRAINT IF EXISTS trial_signups_source_category_check,
  DROP CONSTRAINT IF EXISTS trial_signups_source_category_chk;

-- Belt-and-suspenders: drop any constraint whose definition references
-- source_category, regardless of name (in case some prior hotfix renamed it).
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.trial_signups'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%source_category%'
  LOOP
    EXECUTE format('ALTER TABLE public.trial_signups DROP CONSTRAINT IF EXISTS %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.trial_signups
  ADD CONSTRAINT trial_signups_source_category_check
  CHECK (source_category IS NULL OR source_category IN (
    -- form-driven
    'trial_form','special_form','resign_form','comeback_form','contact_form',
    -- in-person & POS
    'mb_direct','in_person','direct_membership','manual',
    -- sheet / front-desk surfaces
    'sheet','sheet_backfill','walk_in','member_referral',
    -- promos
    'groupon','external_paid','reactivation',
    -- ad attribution
    'ad','web_organic',
    -- raw Stripe checkout (no prior pending row)
    'stripe_checkout',
    -- historical bucket — pre-cutover rows we don't re-label
    'legacy_archived'
  ));

-- ── 2. Extended trigger: mirror to leads AND trial_signups ─────────────────
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
  v_existing_ts UUID;
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

  -- Mirror into leads (attribution chain — unchanged from prior trigger).
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

  -- ALSO mirror into trial_signups so the card appears on /homebase Kanban
  -- in the Abandoned Checkout column. Guard against re-runs by checking
  -- whether a trial_signups row already exists with this email+location+source.
  SELECT id INTO v_existing_ts
    FROM public.trial_signups
   WHERE email = LOWER(NEW.email)
     AND location_id = NEW.location_id
     AND source_category = 'contact_form'
   LIMIT 1;

  IF v_existing_ts IS NULL THEN
    INSERT INTO public.trial_signups (
      name, email, phone, location_id,
      payment_status, source_category,
      front_desk_stage, front_desk_note,
      created_at
    ) VALUES (
      NEW.name,
      LOWER(NEW.email),
      v_phone_e164,
      NEW.location_id,
      'pending',
      'contact_form',
      'new_lead',
      'Inquired via /contact form. Message: ' || COALESCE(NEW.message, '(empty)'),
      NEW.created_at
    );
  END IF;

  RETURN NEW;
END;
$$;

-- (Trigger already exists from prior migration; reuse it.)
DROP TRIGGER IF EXISTS trg_contact_submissions_to_leads ON public.contact_submissions;
CREATE TRIGGER trg_contact_submissions_to_leads
  AFTER INSERT ON public.contact_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.contact_submissions_to_leads();

-- ── 3. Backfill — replay existing contact_submissions ──────────────────────
-- Mirror into leads if not already there.
INSERT INTO public.leads (
  full_name, first_name, last_name,
  email, phone,
  source, stage, studio_slug,
  last_touch_at, notes, meta
)
SELECT
  cs.name,
  split_part(COALESCE(cs.name, ''), ' ', 1),
  NULLIF(regexp_replace(COALESCE(cs.name, ''), '^[^ ]+ *', ''), ''),
  LOWER(cs.email),
  CASE
    WHEN cs.phone IS NULL OR length(regexp_replace(cs.phone, '\D', '', 'g')) < 10 THEN NULL
    WHEN length(regexp_replace(cs.phone, '\D', '', 'g')) = 10
      THEN '+1' || regexp_replace(cs.phone, '\D', '', 'g')
    WHEN length(regexp_replace(cs.phone, '\D', '', 'g')) = 11
      THEN '+' || regexp_replace(cs.phone, '\D', '', 'g')
    ELSE cs.phone
  END,
  'contact_form', 'inquiry',
  LOWER(REPLACE(l.name, ' ', '-')),
  cs.created_at,
  'Contact form submission via /contact. Message: ' || COALESCE(cs.message, '(empty)'),
  jsonb_build_object(
    'contact_submission_id', cs.id,
    'message', cs.message,
    'location_id', cs.location_id,
    'captured_at', cs.created_at
  )
FROM public.contact_submissions cs
LEFT JOIN public.locations l ON l.id = cs.location_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.leads ld
  WHERE ld.source = 'contact_form'
    AND (ld.meta->>'contact_submission_id') = cs.id::text
);

-- Mirror into trial_signups if not already there.
INSERT INTO public.trial_signups (
  name, email, phone, location_id,
  payment_status, source_category,
  front_desk_stage, front_desk_note,
  created_at
)
SELECT
  cs.name,
  LOWER(cs.email),
  CASE
    WHEN cs.phone IS NULL OR length(regexp_replace(cs.phone, '\D', '', 'g')) < 10 THEN NULL
    WHEN length(regexp_replace(cs.phone, '\D', '', 'g')) = 10
      THEN '+1' || regexp_replace(cs.phone, '\D', '', 'g')
    WHEN length(regexp_replace(cs.phone, '\D', '', 'g')) = 11
      THEN '+' || regexp_replace(cs.phone, '\D', '', 'g')
    ELSE cs.phone
  END,
  cs.location_id,
  'pending',
  'contact_form',
  'new_lead',
  'Inquired via /contact form. Message: ' || COALESCE(cs.message, '(empty)'),
  cs.created_at
FROM public.contact_submissions cs
WHERE NOT EXISTS (
  SELECT 1 FROM public.trial_signups ts
  WHERE ts.email = LOWER(cs.email)
    AND ts.location_id = cs.location_id
    AND ts.source_category = 'contact_form'
);

-- ── 4. Verify ──────────────────────────────────────────────────────────────
SELECT
  ts.created_at,
  ts.name,
  l.name AS studio,
  ts.source_category,
  ts.front_desk_stage,
  ts.front_desk_note
FROM public.trial_signups ts
JOIN public.locations l ON l.id = ts.location_id
WHERE ts.source_category = 'contact_form'
ORDER BY ts.created_at DESC;
