-- ─────────────────────────────────────────────────────────────────────────────
-- Soft-delete + staff sign-off for the /homebase Kanban.
--
-- 1. deleted_at column on trial_signups (timestamp of soft-delete; NULL = live)
-- 2. soft_delete_trial_signup(id, by)  — flips deleted_at, prepends audit line
-- 3. restore_trial_signup(id, by)      — clears deleted_at, prepends audit line
-- 4. list_deleted_trial_signups()      — for the "Deleted" tab in the top menu
-- 5. update_trial_signup_card extended with p_signed_by so every note edit
--    automatically gets a "— Alex 3:42pm" tag appended.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS trial_signups_not_deleted_idx
  ON public.trial_signups (location_id, created_at DESC)
  WHERE deleted_at IS NULL;


-- ── soft_delete_trial_signup ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.soft_delete_trial_signup(
  p_trial_id uuid,
  p_by       text DEFAULT NULL
)
RETURNS public.trial_signups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_signups;
  v_existing text;
  v_audit text;
BEGIN
  SELECT front_desk_note INTO v_existing FROM public.trial_signups WHERE id = p_trial_id;
  v_audit := to_char(now() AT TIME ZONE 'America/New_York', 'Mon DD HH12:MIam')
             || ' — DELETED'
             || CASE WHEN p_by IS NOT NULL AND trim(p_by) <> '' THEN ' by ' || trim(p_by) ELSE '' END;
  UPDATE public.trial_signups
     SET deleted_at = now(),
         front_desk_note = CASE
           WHEN v_existing IS NULL OR v_existing = '' THEN v_audit
           ELSE v_audit || E'\n' || v_existing
         END,
         front_desk_updated_at = now()
   WHERE id = p_trial_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.soft_delete_trial_signup(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.soft_delete_trial_signup(uuid, text) TO anon, authenticated;


-- ── restore_trial_signup ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_trial_signup(
  p_trial_id uuid,
  p_by       text DEFAULT NULL
)
RETURNS public.trial_signups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_signups;
  v_existing text;
  v_audit text;
BEGIN
  SELECT front_desk_note INTO v_existing FROM public.trial_signups WHERE id = p_trial_id;
  v_audit := to_char(now() AT TIME ZONE 'America/New_York', 'Mon DD HH12:MIam')
             || ' — RESTORED'
             || CASE WHEN p_by IS NOT NULL AND trim(p_by) <> '' THEN ' by ' || trim(p_by) ELSE '' END;
  UPDATE public.trial_signups
     SET deleted_at = NULL,
         front_desk_note = CASE
           WHEN v_existing IS NULL OR v_existing = '' THEN v_audit
           ELSE v_audit || E'\n' || v_existing
         END,
         front_desk_updated_at = now()
   WHERE id = p_trial_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.restore_trial_signup(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_trial_signup(uuid, text) TO anon, authenticated;


-- ── list_deleted_trial_signups ───────────────────────────────────────────────
-- Powers the "Deleted" tab in the top menu. Scoped to the studio so each
-- studio sees only its own deleted leads.
CREATE OR REPLACE FUNCTION public.list_deleted_trial_signups(p_location_id int DEFAULT NULL)
RETURNS TABLE(
  id uuid, name text, email text, phone text,
  location_id int, payment_status text, payment_date timestamptz,
  created_at timestamptz, deleted_at timestamptz,
  front_desk_note text, front_desk_stage text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.name, t.email, t.phone,
         t.location_id, t.payment_status, t.payment_date,
         t.created_at, t.deleted_at,
         t.front_desk_note, t.front_desk_stage
    FROM public.trial_signups t
   WHERE t.deleted_at IS NOT NULL
     AND (p_location_id IS NULL OR t.location_id = p_location_id)
   ORDER BY t.deleted_at DESC
   LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION public.list_deleted_trial_signups(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_deleted_trial_signups(int) TO anon, authenticated;


-- ── update_trial_signup_card — now accepts a p_signed_by stamp ───────────────
-- When passed, the staff name is appended as "— Alex 3:42pm" to the saved
-- note so every edit is attributable. Existing callers that don't pass it
-- still work — the signature is optional.
DROP FUNCTION IF EXISTS public.update_trial_signup_card(uuid, text, text, text, text, text, date, date);
CREATE OR REPLACE FUNCTION public.update_trial_signup_card(
  p_trial_id        uuid,
  p_name            text DEFAULT NULL,
  p_email           text DEFAULT NULL,
  p_phone           text DEFAULT NULL,
  p_note            text DEFAULT NULL,
  p_stage           text DEFAULT NULL,
  p_day_contacted   date DEFAULT NULL,
  p_day_coming_in   date DEFAULT NULL,
  p_signed_by       text DEFAULT NULL
)
RETURNS public.trial_signups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_signups;
  v_note_in  text;
  v_sig      text;
BEGIN
  v_note_in := NULLIF(trim(coalesce(p_note, '')), '');
  v_sig     := NULLIF(trim(coalesce(p_signed_by, '')), '');
  -- If both note + signature provided, suffix the note with "— Alex 3:42pm"
  IF v_note_in IS NOT NULL AND v_sig IS NOT NULL THEN
    v_note_in := v_note_in || ' — ' || v_sig || ' ' ||
                 to_char(now() AT TIME ZONE 'America/New_York', 'HH12:MIam');
  END IF;

  UPDATE public.trial_signups
     SET name              = COALESCE(NULLIF(trim(p_name),  ''), name),
         email             = COALESCE(NULLIF(trim(p_email), ''), email),
         phone             = COALESCE(NULLIF(trim(p_phone), ''), phone),
         front_desk_note   = CASE WHEN p_note IS NULL THEN front_desk_note ELSE v_note_in END,
         front_desk_stage  = COALESCE(NULLIF(trim(p_stage), ''), front_desk_stage),
         day_contacted     = COALESCE(p_day_contacted, day_contacted),
         day_coming_in     = COALESCE(p_day_coming_in, day_coming_in),
         front_desk_updated_at = now()
   WHERE id = p_trial_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.update_trial_signup_card(uuid, text, text, text, text, text, date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_trial_signup_card(uuid, text, text, text, text, text, date, date, text) TO anon, authenticated;


-- ── log_voicemail_attempt — also accepts signed_by now ───────────────────────
CREATE OR REPLACE FUNCTION public.log_voicemail_attempt(
  p_trial_id uuid,
  p_note     text DEFAULT NULL,
  p_signed_by text DEFAULT NULL
)
RETURNS public.trial_signups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_signups;
  v_new_count int;
  v_extra text;
  v_existing text;
  v_line text;
  v_sig text;
BEGIN
  SELECT front_desk_note, COALESCE(voicemail_attempts, 0) + 1
    INTO v_existing, v_new_count
    FROM public.trial_signups WHERE id = p_trial_id;

  v_extra := COALESCE(NULLIF(trim(p_note), ''), 'Voicemail left');
  v_sig   := NULLIF(trim(coalesce(p_signed_by, '')), '');
  v_line  := to_char(now() AT TIME ZONE 'America/New_York', 'Mon DD HH12:MIam')
             || ' — ' || v_extra || ' (#' || v_new_count || ')'
             || CASE WHEN v_sig IS NOT NULL THEN ' — ' || v_sig ELSE '' END;

  UPDATE public.trial_signups
     SET voicemail_attempts    = v_new_count,
         last_attempt_at       = now(),
         front_desk_note       = CASE
           WHEN v_existing IS NULL OR v_existing = '' THEN v_line
           ELSE v_line || E'\n' || v_existing
         END,
         front_desk_updated_at = now()
   WHERE id = p_trial_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.log_voicemail_attempt(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_voicemail_attempt(uuid, text, text) TO anon, authenticated;
