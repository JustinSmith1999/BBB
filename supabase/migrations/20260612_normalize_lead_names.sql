-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Normalize lead/inquiry name capitalization.
--
-- The Inquiries panel showed names like "john m." and "justin smith" with
-- inconsistent casing because contact_submissions stores whatever the user
-- typed. Apply title-case so cards on /homebase read cleanly.
--
-- Postgres `initcap()` handles the common cases (laura castineiras → Laura
-- Castineiras, JOHN SMITH → John Smith, jean-pierre → Jean-Pierre). It does
-- mis-handle apostrophes (o'brien → O'brien instead of O'Brien) — acceptable
-- limitation; staff can hand-edit those rare outliers via the front desk modal.
--
-- Scope:
--   1. One-shot normalize every trial_signups.name row.
--   2. One-shot normalize leads.full_name, leads.first_name, leads.last_name.
--   3. Patch the contact_submissions_to_leads trigger to apply initcap at
--      insert time so future submissions land already-normalized.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. One-shot: trial_signups names ──────────────────────────────────────
UPDATE public.trial_signups
   SET name = initcap(lower(trim(name)))
 WHERE name IS NOT NULL
   AND name <> initcap(lower(trim(name)));

-- ── 2. One-shot: leads names ──────────────────────────────────────────────
UPDATE public.leads
   SET full_name  = initcap(lower(trim(full_name))),
       first_name = initcap(lower(trim(first_name))),
       last_name  = initcap(lower(trim(last_name)))
 WHERE full_name IS NOT NULL
    OR first_name IS NOT NULL
    OR last_name  IS NOT NULL;

-- ── 3. Patch trigger so future submissions are normalized on insert ───────
CREATE OR REPLACE FUNCTION public.contact_submissions_to_leads()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_studio_slug TEXT;
  v_first       TEXT;
  v_last        TEXT;
  v_full        TEXT;
  v_phone_e164  TEXT;
  v_existing_ts UUID;
BEGIN
  -- Studio slug from location_id.
  SELECT LOWER(REPLACE(l.name, ' ', '-'))
    INTO v_studio_slug
    FROM public.locations l
   WHERE l.id = NEW.location_id;

  -- Normalize the submitted name: trim + lower + title-case.
  v_full  := initcap(lower(trim(COALESCE(NEW.name, ''))));
  v_first := split_part(v_full, ' ', 1);
  v_last  := NULLIF(regexp_replace(v_full, '^[^ ]+ *', ''), '');

  -- Phone → E.164-ish.
  v_phone_e164 := CASE
    WHEN NEW.phone IS NULL OR length(regexp_replace(NEW.phone, '\D', '', 'g')) < 10 THEN NULL
    WHEN length(regexp_replace(NEW.phone, '\D', '', 'g')) = 10
      THEN '+1' || regexp_replace(NEW.phone, '\D', '', 'g')
    WHEN length(regexp_replace(NEW.phone, '\D', '', 'g')) = 11
      THEN '+' || regexp_replace(NEW.phone, '\D', '', 'g')
    ELSE NEW.phone
  END;

  -- Mirror into leads (normalized).
  INSERT INTO public.leads (
    full_name, first_name, last_name,
    email, phone,
    source, stage, studio_slug,
    last_touch_at, notes, meta
  ) VALUES (
    v_full, v_first, v_last,
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

  -- Mirror into trial_signups (normalized) so /homebase Kanban shows it.
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
      v_full,
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

-- ── 4. Verify a sample ─────────────────────────────────────────────────────
SELECT
  ts.name,
  l.name AS studio,
  ts.source_category,
  ts.created_at
FROM public.trial_signups ts
LEFT JOIN public.locations l ON l.id = ts.location_id
WHERE ts.source_category = 'contact_form'
  AND ts.deleted_at IS NULL
ORDER BY ts.created_at DESC
LIMIT 20;
