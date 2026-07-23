-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · get_data_freshness — single RPC the /ops page hits to render
-- "are all analytics live?" widget. Returns the last-update timestamp per
-- data source so Justin can spot a silent sync failure within minutes.
--
-- Each row: {source, last_update, age_seconds, status: ok|stale|dead}
--   ok    = updated within expected cadence
--   stale = older than expected cadence × 2
--   dead  = older than 6 hours OR table is empty
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_data_freshness();
CREATE OR REPLACE FUNCTION public.get_data_freshness()
RETURNS TABLE(
  source       TEXT,
  description  TEXT,
  last_update  TIMESTAMPTZ,
  age_seconds  BIGINT,
  expected_cadence_minutes INTEGER,
  status       TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  PERFORM public.assert_ops_admin();

  RETURN QUERY
  WITH t AS (
    SELECT 'meta_ad_spend'::TEXT                  AS source,
           'Meta ad insights (spend/clicks)'::TEXT AS description,
           (SELECT MAX(synced_at) FROM meta_insights_daily) AS last_update,
           5 AS cadence_min
    UNION ALL
    SELECT 'stripe_paid_mirror',
           'Stripe paid trials',
           (SELECT MAX(paid_at) FROM stripe_paid_mirror),
           5
    UNION ALL
    SELECT 'trial_signups',
           'Trial form fills',
           (SELECT MAX(created_at) FROM trial_signups),
           5
    UNION ALL
    SELECT 'mindbody_sales',
           'MindBody sales (members)',
           (SELECT MAX(synced_at) FROM mindbody_sales),
           10
    UNION ALL
    SELECT 'mindbody_visits',
           'MindBody class check-ins',
           (SELECT MAX(synced_at) FROM mindbody_visits),
           10
    UNION ALL
    SELECT 'mindbody_clients',
           'MindBody client list (linking)',
           (SELECT MAX(synced_at) FROM mindbody_clients),
           30
    UNION ALL
    SELECT 'capi_events',
           'Trial page CAPI fires',
           (SELECT MAX(attempted_at) FROM capi_events),
           5
    UNION ALL
    SELECT 'sms_messages',
           'SMS inbound + outbound',
           (SELECT MAX(sent_at) FROM sms_messages),
           60
    UNION ALL
    SELECT 'email_log',
           'Email send log',
           (SELECT MAX(created_at) FROM email_log),
           60
    UNION ALL
    SELECT 'leads_schedule_requests',
           'Schedule-request soft conversions',
           (SELECT MAX(created_at) FROM leads WHERE source LIKE 'schedule-request-%'),
           60
    UNION ALL
    SELECT 'gsc_metrics',
           'Google Search Console (daily)',
           (SELECT MAX(synced_at) FROM gsc_metrics),
           24 * 60
    UNION ALL
    SELECT 'gbp_metrics',
           'Google Business Profile (daily)',
           (SELECT MAX(synced_at) FROM gbp_metrics),
           24 * 60
  )
  SELECT
    t.source,
    t.description,
    t.last_update,
    EXTRACT(EPOCH FROM (v_now - t.last_update))::BIGINT AS age_seconds,
    t.cadence_min AS expected_cadence_minutes,
    CASE
      WHEN t.last_update IS NULL                            THEN 'dead'
      WHEN v_now - t.last_update > interval '6 hours'       THEN 'dead'
      WHEN v_now - t.last_update > make_interval(mins => t.cadence_min * 2) THEN 'stale'
      ELSE 'ok'
    END AS status
  FROM t
  ORDER BY
    CASE
      WHEN t.last_update IS NULL THEN 0
      ELSE EXTRACT(EPOCH FROM (v_now - t.last_update))::BIGINT
    END DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_data_freshness() TO authenticated;
