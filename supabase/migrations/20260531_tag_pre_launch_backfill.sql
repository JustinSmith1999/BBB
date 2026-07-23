-- ─────────────────────────────────────────────────────────────────────────────
-- Retag any pre-launch paid trial whose source_category is NULL as
-- 'legacy_archived' so every downstream filter catches them.
--
-- ⚠ Use 'legacy_archived' (not 'legacy_pl') — the trial_signups table has
-- a check constraint (trial_signups_source_category_check) allowing only:
--   'ad', 'web_organic', 'in_person', 'legacy_archived'
-- An earlier filter pass used 'legacy_pl' which silently matched nothing.
-- This migration corrects that AND updates the dashboard RPC to match.
--
-- Scope: only paid rows whose payment_date is strictly before the May 15,
-- 2026 launch — the same boundary we use everywhere else. Leaves
-- post-launch rows untouched.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Retag the ghost backfill rows.
UPDATE public.trial_signups
SET source_category = 'legacy_archived'
WHERE payment_status   = 'completed'
  AND payment_date IS NOT NULL
  AND payment_date     <  '2026-05-15'::date
  AND source_category IS NULL;


-- 2. Fix get_trial_journey_v2 to filter the *correct* tag value. The prior
-- migration filtered 'legacy_pl' (which the constraint rejects), so the
-- clause was effectively unreachable.
CREATE OR REPLACE FUNCTION public.get_trial_journey_v2(p_studio text, p_limit int DEFAULT 200)
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
  utm_content           text,
  first_visit_at        timestamptz,
  last_visit_at         timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_studio_slug text := lower(replace(p_studio, ' ', '-'));
BEGIN
  RETURN QUERY
  SELECT
    j.trial_id, j.name, j.email, j.phone, j.studio_slug, j.studio_name,
    j.stage, j.stage_label, j.stage_color,
    j.created_at,
    COALESCE(ts.payment_date, j.paid_at) AS paid_at,
    j.welcome_sms_sent_at, j.welcome_sms_status,
    j.visit_count,
    j.convert_sms_sent_at, j.convert_replied_yes_at,
    j.abandoned_email_sent_at, j.opted_out_at,
    j.last_activity_at, j.days_since_signup,
    ts.front_desk_stage,
    ts.front_desk_note,
    ts.front_desk_updated_at,
    ts.utm_source, ts.utm_medium, ts.utm_campaign, ts.utm_content,
    mb.first_visit_at,
    mb.last_visit_at
  FROM public.get_trial_journey(p_studio, p_limit) j
  LEFT JOIN public.trial_signups ts ON ts.id = j.trial_id
  LEFT JOIN LATERAL (
    SELECT
      min(mv.starts_at) AS first_visit_at,
      max(mv.starts_at) AS last_visit_at
    FROM public.mindbody_visits  mv
    JOIN public.mindbody_clients mc ON mc.mindbody_id = mv.mindbody_client_id
    WHERE lower(mc.email)        = lower(ts.email)
      AND mv.studio_slug         = v_studio_slug
      AND mv.starts_at           <= now()
      AND (ts.payment_date IS NULL OR mv.starts_at >= ts.payment_date)
      AND COALESCE(mv.late_cancelled, false) = false
      AND COALESCE(mv.cancelled,      false) = false
  ) mb ON TRUE
  WHERE lower(trim(j.email)) NOT IN (SELECT lower(s.email) FROM public.dashboard_suppressed_emails s)
    -- Hide pre-launch / legacy backfilled rows — actual constraint value
    AND COALESCE(ts.source_category, '') <> 'legacy_archived'
    -- Belt-and-suspenders date clamp.
    AND (
      COALESCE(ts.payment_date, j.paid_at) IS NULL
      OR COALESCE(ts.payment_date, j.paid_at) >= '2026-05-15'::date
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;

-- Sanity:
--   SELECT name, payment_date, source_category FROM public.trial_signups
--   WHERE payment_status = 'completed' AND payment_date < '2026-05-15'::date;
--   -- All should now show source_category = 'legacy_archived'.
