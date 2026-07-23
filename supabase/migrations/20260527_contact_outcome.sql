-- ─────────────────────────────────────────────────────────────────────────────
-- Contact outcome tracking for /homebase Kanban.
--
-- When staff drags a card from New Lead → Contacted, we want them to log:
--   • day_contacted     — date they actually reached the person
--   • day_coming_in     — date of the first booked class
--   • a note            — what was said / what to follow up on
--
-- If staff CALLED but no one answered, they shouldn't be allowed to call the
-- lead "Contacted" — it's still a new lead. Instead they log a voicemail
-- attempt (voicemail_attempts++) and the card stays in New Lead. The card
-- displays "Voicemail left 3×" so staff can see how many tries have failed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS day_contacted       date,
  ADD COLUMN IF NOT EXISTS day_coming_in       date,
  ADD COLUMN IF NOT EXISTS voicemail_attempts  int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at     timestamptz;

-- ── update_trial_signup_card — extended to accept the 3 new fields + stage ──
-- Any param left NULL means "leave it alone". Passing p_stage moves the card.
-- Frontend calls this from both the inline edit modal AND the new Contacted
-- popup so we don't need a second RPC for the move flow.
DROP FUNCTION IF EXISTS public.update_trial_signup_card(uuid, text, text, text, text);
CREATE OR REPLACE FUNCTION public.update_trial_signup_card(
  p_trial_id        uuid,
  p_name            text DEFAULT NULL,
  p_email           text DEFAULT NULL,
  p_phone           text DEFAULT NULL,
  p_note            text DEFAULT NULL,
  p_stage           text DEFAULT NULL,
  p_day_contacted   date DEFAULT NULL,
  p_day_coming_in   date DEFAULT NULL
)
RETURNS public.trial_signups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_signups;
BEGIN
  UPDATE public.trial_signups
     SET name              = COALESCE(NULLIF(trim(p_name),  ''), name),
         email             = COALESCE(NULLIF(trim(p_email), ''), email),
         phone             = COALESCE(NULLIF(trim(p_phone), ''), phone),
         front_desk_note   = CASE WHEN p_note IS NULL THEN front_desk_note ELSE trim(p_note) END,
         front_desk_stage  = COALESCE(NULLIF(trim(p_stage), ''), front_desk_stage),
         day_contacted     = COALESCE(p_day_contacted, day_contacted),
         day_coming_in     = COALESCE(p_day_coming_in, day_coming_in),
         front_desk_updated_at = now()
   WHERE id = p_trial_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_trial_signup_card(uuid, text, text, text, text, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_trial_signup_card(uuid, text, text, text, text, text, date, date) TO anon, authenticated;


-- ── log_voicemail_attempt — increments counter + appends a timestamped line ──
-- Doesn't change stage. The card stays a New Lead so staff knows it still
-- needs a real conversation. The appended note line lets staff scan the
-- history of attempts without losing the original notes.
CREATE OR REPLACE FUNCTION public.log_voicemail_attempt(
  p_trial_id uuid,
  p_note     text DEFAULT NULL  -- optional extra context staff wants to add
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
BEGIN
  SELECT front_desk_note, COALESCE(voicemail_attempts, 0) + 1
    INTO v_existing, v_new_count
    FROM public.trial_signups WHERE id = p_trial_id;

  v_extra := COALESCE(NULLIF(trim(p_note), ''), 'Voicemail left');
  v_line  := to_char(now() AT TIME ZONE 'America/New_York', 'Mon DD HH12:MIam')
             || ' — ' || v_extra || ' (#' || v_new_count || ')';

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

REVOKE ALL ON FUNCTION public.log_voicemail_attempt(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_voicemail_attempt(uuid, text) TO anon, authenticated;


-- ── get_trial_journey_v2 — bolt the 3 new fields onto the existing payload ──
-- Owner dashboard's Trial Journey table reads this. We add the columns at
-- the END of the return record so any older clients still parse the rest.
DROP FUNCTION IF EXISTS public.get_trial_journey_v2(text, int);
CREATE OR REPLACE FUNCTION public.get_trial_journey_v2(p_studio text, p_limit int DEFAULT 200)
RETURNS TABLE(
  trial_id uuid, name text, email text, phone text, studio_slug text, studio_name text,
  stage text, stage_label text, stage_color text,
  created_at timestamptz, paid_at timestamptz,
  welcome_sms_sent_at timestamptz, welcome_sms_status text,
  visit_count integer,
  convert_sms_sent_at timestamptz, convert_replied_yes_at timestamptz,
  abandoned_email_sent_at timestamptz, opted_out_at timestamptz,
  last_activity_at timestamptz, days_since_signup integer,
  front_desk_stage      text,
  front_desk_note       text,
  front_desk_updated_at timestamptz,
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  utm_content           text,
  day_contacted         date,
  day_coming_in         date,
  voicemail_attempts    int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    j.trial_id, j.name, j.email, j.phone, j.studio_slug, j.studio_name,
    j.stage, j.stage_label, j.stage_color,
    j.created_at, j.paid_at,
    j.welcome_sms_sent_at, j.welcome_sms_status,
    j.visit_count,
    j.convert_sms_sent_at, j.convert_replied_yes_at,
    j.abandoned_email_sent_at, j.opted_out_at,
    j.last_activity_at, j.days_since_signup,
    ts.front_desk_stage,
    ts.front_desk_note,
    ts.front_desk_updated_at,
    ts.utm_source, ts.utm_medium, ts.utm_campaign, ts.utm_content,
    ts.day_contacted, ts.day_coming_in, COALESCE(ts.voicemail_attempts, 0)
  FROM public.get_trial_journey(p_studio, p_limit) j
  LEFT JOIN public.trial_signups ts ON ts.id = j.trial_id
  WHERE lower(trim(j.email)) NOT IN (SELECT lower(email) FROM public.dashboard_suppressed_emails);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;
