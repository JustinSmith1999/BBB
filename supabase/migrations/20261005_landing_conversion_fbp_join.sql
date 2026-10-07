-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-05 (second pass) · get_netlify_landing_conversion — make page→lead
-- compare the SAME PEOPLE on both sides.
--
-- WHAT WAS STILL WRONG after the first fix. Repointing pageviews at
-- capi_events got the card off 0%, but the ratio was nonsense:
--
--     Astoria  295 views / 172 signups = 58.3%
--
-- No landing page converts 58%. The two sides were different populations:
--   • denominator = capi_events PageView rows, which are Meta CONVERSIONS API
--     events. 77-89% of them are ad traffic; it is not a log of every visit.
--   • numerator  = every trial_signups row, from any source — ads, organic,
--     Google Business, walk-in referral, the lot.
-- So when Astoria's ad spend dropped, its denominator collapsed while signups
-- kept arriving from everywhere else, and the "conversion rate" shot up. The
-- metric moved opposite to reality.
--
-- THE FIX: join on fbp, the Meta browser id. It is written onto capi_events
-- (visitor_meta->>'fbp') by meta-capi-pageview and onto trial_signups.fbp by
-- create-trial-checkout (added in 20260605_capi_match_quality_fbp.sql). So we
-- can ask the only question that is actually answerable here:
--
--     of the browsers we SAW on a trial page, how many started a checkout?
--
-- Same population on both sides, no attribution guesswork.
--
-- HONESTY GAUGE: fbp is not always captured (ad blockers, direct traffic, the
-- desk creating a row by hand). If coverage is poor the matched numerator
-- undercounts and page_to_lead_pct reads LOW. So the function also returns
-- fbp_coverage_pct — the share of checkout starts that carry an fbp at all.
-- Read the rate together with the coverage; if coverage is under ~60% treat
-- page_to_lead_pct as a floor, not a measurement. Better an honest floor with
-- its uncertainty on display than a confident 58%.
--
-- TERMINOLOGY, because this caused a real misreading: a trial_signups row is
-- created by create-trial-checkout with payment_status 'pending' when someone
-- CLICKS THROUGH TO CHECKOUT — before paying. It is a checkout start, not a
-- customer. paid_trials is the subset that actually paid. The column is still
-- named trial_signups so the dashboard keeps working, but checkout_starts is
-- returned alongside with the honest name.
--
-- NOTE: capi_events is NOT pruned. The 30-day DELETE in
-- 20260601_capi_events_log.sql:39 is a one-time statement in that migration,
-- not a scheduled job, so the table holds everything since June 2026. The
-- pageview_window_truncated flag from the previous version was based on a
-- wrong assumption and is dropped.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_netlify_landing_conversion(INT);
CREATE OR REPLACE FUNCTION public.get_netlify_landing_conversion(
  p_days INT DEFAULT 30
)
RETURNS TABLE(
  studio_slug        TEXT,
  studio_name        TEXT,
  pageviews          INT,
  unique_visitors    INT,
  trial_signups      INT,   -- = checkout_starts; name kept for the dashboard
  checkout_starts    INT,
  paid_trials        INT,
  matched_visitors   INT,   -- browsers seen on a trial page that then started checkout
  page_to_lead_pct   NUMERIC,
  page_to_paid_pct   NUMERIC,
  lead_to_paid_pct   NUMERIC,
  fbp_coverage_pct   NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH studios AS (
    SELECT lower(replace(l.name, ' ', '-')) AS slug, l.name AS studio_name
    FROM public.locations l
  ),
  views AS (
    SELECT
      c.studio_slug AS slug,
      COUNT(*)::INT AS pageviews,
      COUNT(DISTINCT NULLIF(c.visitor_meta->>'fbp', ''))::INT AS uniq_fbp
    FROM public.capi_events c
    WHERE c.event_name = 'PageView'
      AND c.attempted_at >= now() - (p_days || ' days')::INTERVAL
      AND c.studio_slug IS NOT NULL
    GROUP BY c.studio_slug
  ),
  -- Every browser we saw on a trial page in the window.
  seen AS (
    SELECT DISTINCT c.studio_slug AS slug, c.visitor_meta->>'fbp' AS fbp
    FROM public.capi_events c
    WHERE c.event_name = 'PageView'
      AND c.attempted_at >= now() - (p_days || ' days')::INTERVAL
      AND c.studio_slug IS NOT NULL
      AND NULLIF(c.visitor_meta->>'fbp', '') IS NOT NULL
  ),
  -- One cohort: rows created in the window. paid is a subset of these same
  -- people, never "whoever paid in the window".
  cohort AS (
    SELECT
      lower(replace(l.name, ' ', '-')) AS slug,
      t.fbp,
      (t.payment_status = 'completed') AS paid
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND t.created_at >= now() - (p_days || ' days')::INTERVAL
  ),
  agg AS (
    SELECT
      ch.slug,
      COUNT(*)::INT                                              AS starts,
      COUNT(*) FILTER (WHERE ch.paid)::INT                       AS paid,
      COUNT(*) FILTER (WHERE NULLIF(ch.fbp,'') IS NOT NULL)::INT AS with_fbp
    FROM cohort ch GROUP BY ch.slug
  ),
  matched AS (
    SELECT s.slug, COUNT(DISTINCT s.fbp)::INT AS n
    FROM seen s
    JOIN cohort ch ON ch.slug = s.slug AND ch.fbp = s.fbp
    GROUP BY s.slug
  ),
  matched_paid AS (
    SELECT s.slug, COUNT(DISTINCT s.fbp)::INT AS n
    FROM seen s
    JOIN cohort ch ON ch.slug = s.slug AND ch.fbp = s.fbp AND ch.paid
    GROUP BY s.slug
  )
  SELECT
    st.slug,
    st.studio_name,
    COALESCE(v.pageviews, 0),
    COALESCE(v.uniq_fbp, 0),
    COALESCE(a.starts, 0),
    COALESCE(a.starts, 0),
    COALESCE(a.paid, 0),
    COALESCE(m.n, 0),
    -- honest: matched browsers / browsers seen
    CASE WHEN COALESCE(v.uniq_fbp, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(100.0 * COALESCE(m.n, 0) / v.uniq_fbp, 1) END,
    CASE WHEN COALESCE(v.uniq_fbp, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(100.0 * COALESCE(mp.n, 0) / v.uniq_fbp, 1) END,
    -- checkout completion, one cohort both sides
    CASE WHEN COALESCE(a.starts, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(100.0 * COALESCE(a.paid, 0) / a.starts, 1) END,
    -- how much of the above you can trust
    CASE WHEN COALESCE(a.starts, 0) = 0 THEN 0::NUMERIC
         ELSE ROUND(100.0 * COALESCE(a.with_fbp, 0) / a.starts, 1) END
  FROM studios st
  LEFT JOIN views        v  ON v.slug  = st.slug
  LEFT JOIN agg          a  ON a.slug  = st.slug
  LEFT JOIN matched      m  ON m.slug  = st.slug
  LEFT JOIN matched_paid mp ON mp.slug = st.slug
  ORDER BY st.studio_name;
$$;
GRANT EXECUTE ON FUNCTION public.get_netlify_landing_conversion(INT) TO anon, authenticated;
