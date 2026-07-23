-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · $29 Comeback Offer dashboard tile data.
--
-- One RPC for the per-studio overview tile + one RPC for the recent-sends
-- list so the dashboard can show: how many SMS fired, how many clicked the
-- link, how many converted ($29 paid), revenue collected.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_comeback_overview();
CREATE OR REPLACE FUNCTION public.get_comeback_overview()
RETURNS TABLE(
  studio_slug   TEXT,
  studio_name   TEXT,
  sms_sent_today      INTEGER,
  sms_sent_this_week  INTEGER,
  sms_sent_all_time   INTEGER,
  email_sent_all_time INTEGER,
  clicked_all_time    INTEGER,
  converted_all_time  INTEGER,
  conversion_rate_pct NUMERIC,
  revenue_cents_total INTEGER,
  last_sms_sent_at    TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH base AS (
    SELECT
      LOWER(REPLACE(l.name, ' ', '-')) AS studio_slug,
      l.name AS studio_name,
      l.id   AS location_id
    FROM public.locations l
  ),
  metrics AS (
    SELECT
      LOWER(REPLACE(l.name, ' ', '-')) AS studio_slug,
      COUNT(*) FILTER (WHERE ts.comeback_sms_sent_at >= (CURRENT_DATE AT TIME ZONE 'America/New_York'))::INTEGER AS sms_sent_today,
      COUNT(*) FILTER (WHERE ts.comeback_sms_sent_at >= date_trunc('week', CURRENT_DATE AT TIME ZONE 'America/New_York'))::INTEGER AS sms_sent_this_week,
      COUNT(*) FILTER (WHERE ts.comeback_sms_sent_at IS NOT NULL)::INTEGER AS sms_sent_all_time,
      COUNT(*) FILTER (WHERE ts.comeback_email_sent_at IS NOT NULL)::INTEGER AS email_sent_all_time,
      COUNT(*) FILTER (WHERE ts.comeback_clicked_at IS NOT NULL)::INTEGER AS clicked_all_time,
      COUNT(*) FILTER (WHERE ts.comeback_converted_at IS NOT NULL)::INTEGER AS converted_all_time,
      MAX(ts.comeback_sms_sent_at) AS last_sms_sent_at
    FROM public.trial_signups ts
    JOIN public.locations l ON l.id = ts.location_id
    WHERE ts.comeback_sms_sent_at IS NOT NULL
       OR ts.comeback_email_sent_at IS NOT NULL
    GROUP BY l.name
  )
  SELECT
    b.studio_slug,
    b.studio_name,
    COALESCE(m.sms_sent_today, 0),
    COALESCE(m.sms_sent_this_week, 0),
    COALESCE(m.sms_sent_all_time, 0),
    COALESCE(m.email_sent_all_time, 0),
    COALESCE(m.clicked_all_time, 0),
    COALESCE(m.converted_all_time, 0),
    CASE
      WHEN COALESCE(m.sms_sent_all_time, 0) = 0 THEN 0
      ELSE ROUND(100.0 * COALESCE(m.converted_all_time, 0) / m.sms_sent_all_time, 1)
    END AS conversion_rate_pct,
    (COALESCE(m.converted_all_time, 0) * 2900)::INTEGER AS revenue_cents_total,
    m.last_sms_sent_at
  FROM base b
  LEFT JOIN metrics m ON m.studio_slug = b.studio_slug
  ORDER BY b.studio_slug;
$$;

GRANT EXECUTE ON FUNCTION public.get_comeback_overview() TO anon, authenticated;


DROP FUNCTION IF EXISTS public.get_comeback_recent_list(text);
CREATE OR REPLACE FUNCTION public.get_comeback_recent_list(p_studio_slug TEXT)
RETURNS TABLE(
  trial_signup_id     UUID,
  name                TEXT,
  email               TEXT,
  phone               TEXT,
  comeback_sms_sent_at    TIMESTAMPTZ,
  comeback_email_sent_at  TIMESTAMPTZ,
  comeback_clicked_at     TIMESTAMPTZ,
  comeback_converted_at   TIMESTAMPTZ,
  comeback_sms_error      TEXT,
  stage TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT
    ts.id,
    ts.name,
    ts.email,
    ts.phone,
    ts.comeback_sms_sent_at,
    ts.comeback_email_sent_at,
    ts.comeback_clicked_at,
    ts.comeback_converted_at,
    ts.comeback_sms_error,
    CASE
      WHEN ts.comeback_converted_at IS NOT NULL THEN 'converted'
      WHEN ts.comeback_clicked_at   IS NOT NULL THEN 'clicked'
      WHEN ts.comeback_email_sent_at IS NOT NULL THEN 'emailed'
      WHEN ts.comeback_sms_sent_at  IS NOT NULL THEN 'texted'
      WHEN ts.comeback_sms_error    IS NOT NULL THEN 'failed'
      ELSE 'unknown'
    END AS stage
  FROM public.trial_signups ts
  JOIN public.locations l ON l.id = ts.location_id
  WHERE LOWER(REPLACE(l.name, ' ', '-')) = p_studio_slug
    AND (ts.comeback_sms_sent_at IS NOT NULL OR ts.comeback_email_sent_at IS NOT NULL OR ts.comeback_sms_error IS NOT NULL)
  ORDER BY COALESCE(ts.comeback_converted_at, ts.comeback_clicked_at, ts.comeback_sms_sent_at) DESC
  LIMIT 25;
$$;

GRANT EXECUTE ON FUNCTION public.get_comeback_recent_list(TEXT) TO anon, authenticated;
