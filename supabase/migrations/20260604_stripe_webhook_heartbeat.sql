-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: stripe_webhook_heartbeat
--
-- Insurance against another silent stripe-webhook outage like the one from
-- June 1–4, 2026. Today's bug auto-cleaned via sync-stripe-paid-mirror cron
-- so nothing screamed for 4 days — by the time we noticed, $400+ in welcome
-- emails were missing and every paid trial had a broken CAPI event.
--
-- The check is brutal-simple: if there's been at least one real $49 payment
-- in the last 60 minutes BUT none of those rows came through stripe-webhook
-- (raw->>'source' is NULL or doesn't start with 'stripe-webhook'), the webhook
-- is silently broken. Alert Justin only.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.check_stripe_webhook_heartbeat();

CREATE OR REPLACE FUNCTION public.check_stripe_webhook_heartbeat()
RETURNS TABLE (
  status              text,
  paid_in_last_hour   int,
  webhook_in_last_hour int,
  detail              text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH window_rows AS (
    SELECT
      raw->>'source' AS src,
      paid_at,
      customer_name
    FROM public.stripe_paid_mirror
    WHERE paid_at >= now() - interval '60 minutes'
  ),
  tallies AS (
    SELECT
      COUNT(*)::int AS paid_total,
      COUNT(*) FILTER (WHERE src LIKE 'stripe-webhook%')::int AS webhook_total
    FROM window_rows
  )
  SELECT
    CASE
      WHEN paid_total = 0                                THEN 'idle'
      WHEN webhook_total = paid_total                    THEN 'ok'
      WHEN webhook_total > 0 AND webhook_total < paid_total THEN 'degraded'
      ELSE                                                    'down'
    END AS status,
    paid_total                  AS paid_in_last_hour,
    webhook_total               AS webhook_in_last_hour,
    CASE
      WHEN paid_total = 0
        THEN 'No payments in the last hour — nothing to verify.'
      WHEN webhook_total = paid_total
        THEN format('All %s payment(s) in last hour processed by webhook.', paid_total)
      WHEN webhook_total = 0
        THEN format('%s payment(s) in last hour — NONE processed by webhook. Webhook is DEAD.', paid_total)
      ELSE
        format('%s of %s payments processed by webhook — partial outage.', webhook_total, paid_total)
    END AS detail
  FROM tallies;
$$;

GRANT EXECUTE ON FUNCTION public.check_stripe_webhook_heartbeat() TO authenticated;

-- Sanity probe — current state.
SELECT * FROM public.check_stripe_webhook_heartbeat();
