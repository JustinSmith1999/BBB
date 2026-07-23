-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: get_lead_conversion_heatmap — daily lead + paid counts per studio
--
-- Powers the GitHub-style heatmaps on the owner dashboard:
--   - Per-studio: 2 heatmaps showing daily lead volume + daily paid volume
--   - All Studios: same + network total
--
-- Why a date series CROSS JOIN: we want zero-cells in the heatmap, not gaps.
-- A day with no leads should render as the "cold" color, not be skipped.
--
-- ET timezone for all date bucketing — matches the rest of the dashboard.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_lead_conversion_heatmap(text, int);

CREATE OR REPLACE FUNCTION public.get_lead_conversion_heatmap(
  p_studio_slug text DEFAULT NULL,
  p_days        int  DEFAULT 30
)
RETURNS TABLE (
  studio_slug text,
  day         date,
  day_of_week int,   -- 0 = Sun … 6 = Sat
  lead_count  int,   -- form fills (paid + unpaid)
  paid_count  int    -- $49 Stripe trials completed
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (((now() AT TIME ZONE 'America/New_York')::date) - (p_days - 1))::date,
      ((now() AT TIME ZONE 'America/New_York')::date)::date,
      INTERVAL '1 day'
    )::date AS day
  ),
  studios AS (
    SELECT lower(replace(name, ' ', '-')) AS studio_slug, id AS location_id
    FROM public.locations
    WHERE p_studio_slug IS NULL
       OR lower(replace(name, ' ', '-')) = p_studio_slug
  ),
  daily_leads AS (
    SELECT
      s.studio_slug,
      ((t.created_at AT TIME ZONE 'America/New_York')::date) AS day,
      COUNT(*)::int AS lead_count,
      COUNT(*) FILTER (WHERE t.payment_status = 'completed')::int AS paid_count
    FROM public.trial_signups t
    JOIN studios s ON s.location_id = t.location_id
    WHERE t.deleted_at IS NULL
      AND (t.created_at AT TIME ZONE 'America/New_York')::date
            >= (((now() AT TIME ZONE 'America/New_York')::date) - (p_days - 1))::date
    GROUP BY 1, 2
  )
  SELECT
    s.studio_slug,
    d.day,
    EXTRACT(DOW FROM d.day)::int AS day_of_week,
    COALESCE(dl.lead_count, 0) AS lead_count,
    COALESCE(dl.paid_count, 0) AS paid_count
  FROM studios s
  CROSS JOIN date_series d
  LEFT JOIN daily_leads dl
    ON dl.studio_slug = s.studio_slug AND dl.day = d.day
  ORDER BY s.studio_slug, d.day;
$$;

GRANT EXECUTE ON FUNCTION public.get_lead_conversion_heatmap(text, int) TO authenticated;

-- Sanity probe — 30 days × 4 studios = ~120 rows
SELECT studio_slug, day, day_of_week, lead_count, paid_count
FROM public.get_lead_conversion_heatmap(NULL, 30)
ORDER BY studio_slug, day DESC
LIMIT 12;
