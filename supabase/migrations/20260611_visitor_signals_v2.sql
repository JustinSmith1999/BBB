-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · Extend visitor RPCs to surface the new Tier-1 signals.
--
-- Adds to get_trial_page_visitors_overview:
--   • from_nyc_count      — visitors with cf-postal-code starting "11" (NYC)
--   • from_outside_nyc    — out-of-area (wasted ad spend signal)
--   • returning_visitors  — visit_number > 1
--   • mobile_count        — device='mobile'
--   • desktop_count       — device='desktop'
--
-- Adds to get_trial_page_visitors_recent_list:
--   • geo_city, geo_postal, geo_country
--   • browser, os, device
--   • language, timezone
--   • visit_number, days_since_first
--   • gclid (Google), ttclid (TikTok), msclkid (Microsoft), li_fat_id, twclid
-- ─────────────────────────────────────────────────────────────────────────────

-- Existing function has a narrower RETURNS TABLE; Postgres won't widen via
-- CREATE OR REPLACE, so drop it explicitly first. Idempotent.
DROP FUNCTION IF EXISTS public.get_trial_page_visitors_overview();

CREATE OR REPLACE FUNCTION public.get_trial_page_visitors_overview()
RETURNS TABLE (
  studio_slug          text,
  studio_name          text,
  today                int,
  this_week            int,
  all_time             int,
  from_meta_ads        int,
  unique_visitors_today int,
  unique_visitors_week  int,
  from_nyc_count       int,
  from_outside_nyc     int,
  returning_visitors   int,
  mobile_count         int,
  desktop_count        int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      c.studio_slug,
      c.attempted_at,
      (c.visitor_meta ? 'fbc')                                AS has_fbc,
      coalesce(c.visitor_meta->>'fbp', '')                    AS fbp,
      c.visitor_meta->>'geo_postal'                           AS geo_postal,
      c.visitor_meta->>'device'                               AS device,
      coalesce((c.visitor_meta->>'visit_number')::int, 1)     AS visit_number
    FROM public.capi_events c
    WHERE c.event_name = 'PageView'
      AND c.ok = true
      AND c.attempted_at IS NOT NULL
  ),
  studios AS (
    SELECT lower(replace(name, ' ', '-')) AS studio_slug, name AS studio_name
    FROM public.locations
  )
  SELECT
    s.studio_slug,
    s.studio_name,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug
              AND base.attempted_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York'
             ), 0)::int AS today,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug
              AND base.attempted_at >= now() - interval '7 days'
             ), 0)::int AS this_week,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug), 0)::int AS all_time,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug AND base.has_fbc), 0)::int AS from_meta_ads,
    coalesce((SELECT count(DISTINCT fbp) FROM base
              WHERE base.studio_slug = s.studio_slug
                AND base.attempted_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York'
                AND fbp <> ''
             ), 0)::int AS unique_visitors_today,
    coalesce((SELECT count(DISTINCT fbp) FROM base
              WHERE base.studio_slug = s.studio_slug
                AND base.attempted_at >= now() - interval '7 days'
                AND fbp <> ''
             ), 0)::int AS unique_visitors_week,
    -- NYC zip range is 10001-11697. Approximate via starts-with "1" + 5 digits.
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug
              AND base.geo_postal ~ '^(10|11)[0-9]{3}$'
             ), 0)::int AS from_nyc_count,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug
              AND base.geo_postal IS NOT NULL
              AND base.geo_postal !~ '^(10|11)[0-9]{3}$'
              AND base.geo_postal <> ''
             ), 0)::int AS from_outside_nyc,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug
              AND base.visit_number > 1
             ), 0)::int AS returning_visitors,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug AND base.device = 'mobile'), 0)::int AS mobile_count,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug AND base.device = 'desktop'), 0)::int AS desktop_count
  FROM studios s
  ORDER BY s.studio_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_trial_page_visitors_overview() TO anon, authenticated, service_role;

-- Recent visits list with every signal we capture
DROP FUNCTION IF EXISTS public.get_trial_page_visitors_recent_list(text);

CREATE OR REPLACE FUNCTION public.get_trial_page_visitors_recent_list(p_studio_slug text DEFAULT NULL)
RETURNS TABLE (
  event_id        text,
  studio_slug     text,
  attempted_at    timestamptz,
  ad_click_id     text,
  fbc             text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  referrer        text,
  page_url        text,
  device_hint     text,
  -- new tier-1 signals
  geo_city        text,
  geo_region      text,
  geo_postal      text,
  geo_country     text,
  browser         text,
  os              text,
  language        text,
  timezone        text,
  visit_number    int,
  days_since_first int,
  connection_type text,
  -- multi-platform click IDs
  gclid           text,
  ttclid          text,
  msclkid         text,
  li_fat_id       text,
  twclid          text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.event_id::text,
    c.studio_slug,
    c.attempted_at,
    c.visitor_meta->>'ad_click_id'   AS ad_click_id,
    c.visitor_meta->>'fbc'           AS fbc,
    c.visitor_meta->>'utm_source'    AS utm_source,
    c.visitor_meta->>'utm_medium'    AS utm_medium,
    c.visitor_meta->>'utm_campaign'  AS utm_campaign,
    NULL::text                       AS referrer,
    c.visitor_meta->>'page_url'      AS page_url,
    coalesce(c.visitor_meta->>'device', 'other') AS device_hint,
    c.visitor_meta->>'geo_city'      AS geo_city,
    c.visitor_meta->>'geo_region'    AS geo_region,
    c.visitor_meta->>'geo_postal'    AS geo_postal,
    c.visitor_meta->>'geo_country'   AS geo_country,
    c.visitor_meta->>'browser'       AS browser,
    c.visitor_meta->>'os'            AS os,
    c.visitor_meta->>'language'      AS language,
    c.visitor_meta->>'timezone'      AS timezone,
    nullif(c.visitor_meta->>'visit_number','')::int      AS visit_number,
    nullif(c.visitor_meta->>'days_since_first','')::int  AS days_since_first,
    c.visitor_meta->>'connection_type' AS connection_type,
    c.visitor_meta->>'gclid'         AS gclid,
    c.visitor_meta->>'ttclid'        AS ttclid,
    c.visitor_meta->>'msclkid'       AS msclkid,
    c.visitor_meta->>'li_fat_id'     AS li_fat_id,
    c.visitor_meta->>'twclid'        AS twclid
  FROM public.capi_events c
  WHERE c.event_name = 'PageView'
    AND c.ok = true
    AND c.attempted_at >= now() - interval '30 days'
    AND (p_studio_slug IS NULL OR c.studio_slug = p_studio_slug)
  ORDER BY c.attempted_at DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.get_trial_page_visitors_recent_list(text) TO anon, authenticated, service_role;

SELECT * FROM public.get_trial_page_visitors_overview();
