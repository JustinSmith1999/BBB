-- ──────────────────────────────────────────────────────────────────────────────
-- SEO observability: per-studio overview RPC + a manual action log.
--
-- Why: the SEO card needs to show (a) what the numbers ARE, (b) that they're
-- moving up over time, and (c) what we did that caused them to move. Without
-- the action log it's a black box ("rankings went up… why?"). With it, every
-- ship event is dated and named.
--
-- WHAT THIS MIGRATION DOES:
--   1. Creates public.seo_actions — append-only ledger of every SEO change
--      we make. studio_slug = '_all' for site-wide actions (e.g. schema, GBP
--      changes that affect all 4 locations).
--   2. Creates get_seo_overview(p_studio) — single RPC that powers the
--      dashboard card: 28-day totals + daily time series + top queries +
--      recent action log entries.
--   3. Seeds the action log with the SEO work we've already shipped this
--      session so the new card has something to render today.
-- ──────────────────────────────────────────────────────────────────────────────

-- ── 1. Action log table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.seo_actions (
  id           BIGSERIAL PRIMARY KEY,
  studio_slug  TEXT        NOT NULL,
  action_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
  title        TEXT        NOT NULL,
  notes        TEXT,
  category     TEXT,            -- 'page' | 'gbp' | 'schema' | 'content' | 'tracking' | 'other'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seo_actions_studio_date_idx
  ON public.seo_actions (studio_slug, action_date DESC);

-- Read-only for authenticated users. Inserts happen via SQL editor when
-- Justin ships a change (see helper INSERT pattern at the bottom of file).
ALTER TABLE public.seo_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS seo_actions_read ON public.seo_actions;
CREATE POLICY seo_actions_read ON public.seo_actions
  FOR SELECT TO authenticated USING (true);


-- ── 2. Per-studio SEO overview RPC ──────────────────────────────────────────
-- Returns one JSON blob the dashboard hydrates a whole card from. Splitting
-- this into multiple round-trips slowed down the audience cards earlier in
-- the project, so we mirror that pattern: one query, one fetch.
CREATE OR REPLACE FUNCTION public.get_seo_overview(p_studio TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSON;
BEGIN
  WITH window_28 AS (
    -- p_studio = '_all' returns sitewide totals (used by the All-Studios chip).
    -- Any other slug filters to that studio's bucketed rows only — note that
    -- pages whose URL doesn't match the per-studio regex in gsc-sync land
    -- in studio_slug = '_all', so a studio's totals are honest (its own
    -- pages only) rather than including the homepage.
    SELECT * FROM public.gsc_search_performance
    WHERE date >= CURRENT_DATE - INTERVAL '28 days'
      AND (
        (p_studio = '_all') OR
        (p_studio <> '_all' AND studio_slug = p_studio)
      )
  ),
  totals AS (
    SELECT
      COALESCE(SUM(impressions), 0)::INT AS impressions_28d,
      COALESCE(SUM(clicks),      0)::INT AS clicks_28d,
      ROUND(
        CASE WHEN SUM(impressions) > 0
             THEN SUM(clicks)::numeric / SUM(impressions) * 100
             ELSE 0
        END, 2
      )                                  AS ctr_pct_28d,
      ROUND(
        CASE WHEN SUM(impressions) > 0
             THEN SUM(position * impressions)::numeric / SUM(impressions)
             ELSE 0
        END, 1
      )                                  AS avg_position_28d
    FROM window_28
  ),
  -- Same metrics for the PREVIOUS 28 days, so the card can show MoM-style
  -- deltas next to the headline numbers.
  prior_28 AS (
    SELECT * FROM public.gsc_search_performance
    WHERE date >= CURRENT_DATE - INTERVAL '56 days'
      AND date <  CURRENT_DATE - INTERVAL '28 days'
      AND (
        (p_studio = '_all') OR
        (p_studio <> '_all' AND studio_slug = p_studio)
      )
  ),
  prior_totals AS (
    SELECT
      COALESCE(SUM(impressions), 0)::INT AS impressions_prior,
      COALESCE(SUM(clicks),      0)::INT AS clicks_prior,
      ROUND(
        CASE WHEN SUM(impressions) > 0
             THEN SUM(position * impressions)::numeric / SUM(impressions)
             ELSE 0
        END, 1
      )                                  AS avg_position_prior
    FROM prior_28
  ),
  -- Daily series for the chart. We backfill missing days with zeros so the
  -- chart axis is continuous (otherwise a 0-impression day would just
  -- shorten the line).
  daily AS (
    SELECT
      (CURRENT_DATE - (gs.d || ' days')::INTERVAL)::DATE AS d,
      COALESCE(SUM(g.impressions), 0)::INT AS impressions,
      COALESCE(SUM(g.clicks),      0)::INT AS clicks
    FROM generate_series(0, 27) AS gs(d)
    LEFT JOIN window_28 g
      ON g.date = (CURRENT_DATE - (gs.d || ' days')::INTERVAL)::DATE
    GROUP BY gs.d
    ORDER BY (CURRENT_DATE - (gs.d || ' days')::INTERVAL)::DATE
  ),
  top_q AS (
    SELECT
      query,
      SUM(impressions)::INT AS impressions,
      SUM(clicks)::INT      AS clicks,
      ROUND(
        CASE WHEN SUM(impressions) > 0
             THEN SUM(clicks)::numeric / SUM(impressions) * 100
             ELSE 0
        END, 2
      )                      AS ctr_pct,
      ROUND(
        CASE WHEN SUM(impressions) > 0
             THEN SUM(position * impressions)::numeric / SUM(impressions)
             ELSE 0
        END, 1
      )                      AS avg_position
    FROM window_28
    WHERE query IS NOT NULL AND query <> ''
    GROUP BY query
    HAVING SUM(impressions) >= 3
    ORDER BY SUM(impressions) DESC
    LIMIT 15
  ),
  actions AS (
    -- A studio sees its own actions + every '_all' action (sitewide work
    -- like schema / sitemap / GSC wiring affects every studio's rankings).
    SELECT
      id,
      action_date::TEXT AS action_date,
      title,
      notes,
      category,
      studio_slug
    FROM public.seo_actions
    WHERE (
      (p_studio = '_all') OR
      (studio_slug = p_studio OR studio_slug = '_all')
    )
      AND action_date >= CURRENT_DATE - INTERVAL '120 days'
    ORDER BY action_date DESC, id DESC
    LIMIT 25
  )
  SELECT json_build_object(
    'studio',     p_studio,
    'totals',     (SELECT row_to_json(t) FROM totals t),
    'prior',      (SELECT row_to_json(p) FROM prior_totals p),
    'daily',      COALESCE((SELECT json_agg(d ORDER BY d.d) FROM daily d), '[]'::json),
    'top_queries',COALESCE((SELECT json_agg(q) FROM top_q q),      '[]'::json),
    'actions',    COALESCE((SELECT json_agg(a) FROM actions a),    '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_seo_overview(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_seo_overview(text) TO authenticated;


-- ── 3. Seed with the SEO work shipped this session ──────────────────────────
-- These give the dashboard something real to render today. Going forward,
-- Justin appends a new row whenever he ships an SEO change (template below).
INSERT INTO public.seo_actions (studio_slug, action_date, title, notes, category) VALUES
  ('_all',         '2026-05-26', 'Site-wide schema + sitemap submitted',
     'LocalBusiness + Organization JSON-LD across all 4 location pages. sitemap.xml submitted to GSC.', 'schema'),
  ('_all',         '2026-05-29', 'GSC verified for betterbodybootcamp.com',
     'URL-prefix property verified via HTML file method. First step toward dashboard ranking visibility.', 'tracking'),
  ('williamsburg', '2026-05-26', 'Williamsburg page schema + meta update',
     'LocalBusiness JSON-LD with full address, opening hours, geo coords. Meta description tightened.', 'schema'),
  ('astoria',      '2026-05-26', 'Astoria page schema + meta update',
     'LocalBusiness JSON-LD with full address, opening hours, geo coords. Meta description tightened.', 'schema'),
  ('fresh-meadows','2026-05-26', 'Fresh Meadows page schema + meta update',
     'LocalBusiness JSON-LD with full address, opening hours, geo coords. Meta description tightened.', 'schema'),
  ('bayside',      '2026-05-26', 'Bayside page schema + meta update',
     'LocalBusiness JSON-LD with full address, opening hours, geo coords. Meta description tightened.', 'schema'),
  ('bayside',      '2026-05-27', 'Bayside GBP: categories audited + description filled',
     'Confirmed primary category Personal trainer; secondaries added. Description + hours + social links posted.', 'gbp'),
  ('bayside',      '2026-05-27', 'Bayside GBP: Welcome Post (new ownership)',
     'Published Welcome post calling out new ownership + $49 trial offer.', 'gbp'),
  ('bayside',      '2026-05-28', 'Bayside GBP: filed duplicate-listing report',
     'Reported duplicate listing via GBP support. Tracking baseline interactions for before/after comparison.', 'gbp'),
  ('_all',         '2026-06-01', 'GSC → dashboard pipeline live',
     'gsc-sync edge function deployed using OAuth refresh-token flow. gsc_search_performance receiving daily data. Per-studio Search visibility cards shipped. From here, every SEO change is measurable.', 'tracking')
ON CONFLICT DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────────
-- HELPER: how to log a future SEO action
--
-- Whenever you ship an SEO change, append a row so it shows up on the
-- dashboard within the next minute (no deploy needed — the card re-reads
-- the table on every render).
--
-- INSERT INTO public.seo_actions (studio_slug, title, notes, category) VALUES
--   ('bayside',      'Added pricing FAQ to /trial/bayside',
--    '36 imp / 0 clicks on "better body bootcamp monthly cost". FAQPage schema + visible price block.',
--    'page');
--
-- studio_slug values:
--   'williamsburg' | 'astoria' | 'bayside' | 'fresh-meadows' | '_all'
-- category values:
--   'page' | 'gbp' | 'schema' | 'content' | 'tracking' | 'other'
-- ──────────────────────────────────────────────────────────────────────────────

-- Sanity check
SELECT
  studio_slug,
  COUNT(*) AS actions_logged,
  MAX(action_date) AS most_recent
FROM public.seo_actions
GROUP BY studio_slug
ORDER BY studio_slug;
