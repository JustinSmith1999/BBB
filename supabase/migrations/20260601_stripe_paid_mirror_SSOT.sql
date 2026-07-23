-- ─────────────────────────────────────────────────────────────────────────────
-- stripe_paid_mirror — Stripe as the single source of truth.
--
-- One row per Stripe $49 succeeded PaymentIntent per studio. Populated by the
-- `sync-stripe-paid-mirror` edge function every 5 min (cron) and also after
-- every stripe-webhook event. This table IS the truth — every other "paid
-- trials" count in the dashboard reads from it via count_paid_canonical().
--
-- Why a mirror instead of querying Stripe per dashboard load:
--   - Stripe API is slow (1-2s per studio per query)
--   - Stripe has rate limits
--   - Dashboard renders fast and frequently
--   - 5-min lag is acceptable for KPI-style counts; webhook keeps real-time
--
-- Truth contract:
--   - Row exists in stripe_paid_mirror IFF Stripe says there is a $49 paid PI
--   - Sync function: upserts on stripe_payment_intent_id (idempotent)
--   - trial_signups is downstream: matched to mirror via stripe_payment_intent_id
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.stripe_paid_mirror (
  stripe_payment_intent_id text PRIMARY KEY,
  studio_slug              text NOT NULL,
  location_id              uuid REFERENCES public.locations(id),
  amount_cents             int  NOT NULL,
  currency                 text NOT NULL DEFAULT 'usd',
  paid_at                  timestamptz NOT NULL,
  customer_email           text,
  customer_name            text,
  customer_phone           text,
  stripe_customer_id       text,
  stripe_charge_id         text,
  raw                      jsonb,
  mirrored_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_paid_mirror_studio_paid_at_idx
  ON public.stripe_paid_mirror (studio_slug, paid_at);
CREATE INDEX IF NOT EXISTS stripe_paid_mirror_email_idx
  ON public.stripe_paid_mirror (lower(customer_email));

ALTER TABLE public.stripe_paid_mirror ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stripe_paid_mirror_read ON public.stripe_paid_mirror;
CREATE POLICY stripe_paid_mirror_read ON public.stripe_paid_mirror
  FOR SELECT TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- count_paid_canonical — THE function. Every other paid-count function reads
-- from this. Filters: studio (slug), since (ET date floor), until (ET date
-- ceiling, default now). Returns int.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.count_paid_canonical(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date,
  p_until  date DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COUNT(*)::bigint
  FROM public.stripe_paid_mirror
  WHERE (p_studio IS NULL OR studio_slug = p_studio)
    AND (paid_at AT TIME ZONE 'America/New_York')::date >= p_since
    AND (p_until IS NULL OR (paid_at AT TIME ZONE 'America/New_York')::date <= p_until);
$function$;

REVOKE ALL ON FUNCTION public.count_paid_canonical(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_paid_canonical(text, date, date) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_stripe_mirror_status — for dashboard "Synced X min ago" badge.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_stripe_mirror_status()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'mirror_row_count', COUNT(*),
    'last_paid_at',     MAX(paid_at),
    'last_mirrored_at', MAX(mirrored_at),
    'per_studio',       (
      SELECT COALESCE(jsonb_object_agg(studio_slug, n), '{}'::jsonb)
      FROM (SELECT studio_slug, COUNT(*) AS n FROM stripe_paid_mirror
            WHERE (paid_at AT TIME ZONE 'America/New_York')::date >= '2026-05-15'
            GROUP BY 1) s
    )
  ) INTO v FROM stripe_paid_mirror;
  RETURN v;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_stripe_mirror_status() TO authenticated;

-- Sanity (after sync runs once):
--   SELECT count_paid_canonical();                           -- expect 55 (Stripe truth)
--   SELECT count_paid_canonical('bayside');                  -- expect 5
--   SELECT count_paid_canonical('bayside', '2026-05-26');    -- expect 2 (last 7d)
--   SELECT get_stripe_mirror_status();
