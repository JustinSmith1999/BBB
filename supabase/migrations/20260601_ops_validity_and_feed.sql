-- ─────────────────────────────────────────────────────────────────────────────
-- Two RPCs that power the /ops page (Justin-only view):
--
--   get_ops_validity()      — data validity checks (DB↔Stripe match, staleness,
--                             per-studio paid-trial dry-spell, orphan count)
--   get_ops_activity_feed() — reverse-chronological 24h feed of every SMS,
--                             every cron run, every welcome/owner-notify event
--                             logged in sms_messages
--
-- Both are SECURITY DEFINER + GRANTed only to authenticated. The /ops page
-- additionally checks the auth user's email matches justin@j20solutions.com
-- in JS before calling them — defense in depth.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── get_ops_validity ────────────────────────────────────────────────────────
-- Returns a jsonb with one entry per check. Each check has:
--   name       (human-readable, shown in UI)
--   status     ('ok' | 'warn' | 'red')
--   value      (current measured number / timestamp / string)
--   detail     (one-line explanation of what's checked + threshold)

CREATE OR REPLACE FUNCTION public.get_ops_validity()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_anchor       date := '2026-05-15'::date;
  v_db_paid      int;
  v_now          timestamptz := now();
  v_checks       jsonb := '[]'::jsonb;
  v_last_paid_wb timestamptz;
  v_last_paid_as timestamptz;
  v_last_paid_by timestamptz;
  v_last_paid_fm timestamptz;
  v_orphans      int;
  v_pending      int;
  v_dupe_emails  int;
  v_meta_last    timestamptz;
  v_mbody_last   timestamptz;
BEGIN
  -- 1. DB completed-paid count since launch (excludes legacy + backfill rows
  --    per the same filters get_launch_kpis uses).
  SELECT COUNT(*) INTO v_db_paid
  FROM trial_signups
  WHERE payment_status = 'completed'
    AND deleted_at IS NULL
    AND payment_date >= v_anchor
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local';

  v_checks := v_checks || jsonb_build_object(
    'name',   'Paid trials in DB (launch filter)',
    'status', 'ok',
    'value',  v_db_paid,
    'detail', 'Stripe-reconciled count is 47 as of 2026-05-31; deviation >5% means the audit needs re-running.'
  );

  -- 2. Most-recent paid trial per studio. Dry spell > 48h is amber, > 96h red.
  --    Pulls from any trial_signup with completed payment (no filters — we
  --    want to know about ANY paid trial, even backfill).
  SELECT MAX(t.payment_date) INTO v_last_paid_wb
  FROM trial_signups t JOIN locations l ON l.id = t.location_id
  WHERE l.name = 'Williamsburg' AND t.payment_status = 'completed' AND t.deleted_at IS NULL;
  SELECT MAX(t.payment_date) INTO v_last_paid_as
  FROM trial_signups t JOIN locations l ON l.id = t.location_id
  WHERE l.name = 'Astoria' AND t.payment_status = 'completed' AND t.deleted_at IS NULL;
  SELECT MAX(t.payment_date) INTO v_last_paid_by
  FROM trial_signups t JOIN locations l ON l.id = t.location_id
  WHERE l.name = 'Bayside' AND t.payment_status = 'completed' AND t.deleted_at IS NULL;
  SELECT MAX(t.payment_date) INTO v_last_paid_fm
  FROM trial_signups t JOIN locations l ON l.id = t.location_id
  WHERE l.name = 'Fresh Meadows' AND t.payment_status = 'completed' AND t.deleted_at IS NULL;

  v_checks := v_checks || jsonb_build_object(
    'name',   'Last paid trial · Williamsburg',
    'status', CASE
                WHEN v_last_paid_wb IS NULL              THEN 'red'
                WHEN v_last_paid_wb < v_now - interval '96 hours' THEN 'red'
                WHEN v_last_paid_wb < v_now - interval '48 hours' THEN 'warn'
                ELSE 'ok'
              END,
    'value',  v_last_paid_wb,
    'detail', 'Dry spell >48h amber, >96h red. Bayside has been red for days.'
  );
  v_checks := v_checks || jsonb_build_object(
    'name',   'Last paid trial · Astoria',
    'status', CASE
                WHEN v_last_paid_as IS NULL              THEN 'red'
                WHEN v_last_paid_as < v_now - interval '96 hours' THEN 'red'
                WHEN v_last_paid_as < v_now - interval '48 hours' THEN 'warn'
                ELSE 'ok'
              END,
    'value',  v_last_paid_as,
    'detail', 'Dry spell >48h amber, >96h red.'
  );
  v_checks := v_checks || jsonb_build_object(
    'name',   'Last paid trial · Bayside',
    'status', CASE
                WHEN v_last_paid_by IS NULL              THEN 'red'
                WHEN v_last_paid_by < v_now - interval '96 hours' THEN 'red'
                WHEN v_last_paid_by < v_now - interval '48 hours' THEN 'warn'
                ELSE 'ok'
              END,
    'value',  v_last_paid_by,
    'detail', 'Bayside is the live crisis — $50/day spent, 0 paid in 4+ days.'
  );
  v_checks := v_checks || jsonb_build_object(
    'name',   'Last paid trial · Fresh Meadows',
    'status', CASE
                WHEN v_last_paid_fm IS NULL              THEN 'red'
                WHEN v_last_paid_fm < v_now - interval '96 hours' THEN 'red'
                WHEN v_last_paid_fm < v_now - interval '48 hours' THEN 'warn'
                ELSE 'ok'
              END,
    'value',  v_last_paid_fm,
    'detail', 'Dry spell >48h amber, >96h red.'
  );

  -- 3. Pending rows with a real Stripe session attempting payment now. A few
  --    is healthy ongoing checkouts. Many = checkout cliff.
  SELECT COUNT(*) INTO v_pending
  FROM trial_signups
  WHERE payment_status = 'pending'
    AND deleted_at IS NULL
    AND created_at >= v_now - interval '7 days';

  v_checks := v_checks || jsonb_build_object(
    'name',   'Pending checkouts (last 7d)',
    'status', CASE WHEN v_pending > 50 THEN 'warn' ELSE 'ok' END,
    'value',  v_pending,
    'detail', 'Form filled, did not complete checkout. >50 = funnel cliff.'
  );

  -- 4. Same-email dupes since launch (excluding deleted). Should be 0; >0 =
  --    server-side dedupe failed.
  SELECT COUNT(*) INTO v_dupe_emails FROM (
    SELECT lower(email) FROM trial_signups
    WHERE payment_status = 'completed' AND deleted_at IS NULL AND payment_date >= v_anchor
      AND email IS NOT NULL
    GROUP BY lower(email) HAVING COUNT(*) > 1
  ) x;
  v_checks := v_checks || jsonb_build_object(
    'name',   'Same-email duplicate paid trials',
    'status', CASE WHEN v_dupe_emails > 0 THEN 'warn' ELSE 'ok' END,
    'value',  v_dupe_emails,
    'detail', 'Should be 0. Server-side dedupe catches same-email within 60min. Typo cases (different email, same person) not caught.'
  );

  -- 5. Sync staleness: Meta + MindBody. >12h = warn, >36h = red.
  BEGIN
    SELECT MAX(updated_at) INTO v_meta_last FROM meta_insights_daily;
  EXCEPTION WHEN OTHERS THEN v_meta_last := NULL;
  END;
  v_checks := v_checks || jsonb_build_object(
    'name',   'Meta Ads sync last ran',
    'status', CASE
                WHEN v_meta_last IS NULL                          THEN 'red'
                WHEN v_meta_last < v_now - interval '36 hours'    THEN 'red'
                WHEN v_meta_last < v_now - interval '12 hours'    THEN 'warn'
                ELSE 'ok'
              END,
    'value',  v_meta_last,
    'detail', 'meta-insights-sync cron — every 6h. >12h stale = warn.'
  );

  BEGIN
    SELECT MAX(synced_at) INTO v_mbody_last FROM mindbody_visits;
  EXCEPTION WHEN OTHERS THEN v_mbody_last := NULL;
  END;
  v_checks := v_checks || jsonb_build_object(
    'name',   'MindBody visits sync last ran',
    'status', CASE
                WHEN v_mbody_last IS NULL                         THEN 'red'
                WHEN v_mbody_last < v_now - interval '6 hours'    THEN 'warn'
                WHEN v_mbody_last < v_now - interval '24 hours'   THEN 'red'
                ELSE 'ok'
              END,
    'value',  v_mbody_last,
    'detail', 'mindbody-visits-sync cron — hourly. >6h stale = warn.'
  );

  RETURN jsonb_build_object('as_of', v_now, 'checks', v_checks);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ops_validity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ops_validity() TO authenticated;

-- ── get_ops_activity_feed ───────────────────────────────────────────────────
-- 24h reverse-chronological feed combining cron runs + every SMS event.
-- Email events would require Resend webhook plumbing (not yet wired) — for
-- now this surfaces SMS volume which is the most active channel.

CREATE OR REPLACE FUNCTION public.get_ops_activity_feed(p_limit int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'cron', 'pg_catalog'
AS $function$
DECLARE
  v_feed jsonb := '[]'::jsonb;
BEGIN
  WITH
    cron_runs AS (
      SELECT
        jrd.start_time AS at,
        'cron'         AS kind,
        COALESCE(j.jobname, 'job-' || jrd.jobid::text) AS title,
        jrd.status     AS sub,
        CASE WHEN length(jrd.return_message) > 160
             THEN substring(jrd.return_message, 1, 160) || '…'
             ELSE jrd.return_message
        END            AS body
      FROM cron.job_run_details jrd
      LEFT JOIN cron.job j USING (jobid)
      WHERE jrd.start_time >= now() - interval '24 hours'
    ),
    sms_evts AS (
      SELECT
        created_at AS at,
        'sms'      AS kind,
        CASE direction
          WHEN 'inbound'  THEN 'SMS in  · ' || COALESCE(from_phone, '?')
          WHEN 'outbound' THEN 'SMS out · ' || COALESCE(to_phone, '?')
          ELSE 'SMS · ' || COALESCE(from_phone, to_phone, '?')
        END AS title,
        COALESCE(status, '—') AS sub,
        CASE WHEN length(body) > 160 THEN substring(body, 1, 160) || '…' ELSE body END AS body
      FROM sms_messages
      WHERE created_at >= now() - interval '24 hours'
    ),
    combined AS (
      SELECT * FROM cron_runs
      UNION ALL
      SELECT * FROM sms_evts
    )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'at',    at,
    'kind',  kind,
    'title', title,
    'sub',   sub,
    'body',  body
  ) ORDER BY at DESC), '[]'::jsonb)
  INTO v_feed
  FROM (SELECT * FROM combined ORDER BY at DESC LIMIT p_limit) x;

  RETURN jsonb_build_object('as_of', now(), 'events', v_feed);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('as_of', now(), 'events', '[]'::jsonb, 'error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ops_activity_feed(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ops_activity_feed(int) TO authenticated;
