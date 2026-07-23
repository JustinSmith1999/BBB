-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: get_trial_journey_v2 was erroring with
--   "relation public.dashboard_suppressed_emails does not exist"
-- because the 20260527_suppress_internal_emails migration never landed on
-- the live database. The dashboard fell back to v1 (which doesn't return
-- front_desk_stage), so every row in the Trial Journey card read NEW LEAD
-- regardless of what /homebase actually had it marked as.
--
-- This migration re-applies only the bits required for the dashboard to
-- read front_desk_stage:
--   1. Create the dashboard_suppressed_emails table + seed it
--   2. Re-create get_trial_journey_v2 with front_desk_stage / note /
--      updated_at columns appended
--
-- After running this, the Trial Journey card chips will match exactly what
-- the front desk has each person tagged as in /homebase (New Lead,
-- Contacted, Class Booked, Attended, Converted Member, Lost).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Suppression list (idempotent — won't clobber if it already exists).
CREATE TABLE IF NOT EXISTS public.dashboard_suppressed_emails (
  email      text PRIMARY KEY,
  reason     text,
  added_at   timestamptz DEFAULT now()
);

INSERT INTO public.dashboard_suppressed_emails (email, reason) VALUES
  ('cvicto11@gmail.com', 'Williamsburg gym owner — Christine Victoria')
ON CONFLICT (email) DO UPDATE
  SET reason = EXCLUDED.reason;

-- RLS — Supabase function calls run SECURITY DEFINER so this is belt-and-
-- suspenders. Skip the IF NOT EXISTS variant (Postgres 16+ only); a DO block
-- gives the same idempotency on Postgres 15.
ALTER TABLE public.dashboard_suppressed_emails ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'dashboard_suppressed_emails'
      AND policyname = 'dashboard_suppressed_read'
  ) THEN
    CREATE POLICY "dashboard_suppressed_read"
      ON public.dashboard_suppressed_emails
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END$$;


-- 2. get_trial_journey_v2 — bolts front_desk_stage / note / updated_at AND
-- the utm_* columns onto whatever v1 (get_trial_journey) returns. Drop +
-- create because the OUT-parameter shape may differ from any prior version
-- that's currently in the DB.
DROP FUNCTION IF EXISTS public.get_trial_journey_v2(text, int);

CREATE FUNCTION public.get_trial_journey_v2(p_studio text, p_limit int DEFAULT 200)
RETURNS TABLE(
  trial_id              uuid,
  name                  text,
  email                 text,
  phone                 text,
  studio_slug           text,
  studio_name           text,
  stage                 text,
  stage_label           text,
  stage_color           text,
  created_at            timestamptz,
  paid_at               timestamptz,
  welcome_sms_sent_at   timestamptz,
  welcome_sms_status    text,
  visit_count           integer,
  convert_sms_sent_at   timestamptz,
  convert_replied_yes_at timestamptz,
  abandoned_email_sent_at timestamptz,
  opted_out_at          timestamptz,
  last_activity_at      timestamptz,
  days_since_signup     integer,
  front_desk_stage      text,
  front_desk_note       text,
  front_desk_updated_at timestamptz,
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  utm_content           text
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
    ts.utm_source, ts.utm_medium, ts.utm_campaign, ts.utm_content
  FROM public.get_trial_journey(p_studio, p_limit) j
  LEFT JOIN public.trial_signups ts ON ts.id = j.trial_id
  -- Qualify with the table alias `s` so Postgres doesn't confuse the
  -- subquery's `email` with the function's `email` OUT parameter
  -- (SQLSTATE 42702: column reference is ambiguous).
  WHERE lower(trim(j.email)) NOT IN (SELECT lower(s.email) FROM public.dashboard_suppressed_emails s);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;

-- Sanity check after running:
--   SELECT name, front_desk_stage FROM public.get_trial_journey_v2('astoria') LIMIT 7;
