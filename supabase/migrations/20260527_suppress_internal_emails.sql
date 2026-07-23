-- ─────────────────────────────────────────────────────────────────────────────
-- Suppress internal / gym-owner emails from every dashboard surface.
--
-- A trial_signups row for a gym-owner email (e.g. cvicto11@gmail.com is the
-- Williamsburg owner) was polluting the Homebase "Not Paid" column and the
-- dashboard Trial Journey — she's an Active MindBody member with 21 visits
-- but never bought through Stripe (because she owns the studio).
--
-- We don't delete the trial_signups row (audit / paper trail), we just
-- maintain a small allow-list table the RPCs check against. Add more emails
-- with: INSERT INTO public.dashboard_suppressed_emails (email, reason) VALUES (...);
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dashboard_suppressed_emails (
  email      text PRIMARY KEY,
  reason     text,
  added_at   timestamptz DEFAULT now()
);

-- Seed: known gym-owner / staff emails. Idempotent.
INSERT INTO public.dashboard_suppressed_emails (email, reason) VALUES
  ('cvicto11@gmail.com', 'Williamsburg gym owner — Christine Victoria')
ON CONFLICT (email) DO UPDATE
  SET reason = EXCLUDED.reason;

ALTER TABLE public.dashboard_suppressed_emails ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can READ the suppression list (used by client-side
-- filtering in /homebase). Writes happen via SQL editor only.
CREATE POLICY IF NOT EXISTS "dashboard_suppressed_read"
  ON public.dashboard_suppressed_emails
  FOR SELECT TO anon, authenticated USING (true);


-- ── Patch get_homebase_unpaid_status to skip suppressed emails ──────────────
CREATE OR REPLACE FUNCTION public.get_homebase_unpaid_status(p_location_id uuid)
RETURNS TABLE(
  trial_id          uuid,
  email             text,
  in_mindbody       boolean,
  mindbody_status   text,
  visit_count       integer,
  first_visit_at    timestamptz,
  last_visit_at     timestamptz,
  member_since      timestamptz
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
  WITH unpaid AS (
    SELECT t.id AS trial_id, lower(trim(t.email)) AS email_n
    FROM public.trial_signups t
    WHERE t.location_id = p_location_id
      AND COALESCE(t.payment_status, 'pending') <> 'completed'
      AND t.email IS NOT NULL
      AND lower(trim(t.email)) NOT IN (SELECT lower(email) FROM public.dashboard_suppressed_emails)
  ),
  mb AS (
    SELECT lower(trim(mc.email)) AS email_n,
           mc.mindbody_id,
           mc.status,
           mc.member_since
    FROM public.mindbody_clients mc
    WHERE mc.email IS NOT NULL
  ),
  visits AS (
    SELECT mv.mindbody_client_id,
           COUNT(*)::int AS cnt,
           MIN(mv.starts_at) AS first_visit,
           MAX(mv.starts_at) AS last_visit
    FROM public.mindbody_visits mv
    WHERE mv.studio_slug = v_studio_slug
      AND mv.signed_in = true
    GROUP BY mv.mindbody_client_id
  )
  SELECT
    u.trial_id, u.email_n,
    mb.mindbody_id IS NOT NULL,
    mb.status,
    COALESCE(v.cnt, 0), v.first_visit, v.last_visit, mb.member_since
  FROM unpaid u
  LEFT JOIN mb     ON mb.email_n = u.email_n
  LEFT JOIN visits v ON v.mindbody_client_id = mb.mindbody_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_homebase_unpaid_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_unpaid_status(uuid) TO anon, authenticated;


-- ── Patch get_homebase_at_risk to skip suppressed emails ────────────────────
CREATE OR REPLACE FUNCTION public.get_homebase_at_risk(p_location_id uuid)
RETURNS TABLE(
  trial_id    uuid,
  visit_count integer,
  last_visit  timestamptz,
  days_in     integer,
  at_risk     boolean
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
    v.last_visit            AS last_visit,
    GREATEST(0, (CURRENT_DATE - t.payment_date::date))::int AS days_in,
    (
      t.payment_status = 'completed'
      AND COALESCE(v.cnt, 0) = 0
      AND GREATEST(0, (CURRENT_DATE - t.payment_date::date)) >= 2
    ) AS at_risk
  FROM public.trial_signups t
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS cnt, max(mv.starts_at) AS last_visit
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
    AND lower(trim(t.email)) NOT IN (SELECT lower(email) FROM public.dashboard_suppressed_emails);
END;
$$;
REVOKE ALL ON FUNCTION public.get_homebase_at_risk(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_at_risk(uuid) TO anon, authenticated;


-- ── Patch get_trial_journey_v2 to skip suppressed emails ────────────────────
DROP FUNCTION IF EXISTS public.get_trial_journey_v2(text, int);
CREATE FUNCTION public.get_trial_journey_v2(p_studio text, p_limit int DEFAULT 200)
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
  WHERE lower(trim(j.email)) NOT IN (SELECT lower(email) FROM public.dashboard_suppressed_emails);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;


-- ── Sanity check after running: should NOT include cvicto11 anywhere ───────
-- SELECT * FROM public.dashboard_suppressed_emails;
-- SELECT trial_id, email FROM public.get_homebase_unpaid_status(
--   (SELECT id FROM public.locations WHERE name = 'Williamsburg'));
