-- ─────────────────────────────────────────────────────────────────────────────
-- get_launch_kpis was double-counting paid trials because it had NO filters
-- on trial_signups. Result: dashboard showed 66 paid across all studios
-- while the DB actually had 47 unique customers (and Stripe truth is 55).
--
-- Inflation per studio confirmed via probe (2026-05-31):
--   Williamsburg: KPI 22, real 14 (+8 from 6 legacy + 2 backfill-email)
--   Astoria:      KPI 19, real 16 (+3 from 3 legacy)
--   Fresh Meadows:KPI 17, real 13 (+4)
--   Bayside:      KPI  8, real  4 (+4)
--
-- This migration rewrites get_launch_kpis with the SAME filters every other
-- dashboard surface uses (get_trial_journey_v2, /homebase loadAll):
--   • payment_date >= '2026-05-15'::date  (or created_at for unpaid leads)
--   • source_category <> 'legacy_archived'
--   • email NOT LIKE 'backfill-pi_%@no-email.bbb.local'
--   • deleted_at IS NULL
--
-- Output shape unchanged — CREATE OR REPLACE is safe (returns jsonb).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_launch_kpis(p_studio text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_anchor       date    := '2026-05-15'::date;
  v_loc_id       uuid;
  v_spend_cents  bigint  := 0;
  v_impressions  bigint  := 0;
  v_clicks       bigint  := 0;
  v_meta_leads   bigint  := 0;
  v_trial_sign   int     := 0;
  v_paid_trials  int     := 0;
  v_conv_pct     numeric := 0;
BEGIN
  -- Lookup the studio's location_id from its slug ("williamsburg" → uuid)
  SELECT l.id INTO v_loc_id
  FROM public.locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  -- Meta ad-account aggregates — these don't need extra filtering, the
  -- meta_insights_daily table is already clean per-studio per-day.
  SELECT
    COALESCE(SUM(spend_cents), 0),
    COALESCE(SUM(impressions), 0),
    COALESCE(SUM(clicks), 0),
    COALESCE(SUM(leads), 0)
  INTO v_spend_cents, v_impressions, v_clicks, v_meta_leads
  FROM public.meta_insights_daily
  WHERE studio_slug  = p_studio
    AND date_start  >= v_anchor;

  -- Real trial signups (form fills) since launch. Exclude legacy backfill
  -- rows and webhook-placeholder backfill emails — neither represents a
  -- person who actually filled out the trial form.
  SELECT COUNT(*) INTO v_trial_sign
  FROM public.trial_signups
  WHERE location_id = v_loc_id
    AND deleted_at IS NULL
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
    AND (created_at AT TIME ZONE 'America/New_York')::date >= v_anchor;

  -- Real paid trials since launch. Same filters PLUS payment_date floor so
  -- pre-launch payments tagged with NULL source_category can't sneak in.
  SELECT COUNT(*) INTO v_paid_trials
  FROM public.trial_signups
  WHERE location_id     = v_loc_id
    AND deleted_at IS NULL
    AND payment_status  = 'completed'
    AND payment_date IS NOT NULL
    AND payment_date    >= v_anchor
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local';

  -- Pay rate, rounded to 1 decimal.
  IF v_trial_sign > 0 THEN
    v_conv_pct := ROUND(100.0 * v_paid_trials / v_trial_sign, 1);
  END IF;

  RETURN jsonb_build_object(
    'anchor_date',   v_anchor,
    'spend_cents',   v_spend_cents,
    'impressions',   v_impressions,
    'clicks',        v_clicks,
    'leads',         v_meta_leads,
    'trial_signups', v_trial_sign,
    'paid_trials',   v_paid_trials,
    'conv_pct',      v_conv_pct
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_launch_kpis(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_launch_kpis(text) TO authenticated;

-- Sanity (run after deploy):
--   SELECT public.get_launch_kpis('williamsburg');  -- expect paid_trials: 14
--   SELECT public.get_launch_kpis('astoria');       -- expect paid_trials: 16
--   SELECT public.get_launch_kpis('bayside');       -- expect paid_trials: 4
--   SELECT public.get_launch_kpis('fresh-meadows'); -- expect paid_trials: 13
