-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Schedule-request soft-conversion form now captures first name,
-- last name, AND email (was just first name + phone). Add the missing
-- columns to leads so the upsert lands and dashboard RPCs can expose them.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name  TEXT;

-- Backfill from full_name where possible — best-effort split on first space.
-- Skips rows that already have first_name set (re-run safe).
UPDATE public.leads
SET first_name = split_part(full_name, ' ', 1),
    last_name  = NULLIF(regexp_replace(full_name, '^[^ ]+ *', ''), '')
WHERE full_name IS NOT NULL
  AND first_name IS NULL;

-- Index for /homebase + dashboard recent-list lookups.
CREATE INDEX IF NOT EXISTS idx_leads_studio_recent
  ON public.leads (studio_slug, last_touch_at DESC);

-- ── Update get_schedule_request_recent_list to return first/last/email
-- separately so the dashboard tile can render proper columns instead of
-- having to split full_name client-side.
DROP FUNCTION IF EXISTS public.get_schedule_request_recent_list(text);
CREATE OR REPLACE FUNCTION public.get_schedule_request_recent_list(p_studio_slug TEXT)
RETURNS TABLE(
  lead_id          UUID,
  studio_slug      TEXT,
  first_name       TEXT,
  last_name        TEXT,
  full_name        TEXT,
  email            TEXT,
  phone            TEXT,
  created_at       TIMESTAMPTZ,
  last_touch_at    TIMESTAMPTZ,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  ad_id            TEXT,
  fbc              TEXT,
  referrer         TEXT,
  page_url         TEXT,
  user_agent       TEXT,
  time_on_page_ms  BIGINT,
  notes            TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT
    l.id,
    l.studio_slug,
    COALESCE(l.first_name, split_part(l.full_name, ' ', 1))      AS first_name,
    COALESCE(l.last_name, NULLIF(regexp_replace(l.full_name, '^[^ ]+ *', ''), '')) AS last_name,
    l.full_name,
    l.email,
    l.phone,
    l.created_at,
    l.last_touch_at,
    l.meta->>'utm_source'                                AS utm_source,
    l.meta->>'utm_medium'                                AS utm_medium,
    l.meta->>'utm_campaign'                              AS utm_campaign,
    l.meta->>'ad_click_id'                               AS ad_id,
    l.meta->>'fbc'                                       AS fbc,
    l.meta->>'referrer'                                  AS referrer,
    l.meta->>'page_url'                                  AS page_url,
    l.meta->>'user_agent'                                AS user_agent,
    (l.meta->>'time_on_page_ms')::BIGINT                 AS time_on_page_ms,
    l.notes
  FROM public.leads l
  WHERE l.studio_slug = p_studio_slug
    AND l.source LIKE 'schedule-request-%'
  ORDER BY l.created_at DESC
  LIMIT 25;
$$;

GRANT EXECUTE ON FUNCTION public.get_schedule_request_recent_list(TEXT) TO anon, authenticated;
