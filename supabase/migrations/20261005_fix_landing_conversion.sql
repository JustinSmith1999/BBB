-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-05 · Fix get_netlify_landing_conversion — the "Landing Page
-- Performance" card has been showing 0% conversion for every studio.
--
-- TWO BUGS, both verified live before touching anything.
--
-- BUG 1 — pageviews is always 0, so page_to_lead_pct and page_to_paid_pct are
-- always 0. The function reads public.netlify_analytics_pages, which is empty:
-- get_netlify_summary() returns total_pageviews 0 and last_synced NULL, so the
-- netlify-analytics-sync job has never landed a row. Two reasons it cannot:
--   (a) it needs NETLIFY_API_TOKEN + NETLIFY_SITE_ID secrets, and
--   (b) NETLIFY_SITE_ID is documented as 705bda8a-…-20741de103be, which is the
--       bbbmarketing DASHBOARD site — not betterbodybootcamp.com. So even once
--       the token is set it would sync pageviews for the wrong site, and the
--       '/trial/<studio>%' path match would still find nothing.
-- Meanwhile public.capi_events already holds real per-studio trial-page views
-- (that is what get_trial_page_visitors_overview reads, and it works). So we
-- repoint at the data we actually have instead of waiting on a broken sync.
--
-- BUG 2 — lead_to_paid_pct compared two different groups of people. `leads`
-- counted signups CREATED in the window; `paid` counted anyone who PAID in the
-- window, whenever they signed up. Someone who signed up in June and paid in
-- September landed in `paid` but not in `leads`, inflating the rate. At the
-- 30-day default it read Bayside 91.6%; the honest same-cohort number over the
-- same period is ~77%. The error shrinks as the window grows, which is exactly
-- why it went unnoticed — the long-window numbers looked fine.
-- Now both sides count the SAME people: signed up in the window, of whom N paid.
--
-- NOTE ON THE WINDOW: capi_events is pruned to a 30-day rolling window (see
-- 20260604 heartbeat migration), so pageview-based rates are only meaningful
-- for p_days <= 30. Beyond that the denominator silently truncates and the
-- conversion rate will read far too high. The function now returns
-- pageview_window_truncated so the UI can say so instead of lying.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_netlify_landing_conversion(INT);
CREATE OR REPLACE FUNCTION public.get_netlify_landing_conversion(
  p_days INT DEFAULT 30
)
RETURNS TABLE(
  studio_slug                TEXT,
  studio_name                TEXT,
  pageviews                  INT,
  unique_visitors            INT,
  trial_signups              INT,
  paid_trials                INT,
  page_to_lead_pct           NUMERIC,
  page_to_paid_pct           NUMERIC,
  lead_to_paid_pct           NUMERIC,
  pageview_window_truncated  BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH studios AS (
    SELECT lower(replace(l.name, ' ', '-')) AS slug,
           l.name AS studio_name,
           l.id   AS location_id
    FROM public.locations l
  ),
  -- Real trial-page views, from the table that actually has them.
  page_views AS (
    SELECT
      c.studio_slug AS slug,
      COUNT(*)::INT AS views,
      -- fbp is the browser-level identity the rest of the funnel keys on
      -- (see 20260611_trial_page_visitors.sql); client_ip is the fallback for
      -- visitors who block the pixel.
      COUNT(DISTINCT COALESCE(
        NULLIF(c.visitor_meta->>'fbp', ''),
        NULLIF(c.visitor_meta->>'client_ip', ''),
        c.id::TEXT
      ))::INT AS uniques
    FROM public.capi_events c
    WHERE c.event_name = 'PageView'
      AND c.attempted_at >= now() - (p_days || ' days')::INTERVAL
      AND c.studio_slug IS NOT NULL
    GROUP BY c.studio_slug
  ),
  -- ONE cohort: people who signed up inside the window. `paid` is the subset
  -- of those same people who went on to pay — not everyone who paid in the
  -- window. This is the fix for bug 2.
  cohort AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS slug,
      COUNT(*)::INT AS leads,
      COUNT(*) FILTER (WHERE t.payment_status = 'completed')::INT AS paid
    FROM public.trial_signups t
    LEFT JOIN public.locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND t.created_at >= now() - (p_days || ' days')::INTERVAL
    GROUP BY 1
  )
  SELECT
    s.slug,
    s.studio_name,
    COALESCE(pv.views, 0),
    COALESCE(pv.uniques, 0),
    COALESCE(ch.leads, 0),
    COALESCE(ch.paid, 0),
    CASE WHEN COALESCE(pv.views, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(100.0 * COALESCE(ch.leads, 0) / pv.views, 1) END,
    CASE WHEN COALESCE(pv.views, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(100.0 * COALESCE(ch.paid, 0) / pv.views, 1) END,
    CASE WHEN COALESCE(ch.leads, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(100.0 * COALESCE(ch.paid, 0) / ch.leads, 1) END,
    (p_days > 30)
  FROM studios s
  LEFT JOIN page_views pv ON pv.slug = s.slug
  LEFT JOIN cohort     ch ON ch.slug = s.slug
  ORDER BY s.studio_name;
$$;
GRANT EXECUTE ON FUNCTION public.get_netlify_landing_conversion(INT) TO anon, authenticated;
