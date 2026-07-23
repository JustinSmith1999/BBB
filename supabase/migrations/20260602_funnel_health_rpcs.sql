-- ─────────────────────────────────────────────────────────────────────────────
-- Funnel Health dashboard RPCs.
--
-- Backs the standalone /funnel-health page. Three RPCs:
--
--   1. get_funnel_health_pipeline()   — status of each node in the pipeline
--                                       (Stripe, webhook, cron, mirror, sends)
--                                       Green / yellow / red per node, with
--                                       a metric (e.g. "last fired 3m ago").
--
--   2. get_funnel_health_customers()  — one row per Stripe-paid trial in
--                                       window. 4 boolean status cells:
--                                       customer email, customer SMS, owner
--                                       SMS, studio email.  Plus retry hints.
--
--   3. get_funnel_health_log()        — recent event log: every email send,
--                                       SMS send, webhook fire, cron run.
--                                       Newest first. Used by the log strip
--                                       on the dashboard.
--
-- All three SECURITY DEFINER so the page can read with the anon key.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Pipeline status ──────────────────────────────────────────────────────
-- Returns one row per pipeline node with its status + a key metric.
-- The frontend renders these as the boxes in the diagram.
CREATE OR REPLACE FUNCTION public.get_funnel_health_pipeline()
RETURNS TABLE(
  node_id       TEXT,
  node_label    TEXT,
  status        TEXT,        -- 'green' | 'yellow' | 'red'
  metric        TEXT,        -- short string shown under the title
  detail        TEXT,        -- longer explanation surfaced on hover/click
  last_at       TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_mirror_last       TIMESTAMPTZ;
  v_mirror_count_30d  INT;
  v_cron_job          RECORD;
  v_cron_last_run     TIMESTAMPTZ;
  v_webhook_last      TIMESTAMPTZ;
  v_email_last        TIMESTAMPTZ;
  v_sms_last          TIMESTAMPTZ;
  v_tsigned_30d       INT;
  v_now               TIMESTAMPTZ := now();
BEGIN
  -- Mirror table — latest paid_at and recent count
  SELECT MAX(paid_at), COUNT(*) FILTER (WHERE paid_at >= v_now - INTERVAL '30 days')
    INTO v_mirror_last, v_mirror_count_30d
    FROM public.stripe_paid_mirror;

  -- Cron job for the mirror sync
  SELECT * INTO v_cron_job
    FROM cron.job
   WHERE jobname = 'sync-stripe-paid-mirror-5min'
   LIMIT 1;
  SELECT MAX(jrd.start_time) INTO v_cron_last_run
    FROM cron.job_run_details jrd
   WHERE jrd.jobid = v_cron_job.jobid
     AND jrd.status = 'succeeded';

  -- Stripe webhook last fire — proxy via newest mirrored_at where the mirror
  -- got written. The webhook writes inline so the latest mirrored_at near to
  -- "now" implies the webhook is live. Fallback: latest trial_signups row.
  SELECT MAX(GREATEST(mirrored_at, paid_at)) INTO v_webhook_last
    FROM public.stripe_paid_mirror;

  -- Email sends and SMS sends — broadest signal that comms are firing.
  SELECT MAX(created_at) INTO v_email_last
    FROM public.email_log
   WHERE send_path IN (
     'stripe_customer_welcome_email',
     'stripe_owner_email',
     'manual_welcome_batch',
     'manual_studio_alert'
   );
  SELECT MAX(sent_at) INTO v_sms_last
    FROM public.sms_messages
   WHERE direction = 'outbound'
     AND sent_by IN (
       'stripe_customer_welcome_sms',
       'stripe_owner_sms',
       'manual_welcome_batch',
       'manual_owner_alert'
     );

  -- trial_signups vs mirror — paid count last 30 days
  SELECT COUNT(*) INTO v_tsigned_30d
    FROM public.trial_signups
   WHERE payment_status = 'completed'
     AND deleted_at IS NULL
     AND payment_date >= v_now - INTERVAL '30 days';

  -- Stripe (external, always assumed available)
  RETURN QUERY SELECT
    'stripe'::TEXT,
    'Stripe (truth)'::TEXT,
    'green'::TEXT,
    'external · always on'::TEXT,
    'Stripe is the source of truth. PaymentIntent succeeded events flow downstream from here.'::TEXT,
    v_mirror_last;

  -- Webhook ingestion
  RETURN QUERY SELECT
    'webhook'::TEXT,
    'Webhook'::TEXT,
    CASE
      WHEN v_webhook_last IS NULL                                        THEN 'red'
      WHEN v_webhook_last >= v_now - INTERVAL '24 hours'                 THEN 'green'
      WHEN v_webhook_last >= v_now - INTERVAL '7 days'                   THEN 'yellow'
      ELSE 'red'
    END,
    CASE
      WHEN v_webhook_last IS NULL THEN 'never fired'
      ELSE 'last fire ' || to_char(v_webhook_last AT TIME ZONE 'America/New_York', 'Mon DD HH24:MI')
    END,
    'stripe-webhook function. Inserts to trial_signups + upserts stripe_paid_mirror in real time.'::TEXT,
    v_webhook_last;

  -- Cron sync
  RETURN QUERY SELECT
    'cron'::TEXT,
    'Cron sync (5 min)'::TEXT,
    CASE
      WHEN v_cron_job IS NULL                                            THEN 'red'
      WHEN NOT v_cron_job.active                                         THEN 'red'
      WHEN v_cron_last_run IS NULL                                       THEN 'yellow'
      WHEN v_cron_last_run >= v_now - INTERVAL '15 minutes'              THEN 'green'
      WHEN v_cron_last_run >= v_now - INTERVAL '1 hour'                  THEN 'yellow'
      ELSE 'red'
    END,
    CASE
      WHEN v_cron_job IS NULL                THEN 'not scheduled'
      WHEN NOT v_cron_job.active             THEN 'disabled'
      WHEN v_cron_last_run IS NULL           THEN 'never succeeded'
      ELSE 'last ok ' || to_char(v_cron_last_run AT TIME ZONE 'America/New_York', 'HH24:MI:SS')
    END,
    'sync-stripe-paid-mirror runs every 5 minutes. Pulls last 24h of Stripe $49 paid PIs.'::TEXT,
    v_cron_last_run;

  -- Mirror table
  RETURN QUERY SELECT
    'mirror'::TEXT,
    'stripe_paid_mirror'::TEXT,
    CASE
      WHEN v_mirror_last IS NULL                                         THEN 'red'
      WHEN v_mirror_last >= v_now - INTERVAL '24 hours'                  THEN 'green'
      WHEN v_mirror_last >= v_now - INTERVAL '72 hours'                  THEN 'yellow'
      ELSE 'red'
    END,
    v_mirror_count_30d::TEXT || ' paid · last 30 days',
    'Single source of truth for "paid in Stripe". Webhook upserts in real time + cron tops off every 5 min.'::TEXT,
    v_mirror_last;

  -- trial_signups parity
  RETURN QUERY SELECT
    'tsigned'::TEXT,
    'trial_signups'::TEXT,
    CASE
      WHEN v_tsigned_30d = v_mirror_count_30d THEN 'green'
      WHEN v_tsigned_30d > v_mirror_count_30d * 0.9 THEN 'yellow'
      ELSE 'red'
    END,
    v_tsigned_30d::TEXT || ' rows · vs ' || v_mirror_count_30d::TEXT || ' in mirror',
    'Operational view used by /homebase. Should match mirror count within 1-2 (reconcile gap).'::TEXT,
    NULL::TIMESTAMPTZ;

  -- Email sends
  RETURN QUERY SELECT
    'email_sends'::TEXT,
    'Email sends'::TEXT,
    CASE
      WHEN v_email_last IS NULL                                          THEN 'red'
      WHEN v_email_last >= v_now - INTERVAL '24 hours'                   THEN 'green'
      WHEN v_email_last >= v_now - INTERVAL '7 days'                     THEN 'yellow'
      ELSE 'red'
    END,
    CASE
      WHEN v_email_last IS NULL THEN 'never'
      ELSE 'last ' || to_char(v_email_last AT TIME ZONE 'America/New_York', 'Mon DD HH24:MI')
    END,
    'Welcome email + owner alert email via Resend. Logged to email_log.'::TEXT,
    v_email_last;

  -- SMS sends
  RETURN QUERY SELECT
    'sms_sends'::TEXT,
    'SMS sends'::TEXT,
    CASE
      WHEN v_sms_last IS NULL                                            THEN 'red'
      WHEN v_sms_last >= v_now - INTERVAL '24 hours'                     THEN 'green'
      WHEN v_sms_last >= v_now - INTERVAL '7 days'                       THEN 'yellow'
      ELSE 'red'
    END,
    CASE
      WHEN v_sms_last IS NULL THEN 'never'
      ELSE 'last ' || to_char(v_sms_last AT TIME ZONE 'America/New_York', 'Mon DD HH24:MI')
    END,
    'Welcome SMS + owner alert SMS via Twilio. Logged to sms_messages.'::TEXT,
    v_sms_last;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_funnel_health_pipeline() TO anon, authenticated;


-- ── 2. Per-customer status table ────────────────────────────────────────────
-- One row per Stripe-paid trial in the window. 4 boolean status cells
-- (customer email/SMS, owner SMS, studio email). Frontend renders as table.
CREATE OR REPLACE FUNCTION public.get_funnel_health_customers(
  p_days INT DEFAULT 30,
  p_limit INT DEFAULT 100
)
RETURNS TABLE(
  trial_signup_id        UUID,
  stripe_payment_intent_id TEXT,
  customer_name          TEXT,
  customer_email         TEXT,
  customer_phone         TEXT,
  studio_slug            TEXT,
  paid_at                TIMESTAMPTZ,
  customer_email_status  TEXT,        -- 'green' | 'red' | 'yellow'
  customer_email_at      TIMESTAMPTZ,
  customer_sms_status    TEXT,
  customer_sms_at        TIMESTAMPTZ,
  owner_sms_status       TEXT,
  owner_sms_at           TIMESTAMPTZ,
  studio_email_status    TEXT,
  studio_email_at        TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH window_mirror AS (
    SELECT m.*
      FROM public.stripe_paid_mirror m
     WHERE m.paid_at >= now() - (p_days || ' days')::INTERVAL
  ),
  matched AS (
    SELECT
      wm.stripe_payment_intent_id,
      COALESCE(NULLIF(TRIM(wm.customer_name),  ''), t.name)  AS customer_name,
      COALESCE(NULLIF(TRIM(wm.customer_email), ''), t.email) AS customer_email,
      COALESCE(NULLIF(TRIM(wm.customer_phone), ''), t.phone) AS customer_phone,
      wm.studio_slug,
      wm.paid_at,
      t.id AS trial_signup_id
    FROM window_mirror wm
    LEFT JOIN public.trial_signups t
      ON t.deleted_at IS NULL
     AND (
          t.stripe_session_id = wm.stripe_payment_intent_id
       OR (wm.customer_email IS NOT NULL
           AND LOWER(TRIM(t.email)) = LOWER(TRIM(wm.customer_email))
           AND t.location_id IS NOT DISTINCT FROM wm.location_id)
     )
  )
  SELECT
    m.trial_signup_id,
    m.stripe_payment_intent_id,
    m.customer_name,
    m.customer_email,
    m.customer_phone,
    m.studio_slug,
    m.paid_at,
    -- Customer welcome email — by email match in to_addrs
    CASE WHEN EXISTS (
      SELECT 1 FROM public.email_log e
       WHERE e.send_path IN ('stripe_customer_welcome_email','manual_welcome_batch')
         AND m.customer_email = ANY(COALESCE(e.to_addrs, ARRAY[]::TEXT[]))
    ) THEN 'green' ELSE 'red' END,
    (SELECT MIN(e.created_at) FROM public.email_log e
      WHERE e.send_path IN ('stripe_customer_welcome_email','manual_welcome_batch')
        AND m.customer_email = ANY(COALESCE(e.to_addrs, ARRAY[]::TEXT[]))),
    -- Customer welcome SMS — by phone match
    CASE WHEN EXISTS (
      SELECT 1 FROM public.sms_messages s
       WHERE s.direction = 'outbound'
         AND s.sent_by IN ('stripe_customer_welcome_sms','manual_welcome_batch')
         AND REGEXP_REPLACE(COALESCE(s.to_phone,''), '\D','','g')
             = REGEXP_REPLACE(COALESCE(m.customer_phone,''), '\D','','g')
         AND m.customer_phone IS NOT NULL
    ) THEN 'green' ELSE 'red' END,
    (SELECT MIN(s.sent_at) FROM public.sms_messages s
      WHERE s.direction = 'outbound'
        AND s.sent_by IN ('stripe_customer_welcome_sms','manual_welcome_batch')
        AND REGEXP_REPLACE(COALESCE(s.to_phone,''), '\D','','g')
            = REGEXP_REPLACE(COALESCE(m.customer_phone,''), '\D','','g')),
    -- Owner SMS — by trial_signup_id OR studio_slug + body contains email
    CASE WHEN EXISTS (
      SELECT 1 FROM public.sms_messages s
       WHERE s.direction = 'outbound'
         AND s.sent_by IN ('stripe_owner_sms','manual_owner_alert')
         AND (
              s.trial_signup_id = m.trial_signup_id
           OR (s.studio_slug = m.studio_slug
               AND m.customer_email IS NOT NULL
               AND s.body ILIKE '%' || m.customer_email || '%')
         )
    ) THEN 'green' ELSE 'red' END,
    (SELECT MIN(s.sent_at) FROM public.sms_messages s
      WHERE s.direction = 'outbound'
        AND s.sent_by IN ('stripe_owner_sms','manual_owner_alert')
        AND (
             s.trial_signup_id = m.trial_signup_id
          OR (s.studio_slug = m.studio_slug
              AND m.customer_email IS NOT NULL
              AND s.body ILIKE '%' || m.customer_email || '%')
        )),
    -- Studio inbox email — by trial_signup_id OR raw contains email
    CASE WHEN EXISTS (
      SELECT 1 FROM public.email_log e
       WHERE e.send_path IN ('stripe_owner_email','manual_studio_alert')
         AND (
              e.trial_signup_id = m.trial_signup_id
           OR (m.customer_email IS NOT NULL
               AND e.raw::TEXT ILIKE '%' || m.customer_email || '%')
         )
    ) THEN 'green' ELSE 'red' END,
    (SELECT MIN(e.created_at) FROM public.email_log e
      WHERE e.send_path IN ('stripe_owner_email','manual_studio_alert')
        AND (
             e.trial_signup_id = m.trial_signup_id
          OR (m.customer_email IS NOT NULL
              AND e.raw::TEXT ILIKE '%' || m.customer_email || '%')
        ))
  FROM matched m
  ORDER BY m.paid_at DESC
  LIMIT p_limit;
$$;
GRANT EXECUTE ON FUNCTION public.get_funnel_health_customers(INT, INT) TO anon, authenticated;


-- ── 3. Recent event log ─────────────────────────────────────────────────────
-- Newest-first union of email + SMS + mirror upsert events. Used by the
-- log strip on the dashboard.
CREATE OR REPLACE FUNCTION public.get_funnel_health_log(
  p_limit INT DEFAULT 50
)
RETURNS TABLE(
  ts            TIMESTAMPTZ,
  kind          TEXT,         -- 'paid' | 'email' | 'sms'
  status        TEXT,         -- 'ok' | 'warn' | 'fail'
  summary       TEXT,
  detail        TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    m.paid_at        AS ts,
    'paid'           AS kind,
    'ok'             AS status,
    'Stripe payment · ' || COALESCE(m.customer_name, '(no name)') || ' · ' || COALESCE(m.studio_slug, '?'),
    'PI ' || COALESCE(m.stripe_payment_intent_id, '?')
  FROM public.stripe_paid_mirror m
  UNION ALL
  SELECT
    e.created_at,
    'email',
    CASE
      WHEN e.event_type IN ('delivered','sent','sent_inline','opened','clicked') THEN 'ok'
      WHEN e.event_type IN ('bounced','complained','delivery_delayed','failed')   THEN 'fail'
      ELSE 'warn'
    END,
    'Email · ' || COALESCE(e.send_path, '?') || ' · ' ||
       COALESCE(array_to_string(e.to_addrs, ', '), '(no recipient)'),
    COALESCE(e.subject, '')
  FROM public.email_log e
  WHERE e.created_at >= now() - INTERVAL '14 days'
  UNION ALL
  SELECT
    s.sent_at,
    'sms',
    CASE
      WHEN s.status IN ('delivered','sent','queued','accepted')             THEN 'ok'
      WHEN s.status IN ('failed','undelivered')                             THEN 'fail'
      ELSE 'warn'
    END,
    'SMS · ' || COALESCE(s.sent_by,'(no path)') || ' · ' || COALESCE(s.to_phone,'(no #)'),
    LEFT(COALESCE(s.body,''), 120)
  FROM public.sms_messages s
  WHERE s.sent_at >= now() - INTERVAL '14 days'
    AND s.direction = 'outbound'
  ORDER BY ts DESC
  LIMIT GREATEST(p_limit, 10);
$$;
GRANT EXECUTE ON FUNCTION public.get_funnel_health_log(INT) TO anon, authenticated;


-- ── Sanity check ────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM public.get_funnel_health_pipeline())            AS pipeline_nodes,
  (SELECT COUNT(*) FROM public.get_funnel_health_customers(30, 100))    AS customer_rows,
  (SELECT COUNT(*) FROM public.get_funnel_health_log(50))               AS log_rows;
