-- 2026-08-28: dashboard RPCs for the two new cards (wired into index.html
-- AFTER the owners meeting — these are additive and safe to run anytime).
--   get_promo_funnel()            → sent → claimed → booked → attended per offer
--   get_class_utilization(studio) → attendance by day-of-week × hour (kill/add classes)

-- ── promo funnel ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_promo_funnel()
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH free3_sent AS (
    SELECT COUNT(*) AS n FROM sms_messages WHERE send_path = 'winback_free3' AND status <> 'failed'
  ),
  free3_email AS (
    SELECT COUNT(*) AS n FROM email_log WHERE send_path = 'winback_free3' AND event_type = 'email.sent'
  ),
  claims AS (
    SELECT id, email, location_id FROM trial_signups WHERE payment_status = 'free3_claimed'
  ),
  claim_clients AS (
    SELECT c.email, mc.mt_id
    FROM claims c
    JOIN mariana_tek_clients mc ON LOWER(mc.email) = LOWER(c.email)
  ),
  booked AS (
    SELECT DISTINCT cc.email
    FROM claim_clients cc
    JOIN mariana_tek_visits v ON v.mt_client_id::text = cc.mt_id::text
  ),
  attended AS (
    SELECT DISTINCT cc.email
    FROM claim_clients cc
    JOIN mariana_tek_visits v ON v.mt_client_id::text = cc.mt_id::text
    WHERE v.signed_in IS TRUE
  ),
  joined AS (
    SELECT DISTINCT c.email
    FROM claims c
    JOIN mariana_tek_sales s ON LOWER(s.customer_email) = LOWER(c.email)
    WHERE LOWER(COALESCE(s.item_names,'')) ~ 'contract|pif|month to month|membership'
  )
  SELECT json_build_object(
    'free3', json_build_object(
      'sent',     (SELECT n FROM free3_sent) + (SELECT n FROM free3_email),
      'claimed',  (SELECT COUNT(*) FROM claims),
      'booked',   (SELECT COUNT(*) FROM booked),
      'attended', (SELECT COUNT(*) FROM attended),
      'joined',   (SELECT COUNT(*) FROM joined)
    ),
    'nudges_sent', (SELECT COUNT(*) FROM sms_messages WHERE send_path = 'booking_nudge' AND status <> 'failed'),
    'generated_at', now()
  );
$$;
GRANT EXECUTE ON FUNCTION public.get_promo_funnel() TO authenticated;

-- ── class utilization heatmap ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_class_utilization(p_studio TEXT)
RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH sessions AS (
    SELECT
      v.mt_class_id,
      MIN(v.starts_at AT TIME ZONE 'America/New_York') AS starts_local,
      COUNT(*) FILTER (WHERE v.signed_in IS TRUE) AS attended,
      COUNT(*) AS reserved
    FROM mariana_tek_visits v
    WHERE v.studio_slug = p_studio
      AND v.starts_at >= now() - interval '56 days'
    GROUP BY v.mt_class_id
  ),
  slots AS (
    SELECT
      EXTRACT(ISODOW FROM starts_local)::int AS dow,   -- 1=Mon … 7=Sun
      EXTRACT(HOUR   FROM starts_local)::int AS hour,
      COUNT(*)                          AS class_count,
      ROUND(AVG(attended), 1)           AS avg_attended,
      ROUND(AVG(reserved), 1)           AS avg_reserved
    FROM sessions
    GROUP BY 1, 2
  )
  SELECT json_build_object(
    'studio', p_studio,
    'window_days', 56,
    'slots', COALESCE(json_agg(json_build_object(
      'dow', dow, 'hour', hour,
      'classes', class_count,
      'avg_attended', avg_attended,
      'avg_reserved', avg_reserved
    ) ORDER BY dow, hour), '[]'::json)
  ) FROM slots;
$$;
GRANT EXECUTE ON FUNCTION public.get_class_utilization(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
SELECT 'promo_funnel' AS check, COUNT(*) FROM pg_proc WHERE proname = 'get_promo_funnel'
UNION ALL SELECT 'utilization', COUNT(*) FROM pg_proc WHERE proname = 'get_class_utilization';
