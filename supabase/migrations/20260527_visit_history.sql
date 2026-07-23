-- ─────────────────────────────────────────────────────────────────────────────
-- get_visits_for_trial — every MindBody visit for a single trial signup,
-- newest first. Powers the "Visit History" section in the /homebase card
-- modal so staff can see exactly when each customer came in.
--
-- The match is by email today; we'll add phone fallback later (#60). Visits
-- only count for the studio that owns the trial — cross-studio visits don't
-- inflate this number.
-- ─────────────────────────────────────────────────────────────────────────────

-- 3-way client match: email → phone (digits) → last name. Same fallback
-- chain as did_they_book_a_class so we find visits even when the customer
-- typed a different email on the trial form than what's in MindBody.
-- Returns match_method so the UI can label "matched by phone" if needed.
DROP FUNCTION IF EXISTS public.get_visits_for_trial(uuid);
CREATE OR REPLACE FUNCTION public.get_visits_for_trial(p_trial_id uuid)
RETURNS TABLE(
  starts_at     timestamptz,
  ended_at      timestamptz,
  class_name    text,
  signed_in     boolean,
  studio_slug   text,
  match_method  text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_email        text;
  v_phone_digits text;
  v_last_name    text;
  v_studio_slug  text;
  v_mb_id        text;
  v_match        text;
BEGIN
  SELECT lower(trim(t.email)),
         regexp_replace(coalesce(t.phone, ''), '\D', '', 'g'),
         lower(split_part(t.name, ' ', array_length(string_to_array(t.name, ' '), 1))),
         lower(replace(l.name, ' ', '-'))
    INTO v_email, v_phone_digits, v_last_name, v_studio_slug
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
   WHERE t.id = p_trial_id;

  -- Try email first
  IF v_email IS NOT NULL AND v_email <> '' THEN
    SELECT mc.mindbody_id INTO v_mb_id FROM public.mindbody_clients mc
     WHERE lower(mc.email) = v_email LIMIT 1;
    IF v_mb_id IS NOT NULL THEN v_match := 'email'; END IF;
  END IF;

  -- Then phone (need at least 10 digits to avoid junk matches)
  IF v_mb_id IS NULL AND length(coalesce(v_phone_digits, '')) >= 10 THEN
    SELECT mc.mindbody_id INTO v_mb_id FROM public.mindbody_clients mc
     WHERE regexp_replace(coalesce(mc.phone,''), '\D', '', 'g')
           ILIKE '%' || v_phone_digits || '%'
     LIMIT 1;
    IF v_mb_id IS NOT NULL THEN v_match := 'phone'; END IF;
  END IF;

  -- Then last name (need at least 3 chars to avoid common-name collisions)
  IF v_mb_id IS NULL AND length(coalesce(v_last_name, '')) >= 3 THEN
    SELECT mc.mindbody_id INTO v_mb_id FROM public.mindbody_clients mc
     WHERE lower(mc.last_name) = v_last_name LIMIT 1;
    IF v_mb_id IS NOT NULL THEN v_match := 'lastname'; END IF;
  END IF;

  IF v_mb_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT mv.starts_at,
         mv.ended_at,
         mv.service_name AS class_name,
         mv.signed_in,
         mv.studio_slug,
         v_match AS match_method
    FROM public.mindbody_visits mv
   WHERE mv.mindbody_client_id = v_mb_id
     AND mv.studio_slug = v_studio_slug
   ORDER BY mv.starts_at DESC
   LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.get_visits_for_trial(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visits_for_trial(uuid) TO anon, authenticated;
