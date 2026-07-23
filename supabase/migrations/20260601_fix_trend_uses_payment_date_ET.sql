-- ─────────────────────────────────────────────────────────────────────────────
-- Fix get_meta_daily_trend — the Bayside "Last 7 days: 5 Paid" bug.
--
-- Bug: the function buckets paid trials by `created_at`. Tonight's audit
-- recovery inserted 21 historical Stripe payments into trial_signups with
-- created_at = tonight (Jun 1 ET) but payment_date = original Stripe date
-- (May 18, 5/26, etc). Result: every recovered row showed up on "today" in
-- the trend, plus the "Last 7 days" pulse rolled them all up.
--
-- Fix:
--   • paid_trials → bucket by `(payment_date AT TIME ZONE 'America/New_York')`
--   • trial_signups (form fills) → keep bucketing by created_at
--   • Apply same filters as get_launch_kpis:
--       - source_category <> 'legacy_archived'
--       - email NOT LIKE 'backfill-pi_%@no-email.bbb.local'
--       - deleted_at IS NULL
--
-- Output shape unchanged. CREATE OR REPLACE not safe because OUT params shape
-- is identical — but DROP+CREATE explicitly to match the prior pattern.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_meta_daily_trend(text, int);

CREATE FUNCTION public.get_meta_daily_trend(p_studio text, p_days int DEFAULT 14)
RETURNS TABLE(
  day           date,
  spend_cents   bigint,
  impressions   bigint,
  clicks        bigint,
  trial_signups int,
  paid_trials   int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_loc_id  uuid;
  v_today   date;
  v_start   date;
BEGIN
  -- ET-rooted day windows.
  v_today := (now() AT TIME ZONE 'America/New_York')::date;
  v_start := GREATEST(v_today - (p_days - 1), '2026-05-15'::date);

  SELECT l.id INTO v_loc_id
  FROM locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  RETURN QUERY
  WITH cal AS (
    SELECT generate_series(v_start, v_today, '1 day'::interval)::date AS day
  ),
  meta AS (
    SELECT
      m.date_start                  AS day,
      SUM(m.spend_cents)::bigint    AS spend_cents,
      SUM(m.impressions)::bigint    AS impressions,
      SUM(m.clicks)::bigint         AS clicks
    FROM meta_insights_daily m
    WHERE m.studio_slug = p_studio
      AND m.date_start >= v_start
    GROUP BY 1
  ),
  -- Form fills bucketed by created_at (ET): "someone hit submit on this day"
  fills AS (
    SELECT (t.created_at AT TIME ZONE 'America/New_York')::date AS day,
           COUNT(*)::int AS trial_signups
    FROM trial_signups t
    WHERE t.location_id = v_loc_id
      AND t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (t.created_at AT TIME ZONE 'America/New_York')::date >= v_start
    GROUP BY 1
  ),
  -- Paid trials bucketed by payment_date (ET): "this customer's $49 cleared
  -- on this day", regardless of when the row was inserted into our DB.
  paid AS (
    SELECT (t.payment_date AT TIME ZONE 'America/New_York')::date AS day,
           COUNT(*)::int AS paid_trials
    FROM trial_signups t
    WHERE t.location_id = v_loc_id
      AND t.deleted_at IS NULL
      AND t.payment_status = 'completed'
      AND t.payment_date IS NOT NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= v_start
    GROUP BY 1
  )
  SELECT
    cal.day,
    COALESCE(meta.spend_cents, 0)             AS spend_cents,
    COALESCE(meta.impressions, 0)             AS impressions,
    COALESCE(meta.clicks, 0)                  AS clicks,
    COALESCE(fills.trial_signups, 0)          AS trial_signups,
    COALESCE(paid.paid_trials, 0)             AS paid_trials
  FROM cal
  LEFT JOIN meta   USING (day)
  LEFT JOIN fills  USING (day)
  LEFT JOIN paid   USING (day)
  ORDER BY cal.day;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_meta_daily_trend(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_daily_trend(text, int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Also fix get_launch_kpis to bucket trial_signups (lead count) by the SAME
-- rule across studios. Earlier fix used (created_at AT TIME ZONE 'America/New_York')
-- ::date which is correct, but the lead count gets confused for recovered
-- orphans whose created_at is tonight. Recovered rows ARE leads — but at the
-- time their checkout fired, not tonight. Use payment_date for paid + lead
-- floor at the same date.
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
  SELECT l.id INTO v_loc_id
  FROM public.locations l
  WHERE lower(replace(l.name, ' ', '-')) = p_studio
  LIMIT 1;

  SELECT
    COALESCE(SUM(spend_cents), 0),
    COALESCE(SUM(impressions), 0),
    COALESCE(SUM(clicks), 0),
    COALESCE(SUM(leads), 0)
  INTO v_spend_cents, v_impressions, v_clicks, v_meta_leads
  FROM public.meta_insights_daily
  WHERE studio_slug  = p_studio
    AND date_start  >= v_anchor;

  -- Trial leads: count any row whose checkout EITHER (a) was created since
  -- May 15 ET, or (b) has a payment_date since May 15 ET (covers audit-
  -- recovered rows whose created_at is tonight but real checkout was earlier).
  SELECT COUNT(*) INTO v_trial_sign
  FROM public.trial_signups
  WHERE location_id = v_loc_id
    AND deleted_at IS NULL
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
    AND (
      (created_at AT TIME ZONE 'America/New_York')::date >= v_anchor
      OR (payment_date IS NOT NULL
          AND (payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor)
    );

  -- Paid trials: pure payment_date floor — that's the truth of "this customer
  -- actually paid since launch".
  SELECT COUNT(*) INTO v_paid_trials
  FROM public.trial_signups
  WHERE location_id     = v_loc_id
    AND deleted_at IS NULL
    AND payment_status  = 'completed'
    AND payment_date IS NOT NULL
    AND (payment_date AT TIME ZONE 'America/New_York')::date >= v_anchor
    AND COALESCE(source_category, '') <> 'legacy_archived'
    AND COALESCE(email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local';

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

-- Sanity (run after):
--   SELECT * FROM get_meta_daily_trend('bayside', 14);
--   -- expect: 5/15 → 1 paid (Michelle Shieh), 5/18 → 2 paid (Yi/Mariana),
--   --         5/26 → 2 paid (Gisel + Julie Lin), 0 paid every other day
--   SELECT get_launch_kpis('bayside');  -- expect: paid_trials: 5
