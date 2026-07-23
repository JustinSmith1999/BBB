-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Comeback email open + click tracking on dashboard.
--
-- Resend's webhook handler (resend-webhook function) already writes
-- email_log rows for event_type IN ('email.sent', 'email.delivered',
-- 'email.opened', 'email.clicked', 'email.bounced', 'email.complained'),
-- tagged by send_path and trial_signup_id. We just need to count distinct
-- recipients per studio for the dashboard.
--
-- Extends get_comeback_overview with two columns:
--   - opened_all_time  : distinct trial_signups that have ≥1 email.opened
--   - clicked_all_time : distinct trial_signups that have ≥1 email.clicked
-- Both filtered to send_path = 'comeback_email_fu1' (so it only counts
-- comeback follow-up emails, not welcomes / abandoned-cart / etc).
--
-- Also extends get_comeback_recent_list with two booleans:
--   - email_opened  : this recipient opened at least one comeback email
--   - email_clicked : this recipient clicked through from one
-- so the dashboard tile can show a 📨 / 🔗 badge next to each name.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. get_comeback_overview · add opened/clicked columns ─────────────────
DROP FUNCTION IF EXISTS public.get_comeback_overview();
CREATE OR REPLACE FUNCTION public.get_comeback_overview()
RETURNS TABLE(
  studio_slug          TEXT,
  studio_name          TEXT,
  sms_sent_today       INTEGER,
  sms_sent_this_week   INTEGER,
  sms_sent_all_time    INTEGER,
  email_sent_all_time  INTEGER,
  email_opened_all_time  INTEGER,
  email_clicked_all_time INTEGER,
  clicked_all_time     INTEGER,
  converted_all_time   INTEGER,
  replied_all_time     INTEGER,
  conversion_rate_pct  NUMERIC,
  revenue_cents_total  INTEGER,
  last_sms_sent_at     TIMESTAMPTZ
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
  ),
  -- Email engagement: count distinct trial_signup_ids that have at least
  -- one open or click event in email_log for the comeback follow-up.
  engagement AS (
    SELECT
      LOWER(REPLACE(l.name, ' ', '-')) AS studio_slug,
      COUNT(DISTINCT el.trial_signup_id) FILTER (WHERE el.event_type = 'email.opened')::INTEGER  AS email_opened_all_time,
      COUNT(DISTINCT el.trial_signup_id) FILTER (WHERE el.event_type = 'email.clicked')::INTEGER AS email_clicked_all_time
    FROM public.email_log el
    JOIN public.trial_signups ts ON ts.id = el.trial_signup_id
    JOIN public.locations l ON l.id = ts.location_id
    WHERE el.send_path = 'comeback_email_fu1'
      AND el.trial_signup_id IS NOT NULL
    GROUP BY l.name
  )
  SELECT
    b.studio_slug,
    b.studio_name,
    COALESCE(m.sms_sent_today, 0),
    COALESCE(m.sms_sent_this_week, 0),
    COALESCE(m.sms_sent_all_time, 0),
    COALESCE(m.email_sent_all_time, 0),
    COALESCE(e.email_opened_all_time, 0),
    COALESCE(e.email_clicked_all_time, 0),
    COALESCE(m.clicked_all_time, 0),
    COALESCE(m.converted_all_time, 0),
    COALESCE(m.replied_all_time, 0),
    CASE
      WHEN COALESCE(m.sms_sent_all_time, 0) = 0 THEN 0
      ELSE ROUND(100.0 * COALESCE(m.converted_all_time, 0) / m.sms_sent_all_time, 1)
    END,
    (COALESCE(m.converted_all_time, 0) * 2900)::INTEGER,
    m.last_sms_sent_at
  FROM base b
  LEFT JOIN metrics    m ON m.studio_slug = b.studio_slug
  LEFT JOIN engagement e ON e.studio_slug = b.studio_slug
  ORDER BY b.studio_slug;
$$;
GRANT EXECUTE ON FUNCTION public.get_comeback_overview() TO anon, authenticated;


-- ── 2. get_comeback_recent_list · add email_opened + email_clicked flags ──
DROP FUNCTION IF EXISTS public.get_comeback_recent_list(text);
CREATE OR REPLACE FUNCTION public.get_comeback_recent_list(p_studio_slug TEXT)
RETURNS TABLE(
  trial_signup_id        UUID,
  name                   TEXT,
  email                  TEXT,
  phone                  TEXT,
  comeback_sms_sent_at   TIMESTAMPTZ,
  comeback_email_sent_at TIMESTAMPTZ,
  comeback_clicked_at    TIMESTAMPTZ,
  comeback_converted_at  TIMESTAMPTZ,
  comeback_sms_error     TEXT,
  last_inbound_at        TIMESTAMPTZ,
  last_inbound_body      TEXT,
  replied                BOOLEAN,
  email_opened           BOOLEAN,
  email_clicked          BOOLEAN,
  stage                  TEXT
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
       AND ts.last_inbound_at > ts.comeback_sms_sent_at) AS replied,
      EXISTS (
        SELECT 1 FROM public.email_log el
         WHERE el.trial_signup_id = ts.id
           AND el.send_path = 'comeback_email_fu1'
           AND el.event_type = 'email.opened'
      ) AS email_opened,
      EXISTS (
        SELECT 1 FROM public.email_log el
         WHERE el.trial_signup_id = ts.id
           AND el.send_path = 'comeback_email_fu1'
           AND el.event_type = 'email.clicked'
      ) AS email_clicked
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
    src.email_opened,
    src.email_clicked,
    CASE
      WHEN src.comeback_converted_at IS NOT NULL THEN 'converted'
      WHEN src.comeback_clicked_at   IS NOT NULL THEN 'clicked'
      WHEN src.email_clicked                       THEN 'email_clicked'
      WHEN src.replied                              THEN 'replied'
      WHEN src.email_opened                         THEN 'email_opened'
      WHEN src.comeback_email_sent_at IS NOT NULL THEN 'emailed'
      WHEN src.comeback_sms_sent_at  IS NOT NULL THEN 'texted'
      WHEN src.comeback_sms_error    IS NOT NULL THEN 'failed'
      ELSE 'unknown'
    END AS stage
  FROM src
  ORDER BY
    CASE
      WHEN src.comeback_converted_at IS NOT NULL THEN 0
      WHEN src.comeback_clicked_at   IS NOT NULL THEN 1
      WHEN src.email_clicked                       THEN 2
      WHEN src.replied                              THEN 3
      WHEN src.email_opened                         THEN 4
      ELSE 5
    END,
    COALESCE(
      src.comeback_converted_at,
      src.comeback_clicked_at,
      src.last_inbound_at,
      src.comeback_email_sent_at,
      src.comeback_sms_sent_at
    ) DESC
  LIMIT 25;
$$;
GRANT EXECUTE ON FUNCTION public.get_comeback_recent_list(TEXT) TO anon, authenticated;
