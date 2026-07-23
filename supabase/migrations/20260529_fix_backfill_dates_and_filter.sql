-- ─────────────────────────────────────────────────────────────────────────────
-- Two interrelated fixes for the legacy_pl Stripe backfill:
--
-- 1. The backfilled rows are showing a "Paid" date of TODAY on the owner
--    dashboard, not their real Stripe payment date. Cause: v1
--    get_trial_journey maps `paid_at` from the row's first activity, which
--    for backfill rows is `created_at` = today. We override by COALESCing
--    onto trial_signups.payment_date (the real Stripe payment timestamp).
--
-- 2. Backfilled pre-launch customers (source_category='legacy_pl') from the
--    previous-owners era are showing up on both the dashboard AND /homebase.
--    They paid $49 — that's true — but they're not part of the post-Oct-1
--    new-ownership funnel the studio team is working today. Exclude.
--
-- /homebase patch (separate, client-side): loadAll() in frontdesk.html also
-- needs to drop source_category='legacy_pl' from its direct table query.
-- ─────────────────────────────────────────────────────────────────────────────

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
    -- Prefer the real Stripe payment timestamp over v1's `paid_at`, which
    -- collapses to created_at for backfilled rows (= today). payment_date
    -- is set directly from the Stripe PaymentIntent's `created` field, so
    -- it survives backfills with the actual historical date.
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
    -- Hide pre-launch legacy Stripe rows. These are real $49 charges from
    -- the previous owners' era — true but irrelevant to the post-Oct-1
    -- funnel the studios are working today.
    AND COALESCE(ts.source_category, '') <> 'legacy_pl'
    -- Belt-and-suspenders date clamp on whatever paid_at we ended up with.
    AND (
      COALESCE(ts.payment_date, j.paid_at) IS NULL
      OR COALESCE(ts.payment_date, j.paid_at) >= '2026-05-15'::date
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;

-- Quick sanity:
--   SELECT name, paid_at, payment_date FROM public.get_trial_journey_v2('fresh-meadows')
--   ORDER BY paid_at NULLS LAST LIMIT 15;
