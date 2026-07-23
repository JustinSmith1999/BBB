-- ─────────────────────────────────────────────────────────────────────────────
-- Expose mindbody_visits.first_visit_at to both surfaces so staff and the
-- owner can see the date someone actually showed up to class — not just a
-- vague "ATTENDED" badge.
--
-- Two functions get the new column:
--   • get_trial_journey_v2(p_studio)        → owner dashboard Trial Journey
--   • get_homebase_at_risk(p_location_id)   → /homebase kanban cards
--
-- Source: first signed-in visit recorded in public.mindbody_visits, joined
-- through public.mindbody_clients on email.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── get_homebase_at_risk — append first_visit ──────────────────────────────
-- DROP first because we're adding a new OUT column (`first_visit`); Postgres
-- won't let CREATE OR REPLACE change the function's row type.
DROP FUNCTION IF EXISTS public.get_homebase_at_risk(uuid);

CREATE FUNCTION public.get_homebase_at_risk(p_location_id uuid)
RETURNS TABLE(
  trial_id        uuid,
  visit_count     integer,
  first_visit     timestamptz,
  last_visit      timestamptz,
  days_in         integer,
  at_risk         boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_studio_slug text;
BEGIN
  SELECT lower(replace(name, ' ', '-'))
    INTO v_studio_slug
    FROM public.locations
   WHERE id = p_location_id;

  RETURN QUERY
  SELECT
    t.id AS trial_id,
    COALESCE(v.cnt, 0)::int AS visit_count,
    v.first_visit           AS first_visit,
    v.last_visit            AS last_visit,
    GREATEST(0, (CURRENT_DATE - t.payment_date::date))::int AS days_in,
    (
      t.payment_status = 'completed'
      AND COALESCE(v.cnt, 0) = 0
      AND GREATEST(0, (CURRENT_DATE - t.payment_date::date)) >= 2
    ) AS at_risk
  FROM public.trial_signups t
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int       AS cnt,
      min(mv.starts_at)   AS first_visit,
      max(mv.starts_at)   AS last_visit
    FROM public.mindbody_visits  mv
    JOIN public.mindbody_clients mc ON mc.mindbody_id = mv.mindbody_client_id
    WHERE lower(mc.email) = lower(t.email)
      AND mv.studio_slug = v_studio_slug
      AND mv.starts_at >= t.payment_date
      AND mv.signed_in = true
  ) v ON TRUE
  WHERE t.location_id     = p_location_id
    AND t.payment_status  = 'completed'
    AND t.payment_date    >= now() - interval '30 days'
    AND lower(trim(t.email)) NOT IN (SELECT lower(s.email) FROM public.dashboard_suppressed_emails s);
END;
$$;
REVOKE ALL ON FUNCTION public.get_homebase_at_risk(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_at_risk(uuid) TO anon, authenticated;


-- ── get_trial_journey_v2 — append first_visit_at + last_visit_at ────────────
-- Rebuilt with the same OUT-parameter contract as the prior version plus two
-- new TIMESTAMPTZ columns at the end. Front-end is forward-compatible: any
-- caller that doesn't read the new fields just ignores them.
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
    mb.first_visit_at,
    mb.last_visit_at
  FROM public.get_trial_journey(p_studio, p_limit) j
  LEFT JOIN public.trial_signups ts ON ts.id = j.trial_id
  LEFT JOIN LATERAL (
    -- First/last signed-in MindBody visit for this person at this studio,
    -- after their trial payment date (so pre-payment visits don't count as
    -- "showed up for the trial").
    SELECT
      min(mv.starts_at) AS first_visit_at,
      max(mv.starts_at) AS last_visit_at
    FROM public.mindbody_visits  mv
    JOIN public.mindbody_clients mc ON mc.mindbody_id = mv.mindbody_client_id
    WHERE lower(mc.email) = lower(ts.email)
      AND mv.studio_slug = v_studio_slug
      AND mv.signed_in   = true
      AND (ts.payment_date IS NULL OR mv.starts_at >= ts.payment_date)
  ) mb ON TRUE
  WHERE lower(trim(j.email)) NOT IN (SELECT lower(s.email) FROM public.dashboard_suppressed_emails s);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;

-- Quick sanity:
--   SELECT name, front_desk_stage, first_visit_at
--   FROM public.get_trial_journey_v2('astoria')
--   WHERE first_visit_at IS NOT NULL ORDER BY first_visit_at DESC LIMIT 10;
