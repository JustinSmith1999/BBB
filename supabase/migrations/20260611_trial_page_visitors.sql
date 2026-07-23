-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · Trial Page Visitors tracking
--
-- The "Schedule Requests" tile only shows soft-conversion completers — a tiny
-- fraction of ad-driven traffic. Justin: "tracking that defeats the purpose."
--
-- This migration builds the real-visibility piece: every Meta-driven PageView
-- on /trial/[studio] becomes a row in capi_events (already deployed). Now we:
--   1. Add capi_events.visitor_meta jsonb so PageView events carry the full
--      visitor context (fbp, fbc, ad_click_id, utms, referrer, ua, ip).
--   2. Per-studio RPC counting PageViews + from-ads breakdown.
--   3. Per-studio recent-visits list with ad attribution chips.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.capi_events
  ADD COLUMN IF NOT EXISTS visitor_meta jsonb;

COMMENT ON COLUMN public.capi_events.visitor_meta IS
  'For PageView/Lead/Purchase events: the visitor context captured at fire '
  'time (fbp, fbc, ad_click_id, utm_*, referrer, page_url, ua, ip). NULL on '
  'events we fired ourselves from backend (e.g. mb_<sale_id> backfills).';

CREATE INDEX IF NOT EXISTS capi_events_pageview_studio_time_idx
  ON public.capi_events (studio_slug, attempted_at DESC)
  WHERE event_name = 'PageView';

-- ── Per-studio overview · used by dashboard tile ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_trial_page_visitors_overview()
RETURNS TABLE (
  studio_slug       text,
  studio_name       text,
  today             int,
  this_week         int,
  all_time          int,
  from_meta_ads     int,
  unique_visitors_today int,
  unique_visitors_week  int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      c.studio_slug,
      c.attempted_at,
      (c.visitor_meta ? 'fbc') AS has_fbc,
      coalesce(c.visitor_meta->>'fbp', '') AS fbp
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
    coalesce((SELECT count(*) FROM base
              WHERE base.studio_slug = s.studio_slug
                AND base.attempted_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York'
             ), 0)::int AS today,
    coalesce((SELECT count(*) FROM base
              WHERE base.studio_slug = s.studio_slug
                AND base.attempted_at >= now() - interval '7 days'
             ), 0)::int AS this_week,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug), 0)::int AS all_time,
    coalesce((SELECT count(*) FROM base
              WHERE base.studio_slug = s.studio_slug AND base.has_fbc
             ), 0)::int AS from_meta_ads,
    coalesce((SELECT count(DISTINCT fbp) FROM base
              WHERE base.studio_slug = s.studio_slug
                AND base.attempted_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York'
                AND fbp <> ''
             ), 0)::int AS unique_visitors_today,
    coalesce((SELECT count(DISTINCT fbp) FROM base
              WHERE base.studio_slug = s.studio_slug
                AND base.attempted_at >= now() - interval '7 days'
                AND fbp <> ''
             ), 0)::int AS unique_visitors_week
  FROM studios s
  ORDER BY s.studio_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_trial_page_visitors_overview() TO anon, authenticated, service_role;

-- ── Per-studio recent visits · drill-down with ad attribution ─────────────
CREATE OR REPLACE FUNCTION public.get_trial_page_visitors_recent_list(p_studio_slug text DEFAULT NULL)
RETURNS TABLE (
  event_id      text,
  studio_slug   text,
  attempted_at  timestamptz,
  ad_click_id   text,
  fbc           text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  referrer      text,
  page_url      text,
  device_hint   text   -- "ios" / "android" / "desktop" — quick UA classifier
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.event_id::text,
    c.studio_slug,
    c.attempted_at,
    c.visitor_meta->>'ad_click_id'  AS ad_click_id,
    c.visitor_meta->>'fbc'          AS fbc,
    c.visitor_meta->>'utm_source'   AS utm_source,
    c.visitor_meta->>'utm_medium'   AS utm_medium,
    c.visitor_meta->>'utm_campaign' AS utm_campaign,
    c.visitor_meta->>'referrer'     AS referrer,
    c.visitor_meta->>'page_url'     AS page_url,
    CASE
      WHEN c.visitor_meta->>'user_agent' ILIKE '%iphone%'
        OR c.visitor_meta->>'user_agent' ILIKE '%ipad%'    THEN 'ios'
      WHEN c.visitor_meta->>'user_agent' ILIKE '%android%' THEN 'android'
      WHEN c.visitor_meta->>'user_agent' ILIKE '%mac%'
        OR c.visitor_meta->>'user_agent' ILIKE '%windows%' THEN 'desktop'
      ELSE 'other'
    END AS device_hint
  FROM public.capi_events c
  WHERE c.event_name = 'PageView'
    AND c.ok = true
    AND c.attempted_at >= now() - interval '30 days'
    AND (p_studio_slug IS NULL OR c.studio_slug = p_studio_slug)
  ORDER BY c.attempted_at DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.get_trial_page_visitors_recent_list(text) TO anon, authenticated, service_role;

-- Verify
SELECT * FROM public.get_trial_page_visitors_overview();
