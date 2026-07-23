-- ─────────────────────────────────────────────────────────────────────────────
-- CAPI events log — make Meta Conversions API failures impossible to miss.
--
-- Justin: "every single day you tell me Facebook isn't getting CAPI events,
-- then you say you fix it, then it happens again." This addresses the *pattern*,
-- not a single instance. Three layers:
--
--   1. capi_events table — one row per CAPI send attempt, success OR failure
--   2. get_capi_status() RPC — per-studio: last_ok_at, last_attempt_at, error
--   3. is_capi_silent() helper — TRUE if no successful send in N hours
--
-- After this lands, the dashboard /ops page can show a green/red tile per studio
-- and the failure mode "silent no-op for weeks" becomes structurally impossible.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.capi_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  studio_slug     text NOT NULL,
  pixel_id        text,
  event_name      text NOT NULL,                -- 'Purchase', 'Lead', etc.
  event_id        text,                          -- the dedup key sent to Meta
  value_usd       numeric(10,2),
  ok              boolean NOT NULL,
  http_status     int,
  meta_event_id   text,                          -- Meta's returned id (when ok)
  error           text,                          -- error message / response body slice
  -- Full request/response for debugging — kept in jsonb so we can dig later
  raw             jsonb
);

CREATE INDEX IF NOT EXISTS capi_events_studio_attempted_idx
  ON public.capi_events (studio_slug, attempted_at DESC);

CREATE INDEX IF NOT EXISTS capi_events_attempted_idx
  ON public.capi_events (attempted_at DESC);

-- Keep the table small: 30-day rolling window.
DELETE FROM public.capi_events WHERE attempted_at < now() - interval '30 days';


-- ── RPC: per-studio CAPI health summary ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_capi_status();

CREATE OR REPLACE FUNCTION public.get_capi_status()
RETURNS TABLE (
  studio_slug          text,
  pixel_id             text,
  has_access_token     boolean,
  last_attempt_at      timestamptz,
  last_ok_at           timestamptz,
  last_fail_at         timestamptz,
  last_error           text,
  attempts_24h         int,
  successes_24h        int,
  failures_24h         int,
  ok_silence_hours     numeric,
  status               text                     -- 'ok' | 'warn' | 'red' | 'never'
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH studios AS (
    SELECT m.studio_slug, m.pixel_id,
           (m.access_token IS NOT NULL AND m.access_token <> '') AS has_access_token
    FROM public.meta_accounts m
  ),
  agg AS (
    SELECT
      e.studio_slug,
      MAX(e.attempted_at) AS last_attempt_at,
      MAX(e.attempted_at) FILTER (WHERE e.ok) AS last_ok_at,
      MAX(e.attempted_at) FILTER (WHERE NOT e.ok) AS last_fail_at,
      (SELECT error FROM public.capi_events ce
        WHERE ce.studio_slug = e.studio_slug AND NOT ce.ok
        ORDER BY ce.attempted_at DESC LIMIT 1) AS last_error,
      COUNT(*) FILTER (WHERE e.attempted_at >= now() - interval '24 hours')::int AS attempts_24h,
      COUNT(*) FILTER (WHERE e.attempted_at >= now() - interval '24 hours' AND e.ok)::int AS successes_24h,
      COUNT(*) FILTER (WHERE e.attempted_at >= now() - interval '24 hours' AND NOT e.ok)::int AS failures_24h
    FROM public.capi_events e
    GROUP BY e.studio_slug
  )
  SELECT
    s.studio_slug,
    s.pixel_id,
    s.has_access_token,
    a.last_attempt_at,
    a.last_ok_at,
    a.last_fail_at,
    a.last_error,
    COALESCE(a.attempts_24h, 0)  AS attempts_24h,
    COALESCE(a.successes_24h, 0) AS successes_24h,
    COALESCE(a.failures_24h, 0)  AS failures_24h,
    CASE WHEN a.last_ok_at IS NULL THEN NULL
         ELSE ROUND(EXTRACT(EPOCH FROM (now() - a.last_ok_at)) / 3600.0, 1)
    END AS ok_silence_hours,
    CASE
      WHEN s.pixel_id IS NULL OR NOT s.has_access_token THEN 'never'  -- mis-configured
      WHEN a.last_ok_at IS NULL                          THEN 'never'  -- never succeeded
      WHEN a.last_ok_at < now() - interval '48 hours'    THEN 'red'    -- silent ≥48h
      WHEN a.last_ok_at < now() - interval '24 hours'    THEN 'warn'   -- silent ≥24h
      ELSE 'ok'
    END AS status
  FROM studios s
  LEFT JOIN agg a USING (studio_slug)
  ORDER BY s.studio_slug;
$$;

REVOKE ALL ON FUNCTION public.get_capi_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_capi_status() TO authenticated;


-- ── Cron: daily silence alert (writes a row to ops_alerts when red) ─────────
-- Simple sentinel: if ANY studio has been silent ≥24h, insert a "warn" row
-- into the existing activity feed so it bubbles up on /ops.
-- (No outbound notification yet — that would risk owner spam. Visibility only.)

-- ops_alerts may not exist yet; create defensively.
CREATE TABLE IF NOT EXISTS public.ops_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raised_at   timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  severity    text NOT NULL,        -- 'info' | 'warn' | 'red'
  studio_slug text,
  message     text NOT NULL,
  details     jsonb
);

CREATE INDEX IF NOT EXISTS ops_alerts_raised_idx ON public.ops_alerts (raised_at DESC);


-- ── Initial visibility: dump current status so Justin sees it now ───────────
SELECT * FROM public.get_capi_status();
