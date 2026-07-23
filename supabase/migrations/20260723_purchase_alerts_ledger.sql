-- 20260723_purchase_alerts_ledger.sql
-- Dedupe ledger for mt-purchase-alerts: one row per sale we've already texted
-- Carlos about, so he never gets the same purchase twice.
-- Locked down: service_role only (edge function), no anon/public access.

CREATE TABLE IF NOT EXISTS public.purchase_alerts_sent (
  mt_sale_id   text PRIMARY KEY,
  studio_slug  text,
  total_cents  integer,
  recipient    text,
  sms_sid      text,
  sent_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.purchase_alerts_sent ENABLE ROW LEVEL SECURITY;

-- Public API roles get nothing on this table.
REVOKE ALL ON public.purchase_alerts_sent FROM PUBLIC, anon, authenticated;

-- No RLS policy for anon/authenticated is created, so with RLS on they can read
-- zero rows. service_role bypasses RLS, which is what the edge function uses.
