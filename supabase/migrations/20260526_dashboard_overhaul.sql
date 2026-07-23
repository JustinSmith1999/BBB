-- ─────────────────────────────────────────────────────────────────────────────
-- Dashboard overhaul (May 26 2026) — supports the rewritten owner dashboard.
-- Run in the Supabase SQL editor. Idempotent.
--
--   1. Patch get_meta_ad_creatives so Bayside (and any studio whose 7d
--      window has no insights yet) still shows its ACTIVE ads instead
--      of going completely blank.
--   2. get_studio_overview()   — one row per studio for the cross-studio view.
--   3. get_meta_daily_trend()  — daily spend + conversions for the 14d chart.
--   4. get_daily_pulse()       — yesterday vs today numbers for the top strip.
--   5. Schedule mindbody-visits-sync @hourly via pg_cron (kills the stale-visits
--      → "haven't booked" false positives).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Schema sanity — make sure all meta_ads columns the function references
-- actually exist. The earlier media/preview migrations were applied piecemeal
-- in prod; doing the ALTERs here guarantees the CREATE FUNCTION below compiles.
ALTER TABLE public.meta_ads ADD COLUMN IF NOT EXISTS media_type   text;
ALTER TABLE public.meta_ads ADD COLUMN IF NOT EXISTS video_url    text;
ALTER TABLE public.meta_ads ADD COLUMN IF NOT EXISTS preview_url  text;

-- ── 1. get_meta_ad_creatives — LEFT JOIN + active-ads fallback ──────────────
-- Old version did an INNER JOIN to insights + filtered impressions>0, which
-- left Bayside blank whenever its current ACTIVE ad rolled into the window
-- without delivered impressions yet. New version returns the ad even with
-- zero in-window insights as long as it's flagged ACTIVE in meta_ads.
--
-- Return shape is unchanged from 20260523_meta_ad_preview.sql (keeps
-- media_type / video_url / preview_url that the dashboard's iframe needs).
-- DROP first because Postgres won't CREATE OR REPLACE when the return type
-- is "changing" (even when it isn't — column-order checks are strict).
DROP FUNCTION IF EXISTS public.get_meta_ad_creatives(text);

CREATE FUNCTION public.get_meta_ad_creatives(p_window text DEFAULT 'last_30'::text)
RETURNS TABLE(
  ad_id text, studio_slug text, studio_name text, ad_name text,
  campaign_name text, status text, image_url text, thumbnail_url text,
  headline text, body text, media_type text, video_url text, preview_url text,
  spend_cents bigint, impressions bigint, clicks bigint, reach bigint,
  leads bigint, purchases bigint, ctr numeric, cpm_cents bigint,
  -- NEW: Stripe-confirmed paid trials attributed to this ad.
  -- trials_direct  = paid trials whose utm_content explicitly references the ad
  --                  (requires Justin to set ad-level utm_content={{ad.id}} once
  --                  in Ads Manager — see footer of dashboard for instructions).
  -- trials_estimate = pro-rata share of the studio's total paid trials, weighted
  --                  by this ad's share of the studio's total spend. Shown when
  --                  trials_direct is 0, so the column is never an empty zero.
  trials_direct   integer,
  trials_estimate integer,
  last_synced timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed text[];
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  RETURN QUERY
  WITH bounds AS (
    SELECT GREATEST(
      CASE p_window
        WHEN 'today'    THEN CURRENT_DATE
        WHEN 'last_7'   THEN CURRENT_DATE - 7
        WHEN 'last_30'  THEN CURRENT_DATE - 30
        WHEN 'last_90'  THEN CURRENT_DATE - 90
        WHEN 'lifetime' THEN '2024-01-01'::date
        ELSE CURRENT_DATE - 30
      END,
      '2026-05-15'::date
    ) AS start_date
  ),
  agg AS (
    SELECT
      d.ad_id,
      SUM(d.spend_cents)::bigint AS spend_cents,
      SUM(d.impressions)::bigint AS impressions,
      SUM(d.clicks)::bigint      AS clicks,
      SUM(d.reach)::bigint       AS reach,
      SUM(d.leads)::bigint       AS leads,
      SUM(d.purchases)::bigint   AS purchases,
      MAX(d.synced_at)           AS last_synced
    FROM meta_ad_insights_daily d, bounds
    WHERE d.date_start >= bounds.start_date
    GROUP BY d.ad_id
  ),
  -- ── Per-studio totals so we can pro-rate paid trials across ads ──────
  studio_paid AS (
    SELECT lower(replace(l.name, ' ', '-')) AS studio_slug,
           COUNT(*) FILTER (WHERE t.payment_status = 'completed') AS paid_trials
    FROM trial_signups t
    JOIN locations l ON l.id = t.location_id
    WHERE t.created_at >= '2026-05-15'::date
    GROUP BY 1
  ),
  studio_spend AS (
    SELECT a.studio_slug, SUM(COALESCE(g.spend_cents, 0))::bigint AS spend_cents
    FROM meta_ads a
    LEFT JOIN agg g ON g.ad_id = a.ad_id
    GROUP BY a.studio_slug
  ),
  -- ── Direct attribution: paid trials whose utm_content matches an ad. ──
  -- Requires Justin to set utm_content={{ad.id}} (or any other unique-per-ad
  -- token) in Meta Ads Manager. Until then, counts are 0 and we fall back
  -- to the spend-share estimate.
  trials_per_ad AS (
    SELECT a.ad_id,
           COUNT(*) FILTER (WHERE t.payment_status = 'completed')::int AS paid_trials
    FROM meta_ads a
    LEFT JOIN trial_signups t
      ON t.utm_content IS NOT NULL
     AND (
       t.utm_content = a.ad_id
       OR t.utm_content ILIKE '%' || a.ad_id || '%'
       OR (a.ad_name IS NOT NULL AND t.utm_content ILIKE '%' || a.ad_name || '%')
     )
     AND t.created_at >= '2026-05-15'::date
    GROUP BY a.ad_id
  )
  SELECT
    a.ad_id,
    a.studio_slug,
    s.name,
    a.ad_name,
    a.campaign_name,
    a.status,
    a.image_url,
    a.thumbnail_url,
    a.headline,
    a.body,
    COALESCE(a.media_type, 'image'),
    a.video_url,
    a.preview_url,
    COALESCE(agg.spend_cents, 0),
    COALESCE(agg.impressions, 0),
    COALESCE(agg.clicks, 0),
    COALESCE(agg.reach, 0),
    COALESCE(agg.leads, 0),
    COALESCE(agg.purchases, 0),
    CASE WHEN COALESCE(agg.impressions, 0) > 0
      THEN ROUND(100.0 * agg.clicks / agg.impressions, 2) ELSE 0 END,
    CASE WHEN COALESCE(agg.impressions, 0) > 0
      THEN ROUND(agg.spend_cents::numeric / agg.impressions * 1000)::bigint ELSE 0 END,
    COALESCE(tpa.paid_trials, 0) AS trials_direct,
    -- Spend-share estimate: this ad's share of studio spend × studio paid trials.
    -- Rounded; zero if studio has no spend yet.
    CASE WHEN COALESCE(ss.spend_cents, 0) > 0 AND COALESCE(sp.paid_trials, 0) > 0
      THEN ROUND(
        (COALESCE(agg.spend_cents, 0)::numeric / ss.spend_cents) * sp.paid_trials
      )::int
      ELSE 0 END AS trials_estimate,
    COALESCE(agg.last_synced, a.updated_at)
  FROM meta_ads a
  LEFT JOIN studios       s   ON s.slug         = a.studio_slug
  LEFT JOIN agg           agg ON agg.ad_id      = a.ad_id
  LEFT JOIN studio_paid   sp  ON sp.studio_slug = a.studio_slug
  LEFT JOIN studio_spend  ss  ON ss.studio_slug = a.studio_slug
  LEFT JOIN trials_per_ad tpa ON tpa.ad_id      = a.ad_id
  WHERE a.studio_slug = ANY(v_allowed)
    AND (COALESCE(agg.impressions, 0) > 0 OR UPPER(COALESCE(a.status, '')) = 'ACTIVE')
  ORDER BY a.studio_slug,
           UPPER(COALESCE(a.status, '')) = 'ACTIVE' DESC,
           COALESCE(agg.spend_cents, 0) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_meta_ad_creatives(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_ad_creatives(text) TO authenticated;


-- ── 2. get_studio_overview — one row per studio, for the All-Studios view ───
-- Feeds the cross-studio comparison table at the top of the dashboard.
-- Numbers are May-15-launch-forward to keep parity with get_launch_kpis.
CREATE OR REPLACE FUNCTION public.get_studio_overview()
RETURNS TABLE(
  studio_slug    text,
  studio_name    text,
  spend_cents    bigint,
  impressions    bigint,
  clicks         bigint,
  trial_signups  bigint,
  paid_trials    bigint,
  conv_pct       numeric,
  cost_per_paid_cents bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed text[];
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  RETURN QUERY
  WITH meta AS (
    SELECT
      m.studio_slug,
      SUM(m.spend_cents)::bigint AS spend_cents,
      SUM(m.impressions)::bigint AS impressions,
      SUM(m.clicks)::bigint      AS clicks
    FROM meta_insights_daily m
    WHERE m.date_start >= '2026-05-15'::date
    GROUP BY m.studio_slug
  ),
  signups AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      COUNT(*)                                                  AS trial_signups,
      COUNT(*) FILTER (WHERE t.payment_status = 'completed')    AS paid_trials
    FROM trial_signups t
    JOIN locations l ON l.id = t.location_id
    WHERE t.created_at >= '2026-05-15'::date
    GROUP BY 1
  )
  SELECT
    s.slug,
    s.name,
    COALESCE(meta.spend_cents, 0)            AS spend_cents,
    COALESCE(meta.impressions, 0)            AS impressions,
    COALESCE(meta.clicks, 0)                 AS clicks,
    COALESCE(signups.trial_signups, 0)       AS trial_signups,
    COALESCE(signups.paid_trials, 0)         AS paid_trials,
    CASE WHEN COALESCE(signups.trial_signups, 0) > 0
      THEN ROUND(100.0 * signups.paid_trials / signups.trial_signups, 1)
      ELSE 0 END                             AS conv_pct,
    CASE WHEN COALESCE(signups.paid_trials, 0) > 0
      THEN ROUND(COALESCE(meta.spend_cents, 0)::numeric / signups.paid_trials)::bigint
      ELSE 0 END                             AS cost_per_paid_cents
  FROM studios s
  LEFT JOIN meta    ON meta.studio_slug    = s.slug
  LEFT JOIN signups ON signups.studio_slug = s.slug
  WHERE s.slug = ANY(v_allowed)
  ORDER BY s.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_studio_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_studio_overview() TO authenticated;


-- ── 3. get_meta_daily_trend — feeds the 14-day trend chart ──────────────────
CREATE OR REPLACE FUNCTION public.get_meta_daily_trend(p_studio text, p_days int DEFAULT 14)
RETURNS TABLE(
  day             date,
  spend_cents     bigint,
  impressions     bigint,
  clicks          bigint,
  trial_signups   bigint,
  paid_trials     bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed text[];
  v_loc_id  uuid;
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  IF NOT (p_studio = ANY(v_allowed)) THEN
    RETURN;
  END IF;

  SELECT l.id INTO v_loc_id
  FROM locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  RETURN QUERY
  WITH cal AS (
    SELECT generate_series(
      GREATEST(CURRENT_DATE - (p_days - 1), '2026-05-15'::date),
      CURRENT_DATE,
      '1 day'::interval
    )::date AS day
  ),
  meta AS (
    SELECT m.date_start::date AS day,
           SUM(m.spend_cents)::bigint AS spend_cents,
           SUM(m.impressions)::bigint AS impressions,
           SUM(m.clicks)::bigint      AS clicks
    FROM meta_insights_daily m
    WHERE m.studio_slug = p_studio
      AND m.date_start >= CURRENT_DATE - (p_days - 1)
    GROUP BY 1
  ),
  signs AS (
    SELECT t.created_at::date AS day,
           COUNT(*) FILTER (WHERE TRUE) AS trial_signups,
           COUNT(*) FILTER (WHERE t.payment_status = 'completed') AS paid_trials
    FROM trial_signups t
    WHERE t.location_id = v_loc_id
      AND t.created_at >= CURRENT_DATE - (p_days - 1)
    GROUP BY 1
  )
  SELECT
    cal.day,
    COALESCE(meta.spend_cents,   0) AS spend_cents,
    COALESCE(meta.impressions,   0) AS impressions,
    COALESCE(meta.clicks,        0) AS clicks,
    COALESCE(signs.trial_signups,0) AS trial_signups,
    COALESCE(signs.paid_trials,  0) AS paid_trials
  FROM cal
  LEFT JOIN meta  ON meta.day  = cal.day
  LEFT JOIN signs ON signs.day = cal.day
  ORDER BY cal.day;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_meta_daily_trend(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_daily_trend(text, int) TO authenticated;


-- ── 4. get_daily_pulse — yesterday & today numbers for the top strip ────────
CREATE OR REPLACE FUNCTION public.get_daily_pulse(p_studio text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed text[];
  v_loc_id  uuid;
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

  SELECT l.id INTO v_loc_id
  FROM locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  SELECT COALESCE(SUM(spend_cents), 0) INTO v_today_spend
  FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = CURRENT_DATE;
  SELECT COALESCE(SUM(spend_cents), 0) INTO v_yest_spend
  FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = CURRENT_DATE - 1;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE payment_status = 'completed')
  INTO v_today_sign, v_today_paid
  FROM trial_signups WHERE location_id = v_loc_id AND created_at::date = CURRENT_DATE;
  SELECT COUNT(*), COUNT(*) FILTER (WHERE payment_status = 'completed')
  INTO v_yest_sign, v_yest_paid
  FROM trial_signups WHERE location_id = v_loc_id AND created_at::date = CURRENT_DATE - 1;

  RETURN jsonb_build_object(
    'today', jsonb_build_object('spend_cents', v_today_spend, 'signups', v_today_sign, 'paid', v_today_paid),
    'yesterday', jsonb_build_object('spend_cents', v_yest_spend, 'signups', v_yest_sign, 'paid', v_yest_paid)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_pulse(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_pulse(text) TO authenticated;


-- ── 4b. get_trial_journey_v2 — wraps existing RPC + front-desk fields ──────
-- The original get_trial_journey returns visit_count from MindBody check-ins
-- only. But the front desk uses /homebase to move people through stages
-- (new_lead → contacted → booked → attended → member) and write notes when
-- they book classes by phone. Without those fields the owner dashboard
-- incorrectly shows "haven't booked" for customers who were booked by staff
-- but never matched in MindBody (the email-bridge bug).
--
-- This wrapper just JOINs the existing RPC output with the three front_desk
-- columns on trial_signups. The dashboard then treats front_desk_stage in
-- ('booked','attended','member') as authoritative — overrides the badge.
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
  -- Front-desk Kanban
  front_desk_stage      text,
  front_desk_note       text,
  front_desk_updated_at timestamptz,
  -- Attribution: which marketing link / ad drove this signup
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
    ts.utm_source,
    ts.utm_medium,
    ts.utm_campaign,
    ts.utm_content
  FROM public.get_trial_journey(p_studio, p_limit) j
  LEFT JOIN public.trial_signups ts ON ts.id = j.trial_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_journey_v2(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_journey_v2(text, int) TO authenticated;


-- ── 5. Schedule mindbody-visits-sync hourly via pg_cron ─────────────────────
-- Kills the stale-visits → "haven't booked" false positive across all studios.
-- We schedule with a 2-day lookback so any late check-ins get caught.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Drop any previous schedule with the same name (so this migration can re-run).
DO $$
BEGIN
  PERFORM cron.unschedule('mindbody-visits-sync-hourly');
EXCEPTION WHEN OTHERS THEN
  -- job didn't exist yet; ignore
  NULL;
END$$;

-- Note: pg_cron jobs run as the postgres role. We use pg_net's http_post
-- helper to hit our own edge function. The service-role JWT is read from
-- a previously-set secret in vault. If the vault entry isn't present, this
-- silently no-ops — Justin can add it via:
--   INSERT INTO vault.secrets (name, secret) VALUES
--     ('service_role_jwt', '<the JWT>') ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;
SELECT cron.schedule(
  'mindbody-visits-sync-hourly',
  '7 * * * *',  -- top of each hour + 7 minutes (avoid clashing with meta sync)
  $cron$
    SELECT net.http_post(
      url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-visits-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || COALESCE(
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1),
          ''
        )
      ),
      body := jsonb_build_object('lookback_days', 2, 'concurrency', 5)
    );
  $cron$
);

-- Sanity:
--   SELECT * FROM cron.job WHERE jobname = 'mindbody-visits-sync-hourly';
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
