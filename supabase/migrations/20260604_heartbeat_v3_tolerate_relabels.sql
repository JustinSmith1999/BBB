-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04 v3: heartbeat false-positive fix — tolerate paid_at relabels.
--
-- v2 compared two time-window aggregates (paid_at in last hour vs CAPI ok
-- in last hour). When today's relabel moved Misbah/Yissel/Josephine/Samantha's
-- paid_at INTO the last hour but their CAPI events fired hours earlier, the
-- heartbeat read it as "4 paid, only 1 CAPI ok → degraded" — false positive.
--
-- New logic: a real outage looks like "payments happening AND zero CAPI ok
-- in the same hour." Anything else (CAPI ok > 0 in window) is fine — it
-- proves the webhook chain is alive, even if individual rows don't match
-- one-for-one.
--
-- States:
--   'idle'     — no payments in last hour, nothing to verify
--   'ok'       — payments in last hour AND at least 1 successful CAPI event
--                in last hour (proves webhook chain is firing for real today
--                payments; relabeled rows can't break this)
--   'down'     — payments in last hour AND zero successful CAPI events in
--                last hour AND most recent CAPI was >2h ago (real outage)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.check_stripe_webhook_heartbeat();

CREATE OR REPLACE FUNCTION public.check_stripe_webhook_heartbeat()
RETURNS TABLE (
  status               text,
  paid_in_last_hour    int,
  capi_ok_last_hour    int,
  capi_fail_last_hour  int,
  minutes_since_capi   int,
  detail               text
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
      COUNT(*) FILTER (WHERE ok)::int     AS ok_n,
      COUNT(*) FILTER (WHERE NOT ok)::int AS fail_n
    FROM public.capi_events
    WHERE attempted_at >= now() - interval '60 minutes'
      AND event_name = 'Purchase'
  ),
  last_ok AS (
    SELECT EXTRACT(EPOCH FROM (now() - MAX(attempted_at)))::int / 60 AS minutes_ago
    FROM public.capi_events
    WHERE event_name = 'Purchase' AND ok = true
  )
  SELECT
    CASE
      WHEN paid.n = 0                                    THEN 'idle'
      WHEN capi.ok_n >= 1                                THEN 'ok'
      WHEN COALESCE(last_ok.minutes_ago, 999999) <= 120  THEN 'ok'
      ELSE                                                    'down'
    END AS status,
    paid.n               AS paid_in_last_hour,
    capi.ok_n            AS capi_ok_last_hour,
    capi.fail_n          AS capi_fail_last_hour,
    last_ok.minutes_ago  AS minutes_since_capi,
    CASE
      WHEN paid.n = 0
        THEN 'No payments in the last hour — nothing to verify.'
      WHEN capi.ok_n >= 1
        THEN format('%s payment(s) in last hour, %s CAPI ok / %s fail. Chain alive.',
                    paid.n, capi.ok_n, capi.fail_n)
      WHEN COALESCE(last_ok.minutes_ago, 999999) <= 120
        THEN format('%s payment(s) but no CAPI in last hour. Last CAPI ok was %s min ago — still healthy.',
                    paid.n, last_ok.minutes_ago)
      ELSE
        format('OUTAGE: %s payment(s) in last hour, ZERO successful CAPI. Last CAPI ok was %s min ago.',
               paid.n, COALESCE(last_ok.minutes_ago, 999999))
    END AS detail
  FROM paid, capi, last_ok;
$$;

GRANT EXECUTE ON FUNCTION public.check_stripe_webhook_heartbeat() TO authenticated;

-- Sanity probe — should print 'ok' or 'idle', not 'degraded' or 'down'.
SELECT * FROM public.check_stripe_webhook_heartbeat();
