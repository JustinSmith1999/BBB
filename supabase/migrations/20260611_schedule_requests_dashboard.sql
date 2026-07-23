-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-11 · Soft-conversion ("text me the schedule") tracking
--
-- Adds:
--   1. leads.meta jsonb column — captures every signal Meta gives us on
--      arrival: fbp, fbc, utm_*, referrer, user-agent, page_url, time-on-page,
--      and the decoded ad_id from fbc (Meta encodes campaign/ad in fbc).
--   2. get_schedule_requests_overview() RPC for the dashboard tile —
--      per-studio counts (today / week / all-time) + the recent list.
--   3. get_schedule_request_recent_list() — per-studio drill-down with the
--      phone + first name + ad attribution so front desk can call/text.
--
-- Filter rule everywhere:
--   source LIKE 'schedule-request-%'  AND  stage = 'soft_conversion'
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. meta jsonb column
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS meta jsonb;

COMMENT ON COLUMN public.leads.meta IS
  'Visitor context captured at lead-creation time (fbp, fbc, utm_*, referrer, '
  'user_agent, page_url, time_on_page_ms, decoded ad_id, etc). For attributing '
  'soft conversions to specific Meta ads.';

CREATE INDEX IF NOT EXISTS leads_meta_fbc_idx
  ON public.leads ((meta->>'fbc'))
  WHERE meta ? 'fbc';

-- 2. Per-studio overview for the dashboard tile
CREATE OR REPLACE FUNCTION public.get_schedule_requests_overview()
RETURNS TABLE (
  studio_slug      text,
  studio_name      text,
  today            int,
  this_week        int,
  all_time         int,
  -- richer signal counts for trust:
  with_ad_attribution int,
  unique_ads_seen     int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      l.studio_slug,
      l.last_touch_at,
      (l.meta ? 'fbc')                    AS has_fbc,
      coalesce(l.meta->>'ad_id', '')      AS ad_id
    FROM public.leads l
    WHERE l.source LIKE 'schedule-request-%'
      AND l.stage = 'soft_conversion'
  ),
  studios AS (
    SELECT
      lower(replace(name, ' ', '-')) AS studio_slug,
      name AS studio_name
    FROM public.locations
  )
  SELECT
    s.studio_slug,
    s.studio_name,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug
              AND base.last_touch_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York'), 0)::int AS today,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug
              AND base.last_touch_at >= now() - interval '7 days'), 0)::int AS this_week,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug), 0)::int AS all_time,
    coalesce((SELECT count(*) FROM base WHERE base.studio_slug = s.studio_slug AND base.has_fbc), 0)::int AS with_ad_attribution,
    coalesce((SELECT count(DISTINCT ad_id) FROM base
              WHERE base.studio_slug = s.studio_slug AND base.ad_id <> ''), 0)::int AS unique_ads_seen
  FROM studios s
  ORDER BY s.studio_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_schedule_requests_overview() TO anon, authenticated, service_role;

-- 3. Per-studio drill-down list (recent 50 with phone + ad attribution)
CREATE OR REPLACE FUNCTION public.get_schedule_request_recent_list(p_studio_slug text DEFAULT NULL)
RETURNS TABLE (
  lead_id      uuid,
  studio_slug  text,
  full_name    text,
  phone        text,
  last_touch_at timestamptz,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  ad_id        text,
  fbc          text,
  referrer     text,
  page_url     text,
  user_agent   text,
  time_on_page_ms int,
  notes        text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.id                                  AS lead_id,
    l.studio_slug,
    l.full_name,
    l.phone,
    l.last_touch_at,
    l.meta->>'utm_source'                 AS utm_source,
    l.meta->>'utm_medium'                 AS utm_medium,
    l.meta->>'utm_campaign'               AS utm_campaign,
    l.meta->>'ad_id'                      AS ad_id,
    l.meta->>'fbc'                        AS fbc,
    l.meta->>'referrer'                   AS referrer,
    l.meta->>'page_url'                   AS page_url,
    l.meta->>'user_agent'                 AS user_agent,
    nullif(l.meta->>'time_on_page_ms', '')::int  AS time_on_page_ms,
    l.notes
  FROM public.leads l
  WHERE l.source LIKE 'schedule-request-%'
    AND l.stage = 'soft_conversion'
    AND (p_studio_slug IS NULL OR l.studio_slug = p_studio_slug)
  ORDER BY l.last_touch_at DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.get_schedule_request_recent_list(text) TO anon, authenticated, service_role;

-- Verify
SELECT * FROM public.get_schedule_requests_overview();
