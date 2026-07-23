-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Surface comeback-SMS replies on the dashboard tile.
--
-- We already capture inbound replies (twilio-inbound-sms webhook writes
-- last_inbound_at + last_inbound_body on trial_signups), but the comeback
-- tile didn't count them. So a recipient who texts "yes please send me the
-- link" was invisible on the dashboard unless staff opened their card.
--
-- This migration:
--   1. Adds `replied_all_time` to get_comeback_overview — counts trial_signups
--      where the recipient texted back AFTER the comeback SMS fired.
--   2. Adds `last_inbound_at` + `last_inbound_body` + a `replied` boolean to
--      get_comeback_recent_list so the tile can render a 💬 badge with the
--      reply preview on each row.
--   3. Bumps the recent-list stage enum so "replied" sits above "texted" but
--      below "clicked" → "converted" — so the most engaged recipients stay
--      on top of the list.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. get_comeback_overview · add replied_all_time ───────────────────────
DROP FUNCTION IF EXISTS public.get_comeback_overview();
CREATE OR REPLACE FUNCTION public.get_comeback_overview()
RETURNS TABLE(
  studio_slug   TEXT,
  studio_name   TEXT,
  sms_sent_today      INTEGER,
  sms_sent_this_week  INTEGER,
  sms_sent_all_time   INTEGER,
  email_sent_all_time INTEGER,
  clicked_all_time    INTEGER,
  converted_all_time  INTEGER,
  replied_all_time    INTEGER,
  conversion_rate_pct NUMERIC,
  revenue_cents_total INTEGER,
  last_sms_sent_at    TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH base AS (
    SELECT
      LOWER(REPLACE(l.name, ' ', '-')) AS studio_slug,
      l.name AS studio_name,
      l.id   AS location_id
    FROM public.locations l
  ),
  metrics AS (
    SELECT
      LOWER(REPLACE(l.name, ' ', '-')) AS studio_slug,
      COUNT(*) FILTER (WHERE ts.comeback_sms_sent_at >= (CURRENT_DATE AT TIME ZONE 'America/New_York'))::INTEGER AS sms_sent_today,
      COUNT(*) FILTER (WHERE ts.comeback_sms_sent_at >= date_trunc('week', CURRENT_DATE AT TIME ZONE 'America/New_York'))::INTEGER AS sms_sent_this_week,
      COUNT(*) FILTER (WHERE ts.comeback_sms_sent_at IS NOT NULL)::INTEGER AS sms_sent_all_time,
      COUNT(*) FILTER (WHERE ts.comeback_email_sent_at IS NOT NULL)::INTEGER AS email_sent_all_time,
      COUNT(*) FILTER (WHERE ts.comeback_clicked_at IS NOT NULL)::INTEGER AS clicked_all_time,
      COUNT(*) FILTER (WHERE ts.comeback_converted_at IS NOT NULL)::INTEGER AS converted_all_time,
      -- A reply counts only if it landed AFTER the comeback SMS fired
      -- (otherwise we'd double-count any pre-existing inbound on their record).
      COUNT(*) FILTER (
        WHERE ts.last_inbound_at IS NOT NULL
          AND ts.last_inbound_at > ts.comeback_sms_sent_at
      )::INTEGER AS replied_all_time,
      MAX(ts.comeback_sms_sent_at) AS last_sms_sent_at
    FROM public.trial_signups ts
    JOIN public.locations l ON l.id = ts.location_id
    WHERE ts.comeback_sms_sent_at IS NOT NULL
       OR ts.comeback_email_sent_at IS NOT NULL
    GROUP BY l.name
  )
  SELECT
    b.studio_slug,
    b.studio_name,
    COALESCE(m.sms_sent_today, 0),
    COALESCE(m.sms_sent_this_week, 0),
    COALESCE(m.sms_sent_all_time, 0),
    COALESCE(m.email_sent_all_time, 0),
    COALESCE(m.clicked_all_time, 0),
    COALESCE(m.converted_all_time, 0),
    COALESCE(m.replied_all_time, 0),
    CASE
      WHEN COALESCE(m.sms_sent_all_time, 0) = 0 THEN 0
      ELSE ROUND(100.0 * COALESCE(m.converted_all_time, 0) / m.sms_sent_all_time, 1)
    END AS conversion_rate_pct,
    (COALESCE(m.converted_all_time, 0) * 2900)::INTEGER AS revenue_cents_total,
    m.last_sms_sent_at
  FROM base b
  LEFT JOIN metrics m ON m.studio_slug = b.studio_slug
  ORDER BY b.studio_slug;
$$;

GRANT EXECUTE ON FUNCTION public.get_comeback_overview() TO anon, authenticated;


-- ── 2. get_comeback_recent_list · surface inbound replies ─────────────────
DROP FUNCTION IF EXISTS public.get_comeback_recent_list(text);
CREATE OR REPLACE FUNCTION public.get_comeback_recent_list(p_studio_slug TEXT)
RETURNS TABLE(
  trial_signup_id     UUID,
  name                TEXT,
  email               TEXT,
  phone               TEXT,
  comeback_sms_sent_at    TIMESTAMPTZ,
  comeback_email_sent_at  TIMESTAMPTZ,
  comeback_clicked_at     TIMESTAMPTZ,
  comeback_converted_at   TIMESTAMPTZ,
  comeback_sms_error      TEXT,
  last_inbound_at         TIMESTAMPTZ,
  last_inbound_body       TEXT,
  replied                 BOOLEAN,
  stage TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH src AS (
    SELECT
      ts.id,
      ts.name,
      ts.email,
      ts.phone,
      ts.comeback_sms_sent_at,
      ts.comeback_email_sent_at,
      ts.comeback_clicked_at,
      ts.comeback_converted_at,
      ts.comeback_sms_error,
      ts.last_inbound_at,
      ts.last_inbound_body,
      (ts.last_inbound_at IS NOT NULL
       AND ts.last_inbound_at > ts.comeback_sms_sent_at) AS replied
    FROM public.trial_signups ts
    JOIN public.locations l ON l.id = ts.location_id
    WHERE LOWER(REPLACE(l.name, ' ', '-')) = p_studio_slug
      AND (ts.comeback_sms_sent_at IS NOT NULL
        OR ts.comeback_email_sent_at IS NOT NULL
        OR ts.comeback_sms_error IS NOT NULL)
  )
  SELECT
    src.id,
    src.name,
    src.email,
    src.phone,
    src.comeback_sms_sent_at,
    src.comeback_email_sent_at,
    src.comeback_clicked_at,
    src.comeback_converted_at,
    src.comeback_sms_error,
    src.last_inbound_at,
    src.last_inbound_body,
    src.replied,
    CASE
      WHEN src.comeback_converted_at IS NOT NULL THEN 'converted'
      WHEN src.comeback_clicked_at   IS NOT NULL THEN 'clicked'
      WHEN src.replied                              THEN 'replied'
      WHEN src.comeback_email_sent_at IS NOT NULL THEN 'emailed'
      WHEN src.comeback_sms_sent_at  IS NOT NULL THEN 'texted'
      WHEN src.comeback_sms_error    IS NOT NULL THEN 'failed'
      ELSE 'unknown'
    END AS stage
  FROM src
  -- Most engaged first: converted → clicked → replied → … → texted
  ORDER BY
    CASE
      WHEN src.comeback_converted_at IS NOT NULL THEN 0
      WHEN src.comeback_clicked_at   IS NOT NULL THEN 1
      WHEN src.replied                              THEN 2
      ELSE 3
    END,
    COALESCE(src.comeback_converted_at, src.comeback_clicked_at, src.last_inbound_at, src.comeback_sms_sent_at) DESC
  LIMIT 25;
$$;

GRANT EXECUTE ON FUNCTION public.get_comeback_recent_list(TEXT) TO anon, authenticated;

-- ── 3. Sanity check ──────────────────────────────────────────────────────
SELECT * FROM public.get_comeback_overview();
