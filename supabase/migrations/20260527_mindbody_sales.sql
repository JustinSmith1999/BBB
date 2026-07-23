-- ─────────────────────────────────────────────────────────────────────────────
-- mindbody_sales table — POS transactions pulled from MindBody for the
-- new "In-person" revenue card on the owner dashboard.
-- Populated by the mindbody-sales-sync edge function (hourly cron).
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop first so an old half-created version with mismatched columns can't
-- block the new schema. Idempotent — safe to re-run anytime.
DROP TABLE IF EXISTS public.mindbody_sales CASCADE;

CREATE TABLE public.mindbody_sales (
  mindbody_sale_id      text PRIMARY KEY,
  studio_slug           text NOT NULL,
  location_id           int,
  sale_date_time        timestamptz,
  customer_mindbody_id  text,
  customer_first_name   text,
  customer_last_name    text,
  customer_email        text,
  payment_method        text,
  item_names            text,
  item_count            int,
  total_cents           bigint DEFAULT 0,
  raw                   jsonb,
  synced_at             timestamptz DEFAULT now()
);

CREATE INDEX mindbody_sales_studio_date_idx
  ON public.mindbody_sales (studio_slug, sale_date_time DESC);

CREATE INDEX mindbody_sales_email_idx
  ON public.mindbody_sales (customer_email)
  WHERE customer_email IS NOT NULL;

ALTER TABLE public.mindbody_sales ENABLE ROW LEVEL SECURITY;
-- No SELECT policy = denied to anon/authenticated. Dashboard reads via the
-- SECURITY DEFINER RPCs below.


-- ── get_studio_revenue — the 3-bucket breakdown for the owner dashboard ────
-- Returns one row per requested studio with online ads / web organic / POS
-- revenue counted in cents, customer count per bucket, and a since-date.
CREATE OR REPLACE FUNCTION public.get_studio_revenue(
  p_studio  text,
  p_since   date DEFAULT '2026-05-15'::date
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_allowed text[];
  v_loc_id  uuid;
  v_ad_customers     int;
  v_ad_revenue       bigint;
  v_organic_customers int;
  v_organic_revenue  bigint;
  v_in_person_customers int;
  v_in_person_revenue bigint;
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;
  IF NOT (p_studio = ANY(v_allowed)) THEN
    RETURN jsonb_build_object('blocked', true);
  END IF;

  SELECT l.id INTO v_loc_id
  FROM public.locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  -- Online (ad) — strict: only source_category='ad' paid rows
  SELECT COUNT(*), COUNT(*) * 4900
  INTO v_ad_customers, v_ad_revenue
  FROM public.trial_signups
  WHERE location_id = v_loc_id
    AND payment_status = 'completed'
    AND source_category = 'ad'
    AND created_at >= p_since;

  -- Online (web organic)
  SELECT COUNT(*), COUNT(*) * 4900
  INTO v_organic_customers, v_organic_revenue
  FROM public.trial_signups
  WHERE location_id = v_loc_id
    AND payment_status = 'completed'
    AND source_category = 'web_organic'
    AND created_at >= p_since;

  -- In-person — every MindBody sale at the studio since the cutoff.
  SELECT COUNT(*), COALESCE(SUM(total_cents), 0)
  INTO v_in_person_customers, v_in_person_revenue
  FROM public.mindbody_sales
  WHERE studio_slug = p_studio
    AND sale_date_time >= p_since;

  RETURN jsonb_build_object(
    'studio_slug', p_studio,
    'since', p_since,
    'ad', jsonb_build_object('customers', v_ad_customers, 'revenue_cents', v_ad_revenue),
    'web_organic', jsonb_build_object('customers', v_organic_customers, 'revenue_cents', v_organic_revenue),
    'in_person', jsonb_build_object('customers', v_in_person_customers, 'revenue_cents', v_in_person_revenue),
    'total_customers', v_ad_customers + v_organic_customers + v_in_person_customers,
    'total_revenue_cents', v_ad_revenue + v_organic_revenue + v_in_person_revenue
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_studio_revenue(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_studio_revenue(text, date) TO authenticated;


-- ── get_ad_performance — strict Meta-ads-only CPM math ─────────────────────
-- Spend comes from meta_insights_daily; converted trials come ONLY from
-- source_category='ad' rows. Nothing else inflates the denominator.
CREATE OR REPLACE FUNCTION public.get_ad_performance(p_studio text, p_since date DEFAULT '2026-05-15'::date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_allowed text[];
  v_loc_id  uuid;
  v_spend_cents bigint;
  v_impressions bigint;
  v_clicks bigint;
  v_ad_trials int;
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;
  IF NOT (p_studio = ANY(v_allowed)) THEN
    RETURN jsonb_build_object('blocked', true);
  END IF;

  SELECT l.id INTO v_loc_id
  FROM public.locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  SELECT COALESCE(SUM(spend_cents), 0),
         COALESCE(SUM(impressions), 0),
         COALESCE(SUM(clicks), 0)
  INTO v_spend_cents, v_impressions, v_clicks
  FROM public.meta_insights_daily
  WHERE studio_slug = p_studio
    AND date_start >= p_since;

  SELECT COUNT(*) INTO v_ad_trials
  FROM public.trial_signups
  WHERE location_id = v_loc_id
    AND payment_status = 'completed'
    AND source_category = 'ad'
    AND created_at >= p_since;

  RETURN jsonb_build_object(
    'studio_slug', p_studio,
    'since', p_since,
    'spend_cents', v_spend_cents,
    'impressions', v_impressions,
    'clicks', v_clicks,
    'ad_trials', v_ad_trials,
    'cost_per_trial_cents', CASE WHEN v_ad_trials > 0 THEN ROUND(v_spend_cents::numeric / v_ad_trials)::bigint ELSE NULL END,
    'cpm_cents', CASE WHEN v_impressions > 0 THEN ROUND(v_spend_cents::numeric / v_impressions * 1000)::bigint ELSE NULL END,
    'ctr', CASE WHEN v_impressions > 0 THEN ROUND(100.0 * v_clicks / v_impressions, 2) ELSE 0 END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_ad_performance(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_performance(text, date) TO authenticated;


-- ── Sanity ─────────────────────────────────────────────────────────────────
-- SELECT public.get_studio_revenue('astoria');
-- SELECT public.get_ad_performance('astoria');
