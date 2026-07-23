-- ─────────────────────────────────────────────────────────────────────────────
-- Netlify Web Analytics — daily-granular tables synced from Netlify's API.
--
-- Four sibling tables, one per Netlify ranking endpoint. Each upserts on
-- (date, …) so re-syncing yesterday is idempotent. RPCs at the bottom power
-- the owner-dashboard card without exposing raw Netlify data.
--
-- Source endpoints (Netlify API):
--   /sites/{id}/analytics/pageviews?from=…&to=…&resolution=day
--   /sites/{id}/analytics/visitors?from=…&to=…&resolution=day
--   /sites/{id}/analytics/ranking/pages?from=…&to=…&limit=50
--   /sites/{id}/analytics/ranking/sources?from=…&to=…&limit=50
--   /sites/{id}/analytics/ranking/countries?from=…&to=…&limit=20
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.netlify_analytics_daily (
  date              DATE         PRIMARY KEY,
  pageviews         INT          NOT NULL DEFAULT 0,
  unique_visitors   INT          NOT NULL DEFAULT 0,
  synced_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.netlify_analytics_pages (
  date              DATE         NOT NULL,
  path              TEXT         NOT NULL,
  pageviews         INT          NOT NULL DEFAULT 0,
  synced_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (date, path)
);
CREATE INDEX IF NOT EXISTS netlify_pages_path_idx ON public.netlify_analytics_pages(path);

CREATE TABLE IF NOT EXISTS public.netlify_analytics_sources (
  date              DATE         NOT NULL,
  source            TEXT         NOT NULL,
  referrals         INT          NOT NULL DEFAULT 0,
  synced_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (date, source)
);

CREATE TABLE IF NOT EXISTS public.netlify_analytics_countries (
  date              DATE         NOT NULL,
  country           TEXT         NOT NULL,
  pageviews         INT          NOT NULL DEFAULT 0,
  synced_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (date, country)
);

-- RLS — read-allowed for anon (dashboard reads). Writes go through service
-- role only (the sync function uses SUPABASE_SERVICE_ROLE_KEY).
ALTER TABLE public.netlify_analytics_daily     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.netlify_analytics_pages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.netlify_analytics_sources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.netlify_analytics_countries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY netlify_daily_read     ON public.netlify_analytics_daily     FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END$$;
DO $$
BEGIN
  CREATE POLICY netlify_pages_read     ON public.netlify_analytics_pages     FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END$$;
DO $$
BEGIN
  CREATE POLICY netlify_sources_read   ON public.netlify_analytics_sources   FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END$$;
DO $$
BEGIN
  CREATE POLICY netlify_countries_read ON public.netlify_analytics_countries FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: get_netlify_landing_conversion(p_days)
-- Returns one row per studio with landing-page traffic + paid-trial
-- conversion rate. Powers the "Landing Page Performance" dashboard card.
-- This is the single most useful join — answers "are people landing but
-- not buying" for each studio individually.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_netlify_landing_conversion(
  p_days INT DEFAULT 30
)
RETURNS TABLE(
  studio_slug       TEXT,
  studio_name       TEXT,
  pageviews         INT,
  trial_signups     INT,
  paid_trials       INT,
  page_to_lead_pct  NUMERIC,
  page_to_paid_pct  NUMERIC,
  lead_to_paid_pct  NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH studios AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS slug,
      l.name AS studio_name,
      l.id   AS location_id
    FROM public.locations l
  ),
  page_views AS (
    SELECT
      CASE
        WHEN p.path ILIKE '/trial/williamsburg%'   THEN 'williamsburg'
        WHEN p.path ILIKE '/trial/astoria%'        THEN 'astoria'
        WHEN p.path ILIKE '/trial/bayside%'        THEN 'bayside'
        WHEN p.path ILIKE '/trial/fresh-meadows%'  THEN 'fresh-meadows'
      END AS slug,
      SUM(p.pageviews) AS views
    FROM public.netlify_analytics_pages p
    WHERE p.date >= CURRENT_DATE - (p_days || ' days')::INTERVAL
    GROUP BY 1
  ),
  signups AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS slug,
      COUNT(*) FILTER (WHERE t.created_at >= now() - (p_days || ' days')::INTERVAL) AS leads,
      COUNT(*) FILTER (WHERE t.payment_status = 'completed'
                          AND t.payment_date >= now() - (p_days || ' days')::INTERVAL) AS paid
    FROM public.trial_signups t
    LEFT JOIN public.locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
    GROUP BY 1
  )
  SELECT
    s.slug,
    s.studio_name,
    COALESCE(pv.views, 0)::INT,
    COALESCE(sg.leads, 0)::INT,
    COALESCE(sg.paid, 0)::INT,
    CASE WHEN COALESCE(pv.views, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(COALESCE(sg.leads, 0)::NUMERIC / pv.views::NUMERIC * 100, 2)
    END AS page_to_lead_pct,
    CASE WHEN COALESCE(pv.views, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(COALESCE(sg.paid,  0)::NUMERIC / pv.views::NUMERIC * 100, 2)
    END AS page_to_paid_pct,
    CASE WHEN COALESCE(sg.leads, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(COALESCE(sg.paid,  0)::NUMERIC / sg.leads::NUMERIC * 100, 1)
    END AS lead_to_paid_pct
  FROM studios s
  LEFT JOIN page_views pv USING (slug)
  LEFT JOIN signups    sg USING (slug)
  WHERE s.slug IN ('williamsburg','astoria','bayside','fresh-meadows')
  ORDER BY page_to_paid_pct DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION public.get_netlify_landing_conversion(INT) TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: get_netlify_summary(p_days) — network totals + top sources/pages.
-- One call, all the data the dashboard card needs.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_netlify_summary(
  p_days INT DEFAULT 30
)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'window_days', p_days,
    'total_pageviews', COALESCE(
      (SELECT SUM(pageviews)::INT FROM public.netlify_analytics_daily
        WHERE date >= CURRENT_DATE - (p_days || ' days')::INTERVAL), 0),
    'total_unique_visitors', COALESCE(
      (SELECT SUM(unique_visitors)::INT FROM public.netlify_analytics_daily
        WHERE date >= CURRENT_DATE - (p_days || ' days')::INTERVAL), 0),
    'daily', (SELECT jsonb_agg(jsonb_build_object('date', date, 'pageviews', pageviews, 'unique_visitors', unique_visitors) ORDER BY date)
              FROM public.netlify_analytics_daily
             WHERE date >= CURRENT_DATE - (p_days || ' days')::INTERVAL),
    'top_pages', (SELECT jsonb_agg(jsonb_build_object('path', path, 'pageviews', total))
                  FROM (SELECT path, SUM(pageviews)::INT AS total
                          FROM public.netlify_analytics_pages
                         WHERE date >= CURRENT_DATE - (p_days || ' days')::INTERVAL
                         GROUP BY path ORDER BY total DESC LIMIT 15) t),
    'top_sources', (SELECT jsonb_agg(jsonb_build_object('source', source, 'referrals', total))
                    FROM (SELECT source, SUM(referrals)::INT AS total
                            FROM public.netlify_analytics_sources
                           WHERE date >= CURRENT_DATE - (p_days || ' days')::INTERVAL
                           GROUP BY source ORDER BY total DESC LIMIT 10) t),
    'top_countries', (SELECT jsonb_agg(jsonb_build_object('country', country, 'pageviews', total))
                      FROM (SELECT country, SUM(pageviews)::INT AS total
                              FROM public.netlify_analytics_countries
                             WHERE date >= CURRENT_DATE - (p_days || ' days')::INTERVAL
                             GROUP BY country ORDER BY total DESC LIMIT 10) t),
    'last_synced', (SELECT MAX(synced_at) FROM public.netlify_analytics_daily)
  )::JSON;
$$;
GRANT EXECUTE ON FUNCTION public.get_netlify_summary(INT) TO anon, authenticated;

-- Sanity (will return empty until the sync function runs)
SELECT get_netlify_summary(30);
