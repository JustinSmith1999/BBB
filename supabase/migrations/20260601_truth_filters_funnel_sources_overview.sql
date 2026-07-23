-- ─────────────────────────────────────────────────────────────────────────────
-- Fix the dashboard's truth across three cards that were overcounting paid
-- trials. Same filter set get_launch_kpis uses, applied consistently:
--
--   deleted_at IS NULL
--   source_category <> 'legacy_archived'
--   email NOT LIKE 'backfill-pi_%@no-email.bbb.local'
--   For paid counts: payment_status = 'completed' AND payment_date IS NOT NULL
--                    AND (payment_date AT TIME ZONE 'America/New_York')::date >= 2026-05-15
--
-- Cards affected:
--   1. get_funnel_health    (Trial Funnel · Health card)
--   2. get_studio_overview  (All Studios cross-studio table)
--   3. get_trial_sources    (Lead Sources card)
--
-- Before this fix:
--   Williamsburg funnel showed 25 paid (KPI says 17 — overcount by 8)
--   Astoria      funnel showed 21 paid (KPI says 18)
--   Bayside      funnel showed  8 paid (KPI says  5)
--   Fresh Mead.  funnel showed 18 paid (KPI says 14)
--
-- Caused by missing the legacy/backfill filters and using created_at for the
-- paid count (post-audit, recovered orphans had created_at = recovery time
-- but real payment_date weeks earlier — they ended up counted).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. get_funnel_health — apply launch filters ─────────────────────────────
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
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  RETURN QUERY
  SELECT
    lower(replace(l.name, ' ', '-'))                                AS studio_slug,
    l.name                                                          AS studio_name,
    -- form_fills: anyone who hit submit since launch (created_at floor)
    COUNT(*)::int                                                   AS form_fills,
    -- paid: payment_status=completed AND payment_date since launch
    COUNT(*) FILTER (
      WHERE t.payment_status = 'completed'
        AND t.payment_date IS NOT NULL
        AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
    )::int                                                          AS paid,
    -- abandoned: form filled, no completed payment yet
    COUNT(*) FILTER (
      WHERE t.payment_status = 'pending'
    )::int                                                          AS abandoned,
    CASE WHEN COUNT(*) > 0
      THEN ROUND(
        100.0 * COUNT(*) FILTER (
          WHERE t.payment_status = 'completed'
            AND t.payment_date IS NOT NULL
            AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
        ) / COUNT(*),
      1)
      ELSE 0 END                                                    AS pay_rate_pct
  FROM public.trial_signups t
  JOIN public.locations l ON l.id = t.location_id
  WHERE t.deleted_at IS NULL
    AND COALESCE(t.source_category, '') <> 'legacy_archived'
    AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
    AND (
      (t.created_at AT TIME ZONE 'America/New_York')::date >= p_since
      OR (t.payment_date IS NOT NULL
          AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= p_since)
    )
    AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
    AND lower(replace(l.name, ' ', '-')) = ANY(v_allowed)
  GROUP BY 1, 2
  ORDER BY 2;
END;
$$;

REVOKE ALL ON FUNCTION public.get_funnel_health(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_funnel_health(text, date) TO authenticated;


-- ── 2. get_studio_overview — apply launch filters ──────────────────────────
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
    WHERE m.date_start >= v_anchor
    GROUP BY m.studio_slug
  ),
  signups AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      COUNT(*) FILTER (
        WHERE (t.created_at AT TIME ZONE 'America/New_York')::date >= v_anchor
           OR (t.payment_date IS NOT NULL
               AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor)
      )::bigint                                                    AS trial_signups,
      COUNT(*) FILTER (
        WHERE t.payment_status = 'completed'
          AND t.payment_date IS NOT NULL
          AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor
      )::bigint                                                    AS paid_trials
    FROM trial_signups t
    JOIN locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
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


-- ── 3. get_trial_sources — recreate so it uses launch filters ──────────────
-- Existing function lives only as a deployed runtime object (not in any
-- migration). Drop first because the existing return-type shape differs
-- from ours (Postgres error 42P13 otherwise). Then recreate with the right
-- filters. Returns per-source counts of leads + paid for the studio's
-- launch window.
DROP FUNCTION IF EXISTS public.get_trial_sources(text);

CREATE OR REPLACE FUNCTION public.get_trial_sources(p_studio text DEFAULT NULL)
RETURNS TABLE(
  source    text,
  signups   bigint,
  paid      bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_anchor date := '2026-05-15'::date;
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(NULLIF(t.utm_source, ''), 'Direct / untagged')        AS source,
    COUNT(*)::bigint                                                AS signups,
    COUNT(*) FILTER (
      WHERE t.payment_status = 'completed'
        AND t.payment_date IS NOT NULL
        AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor
    )::bigint                                                       AS paid
  FROM trial_signups t
  JOIN locations l ON l.id = t.location_id
  WHERE t.deleted_at IS NULL
    AND COALESCE(t.source_category, '') <> 'legacy_archived'
    AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
    AND (
      (t.created_at AT TIME ZONE 'America/New_York')::date >= v_anchor
      OR (t.payment_date IS NOT NULL
          AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor)
    )
    AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
  GROUP BY 1
  ORDER BY signups DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_trial_sources(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_sources(text) TO authenticated;

-- Sanity (run after):
--   SELECT * FROM get_funnel_health();         -- per-studio paid should match get_launch_kpis
--   SELECT * FROM get_studio_overview();       -- same
--   SELECT * FROM get_trial_sources('bayside'); -- sum(paid) per source ≤ 5
