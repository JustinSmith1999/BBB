-- ─────────────────────────────────────────────────────────────────────────────
-- Rewire every "paid trials" count in the dashboard to read from
-- stripe_paid_mirror (the Stripe SSOT) instead of counting trial_signups.
--
-- Every count is computed identically by count_paid_canonical(studio, since,
-- until). trial_signups still drives form_fills, abandoned, and trial-pipeline
-- views (because those are about people who interacted with US, not Stripe).
--
-- After this lands, every paid count on the dashboard matches Stripe to the
-- row. trial_signups can drift (webhook miss, audit lag) and the dashboard
-- will still tell the truth, because the dashboard no longer reads paid
-- counts from trial_signups at all.
--
-- Run AFTER 20260601_stripe_paid_mirror_SSOT.sql AND after the first sync.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. get_launch_kpis — paid = canonical, leads stay from trial_signups ───
CREATE OR REPLACE FUNCTION public.get_launch_kpis(p_studio text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_anchor       date    := '2026-05-15'::date;
  v_loc_id       uuid;
  v_spend_cents  bigint  := 0;
  v_impressions  bigint  := 0;
  v_clicks       bigint  := 0;
  v_meta_leads   bigint  := 0;
  v_trial_sign   int     := 0;
  v_paid_trials  int     := 0;
  v_conv_pct     numeric := 0;
BEGIN
  SELECT l.id INTO v_loc_id FROM public.locations l
   WHERE lower(replace(l.name, ' ', '-')) = p_studio LIMIT 1;

  SELECT
    COALESCE(SUM(spend_cents), 0),
    COALESCE(SUM(impressions), 0),
    COALESCE(SUM(clicks), 0),
    COALESCE(SUM(leads), 0)
  INTO v_spend_cents, v_impressions, v_clicks, v_meta_leads
  FROM public.meta_insights_daily
  WHERE studio_slug = p_studio AND date_start >= v_anchor;

  -- LEADS (form fills) — still from trial_signups, with our filter set
  SELECT COUNT(*) INTO v_trial_sign FROM public.trial_signups
   WHERE location_id = v_loc_id
     AND deleted_at IS NULL
     AND COALESCE(source_category, '') <> 'legacy_archived'
     AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
     AND (
       (created_at AT TIME ZONE 'America/New_York')::date >= v_anchor
       OR (payment_date IS NOT NULL AND (payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor)
     );

  -- PAID — Stripe SSOT
  v_paid_trials := public.count_paid_canonical(p_studio, v_anchor, NULL)::int;

  IF v_trial_sign > 0 THEN
    v_conv_pct := ROUND(100.0 * v_paid_trials / v_trial_sign, 1);
  END IF;

  RETURN jsonb_build_object(
    'anchor_date',   v_anchor,
    'spend_cents',   v_spend_cents,
    'impressions',   v_impressions,
    'clicks',        v_clicks,
    'leads',         v_meta_leads,
    'trial_signups', v_trial_sign,
    'paid_trials',   v_paid_trials,
    'conv_pct',      v_conv_pct,
    'truth_source',  'stripe_paid_mirror'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_launch_kpis(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_launch_kpis(text) TO authenticated;


-- ── 2. get_funnel_health — paid from Stripe SSOT ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_funnel_health(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date
)
RETURNS TABLE(
  studio_slug      text,
  studio_name      text,
  form_fills       int,
  paid             int,
  abandoned        int,
  pay_rate_pct     numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_allowed text[];
BEGIN
  BEGIN v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  RETURN QUERY
  WITH fills AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      l.name                            AS studio_name,
      COUNT(*)::int                     AS form_fills,
      COUNT(*) FILTER (WHERE t.payment_status = 'pending')::int AS abandoned
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (
        (t.created_at AT TIME ZONE 'America/New_York')::date >= p_since
        OR (t.payment_date IS NOT NULL AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= p_since)
      )
      AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
      AND lower(replace(l.name, ' ', '-')) = ANY(v_allowed)
    GROUP BY 1, 2
  )
  SELECT
    f.studio_slug,
    f.studio_name,
    f.form_fills,
    public.count_paid_canonical(f.studio_slug, p_since, NULL)::int AS paid,
    f.abandoned,
    CASE WHEN f.form_fills > 0
      THEN ROUND(100.0 * public.count_paid_canonical(f.studio_slug, p_since, NULL) / f.form_fills, 1)
      ELSE 0 END AS pay_rate_pct
  FROM fills f
  ORDER BY f.studio_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_funnel_health(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_funnel_health(text, date) TO authenticated;


-- ── 3. get_studio_overview — paid from Stripe SSOT ─────────────────────────
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
  v_anchor  date := '2026-05-15'::date;
BEGIN
  BEGIN v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  RETURN QUERY
  WITH meta AS (
    SELECT m.studio_slug,
      SUM(m.spend_cents)::bigint AS spend_cents,
      SUM(m.impressions)::bigint AS impressions,
      SUM(m.clicks)::bigint      AS clicks
    FROM meta_insights_daily m
    WHERE m.date_start >= v_anchor GROUP BY m.studio_slug
  ),
  fills AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      COUNT(*)::bigint AS trial_signups
    FROM trial_signups t JOIN locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (
        (t.created_at AT TIME ZONE 'America/New_York')::date >= v_anchor
        OR (t.payment_date IS NOT NULL AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor)
      )
    GROUP BY 1
  )
  SELECT
    s.slug,
    s.name,
    COALESCE(meta.spend_cents, 0),
    COALESCE(meta.impressions, 0),
    COALESCE(meta.clicks, 0),
    COALESCE(fills.trial_signups, 0),
    public.count_paid_canonical(s.slug, v_anchor, NULL) AS paid_trials,
    CASE WHEN COALESCE(fills.trial_signups, 0) > 0
      THEN ROUND(100.0 * public.count_paid_canonical(s.slug, v_anchor, NULL) / fills.trial_signups, 1)
      ELSE 0 END,
    CASE WHEN public.count_paid_canonical(s.slug, v_anchor, NULL) > 0
      THEN ROUND(COALESCE(meta.spend_cents, 0)::numeric / public.count_paid_canonical(s.slug, v_anchor, NULL))::bigint
      ELSE 0 END
  FROM studios s
  LEFT JOIN meta  ON meta.studio_slug  = s.slug
  LEFT JOIN fills ON fills.studio_slug = s.slug
  WHERE s.slug = ANY(v_allowed)
  ORDER BY s.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_studio_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_studio_overview() TO authenticated;


-- ── 4. get_meta_daily_trend — paid from Stripe SSOT per-day ────────────────
DROP FUNCTION IF EXISTS public.get_meta_daily_trend(text, int);

CREATE FUNCTION public.get_meta_daily_trend(p_studio text, p_days int DEFAULT 14)
RETURNS TABLE(
  day           date,
  spend_cents   bigint,
  impressions   bigint,
  clicks        bigint,
  trial_signups int,
  paid_trials   int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_loc_id  uuid;
  v_today   date;
  v_start   date;
BEGIN
  v_today := (now() AT TIME ZONE 'America/New_York')::date;
  v_start := GREATEST(v_today - (p_days - 1), '2026-05-15'::date);

  SELECT l.id INTO v_loc_id FROM locations l
   WHERE lower(replace(l.name, ' ', '-')) = p_studio LIMIT 1;

  RETURN QUERY
  WITH cal AS (
    SELECT generate_series(v_start, v_today, '1 day'::interval)::date AS day
  ),
  meta AS (
    SELECT m.date_start AS day,
      SUM(m.spend_cents)::bigint AS spend_cents,
      SUM(m.impressions)::bigint AS impressions,
      SUM(m.clicks)::bigint      AS clicks
    FROM meta_insights_daily m
    WHERE m.studio_slug = p_studio AND m.date_start >= v_start GROUP BY 1
  ),
  fills AS (
    SELECT (t.created_at AT TIME ZONE 'America/New_York')::date AS day,
      COUNT(*)::int AS trial_signups
    FROM trial_signups t
    WHERE t.location_id = v_loc_id
      AND t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (t.created_at AT TIME ZONE 'America/New_York')::date >= v_start
    GROUP BY 1
  ),
  -- PAID PER DAY FROM STRIPE SSOT
  paid AS (
    SELECT (m.paid_at AT TIME ZONE 'America/New_York')::date AS day,
      COUNT(*)::int AS paid_trials
    FROM stripe_paid_mirror m
    WHERE m.studio_slug = p_studio
      AND (m.paid_at AT TIME ZONE 'America/New_York')::date >= v_start
    GROUP BY 1
  )
  SELECT
    cal.day,
    COALESCE(meta.spend_cents, 0),
    COALESCE(meta.impressions, 0),
    COALESCE(meta.clicks, 0),
    COALESCE(fills.trial_signups, 0),
    COALESCE(paid.paid_trials, 0)
  FROM cal
  LEFT JOIN meta  USING (day)
  LEFT JOIN fills USING (day)
  LEFT JOIN paid  USING (day)
  ORDER BY cal.day;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_meta_daily_trend(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_daily_trend(text, int) TO authenticated;


-- ── 5. get_daily_pulse — paid for today/yesterday from Stripe SSOT ─────────
CREATE OR REPLACE FUNCTION public.get_daily_pulse(p_studio text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today        date;
  v_yest         date;
  v_loc_id       uuid;
  v_today_spend  bigint := 0;
  v_yest_spend   bigint := 0;
  v_today_sign   int    := 0;
  v_yest_sign    int    := 0;
  v_today_paid   int    := 0;
  v_yest_paid    int    := 0;
BEGIN
  v_today := (now() AT TIME ZONE 'America/New_York')::date;
  v_yest  := v_today - 1;

  SELECT l.id INTO v_loc_id FROM locations l
   WHERE lower(replace(l.name, ' ', '-')) = p_studio LIMIT 1;

  SELECT COALESCE(SUM(spend_cents),0) INTO v_today_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_today;
  SELECT COALESCE(SUM(spend_cents),0) INTO v_yest_spend
    FROM meta_insights_daily WHERE studio_slug = p_studio AND date_start = v_yest;

  SELECT COUNT(*) INTO v_today_sign FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND COALESCE(source_category,'') <> 'legacy_archived'
      AND COALESCE(email,'') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (created_at AT TIME ZONE 'America/New_York')::date = v_today;
  SELECT COUNT(*) INTO v_yest_sign FROM trial_signups
    WHERE location_id = v_loc_id AND deleted_at IS NULL
      AND COALESCE(source_category,'') <> 'legacy_archived'
      AND COALESCE(email,'') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (created_at AT TIME ZONE 'America/New_York')::date = v_yest;

  -- PAID FROM STRIPE SSOT
  v_today_paid := public.count_paid_canonical(p_studio, v_today, v_today)::int;
  v_yest_paid  := public.count_paid_canonical(p_studio, v_yest,  v_yest)::int;

  RETURN jsonb_build_object(
    'today',     jsonb_build_object('spend_cents', v_today_spend, 'signups', v_today_sign, 'paid', v_today_paid),
    'yesterday', jsonb_build_object('spend_cents', v_yest_spend,  'signups', v_yest_sign,  'paid', v_yest_paid),
    'truth_source', 'stripe_paid_mirror'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_pulse(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_pulse(text) TO authenticated;


-- ── 6. get_trial_sources — paid from Stripe SSOT (joined by email) ─────────
-- Sources are tagged on trial_signups (utm_source). Join to mirror by email
-- so the source's "paid" column equals the number of Stripe-paid customers
-- who came from that source.
DROP FUNCTION IF EXISTS public.get_trial_sources(text);

CREATE FUNCTION public.get_trial_sources(p_studio text DEFAULT NULL)
RETURNS TABLE(source text, signups bigint, paid bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_anchor date := '2026-05-15'::date;
BEGIN
  RETURN QUERY
  WITH studio_signups AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      lower(t.email)                    AS email_norm,
      COALESCE(NULLIF(t.utm_source, ''), 'Direct / untagged') AS source
    FROM trial_signups t
    JOIN locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (
        (t.created_at AT TIME ZONE 'America/New_York')::date >= v_anchor
        OR (t.payment_date IS NOT NULL AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor)
      )
      AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
  ),
  paid_emails AS (
    SELECT studio_slug, lower(customer_email) AS email_norm
    FROM stripe_paid_mirror
    WHERE (paid_at AT TIME ZONE 'America/New_York')::date >= v_anchor
      AND (p_studio IS NULL OR studio_slug = p_studio)
      AND customer_email IS NOT NULL
  )
  SELECT
    s.source,
    COUNT(DISTINCT s.email_norm || '|' || s.studio_slug)::bigint AS signups,
    COUNT(DISTINCT CASE
      WHEN EXISTS (SELECT 1 FROM paid_emails p
                    WHERE p.email_norm = s.email_norm AND p.studio_slug = s.studio_slug)
      THEN s.email_norm || '|' || s.studio_slug
    END)::bigint AS paid
  FROM studio_signups s
  GROUP BY 1
  ORDER BY signups DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_sources(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_sources(text) TO authenticated;

-- Final sanity — after sync runs once, every paid count is identical:
--   SELECT count_paid_canonical(s.slug) AS canonical,
--          (get_launch_kpis(s.slug)->>'paid_trials')::int AS launch,
--          (SELECT paid FROM get_funnel_health(s.slug)) AS funnel,
--          (SELECT paid_trials FROM get_studio_overview() WHERE studio_slug = s.slug) AS overview
--     FROM (VALUES('williamsburg'),('astoria'),('bayside'),('fresh-meadows')) AS s(slug);
