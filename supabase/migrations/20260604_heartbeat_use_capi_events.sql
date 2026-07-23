-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04 v2: heartbeat truth source — capi_events instead of mirror.raw
--
-- The previous heartbeat keyed on stripe_paid_mirror.raw->>'source' being
-- 'stripe-webhook checkout.session.completed'. Problem: the cron job
-- sync-stripe-paid-mirror runs every ~15 min and overwrites the raw column,
-- clobbering the webhook's attribution. So a fully-healthy webhook could
-- still register as 'down' after the cron tick.
--
-- New signal: capi_events. The stripe-webhook writes a row to capi_events
-- every time it fires a Purchase event to Meta CAPI. If we see paid trials
-- in the last hour AND no successful CAPI events for them, the webhook is
-- dead. The cron never touches capi_events, so the signal is durable.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.check_stripe_webhook_heartbeat();

CREATE OR REPLACE FUNCTION public.check_stripe_webhook_heartbeat()
RETURNS TABLE (
  status              text,
  paid_in_last_hour   int,
  capi_ok_last_hour   int,
  capi_fail_last_hour int,
  detail              text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH paid AS (
    SELECT COUNT(*)::int AS n
    FROM public.stripe_paid_mirror
    WHERE paid_at >= now() - interval '60 minutes'
  ),
  capi AS (
    SELECT
      COUNT(*) FILTER (WHERE ok)::int      AS ok_n,
      COUNT(*) FILTER (WHERE NOT ok)::int  AS fail_n
    FROM public.capi_events
    WHERE attempted_at >= now() - interval '60 minutes'
      AND event_name = 'Purchase'
  )
  SELECT
    CASE
      WHEN paid.n = 0                                      THEN 'idle'
      WHEN capi.ok_n >= paid.n                             THEN 'ok'
      WHEN capi.ok_n > 0 AND capi.ok_n < paid.n            THEN 'degraded'
      ELSE                                                      'down'
    END AS status,
    paid.n                                                  AS paid_in_last_hour,
    capi.ok_n                                               AS capi_ok_last_hour,
    capi.fail_n                                             AS capi_fail_last_hour,
    CASE
      WHEN paid.n = 0
        THEN 'No payments in the last hour — nothing to verify.'
      WHEN capi.ok_n >= paid.n
        THEN format('All %s payment(s) processed (CAPI ok=%s, fail=%s).',
                    paid.n, capi.ok_n, capi.fail_n)
      WHEN capi.ok_n = 0
        THEN format('%s payment(s) in last hour — ZERO successful CAPI events. Webhook is DEAD. (CAPI fail=%s)',
                    paid.n, capi.fail_n)
      ELSE
        format('%s payment(s), only %s reached CAPI ok. Partial outage. (CAPI fail=%s)',
               paid.n, capi.ok_n, capi.fail_n)
    END AS detail
  FROM paid, capi;
$$;

GRANT EXECUTE ON FUNCTION public.check_stripe_webhook_heartbeat() TO authenticated;

-- Sanity probe — current state with the new signal.
SELECT * FROM public.check_stripe_webhook_heartbeat();
