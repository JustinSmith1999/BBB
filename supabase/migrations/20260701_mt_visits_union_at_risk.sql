-- ─────────────────────────────────────────────────────────────────────────────
-- MT visits → trial-start signal for /homebase.
--
-- Problem chain that Justin flagged 2026-07-01:
--   1. mt_app trials paid via the Mariana Tek app were being classified as
--      "Abandoned Checkout / UNVERIFIED" on /homebase.  Client-side fix
--      (frontdesk.html isMtAppTrial helper) now categorises them as paid.
--   2. Once categorised as paid, the /homebase card needs to show ATTENDED
--      and start the 14-day trial-clock when the customer first attends a
--      class. That signal comes from `get_homebase_at_risk` (visit_count,
--      first_visit) and `get_trial_journey_v2` (first_visit_at). Both RPCs
--      currently join through `mindbody_visits` + `mindbody_clients` and
--      match by email — which requires the MT-clients / MT-visits compat
--      shim to be flowing data into `mindbody_*` tables.
--   3. Prod schema audit today shows `mariana_tek_visits` missing from the
--      schema cache and `mariana_tek_clients` empty. So even if the shim
--      trigger exists, there's nothing for it to shadow.
--
-- Fix (this migration):
--   • Idempotently CREATE the MT tables (safety net for prod, matches the
--     definitions in 20260623_mariana_tek_cutover.sql).
--   • Patch get_homebase_at_risk and get_trial_journey_v2 to UNION MB
--     visits (existing email-based path) with MT visits (direct
--     mariana_tek_id → mt_client_id join). No dependency on the shim.
--   • Schedule mariana-tek-visits-sync every 15 minutes via pg_cron so
--     mariana_tek_visits stays fresh once the edge function is deployed.
--
-- After this ships + mariana-tek-visits-sync is deployed:
--   - Batsheva / Janet / Johani / Roman etc will show visit_count > 0 on
--     /homebase within 15 min of their first class
--   - Their 14-day trial clock will start counting from first_visit
--   - front_desk_stage classification (attended, at_risk, etc) works
--     identically for mt_app and mindbody trials
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Idempotent MT table safety nets ──────────────────────────────────────
-- These match the definitions in 20260623_mariana_tek_cutover.sql. If that
-- migration already ran, these are no-ops. If it didn't (as prod schema cache
-- suggests today), the tables get created here so the RPC compiles.

CREATE TABLE IF NOT EXISTS public.mariana_tek_clients (
  mt_id           text PRIMARY KEY,
  studio_slug     text NOT NULL,
  email           text,
  first_name      text,
  last_name       text,
  phone           text,
  dob             date,
  raw             jsonb,
  synced_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mariana_tek_clients_email_idx
  ON public.mariana_tek_clients (lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS mariana_tek_clients_studio_idx
  ON public.mariana_tek_clients (studio_slug);

ALTER TABLE public.mariana_tek_clients ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.mariana_tek_visits (
  mt_visit_id     text PRIMARY KEY,
  studio_slug     text NOT NULL,
  mt_client_id    text,
  mt_class_id     text,
  starts_at       timestamptz,
  signed_in       boolean DEFAULT false,
  status          text,
  raw             jsonb,
  synced_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mariana_tek_visits_client_starts_idx
  ON public.mariana_tek_visits (mt_client_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS mariana_tek_visits_studio_date_idx
  ON public.mariana_tek_visits (studio_slug, starts_at DESC);

ALTER TABLE public.mariana_tek_visits ENABLE ROW LEVEL SECURITY;

-- ── 2. get_homebase_at_risk — UNION MB + MT visits ──────────────────────────
-- Same shape as 20260529_smarter_attended_signal.sql; the LATERAL subquery
-- now unions MB visits (email-joined via mindbody_clients) with MT visits
-- (direct mariana_tek_id → mt_client_id). Filters live inside each branch
-- so we can use the MT `status` field for cancel/no-show detection, since
-- MT doesn't have the boolean late_cancelled / cancelled columns MB does.

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
      count(*)::int      AS cnt,
      min(u.starts_at)   AS first_visit,
      max(u.starts_at)   AS last_visit
    FROM (
      -- ── MindBody visits (existing email-based path) ──────────────────
      SELECT mv.starts_at
        FROM public.mindbody_visits  mv
        JOIN public.mindbody_clients mc ON mc.mindbody_id = mv.mindbody_client_id
       WHERE lower(mc.email) = lower(t.email)
         AND mv.studio_slug  = v_studio_slug
         AND mv.starts_at    >= t.payment_date
         AND mv.starts_at    <= now()
         AND COALESCE(mv.late_cancelled, false) = false
         AND COALESCE(mv.cancelled,      false) = false

      UNION ALL

      -- ── Mariana Tek visits (direct id match, no email dependency) ────
      SELECT mtv.starts_at
        FROM public.mariana_tek_visits mtv
       WHERE t.mariana_tek_id IS NOT NULL
         AND mtv.mt_client_id  = t.mariana_tek_id
         AND mtv.studio_slug   = v_studio_slug
         AND mtv.starts_at     >= t.payment_date
         AND mtv.starts_at     <= now()
         -- MT uses a text status column instead of two booleans. Treat
         -- everything except cancelled / late_cancelled / no_show as attended.
         AND lower(COALESCE(mtv.status, 'reserved')) NOT IN
             ('cancelled', 'canceled', 'late_cancelled', 'late-cancelled', 'no_show', 'no-show', 'missed')
    ) u
  ) v ON TRUE
  WHERE t.location_id     = p_location_id
    AND t.payment_status  = 'completed'
    AND t.payment_date    >= now() - interval '30 days'
    AND lower(trim(t.email)) NOT IN (SELECT lower(s.email) FROM public.dashboard_suppressed_emails s);
END;
$$;

REVOKE ALL ON FUNCTION public.get_homebase_at_risk(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_at_risk(uuid) TO anon, authenticated;

-- ── 3. get_trial_journey_v2 — same UNION for first_visit_at / last_visit_at ─

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

-- ── 4. Schedule mariana-tek-visits-sync every 15 minutes via pg_cron ────────
-- Assumes pg_cron + pg_net are enabled and vault.secrets contains
-- 'service_role_jwt' (same pattern as the other syncs). We unschedule any
-- prior schedule to keep this idempotent.

DO $$
DECLARE
  v_jwt text;
  v_url text := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mariana-tek-visits-sync';
BEGIN
  -- Guard: skip cron setup gracefully if pg_cron or vault aren't installed.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping mariana-tek-visits-sync schedule';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net not installed — skipping mariana-tek-visits-sync schedule';
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_jwt FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_jwt := NULL;
  END;

  IF v_jwt IS NULL THEN
    RAISE NOTICE 'vault.secrets.service_role_jwt not found — skipping schedule (add secret then rerun this block)';
    RETURN;
  END IF;

  -- Unschedule any prior run of this job so we don't stack duplicates.
  PERFORM cron.unschedule(jobid)
    FROM cron.job
   WHERE jobname = 'mariana_tek_visits_sync_15min';

  PERFORM cron.schedule(
    'mariana_tek_visits_sync_15min',
    '*/15 * * * *',
    format($cron$
      SELECT net.http_post(
        url     := %L,
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || %L,
          'Content-Type',  'application/json'
        ),
        body    := jsonb_build_object('lookback_days', 2),
        timeout_milliseconds := 55000
      );
    $cron$, v_url, v_jwt)
  );
END;
$$;

-- Verification queries (paste into SQL editor after applying):
--   -- 1) tables exist
--   SELECT to_regclass('public.mariana_tek_visits') , to_regclass('public.mariana_tek_clients');
--   -- 2) RPCs compile
--   SELECT proname FROM pg_proc WHERE proname IN ('get_homebase_at_risk','get_trial_journey_v2');
--   -- 3) cron scheduled
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'mariana_tek_visits_sync_15min';
--   -- 4) fire the sync manually once so /homebase has data to render:
--   --   curl -X POST https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mariana-tek-visits-sync \
--   --        -H "Authorization: Bearer <anon_or_service>" -d '{"lookback_days": 30}'
--   -- 5) confirm visits landed:
--   SELECT count(*), min(starts_at), max(starts_at) FROM public.mariana_tek_visits;
