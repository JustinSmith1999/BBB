-- ─────────────────────────────────────────────────────────────────────────────
-- get_ops_status — single live view of "what's running" for the owner dashboard.
--
-- Background: on 2026-05-31 a `funnel-recovery` edge function got scheduled
-- to send daily owner-digest emails. Nobody knew it existed until 4 gym
-- owners got spammed. The cron job + function existed in the project but
-- the only kill switch was the Supabase Dashboard, and Justin had no live
-- visibility into what was scheduled.
--
-- This RPC exposes three things to the dashboard so spam can be SEEN before
-- it's sent:
--   1. cron.job rows (job name, schedule, active flag, last command)
--   2. cron.job_run_details: when each job last ran + status (success/failure)
--   3. last-24h notification volume by direction (from sms_messages, the
--      gateway logging table). Email volume not yet logged in-app — Resend
--      logs would need to be pulled separately.
--
-- Output shape: jsonb { cron_jobs: [...], recent_runs: [...], sms_24h: {...} }
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_ops_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'cron', 'pg_catalog'
AS $function$
DECLARE
  v_cron     jsonb := '[]'::jsonb;
  v_runs     jsonb := '[]'::jsonb;
  v_sms      jsonb := '{}'::jsonb;
BEGIN
  -- 1. Currently scheduled cron jobs.
  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'jobid',    jobid,
      'jobname',  jobname,
      'schedule', schedule,
      'active',   active,
      'command',  -- only the first 240 chars so we don't leak full SQL
                  CASE WHEN length(command) > 240
                       THEN substring(command, 1, 240) || '…'
                       ELSE command
                  END
    ) ORDER BY jobid), '[]'::jsonb)
    INTO v_cron
    FROM cron.job;
  EXCEPTION WHEN OTHERS THEN
    v_cron := jsonb_build_array(jsonb_build_object('error', SQLERRM));
  END;

  -- 2. Last-run details — most recent 30 entries across all jobs.
  BEGIN
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
    INTO v_runs
    FROM (
      SELECT
        jrd.jobid,
        j.jobname,
        jrd.start_time,
        jrd.end_time,
        jrd.status,
        CASE WHEN length(jrd.return_message) > 200
             THEN substring(jrd.return_message, 1, 200) || '…'
             ELSE jrd.return_message
        END AS return_message
      FROM cron.job_run_details jrd
      LEFT JOIN cron.job j USING (jobid)
      ORDER BY jrd.start_time DESC NULLS LAST
      LIMIT 30
    ) r;
  EXCEPTION WHEN OTHERS THEN
    v_runs := jsonb_build_array(jsonb_build_object('error', SQLERRM));
  END;

  -- 3. SMS gateway volume in the last 24h, split by direction + status.
  BEGIN
    SELECT jsonb_build_object(
      'window_hours', 24,
      'inbound',  COUNT(*) FILTER (WHERE direction = 'inbound'),
      'outbound', COUNT(*) FILTER (WHERE direction = 'outbound'),
      'failed',   COUNT(*) FILTER (WHERE status IN ('failed', 'undelivered')),
      'delivered',COUNT(*) FILTER (WHERE status = 'delivered'),
      'queued',   COUNT(*) FILTER (WHERE status IN ('queued', 'sent', 'received'))
    )
    INTO v_sms
    FROM public.sms_messages
    WHERE created_at >= now() - interval '24 hours';
  EXCEPTION WHEN OTHERS THEN
    v_sms := jsonb_build_object('error', SQLERRM);
  END;

  RETURN jsonb_build_object(
    'as_of',       now(),
    'cron_jobs',   v_cron,
    'recent_runs', v_runs,
    'sms_24h',     v_sms
  );
END;
$function$;

-- Lock down: only authenticated dashboard users can call.
REVOKE ALL ON FUNCTION public.get_ops_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ops_status() TO authenticated;

-- Sanity check (run after deploy):
--   SELECT public.get_ops_status();
