-- ─────────────────────────────────────────────────────────────────────────────
-- Member churn visibility — who joined, who's slipping, who's gone.
--
-- IMPORTANT LESSON FROM v1 OF THIS MIGRATION:
--   We initially treated mindbody_clients.member_since as "membership start
--   date." It is NOT. In MindBody, `member_since` (a.k.a. CreationDate) is
--   just when the client record was created — equivalent to "first signed
--   up for anything." A trial-only walk-in has a member_since too.
--
--   The TRUE membership signal is mindbody_clients.status:
--     'Active'      paying member
--     'Non-Member'  trial / contact / lead — NOT a member
--     'Suspended'   paying member but on hold (we count them as members)
--     'Expired'/'Terminated'/'Cancelled' — used to be a member, gone now
--
-- WHY THIS EXISTS:
--   Owners can see "55 paid trials this month" but have no visibility into the
--   metric that pays the rent: of those who became members, how many are
--   still showing up? Where in the lifecycle are they slipping?
--
-- HOW WE DEFINE CHURN (behavioral, not status-driven):
--   MindBody's status field updates with a lag (and front desk sometimes
--   forgets to flip it). The TRUTH for "is this person still a member" is
--   class attendance. So we bucket Active/Suspended members by behavior:
--     engaged       attended ≤ 7d ago
--     slowing       attended 8-14d ago
--     at_risk       attended 15-30d ago   ← rescuable window
--     dormant       attended 31-60d ago
--     lapsed        no attended class 60+ days
--     never_attended  Active in MindBody but never signed into a class
--   Explicit MindBody cancellations get their own bucket (mindbody_canceled).
--
-- COHORTS:
--   Without a true "membership_started_at" field, we can't reconstruct the
--   exact month each member converted. We bucket instead by first_attended_
--   at month — the month of their first class. This is a fair proxy because
--   members generally attend within days of joining.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 0. Drop the v1 view + RPCs (using wrong definition) ────────────────────
DROP FUNCTION IF EXISTS public.get_at_risk_members(text);
DROP FUNCTION IF EXISTS public.get_member_cohort_retention(text);
DROP FUNCTION IF EXISTS public.get_member_churn_summary(text);
DROP VIEW     IF EXISTS public.v_member_lifecycle CASCADE;


-- ── 1. View: v_member_lifecycle ────────────────────────────────────────────
-- One row per current/former MEMBER (status indicates paid relationship).
-- Joins to mindbody_visits to derive behavioral signals + cohort month.
CREATE OR REPLACE VIEW public.v_member_lifecycle AS
WITH visit_agg AS (
  SELECT
    mv.mindbody_client_id,
    MIN(mv.starts_at) FILTER (WHERE mv.signed_in = true) AS first_attended_at,
    MAX(mv.starts_at) FILTER (WHERE mv.signed_in = true) AS last_attended_at,
    COUNT(*)         FILTER (WHERE mv.signed_in = true) AS lifetime_attended,
    COUNT(*) FILTER (
      WHERE mv.signed_in = true
        AND mv.starts_at >= now() - interval '30 days'
    ) AS visits_30d,
    COUNT(*) FILTER (
      WHERE mv.signed_in = true
        AND mv.starts_at >= now() - interval '7 days'
    ) AS visits_7d
  FROM public.mindbody_visits mv
  GROUP BY mv.mindbody_client_id
),
base AS (
  SELECT
    mc.mindbody_id,
    mc.email,
    mc.first_name,
    mc.last_name,
    mc.studio_slug,
    mc.member_since                                   AS mindbody_record_created_at,
    mc.status                                         AS mindbody_status,
    va.first_attended_at,
    va.last_attended_at,
    -- Cohort month = month of first attended class (best proxy for "started
    -- their member life" since we don't have a true membership_started_at)
    date_trunc('month', (va.first_attended_at AT TIME ZONE 'America/New_York'))::date AS cohort_month,
    COALESCE(va.lifetime_attended, 0) AS lifetime_attended,
    COALESCE(va.visits_30d, 0)        AS visits_30d,
    COALESCE(va.visits_7d, 0)         AS visits_7d,
    CASE
      WHEN va.last_attended_at IS NOT NULL
      THEN GREATEST(0,
             EXTRACT(EPOCH FROM (now() - va.last_attended_at)) / 86400.0
           )::int
      ELSE NULL
    END AS days_since_last_visit
  FROM public.mindbody_clients mc
  LEFT JOIN visit_agg va ON va.mindbody_client_id = mc.mindbody_id
  -- Restrict to the 4 currently-active BBB studios. great-neck and new-
  -- hyde-park are old locations that lived in the same MindBody account;
  -- they should never appear on the owner dashboard. 'unknown' studio_slug
  -- means the MindBody sync didn't get a HomeLocation back — also excluded.
  WHERE mc.studio_slug IN ('astoria', 'bayside', 'fresh-meadows', 'williamsburg')
    -- Only people who are CURRENTLY or WERE EVER a paid member.
    AND mc.status IN ('Active', 'Suspended', 'Expired', 'Terminated', 'Cancelled')
)
SELECT
  *,
  -- Effective status: explicit cancellations override behavioral signal.
  CASE
    WHEN mindbody_status IN ('Expired', 'Terminated', 'Cancelled') THEN 'mindbody_canceled'
    WHEN last_attended_at IS NULL                                  THEN 'never_attended'
    WHEN days_since_last_visit <= 7                                 THEN 'engaged'
    WHEN days_since_last_visit <= 14                                THEN 'slowing'
    WHEN days_since_last_visit <= 30                                THEN 'at_risk'
    WHEN days_since_last_visit <= 60                                THEN 'dormant'
    ELSE                                                                 'lapsed'
  END AS effective_status,
  -- Convenience: is this person CURRENTLY a paying member per MindBody?
  CASE WHEN mindbody_status IN ('Active', 'Suspended') THEN true ELSE false END AS is_active_member
FROM base;

COMMENT ON VIEW public.v_member_lifecycle IS
  'Per-member behavioral lifecycle. Includes anyone whose MindBody status is/was a member tier (Active/Suspended/Expired/Terminated/Cancelled). NOT included: Non-Member (= trial leads only). Bucket via effective_status.';


-- ── 2. RPC: get_member_churn_summary(p_studio) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_member_churn_summary(p_studio text DEFAULT NULL)
RETURNS TABLE (
  studio_slug              text,
  active_members           int,    -- status='Active' or 'Suspended'
  ever_members             int,    -- includes canceled
  engaged_count            int,
  slowing_count            int,
  at_risk_count            int,
  dormant_count            int,
  lapsed_count             int,
  never_attended_count     int,
  mindbody_canceled_count  int,
  new_this_month           int,    -- first_attended_at in current ET month
  new_last_month_partial   int,    -- same day-range, last month
  net_new_delta_pct        numeric,
  median_visits_30d        numeric,
  retention_pct            numeric  -- % of active members behaviorally engaged/slowing/at_risk
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      date_trunc('month', (now() AT TIME ZONE 'America/New_York'))::date AS month_start,
      ((now() AT TIME ZONE 'America/New_York'))::date                    AS today_et,
      (date_trunc('month', (now() AT TIME ZONE 'America/New_York')) - interval '1 month')::date AS last_month_start,
      (date_trunc('month', (now() AT TIME ZONE 'America/New_York')) - interval '1 month')::date
        + ((now() AT TIME ZONE 'America/New_York')::date
           - date_trunc('month', (now() AT TIME ZONE 'America/New_York'))::date) AS last_month_through
  ),
  filt AS (
    SELECT *
    FROM public.v_member_lifecycle
    WHERE (p_studio IS NULL OR studio_slug = p_studio)
  ),
  -- median_visits_30d is computed over active members ONLY. PL/pgSQL refuses
  -- to combine percentile_cont WITHIN GROUP with FILTER cleanly, so this is
  -- broken out into its own CTE.
  active_only AS (
    SELECT studio_slug, visits_30d
    FROM filt
    WHERE is_active_member
  ),
  median_per_studio AS (
    SELECT
      studio_slug,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY visits_30d)::numeric, 1) AS median_visits_30d
    FROM active_only
    GROUP BY studio_slug
  ),
  agg AS (
    SELECT
      studio_slug,
      COUNT(*) FILTER (WHERE is_active_member)::int                       AS active_members,
      COUNT(*)::int                                                       AS ever_members,
      COUNT(*) FILTER (WHERE effective_status = 'engaged')::int            AS engaged_count,
      COUNT(*) FILTER (WHERE effective_status = 'slowing')::int            AS slowing_count,
      COUNT(*) FILTER (WHERE effective_status = 'at_risk')::int            AS at_risk_count,
      COUNT(*) FILTER (WHERE effective_status = 'dormant')::int            AS dormant_count,
      COUNT(*) FILTER (WHERE effective_status = 'lapsed')::int             AS lapsed_count,
      COUNT(*) FILTER (WHERE effective_status = 'never_attended')::int     AS never_attended_count,
      COUNT(*) FILTER (WHERE effective_status = 'mindbody_canceled')::int  AS mindbody_canceled_count,
      COUNT(*) FILTER (
        WHERE first_attended_at IS NOT NULL
          AND (first_attended_at AT TIME ZONE 'America/New_York')::date >= (SELECT month_start FROM bounds)
      )::int                                                              AS new_this_month,
      COUNT(*) FILTER (
        WHERE first_attended_at IS NOT NULL
          AND (first_attended_at AT TIME ZONE 'America/New_York')::date >= (SELECT last_month_start FROM bounds)
          AND (first_attended_at AT TIME ZONE 'America/New_York')::date <= (SELECT last_month_through FROM bounds)
      )::int                                                              AS new_last_month_partial
    FROM filt
    GROUP BY studio_slug
  )
  SELECT
    a.studio_slug,
    a.active_members, a.ever_members,
    a.engaged_count, a.slowing_count, a.at_risk_count,
    a.dormant_count, a.lapsed_count, a.never_attended_count, a.mindbody_canceled_count,
    a.new_this_month, a.new_last_month_partial,
    CASE WHEN a.new_last_month_partial > 0
         THEN ROUND(100.0 * (a.new_this_month - a.new_last_month_partial)::numeric
                    / a.new_last_month_partial, 1)
         ELSE NULL END                                                    AS net_new_delta_pct,
    COALESCE(m.median_visits_30d, 0)                                      AS median_visits_30d,
    CASE WHEN a.active_members > 0
         THEN ROUND(100.0 * (a.engaged_count + a.slowing_count + a.at_risk_count)::numeric
                    / a.active_members, 1)
         ELSE NULL END                                                    AS retention_pct
  FROM agg a
  LEFT JOIN median_per_studio m ON m.studio_slug = a.studio_slug
  ORDER BY a.studio_slug;
$$;

REVOKE ALL ON FUNCTION public.get_member_churn_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_member_churn_summary(text) TO authenticated;


-- ── 3. RPC: get_member_cohort_retention(p_studio) ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_member_cohort_retention(p_studio text DEFAULT NULL)
RETURNS TABLE (
  cohort_month           date,    -- month of first attended class
  studio_slug            text,
  members_in_cohort      int,
  still_engaged          int,
  still_attending        int,
  dormant_or_lapsed      int,
  retention_30d_pct      numeric,
  retention_engaged_pct  numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filt AS (
    SELECT *
    FROM public.v_member_lifecycle
    WHERE (p_studio IS NULL OR studio_slug = p_studio)
      AND cohort_month IS NOT NULL  -- only members who've attended at least once
  ),
  agg AS (
    SELECT
      cohort_month,
      studio_slug,
      COUNT(*)::int                                                       AS members_in_cohort,
      COUNT(*) FILTER (WHERE effective_status = 'engaged')::int            AS still_engaged,
      COUNT(*) FILTER (WHERE effective_status IN ('engaged','slowing','at_risk'))::int AS still_attending,
      COUNT(*) FILTER (WHERE effective_status IN ('dormant','lapsed','mindbody_canceled'))::int AS dormant_or_lapsed
    FROM filt
    GROUP BY cohort_month, studio_slug
  )
  SELECT
    cohort_month, studio_slug, members_in_cohort, still_engaged, still_attending, dormant_or_lapsed,
    CASE WHEN members_in_cohort > 0
         THEN ROUND(100.0 * still_attending::numeric / members_in_cohort, 1) ELSE 0 END AS retention_30d_pct,
    CASE WHEN members_in_cohort > 0
         THEN ROUND(100.0 * still_engaged::numeric / members_in_cohort, 1) ELSE 0 END AS retention_engaged_pct
  FROM agg
  ORDER BY cohort_month DESC, studio_slug;
$$;

REVOKE ALL ON FUNCTION public.get_member_cohort_retention(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_member_cohort_retention(text) TO authenticated;


-- ── 4. RPC: get_at_risk_members(p_studio) ──────────────────────────────────
-- Action list for the front desk: active members who haven't been in for
-- 14-45 days. Calls to these people while there's still a chance.
CREATE OR REPLACE FUNCTION public.get_at_risk_members(p_studio text DEFAULT NULL)
RETURNS TABLE (
  mindbody_id            text,
  first_name             text,
  last_name              text,
  email                  text,
  studio_slug            text,
  mindbody_status        text,
  first_attended_at      timestamptz,
  last_attended_at       timestamptz,
  days_since_last_visit  int,
  lifetime_attended      int,
  effective_status       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    mindbody_id, first_name, last_name, email, studio_slug,
    mindbody_status, first_attended_at, last_attended_at,
    days_since_last_visit, lifetime_attended, effective_status
  FROM public.v_member_lifecycle
  WHERE (p_studio IS NULL OR studio_slug = p_studio)
    AND is_active_member = true
    AND effective_status IN ('at_risk', 'dormant')
    AND days_since_last_visit BETWEEN 14 AND 45
  ORDER BY days_since_last_visit ASC, last_attended_at DESC
  LIMIT 50;
$$;

REVOKE ALL ON FUNCTION public.get_at_risk_members(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_at_risk_members(text) TO authenticated;


-- ── 5. Initial visibility ──────────────────────────────────────────────────
SELECT 'churn_summary' AS report, * FROM public.get_member_churn_summary();
SELECT 'cohort_retention' AS report, * FROM public.get_member_cohort_retention();
SELECT 'at_risk_count' AS report, COUNT(*)::int AS rescueable_members
  FROM public.get_at_risk_members();

-- Sanity: show actual MindBody status distribution per studio so you know
-- which buckets are populated in the real data.
SELECT 'status_breakdown' AS report,
       studio_slug, status, COUNT(*)::int AS n
  FROM public.mindbody_clients
  WHERE studio_slug IS NOT NULL
  GROUP BY studio_slug, status
  ORDER BY studio_slug, n DESC;
