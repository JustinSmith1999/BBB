-- ─────────────────────────────────────────────────────────────────────────────
-- THREE-PART FIX surfaced by end-to-end QA on May 31, 2026:
--
-- 1) get_daily_pulse counts paid trials by `created_at = today` instead of
--    `payment_date = today`. Every Stripe-backfill row inserted today (with
--    real payment dates from May 3-16) was showing as "paid today". Today's
--    actual paid count across all 4 studios = 0; dashboard was reading 17.
--
-- 2) Two backfill rows post-launch (5/15 + 5/16) have source_category=NULL
--    instead of 'legacy_archived' and slip through every filter. Retag any
--    backfill row identifiable by its placeholder email pattern.
--
-- 3) Add an email-pattern guard to get_daily_pulse so future webhook
--    backfills with NULL source_category are still excluded.
--
-- After this lands, Today's panel will show real customer activity only.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Retag remaining null-source backfill rows ────────────────────────────
-- Webhook backfill creates rows with email "backfill-pi_*@no-email.bbb.local".
-- Catch all such rows regardless of payment_date.
UPDATE public.trial_signups
SET source_category = 'legacy_archived'
WHERE email LIKE 'backfill-pi_%@no-email.bbb.local'
  AND COALESCE(source_category, '') <> 'legacy_archived';


-- ── 2. get_daily_pulse — payment_date for paid, exclude legacy_archived ─────
-- Same OUT shape (jsonb) so CREATE OR REPLACE is fine.
CREATE OR REPLACE FUNCTION public.get_daily_pulse(p_studio text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed text[];
  v_loc_id  uuid;
  v_today   date;
  v_yest    date;
  v_today_spend bigint;
  v_yest_spend  bigint;
  v_today_sign  int;
  v_yest_sign   int;
  v_today_paid  int;
  v_yest_paid   int;
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;
  IF NOT (p_studio = ANY(v_allowed)) THEN
    RETURN jsonb_build_object('blocked', true);
  END IF;

  v_today := (now() AT TIME ZONE 'America/New_York')::date;
  v_yest  := v_today - 1;

  SELECT l.id INTO v_loc_id
  FROM locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  -- Ad spend — Meta accounts report in ET, date_start is a `date`.
  SELECT COALESCE(SUM(spend_cents), 0) INTO v_today_spend
  FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_today;
  SELECT COALESCE(SUM(spend_cents), 0) INTO v_yest_spend
  FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_yest;

  -- Signups today = trial form fills today (NY-calendar), excluding backfill
  -- rows. Webhook backfills aren't real form fills; they're Stripe-discovered
  -- charges with no corresponding signup event.
  SELECT COUNT(*) INTO v_today_sign
  FROM trial_signups
  WHERE location_id = v_loc_id
    AND (created_at AT TIME ZONE 'America/New_York')::date = v_today
    AND deleted_at IS NULL
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local';

  SELECT COUNT(*) INTO v_yest_sign
  FROM trial_signups
  WHERE location_id = v_loc_id
    AND (created_at AT TIME ZONE 'America/New_York')::date = v_yest
    AND deleted_at IS NULL
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local';

  -- PAID today = trial whose Stripe payment actually happened today (NY).
  -- This was the bug: previously used created_at which counts the row's
  -- insert time (today for any backfill), not when the customer paid.
  SELECT COUNT(*) INTO v_today_paid
  FROM trial_signups
  WHERE location_id = v_loc_id
    AND payment_status = 'completed'
    AND payment_date IS NOT NULL
    AND (payment_date AT TIME ZONE 'America/New_York')::date = v_today
    AND deleted_at IS NULL
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local';

  SELECT COUNT(*) INTO v_yest_paid
  FROM trial_signups
  WHERE location_id = v_loc_id
    AND payment_status = 'completed'
    AND payment_date IS NOT NULL
    AND (payment_date AT TIME ZONE 'America/New_York')::date = v_yest
    AND deleted_at IS NULL
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local';

  RETURN jsonb_build_object(
    'today', jsonb_build_object('spend_cents', v_today_spend, 'signups', v_today_sign, 'paid', v_today_paid),
    'yesterday', jsonb_build_object('spend_cents', v_yest_spend, 'signups', v_yest_sign, 'paid', v_yest_paid)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_pulse(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_pulse(text) TO authenticated;


-- ── 3. Same email-pattern guard to get_trial_journey_v2 ────────────────────
-- Belt-and-suspenders: if a webhook backfill row sneaks past source_category
-- filters, the placeholder email pattern still excludes it.
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
    AND COALESCE(ts.source_category, '') <> 'legacy_archived'
    AND COALESCE(ts.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
    AND (
      COALESCE(ts.payment_date, j.paid_at) IS NULL
      OR COALESCE(ts.payment_date, j.paid_at) >= '2026-05-15'::date
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;

-- After running, expect:
--   SELECT public.get_daily_pulse('williamsburg');
--   → today.paid = 0, today.signups = 0 (or only real today form fills)
