-- ─────────────────────────────────────────────────────────────────────────────
-- Two surgical fixes:
--   1. refresh_dashboard_kpis() — has been ERRORing every 5 min for who knows
--      how long. References `total_amount_cents` which doesn't exist on any
--      current table. Rewrite to use only existing columns: revenue_30d is
--      computed as (count of completed paid trials in last 30d) × 4900, which
--      is the only revenue stream we currently capture. Members/leads/visits/
--      calls pulled from real tables; defensive COALESCE so missing tables
--      become 0 instead of failing.
--
--   2. get_ops_activity_feed() — has been returning empty for the same reason
--      get_ops_status's SMS section did: sms_messages doesn't exist yet, so
--      the UNION fails and the outer exception swallows the cron rows too.
--      Guard the sms_evts CTE with to_regclass.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Fix refresh_dashboard_kpis() ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_dashboard_kpis()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_members_total   bigint := 0;
  v_leads_total     bigint := 0;
  v_leads_converted bigint := 0;
  v_visits_total    bigint := 0;
  v_calls_total     bigint := 0;
  v_sessions_today  bigint := 0;
  v_sessions_future bigint := 0;
  v_revenue_30d     bigint := 0;
BEGIN
  -- Revenue: every completed paid trial in the last 30 days is $49.
  -- (mindbody_sales would be the right source long-term, but that table is
  -- empty until the MindBody sync is fixed. trial_signups is what we have.)
  SELECT COALESCE(COUNT(*), 0) * 4900 INTO v_revenue_30d
  FROM trial_signups
  WHERE payment_status = 'completed'
    AND deleted_at IS NULL
    AND payment_date >= now() - interval '30 days';

  -- Leads + conversions from trial_signups (real, populated).
  SELECT COUNT(*) INTO v_leads_total
  FROM trial_signups WHERE deleted_at IS NULL;

  SELECT COUNT(*) INTO v_leads_converted
  FROM trial_signups
  WHERE deleted_at IS NULL AND payment_status = 'completed';

  -- Visits from mindbody_visits (real, populated — 288k+ rows).
  BEGIN
    SELECT COUNT(*) INTO v_visits_total FROM mindbody_visits;
  EXCEPTION WHEN OTHERS THEN v_visits_total := 0;
  END;

  -- Members: try mindbody_clients; defaults to 0 if empty / missing.
  BEGIN
    EXECUTE 'SELECT COUNT(*) FROM public.mindbody_clients' INTO v_members_total;
  EXCEPTION WHEN OTHERS THEN v_members_total := 0;
  END;

  -- Calls: try a few likely tables (vapi_calls is what vapi-calls-sync writes).
  BEGIN
    EXECUTE 'SELECT COUNT(*) FROM public.vapi_calls' INTO v_calls_total;
  EXCEPTION WHEN OTHERS THEN v_calls_total := 0;
  END;

  -- Sessions today + future from mindbody_visits.starts_at.
  BEGIN
    SELECT
      COUNT(*) FILTER (WHERE (starts_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date),
      COUNT(*) FILTER (WHERE starts_at > now())
    INTO v_sessions_today, v_sessions_future
    FROM mindbody_visits;
  EXCEPTION WHEN OTHERS THEN
    v_sessions_today := 0; v_sessions_future := 0;
  END;

  -- Single-row cache table: insert if absent, otherwise update id=1.
  INSERT INTO dashboard_kpis (id, members_total, leads_total, leads_converted,
                              visits_total, calls_total, sessions_today,
                              sessions_future, revenue_30d_cents, refreshed_at)
  VALUES (1, v_members_total, v_leads_total, v_leads_converted, v_visits_total,
          v_calls_total, v_sessions_today, v_sessions_future, v_revenue_30d, now())
  ON CONFLICT (id) DO UPDATE SET
    members_total     = EXCLUDED.members_total,
    leads_total       = EXCLUDED.leads_total,
    leads_converted   = EXCLUDED.leads_converted,
    visits_total      = EXCLUDED.visits_total,
    calls_total       = EXCLUDED.calls_total,
    sessions_today    = EXCLUDED.sessions_today,
    sessions_future   = EXCLUDED.sessions_future,
    revenue_30d_cents = EXCLUDED.revenue_30d_cents,
    refreshed_at      = EXCLUDED.refreshed_at;
END;
$function$;

-- ── 2. Fix get_ops_activity_feed (guard sms_messages) ───────────────────────
CREATE OR REPLACE FUNCTION public.get_ops_activity_feed(p_limit int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'cron', 'pg_catalog'
AS $function$
DECLARE
  v_feed jsonb := '[]'::jsonb;
  v_has_sms boolean := to_regclass('public.sms_messages') IS NOT NULL;
BEGIN
  PERFORM public.assert_ops_admin();

  IF v_has_sms THEN
    WITH
      cron_runs AS (
        SELECT jrd.start_time AS at, 'cron'::text AS kind,
          COALESCE(j.jobname, 'job-' || jrd.jobid::text) AS title,
          jrd.status::text AS sub,
          CASE WHEN length(jrd.return_message) > 160 THEN substring(jrd.return_message, 1, 160) || '…' ELSE jrd.return_message END AS body
        FROM cron.job_run_details jrd LEFT JOIN cron.job j USING (jobid)
        WHERE jrd.start_time >= now() - interval '24 hours'
      ),
      sms_evts AS (
        SELECT created_at AS at, 'sms'::text AS kind,
          CASE direction
            WHEN 'inbound'  THEN 'SMS in  · ' || COALESCE(from_phone, '?')
            WHEN 'outbound' THEN 'SMS out · ' || COALESCE(to_phone, '?')
            ELSE 'SMS · ' || COALESCE(from_phone, to_phone, '?') END AS title,
          COALESCE(status, '—') AS sub,
          CASE WHEN length(body) > 160 THEN substring(body, 1, 160) || '…' ELSE body END AS body
        FROM sms_messages WHERE created_at >= now() - interval '24 hours'
      ),
      combined AS (SELECT * FROM cron_runs UNION ALL SELECT * FROM sms_evts)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('at',at,'kind',kind,'title',title,'sub',sub,'body',body) ORDER BY at DESC), '[]'::jsonb)
    INTO v_feed FROM (SELECT * FROM combined ORDER BY at DESC LIMIT p_limit) x;
  ELSE
    -- sms_messages doesn't exist yet — cron rows only.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'at',    jrd.start_time,
      'kind',  'cron',
      'title', COALESCE(j.jobname, 'job-' || jrd.jobid::text),
      'sub',   jrd.status::text,
      'body',  CASE WHEN length(jrd.return_message) > 160 THEN substring(jrd.return_message, 1, 160) || '…' ELSE jrd.return_message END
    ) ORDER BY jrd.start_time DESC), '[]'::jsonb)
    INTO v_feed
    FROM (
      SELECT jrd.start_time, jrd.jobid, jrd.status, jrd.return_message
      FROM cron.job_run_details jrd
      WHERE jrd.start_time >= now() - interval '24 hours'
      ORDER BY jrd.start_time DESC
      LIMIT p_limit
    ) jrd
    LEFT JOIN cron.job j USING (jobid);
  END IF;

  RETURN jsonb_build_object('as_of', now(), 'events', v_feed, 'sms_table', v_has_sms);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('as_of', now(), 'events', '[]'::jsonb, 'error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ops_activity_feed(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ops_activity_feed(int) TO authenticated;

-- Sanity (run after):
--   SELECT refresh_dashboard_kpis();
--   SELECT * FROM dashboard_kpis;
--   SELECT public.get_ops_activity_feed(20);
