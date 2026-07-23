-- Google Search Console (GSC) Search Analytics storage + read RPC.
-- The gsc-sync edge function pulls daily query/page rows from the GSC API
-- and writes them here. The dashboard reads via get_gsc_summary().
--
-- One row per (date, query, page, studio_slug). 'site-wide' studio slug
-- = '_all' so we don't have to lookup-map every URL.

CREATE TABLE IF NOT EXISTS public.gsc_search_performance (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE         NOT NULL,
  studio_slug   TEXT         NOT NULL,       -- 'astoria' | 'bayside' | ... | '_all'
  query         TEXT         NOT NULL,
  page          TEXT         NOT NULL,
  impressions   INT          NOT NULL DEFAULT 0,
  clicks        INT          NOT NULL DEFAULT 0,
  ctr           NUMERIC(6,4) NOT NULL DEFAULT 0,   -- 0.0341 = 3.41%
  position      NUMERIC(5,2) NOT NULL DEFAULT 0,   -- avg search position
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (date, studio_slug, query, page)
);

CREATE INDEX IF NOT EXISTS idx_gsc_search_perf_date     ON public.gsc_search_performance (date DESC);
CREATE INDEX IF NOT EXISTS idx_gsc_search_perf_studio   ON public.gsc_search_performance (studio_slug, date DESC);
CREATE INDEX IF NOT EXISTS idx_gsc_search_perf_query    ON public.gsc_search_performance (query);

-- Bucket each page URL into a studio slug. URLs containing /locations/<slug>
-- or /trial/<slug> or /schedule/<slug> count toward that studio. Everything
-- else rolls up under '_all' (homepage, /classes, /pricing, etc).
CREATE OR REPLACE FUNCTION public.gsc_page_to_studio(p_page TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_page ~* '/(locations|trial|schedule)/astoria'        THEN 'astoria'
    WHEN p_page ~* '/(locations|trial|schedule)/bayside'        THEN 'bayside'
    WHEN p_page ~* '/(locations|trial|schedule)/fresh-meadows'  THEN 'fresh-meadows'
    WHEN p_page ~* '/(locations|trial|schedule)/williamsburg'   THEN 'williamsburg'
    ELSE '_all'
  END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_gsc_summary — top-level numbers + top queries for the dashboard card.
--
-- Returns a JSON object so the front-end gets everything in one round-trip:
--   { totals: { clicks, impressions, ctr_pct, avg_position },
--     by_studio: [ { studio_slug, clicks, impressions, ctr_pct, avg_position } ],
--     top_queries: [ { query, clicks, impressions, ctr_pct, avg_position } ],
--     neighborhood_queries: [ ... ]  -- queries matching 'gyms in <neighborhood>'
--   }
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_gsc_summary(
  p_since DATE DEFAULT (CURRENT_DATE - INTERVAL '28 days')::date
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_allowed     text[];
  v_totals      jsonb;
  v_by_studio   jsonb;
  v_top         jsonb;
  v_neighbor    jsonb;
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  -- Site-wide totals (sum clicks/impressions, weighted ctr + position).
  SELECT jsonb_build_object(
    'clicks',       COALESCE(SUM(clicks), 0),
    'impressions',  COALESCE(SUM(impressions), 0),
    'ctr_pct',      CASE WHEN COALESCE(SUM(impressions), 0) > 0
                         THEN ROUND(100.0 * SUM(clicks)::numeric / SUM(impressions), 2)
                         ELSE 0 END,
    'avg_position', CASE WHEN COALESCE(SUM(impressions), 0) > 0
                         THEN ROUND(SUM(position * impressions)::numeric / SUM(impressions), 1)
                         ELSE 0 END
  )
  INTO v_totals
  FROM public.gsc_search_performance
  WHERE date >= p_since;

  -- Per-studio rollup (only studios the user can see).
  SELECT COALESCE(jsonb_agg(row_to_json(s) ORDER BY s.studio_slug), '[]'::jsonb)
  INTO v_by_studio
  FROM (
    SELECT
      studio_slug,
      SUM(clicks)::int      AS clicks,
      SUM(impressions)::int AS impressions,
      CASE WHEN SUM(impressions) > 0
        THEN ROUND(100.0 * SUM(clicks)::numeric / SUM(impressions), 2)
        ELSE 0 END          AS ctr_pct,
      CASE WHEN SUM(impressions) > 0
        THEN ROUND(SUM(position * impressions)::numeric / SUM(impressions), 1)
        ELSE 0 END          AS avg_position
    FROM public.gsc_search_performance
    WHERE date >= p_since
      AND studio_slug = ANY(v_allowed)
    GROUP BY studio_slug
  ) s;

  -- Top 20 queries by impressions across the whole site.
  SELECT COALESCE(jsonb_agg(row_to_json(q) ORDER BY q.impressions DESC), '[]'::jsonb)
  INTO v_top
  FROM (
    SELECT
      query,
      SUM(clicks)::int      AS clicks,
      SUM(impressions)::int AS impressions,
      CASE WHEN SUM(impressions) > 0
        THEN ROUND(100.0 * SUM(clicks)::numeric / SUM(impressions), 2)
        ELSE 0 END          AS ctr_pct,
      CASE WHEN SUM(impressions) > 0
        THEN ROUND(SUM(position * impressions)::numeric / SUM(impressions), 1)
        ELSE 0 END          AS avg_position
    FROM public.gsc_search_performance
    WHERE date >= p_since
    GROUP BY query
    ORDER BY SUM(impressions) DESC
    LIMIT 20
  ) q;

  -- "Neighborhood gym" queries — these are the SEO target. Anything matching
  -- gym/gyms/bootcamp/fitness near a NYC neighborhood word.
  SELECT COALESCE(jsonb_agg(row_to_json(n) ORDER BY n.impressions DESC), '[]'::jsonb)
  INTO v_neighbor
  FROM (
    SELECT
      query,
      SUM(clicks)::int      AS clicks,
      SUM(impressions)::int AS impressions,
      CASE WHEN SUM(impressions) > 0
        THEN ROUND(100.0 * SUM(clicks)::numeric / SUM(impressions), 2)
        ELSE 0 END          AS ctr_pct,
      CASE WHEN SUM(impressions) > 0
        THEN ROUND(SUM(position * impressions)::numeric / SUM(impressions), 1)
        ELSE 0 END          AS avg_position
    FROM public.gsc_search_performance
    WHERE date >= p_since
      AND query ~* '(gym|gyms|bootcamp|fitness|workout|hiit|class)'
      AND query ~* '(astoria|bayside|fresh.?meadows|williamsburg|queens|brooklyn|nyc|new york)'
    GROUP BY query
    ORDER BY SUM(impressions) DESC
    LIMIT 25
  ) n;

  RETURN jsonb_build_object(
    'totals',               COALESCE(v_totals, '{}'::jsonb),
    'by_studio',            v_by_studio,
    'top_queries',          v_top,
    'neighborhood_queries', v_neighbor,
    'since',                p_since
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_gsc_summary(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gsc_summary(date) TO authenticated;

-- Quick sanity:
-- SELECT public.get_gsc_summary();
-- SELECT public.get_gsc_summary('2026-04-01');
