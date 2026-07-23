-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10: Purchase-path classification + dashboard breakdown RPC.
--
-- WHY
-- "Where did the money actually come from" is now the question. We have
-- 95 paid trials since launch and they entered through different doors:
--   • Stripe Checkout (web form → Stripe)
--   • MindBody POS (walk in, pay at desk)
--   • MindBody Online widget (clients.mindbodyonline.com self-serve)
--   • Form → MindBody POS (abandoned Stripe checkout, came in to pay)
--   • Legacy backfill (pre-launch import)
--
-- Each path needs different optimization: Stripe = funnel/ads, POS = staff,
-- Online widget = mindbody-widget UX, Form→POS = recovery automation.
--
-- WHAT
--   1. View v_paid_trials_with_path — every paid trial + a `purchase_path` text
--      column based on stripe_session_id, stripe_paid_mirror membership,
--      source_category, and mindbody_id.
--   2. RPC get_purchase_paths(p_studio, p_since) — per-path count + revenue,
--      sorted by count desc. Dashboard card binds to this.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. View: every paid trial labeled with its purchase path + lead source ──
-- Each row also carries the UTM tags from when they first filled the trial
-- form (if they did), so a desk-paid customer who originally came in via
-- "facebook · cpc" can be attributed back to that ad even though MindBody
-- doesn't know about it. Walk-ins with NO web touch get utm_source = NULL.
CREATE OR REPLACE VIEW public.v_paid_trials_with_path AS
WITH stripe_emails AS (
  SELECT DISTINCT lower(customer_email) AS email
  FROM public.stripe_paid_mirror
  WHERE customer_email IS NOT NULL AND customer_email <> ''
)
SELECT
  ts.id,
  ts.name,
  ts.email,
  ts.location_id,
  lower(replace(l.name, ' ', '-')) AS studio_slug,
  ts.payment_date,
  ts.source_category,
  ts.stripe_session_id,
  ts.mindbody_id,
  ts.front_desk_stage,
  ts.utm_source,
  ts.utm_medium,
  ts.utm_campaign,
  CASE
    WHEN ts.source_category = 'legacy_archived'
      THEN 'Legacy backfill'
    WHEN ts.source_category = 'in_person'
      THEN 'MindBody POS (in-person)'
    WHEN lower(ts.email) IN (SELECT email FROM stripe_emails)
      THEN 'Stripe Checkout (web)'
    WHEN ts.stripe_session_id IS NOT NULL AND ts.mindbody_id IS NOT NULL
      THEN 'Form → MindBody POS'
    WHEN ts.mindbody_id IS NOT NULL
      THEN 'MindBody Online widget'
    ELSE 'Unknown'
  END AS purchase_path,
  -- True walk-in flag: in_person + no web touch (no stripe_session_id, no UTM).
  -- These are pure POS sales we cannot attribute to an ad campaign — staff
  -- closed them via word-of-mouth, walk-by foot traffic, or referral.
  CASE
    WHEN ts.source_category = 'in_person'
     AND ts.stripe_session_id IS NULL
     AND ts.utm_source IS NULL
      THEN true
    ELSE false
  END AS is_pure_walk_in,
  -- Friendly origin label combining purchase_path + UTM:
  --   "Walk-in (Astoria desk)"             — pure POS, no funnel touch
  --   "FB ad → desk"                       — paid Stripe-stage failed, MB POS paid
  --   "Form abandoned → desk"              — Dongha pattern
  --   "FB ad → Stripe"                     — clean web conversion
  CASE
    WHEN ts.source_category = 'in_person'
     AND ts.stripe_session_id IS NULL
      THEN 'Walk-in · ' || INITCAP(lower(replace(l.name, ' ', '-')))
    WHEN ts.source_category = 'in_person'
     AND ts.stripe_session_id IS NOT NULL
      THEN COALESCE(INITCAP(ts.utm_source), 'Form') || ' → desk'
    WHEN ts.stripe_session_id IS NOT NULL
     AND lower(ts.email) NOT IN (SELECT email FROM stripe_emails)
     AND ts.mindbody_id IS NOT NULL
      THEN COALESCE(INITCAP(ts.utm_source), 'Form') || ' abandoned → desk'
    WHEN ts.utm_source IS NOT NULL
      THEN INITCAP(ts.utm_source) || ' → Stripe'
    WHEN ts.source_category = 'web_organic'
      THEN 'Organic → Stripe'
    WHEN ts.source_category = 'ad'
      THEN 'Ad → Stripe'
    WHEN ts.source_category = 'legacy_archived'
      THEN 'Legacy import'
    ELSE 'Unknown origin'
  END AS lead_origin
FROM public.trial_signups ts
JOIN public.locations l ON l.id = ts.location_id
WHERE ts.payment_status = 'completed'
  AND ts.payment_date   IS NOT NULL
  AND ts.deleted_at     IS NULL;

GRANT SELECT ON public.v_paid_trials_with_path TO authenticated;


-- ── 2. RPC: per-path count + revenue, sorted by count desc ──────────────────
CREATE OR REPLACE FUNCTION public.get_purchase_paths(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  purchase_path     text,
  trial_count       int,
  revenue_usd       numeric,
  pct_of_total      numeric,
  newest_paid_at    timestamptz,
  oldest_paid_at    timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH base AS (
    SELECT *
    FROM public.v_paid_trials_with_path
    WHERE (p_studio IS NULL OR studio_slug = p_studio)
      AND (payment_date AT TIME ZONE 'America/New_York')::date >= p_since
  ),
  total AS (SELECT COUNT(*)::numeric AS n FROM base),
  paths AS (
    SELECT
      purchase_path,
      COUNT(*)::int AS trial_count,
      ROUND(COUNT(*) * 49.0, 2) AS revenue_usd,
      MAX(payment_date) AS newest_paid_at,
      MIN(payment_date) AS oldest_paid_at
    FROM base
    GROUP BY purchase_path
  )
  SELECT
    p.purchase_path,
    p.trial_count,
    p.revenue_usd,
    CASE WHEN t.n > 0 THEN ROUND(p.trial_count / t.n * 100, 1) ELSE 0 END AS pct_of_total,
    p.newest_paid_at,
    p.oldest_paid_at
  FROM paths p, total t
  ORDER BY p.trial_count DESC, p.purchase_path ASC;
$$;

REVOKE ALL ON FUNCTION public.get_purchase_paths(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_purchase_paths(text, date) TO authenticated;


-- ── 3. Per-studio matrix RPC: which path dominates which studio? ────────────
CREATE OR REPLACE FUNCTION public.get_purchase_paths_by_studio(
  p_since date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  studio_slug    text,
  purchase_path  text,
  trial_count    int,
  revenue_usd    numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    studio_slug,
    purchase_path,
    COUNT(*)::int AS trial_count,
    ROUND(COUNT(*) * 49.0, 2) AS revenue_usd
  FROM public.v_paid_trials_with_path
  WHERE (payment_date AT TIME ZONE 'America/New_York')::date >= p_since
  GROUP BY studio_slug, purchase_path
  ORDER BY studio_slug, trial_count DESC;
$$;

REVOKE ALL ON FUNCTION public.get_purchase_paths_by_studio(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_purchase_paths_by_studio(date) TO authenticated;


-- ── 4. Detail RPC: every paid trial with path label + attribution ──────────
DROP FUNCTION IF EXISTS public.get_paid_trials_detail(text, date, text);

CREATE FUNCTION public.get_paid_trials_detail(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date,
  p_path   text DEFAULT NULL
)
RETURNS TABLE (
  id                uuid,
  name              text,
  email             text,
  studio_slug       text,
  payment_date      timestamptz,
  purchase_path     text,
  lead_origin       text,
  is_pure_walk_in   boolean,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  source_category   text,
  mindbody_id       text,
  front_desk_stage  text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    v.id, v.name, v.email, v.studio_slug, v.payment_date,
    v.purchase_path, v.lead_origin, v.is_pure_walk_in,
    v.utm_source, v.utm_medium, v.utm_campaign,
    v.source_category, v.mindbody_id, v.front_desk_stage
  FROM public.v_paid_trials_with_path v
  WHERE (p_studio IS NULL OR v.studio_slug = p_studio)
    AND (p_path   IS NULL OR v.purchase_path = p_path)
    AND (v.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
  ORDER BY v.payment_date DESC;
$$;

REVOKE ALL ON FUNCTION public.get_paid_trials_detail(text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_paid_trials_detail(text, date, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION PROBES
-- After Run, expected output (per the REST audit):
--
--   purchase_path                        trial_count  revenue_usd  pct
--   Stripe Checkout (web)                    76        3724.00     80.0
--   MindBody POS (in-person)                 17         833.00     17.9
--   Form → MindBody POS                       1          49.00      1.1
--   Legacy backfill                           1          49.00      1.1
-- ─────────────────────────────────────────────────────────────────────────────
SELECT * FROM public.get_purchase_paths(NULL, '2026-05-15'::date);

SELECT studio_slug, purchase_path, trial_count
FROM public.get_purchase_paths_by_studio('2026-05-15'::date);
