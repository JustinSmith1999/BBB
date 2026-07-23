-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Schedule-request leads land on /homebase Kanban.
--
-- Background: Justin saw Jessica Palumbo on the Schedule Requests dashboard
-- tile but she wasn't on /homebase. We want every schedule-request lead to
-- appear as a card in the Abandoned Checkout column with a "Requested
-- schedule (sent)" sub-status — same pattern we used for contact_form.
--
-- Strategy mirrors 20260612_contact_form_into_kanban.sql:
--   1. Extend trial_signups.source_category CHECK to allow 'schedule_request'.
--   2. Backfill existing leads where source LIKE 'schedule-request-%' into
--      trial_signups (one row per lead, matched by email+location).
--   3. Ship a small trigger on leads (NEW.source LIKE 'schedule-request-%')
--      so future schedule requests auto-mirror into the Kanban table.
--   4. Verify SELECT at the end shows what landed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Expand source_category CHECK ───────────────────────────────────────
ALTER TABLE public.trial_signups
  DROP CONSTRAINT IF EXISTS trial_signups_source_category_check,
  DROP CONSTRAINT IF EXISTS trial_signups_source_category_chk;

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
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
    'trial_form','special_form','resign_form','comeback_form','contact_form','schedule_request',
    'mb_direct','in_person','direct_membership','manual',
    'sheet','sheet_backfill','walk_in','member_referral',
    'groupon','external_paid','reactivation',
    'ad','web_organic',
    'stripe_checkout',
    'legacy_archived'
  ));

-- ── 2. Backfill existing schedule-request leads into trial_signups ────────
INSERT INTO public.trial_signups (
  name, email, phone, location_id,
  payment_status, source_category,
  front_desk_stage, front_desk_note,
  created_at
)
SELECT
  initcap(lower(trim(COALESCE(l.full_name,
                              concat_ws(' ', l.first_name, l.last_name),
                              split_part(l.email, '@', 1))))),
  LOWER(l.email),
  l.phone,
  loc.id,
  'pending',
  'schedule_request',
  'new_lead',
  'Requested class schedule via /trial form. Schedule SMS sent automatically.',
  l.created_at
FROM public.leads l
JOIN public.locations loc
  ON LOWER(REPLACE(loc.name, ' ', '-')) = REPLACE(l.source, 'schedule-request-', '')
WHERE l.source LIKE 'schedule-request-%'
  AND l.email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.trial_signups ts
    WHERE ts.email = LOWER(l.email)
      AND ts.location_id = loc.id
      AND ts.source_category = 'schedule_request'
  );

-- ── 3. Trigger: future schedule-request leads auto-mirror to trial_signups
CREATE OR REPLACE FUNCTION public.schedule_request_lead_to_kanban()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_loc_id UUID;
  v_studio_slug TEXT;
  v_existing UUID;
  v_normalized_name TEXT;
BEGIN
  -- Only fire for schedule-request rows. Other lead sources are out of scope.
  IF NEW.source IS NULL OR NEW.source NOT LIKE 'schedule-request-%' THEN
    RETURN NEW;
  END IF;

  v_studio_slug := REPLACE(NEW.source, 'schedule-request-', '');

  SELECT id INTO v_loc_id
    FROM public.locations
   WHERE LOWER(REPLACE(name, ' ', '-')) = v_studio_slug;

  IF v_loc_id IS NULL THEN
    -- Unknown studio slug — skip silently rather than block the insert.
    RETURN NEW;
  END IF;

  -- De-dup guard.
  SELECT id INTO v_existing
    FROM public.trial_signups
   WHERE email = LOWER(NEW.email)
     AND location_id = v_loc_id
     AND source_category = 'schedule_request'
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_normalized_name := initcap(lower(trim(COALESCE(
    NEW.full_name,
    concat_ws(' ', NEW.first_name, NEW.last_name),
    split_part(NEW.email, '@', 1)
  ))));

  INSERT INTO public.trial_signups (
    name, email, phone, location_id,
    payment_status, source_category,
    front_desk_stage, front_desk_note,
    created_at
  ) VALUES (
    v_normalized_name,
    LOWER(NEW.email),
    NEW.phone,
    v_loc_id,
    'pending',
    'schedule_request',
    'new_lead',
    'Requested class schedule via /trial form. Schedule SMS sent automatically.',
    NEW.created_at
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_schedule_request_lead_to_kanban ON public.leads;
CREATE TRIGGER trg_schedule_request_lead_to_kanban
  AFTER INSERT ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.schedule_request_lead_to_kanban();

-- ── 4. Verify ─────────────────────────────────────────────────────────────
SELECT
  ts.created_at,
  ts.name,
  ts.email,
  ts.phone,
  loc.name AS studio,
  ts.source_category,
  ts.front_desk_stage,
  ts.front_desk_note
FROM public.trial_signups ts
JOIN public.locations loc ON loc.id = ts.location_id
WHERE ts.source_category = 'schedule_request'
ORDER BY ts.created_at DESC;
