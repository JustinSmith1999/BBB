-- 2026-07-07 · Fix: /homebase lead cards show "Source category —" even when the
-- trial_signups row IS tagged (e.g. Michele Pacheco = trial_form). Root cause:
-- get_trial_journey_v2 returned utm_source/utm_campaign but never source_category,
-- so the dashboard card (index.html trialJourneyCard → r.source_category) always
-- rendered "—". The frontend already reads r.source_category; we only need the
-- RPC to return it. Verbatim copy of the 2026-07-01 definition with a single
-- added column: source_category (RETURNS TABLE + SELECT), nothing else changed.
--
-- Run: paste into the Supabase SQL editor and Run. (No frontend deploy needed —
-- just reload /homebase after this applies.)

-- ── Part A: backfill the 11 rows that never got a source_category ────────────
-- Derived from signals already on the row (utm=facebook/instagram ⇒ paid ad,
-- trial-form-* ⇒ trial_form, etc). Only touches rows where it's NULL, so it's
-- safe to re-run and can't overwrite an existing tag.
UPDATE public.trial_signups
SET source_category = CASE
  WHEN lower(coalesce(utm_source,'')) IN ('facebook','fb','instagram','ig','meta','paid') THEN 'ad'
  WHEN lower(coalesce(lead_source,'')) LIKE 'trial-form%'                                  THEN 'trial_form'
  WHEN lower(coalesce(lead_source,'')) LIKE '%contact%'                                    THEN 'contact_form'
  WHEN lower(coalesce(lead_source,'')) LIKE '%schedule%'                                   THEN 'schedule_request'
  WHEN mindbody_id IS NOT NULL                                                             THEN 'mb_direct'
  WHEN stripe_session_id IS NOT NULL                                                       THEN 'stripe_checkout'
  ELSE 'web_organic'
END
WHERE source_category IS NULL
  AND deleted_at IS NULL;

-- ── Part B: teach get_trial_journey_v2 to return source_category ─────────────
DROP FUNCTION IF EXISTS public.get_trial_journey_v2(text, int);

CREATE FUNCTION public.get_trial_journey_v2(p_studio text, p_limit int DEFAULT 200)
RETURNS TABLE(
  trial_id                uuid,
  name                    text,
  email                   text,
  phone                   text,
  studio_slug             text,
  studio_name             text,
  stage                   text,
  stage_label             text,
  stage_color             text,
  created_at              timestamptz,
  paid_at                 timestamptz,
  welcome_sms_sent_at     timestamptz,
  welcome_sms_status      text,
  visit_count             integer,
  convert_sms_sent_at     timestamptz,
  convert_replied_yes_at  timestamptz,
  abandoned_email_sent_at timestamptz,
  opted_out_at            timestamptz,
  last_activity_at        timestamptz,
  days_since_signup       integer,
  front_desk_stage        text,
  front_desk_note         text,
  front_desk_updated_at   timestamptz,
  utm_source              text,
  utm_medium              text,
  utm_campaign            text,
  utm_content             text,
  source_category         text,      -- ← added 2026-07-07
  first_visit_at          timestamptz,
  last_visit_at           timestamptz
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
    ts.source_category,                 -- ← added 2026-07-07
    v.first_visit_at,
    v.last_visit_at
  FROM public.get_trial_journey(p_studio, p_limit) j
  LEFT JOIN public.trial_signups ts ON ts.id = j.trial_id
  LEFT JOIN LATERAL (
    SELECT
      min(u.starts_at) AS first_visit_at,
      max(u.starts_at) AS last_visit_at
    FROM (
      -- MindBody visits (email path)
      SELECT mv.starts_at
        FROM public.mindbody_visits  mv
        JOIN public.mindbody_clients mc ON mc.mindbody_id = mv.mindbody_client_id
       WHERE lower(mc.email) = lower(ts.email)
         AND mv.studio_slug  = v_studio_slug
         AND mv.starts_at    <= now()
         AND (ts.payment_date IS NULL OR mv.starts_at >= ts.payment_date)
         AND COALESCE(mv.late_cancelled, false) = false
         AND COALESCE(mv.cancelled,      false) = false

      UNION ALL

      -- Mariana Tek visits (id path)
      SELECT mtv.starts_at
        FROM public.mariana_tek_visits mtv
       WHERE ts.mariana_tek_id IS NOT NULL
         AND mtv.mt_client_id  = ts.mariana_tek_id
         AND mtv.studio_slug   = v_studio_slug
         AND mtv.starts_at     <= now()
         AND (ts.payment_date IS NULL OR mtv.starts_at >= ts.payment_date)
         AND lower(COALESCE(mtv.status, 'reserved')) NOT IN
             ('cancelled', 'canceled', 'late_cancelled', 'late-cancelled', 'no_show', 'no-show', 'missed')
    ) u
  ) v ON TRUE
  WHERE lower(trim(j.email)) NOT IN (SELECT lower(s.email) FROM public.dashboard_suppressed_emails s);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;
