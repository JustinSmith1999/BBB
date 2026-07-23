-- ─────────────────────────────────────────────────────────────────────────────
-- Hide any paid trial whose payment landed BEFORE May 15, 2026 from the
-- owner dashboard. The May 15 launch is the boundary every other dashboard
-- card already clamps to (see 2026-05-15 literal in get_meta_daily_trend,
-- get_studio_overview, etc) — Trial Journey should too.
--
-- Unpaid / abandoned form fills (paid_at IS NULL) stay visible regardless
-- of when they were filled — those are still actionable.
-- ─────────────────────────────────────────────────────────────────────────────

-- Signature unchanged from prior version (just adds a WHERE clause), so a
-- plain CREATE OR REPLACE is sufficient — no DROP needed.
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
    -- Clamp paid trials to the May 15, 2026 launch boundary. Pre-launch
    -- payments (legacy Stripe rows from before the new website) clutter
    -- the Trial Journey table. Unpaid form fills are unaffected.
    AND (j.paid_at IS NULL OR j.paid_at >= '2026-05-15'::date);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;

-- Quick sanity (should return only rows with paid_at >= 2026-05-15 OR NULL):
--   SELECT name, paid_at FROM public.get_trial_journey_v2('astoria')
--   ORDER BY paid_at NULLS LAST, name LIMIT 30;
