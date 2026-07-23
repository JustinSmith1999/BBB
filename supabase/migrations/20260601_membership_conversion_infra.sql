-- ─────────────────────────────────────────────────────────────────────────────
-- Membership conversion infrastructure (BUILD COLD, SHIP GATED)
--
-- Tonight: build the schema + RPCs + log table. Nothing fires automatically.
-- The 14-day SMS nudge function is deployed but gated by the BBB_SEND_PATHS_
-- ENABLED env var path "trial_membership_nudge" which is OFF by default. The
-- cron schedule below is COMMENTED OUT until Justin reviews.
--
-- THE BUSINESS QUESTION THIS UNLOCKS:
--   "Of the people who paid the $49 trial, how many actually become paying
--    members? At what cost? Within what time window?"
--   Currently invisible. After this migration, fully measurable.
--
-- DATA MODEL:
--   - We don't denormalize membership status onto trial_signups. Instead a
--     view (v_trial_member_journey) joins trial_signups → mindbody_clients
--     (by email) → mindbody_visits (counts). Truth stays in source tables.
--   - We do add a `membership_nudge_sent_at` column so we can guarantee at most
--     one nudge SMS per trial customer.
--   - membership_nudges table logs every send attempt for /ops visibility.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tracking column on trial_signups ────────────────────────────────────
ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS membership_nudge_sent_at timestamptz;

COMMENT ON COLUMN public.trial_signups.membership_nudge_sent_at IS
  'When the 14-day membership-conversion SMS nudge was sent (1x lifetime per trial). NULL = never sent. Enforces single-send policy.';


-- ── 2. View: v_trial_member_journey ────────────────────────────────────────
-- Per-trial summary joining signup → MindBody client (by email) → visit count
-- → conversion status. This is the single source of truth for membership
-- conversion analytics. Rebuilds whenever queried, so it's always fresh.
CREATE OR REPLACE VIEW public.v_trial_member_journey AS
WITH paid_trials AS (
  SELECT
    t.id                AS trial_id,
    t.name,
    t.email,
    t.phone,
    t.location_id,
    lower(replace(l.name, ' ', '-')) AS studio_slug,
    t.payment_date,
    t.payment_status,
    t.front_desk_stage,
    t.membership_nudge_sent_at,
    -- Cohort week — every paid trial belongs to a cohort defined by the
    -- Monday of the week they paid. Easy to roll up for retention math.
    date_trunc('week', t.payment_date AT TIME ZONE 'America/New_York')::date AS cohort_week
  FROM public.trial_signups t
  JOIN public.locations l ON l.id = t.location_id
  WHERE t.payment_status = 'completed'
    AND t.payment_date >= '2026-05-15'::date  -- launch filter
    AND t.deleted_at IS NULL
),
client_lookup AS (
  -- Match paid trial → MindBody client by normalized email
  SELECT
    pt.trial_id,
    mc.mindbody_id,
    mc.member_since,
    mc.status AS mindbody_status
  FROM paid_trials pt
  LEFT JOIN public.mindbody_clients mc
    ON lower(trim(mc.email)) = lower(trim(pt.email))
   AND mc.email IS NOT NULL
),
visit_counts AS (
  -- How many classes have they signed in to since paying?
  SELECT
    pt.trial_id,
    COUNT(*) FILTER (WHERE mv.signed_in = true)        AS attended_count,
    MIN(mv.starts_at) FILTER (WHERE mv.signed_in)      AS first_attended_at,
    MAX(mv.starts_at) FILTER (WHERE mv.signed_in)      AS last_attended_at,
    COUNT(*) FILTER (WHERE mv.signed_in = false
                        AND mv.late_cancelled = false
                        AND mv.cancelled = false)      AS booked_not_yet_attended_count
  FROM paid_trials pt
  JOIN client_lookup cl ON cl.trial_id = pt.trial_id
  LEFT JOIN public.mindbody_visits mv
    ON mv.mindbody_client_id = cl.mindbody_id
   AND mv.starts_at >= pt.payment_date - interval '1 day'
  GROUP BY pt.trial_id
)
SELECT
  pt.trial_id,
  pt.name,
  pt.email,
  pt.phone,
  pt.studio_slug,
  pt.location_id,
  pt.payment_date,
  pt.front_desk_stage,
  pt.cohort_week,
  pt.membership_nudge_sent_at,
  cl.mindbody_id,
  cl.member_since,
  cl.mindbody_status,
  COALESCE(vc.attended_count, 0)                AS attended_count,
  COALESCE(vc.booked_not_yet_attended_count, 0) AS booked_not_yet_attended_count,
  vc.first_attended_at,
  vc.last_attended_at,
  -- Days elapsed since the customer paid for the trial.
  GREATEST(0,
    EXTRACT(EPOCH FROM (now() - pt.payment_date)) / 86400.0
  )::int AS days_since_paid,
  -- Best-effort "is this person a paying member yet?" — MindBody assigns
  -- member_since when a paid membership is activated. If member_since is
  -- AFTER payment_date, they converted during/after their trial.
  CASE
    WHEN cl.member_since IS NOT NULL
     AND cl.member_since > pt.payment_date
    THEN true ELSE false
  END AS converted_to_member,
  -- The nudge eligibility flag: 5+ attended classes OR 12+ days since paid,
  -- and no nudge already sent. This is what trial-membership-nudge checks.
  CASE
    WHEN pt.membership_nudge_sent_at IS NOT NULL THEN false
    WHEN cl.member_since IS NOT NULL
     AND cl.member_since > pt.payment_date THEN false  -- already a member, no nudge needed
    WHEN COALESCE(vc.attended_count, 0) >= 5 THEN true
    WHEN GREATEST(0, EXTRACT(EPOCH FROM (now() - pt.payment_date)) / 86400.0) >= 12
     AND COALESCE(vc.attended_count, 0) >= 3 THEN true
    ELSE false
  END AS nudge_eligible
FROM paid_trials pt
LEFT JOIN client_lookup cl ON cl.trial_id = pt.trial_id
LEFT JOIN visit_counts vc  ON vc.trial_id = pt.trial_id;

COMMENT ON VIEW public.v_trial_member_journey IS
  'Per-trial conversion journey: signup → MindBody client → visit count → member. Used for cohort retention + membership-nudge eligibility. Filters trial_signups to completed + post-2026-05-15 + not-deleted.';


-- ── 3. RPC: get_membership_conversion_candidates(p_studio) ─────────────────
-- Front-desk and Justin's dashboard use this to surface trials ready for the
-- "ready for monthly?" upsell. Sorted by attendance desc so the most-engaged
-- show first.
DROP FUNCTION IF EXISTS public.get_membership_conversion_candidates(text);

CREATE OR REPLACE FUNCTION public.get_membership_conversion_candidates(p_studio text DEFAULT NULL)
RETURNS TABLE (
  trial_id                uuid,
  name                    text,
  email                   text,
  phone                   text,
  studio_slug             text,
  payment_date            timestamptz,
  days_since_paid         int,
  attended_count          int,
  booked_not_yet_attended_count int,
  last_attended_at        timestamptz,
  front_desk_stage        text,
  nudge_eligible          boolean,
  membership_nudge_sent_at timestamptz,
  converted_to_member     boolean,
  member_since            timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    trial_id, name, email, phone, studio_slug, payment_date, days_since_paid,
    attended_count, booked_not_yet_attended_count, last_attended_at,
    front_desk_stage, nudge_eligible, membership_nudge_sent_at,
    converted_to_member, member_since
  FROM public.v_trial_member_journey
  WHERE (p_studio IS NULL OR studio_slug = p_studio)
    AND converted_to_member = false                -- exclude already-members
    AND attended_count >= 3                         -- minimum signal to upsell
  ORDER BY attended_count DESC, last_attended_at DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.get_membership_conversion_candidates(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_membership_conversion_candidates(text) TO authenticated;


-- ── 4. RPC: get_cohort_conversion_stats() ──────────────────────────────────
-- For the cohort retention dashboard. Each cohort_week shows: paid → attended
-- → engaged (3+) → converted_to_member. The percentages reveal where the
-- funnel is leaking week over week.
DROP FUNCTION IF EXISTS public.get_cohort_conversion_stats();

CREATE OR REPLACE FUNCTION public.get_cohort_conversion_stats()
RETURNS TABLE (
  cohort_week               date,
  studio_slug               text,
  paid_count                int,
  attended_at_least_once    int,
  engaged_3_plus            int,
  converted_to_member       int,
  pay_to_attend_pct         numeric,
  attend_to_engaged_pct     numeric,
  engaged_to_member_pct     numeric,
  pay_to_member_pct         numeric,
  avg_days_to_first_attend  numeric,
  avg_days_to_member        numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT * FROM public.v_trial_member_journey
  ),
  per_cohort AS (
    SELECT
      cohort_week,
      studio_slug,
      COUNT(*)::int                                                              AS paid_count,
      COUNT(*) FILTER (WHERE attended_count >= 1)::int                           AS attended_at_least_once,
      COUNT(*) FILTER (WHERE attended_count >= 3)::int                           AS engaged_3_plus,
      COUNT(*) FILTER (WHERE converted_to_member)::int                           AS converted_to_member,
      AVG(EXTRACT(EPOCH FROM (first_attended_at - payment_date)) / 86400.0)
        FILTER (WHERE first_attended_at IS NOT NULL)                              AS avg_days_to_first_attend,
      AVG(EXTRACT(EPOCH FROM (member_since - payment_date)) / 86400.0)
        FILTER (WHERE converted_to_member)                                        AS avg_days_to_member
    FROM base
    GROUP BY cohort_week, studio_slug
  )
  SELECT
    cohort_week,
    studio_slug,
    paid_count,
    attended_at_least_once,
    engaged_3_plus,
    converted_to_member,
    CASE WHEN paid_count > 0
      THEN ROUND(100.0 * attended_at_least_once / paid_count, 1) ELSE 0 END AS pay_to_attend_pct,
    CASE WHEN attended_at_least_once > 0
      THEN ROUND(100.0 * engaged_3_plus / attended_at_least_once, 1) ELSE 0 END AS attend_to_engaged_pct,
    CASE WHEN engaged_3_plus > 0
      THEN ROUND(100.0 * converted_to_member / engaged_3_plus, 1) ELSE 0 END AS engaged_to_member_pct,
    CASE WHEN paid_count > 0
      THEN ROUND(100.0 * converted_to_member / paid_count, 1) ELSE 0 END AS pay_to_member_pct,
    ROUND(avg_days_to_first_attend::numeric, 1) AS avg_days_to_first_attend,
    ROUND(avg_days_to_member::numeric, 1)        AS avg_days_to_member
  FROM per_cohort
  ORDER BY cohort_week DESC, studio_slug;
$$;

REVOKE ALL ON FUNCTION public.get_cohort_conversion_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cohort_conversion_stats() TO authenticated;


-- ── 5. Log table: membership_nudges ────────────────────────────────────────
-- One row per nudge attempt (success or failure). Mirrors the capi_events
-- pattern — silent failures stop being silent.
CREATE TABLE IF NOT EXISTS public.membership_nudges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  trial_id        uuid REFERENCES public.trial_signups(id),
  studio_slug     text,
  customer_name   text,
  customer_phone  text,
  attended_count  int,
  days_since_paid int,
  channel         text NOT NULL,           -- 'sms' for now; may add 'email' later
  ok              boolean NOT NULL,
  twilio_sid      text,                     -- Twilio message SID on success
  error           text,
  raw             jsonb
);

CREATE INDEX IF NOT EXISTS membership_nudges_attempted_idx ON public.membership_nudges (attempted_at DESC);
CREATE INDEX IF NOT EXISTS membership_nudges_trial_idx ON public.membership_nudges (trial_id);


-- ── 6. RPC: get_membership_nudge_status() ──────────────────────────────────
-- For /ops visibility. Shows the most recent nudge attempts so a silent
-- failure can't sit unnoticed.
DROP FUNCTION IF EXISTS public.get_membership_nudge_status();

CREATE OR REPLACE FUNCTION public.get_membership_nudge_status()
RETURNS TABLE (
  studio_slug         text,
  attempts_7d         int,
  successes_7d        int,
  failures_7d         int,
  last_attempt_at     timestamptz,
  last_ok_at          timestamptz,
  last_error          text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH agg AS (
    SELECT
      studio_slug,
      COUNT(*) FILTER (WHERE attempted_at >= now() - interval '7 days')::int AS attempts_7d,
      COUNT(*) FILTER (WHERE attempted_at >= now() - interval '7 days' AND ok)::int AS successes_7d,
      COUNT(*) FILTER (WHERE attempted_at >= now() - interval '7 days' AND NOT ok)::int AS failures_7d,
      MAX(attempted_at)                          AS last_attempt_at,
      MAX(attempted_at) FILTER (WHERE ok)        AS last_ok_at,
      (SELECT error FROM public.membership_nudges m2
        WHERE m2.studio_slug = m.studio_slug AND NOT m2.ok
        ORDER BY m2.attempted_at DESC LIMIT 1)   AS last_error
    FROM public.membership_nudges m
    GROUP BY studio_slug
  )
  SELECT * FROM agg ORDER BY studio_slug;
$$;

REVOKE ALL ON FUNCTION public.get_membership_nudge_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_membership_nudge_status() TO authenticated;


-- ── 7. Cron schedule (LEFT COMMENTED — Justin enables when ready) ──────────
-- Once enabled, this runs every weekday at 6pm ET (22:00 UTC during EDT).
-- The function ITSELF checks BBB_SEND_PATHS_ENABLED for "trial_membership_
-- nudge" and no-ops if that path isn't allowlisted. So uncommenting this
-- block alone WON'T send anything — Justin must also add the send path.
--
-- TO ENABLE (two steps required):
--   1. Uncomment the cron.schedule block below and re-run this migration
--      (it's idempotent — the unschedule call handles re-runs).
--   2. Add 'trial_membership_nudge' to BBB_SEND_PATHS_ENABLED on the
--      trial-membership-nudge function AND on bbb-send-paths-status.
--
-- /*
-- DO $$
-- BEGIN
--   PERFORM cron.unschedule('trial-membership-nudge-6pm-et');
-- EXCEPTION WHEN OTHERS THEN
--   NULL;
-- END$$;
--
-- SELECT cron.schedule(
--   'trial-membership-nudge-6pm-et',
--   '0 22 * * 1-5',  -- 22:00 UTC = 6pm EDT, Mon-Fri only (no weekend pings)
--   $cron$
--     SELECT net.http_post(
--       url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/trial-membership-nudge',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'Authorization', 'Bearer ' || COALESCE(
--           (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_jwt' LIMIT 1),
--           ''
--         )
--       ),
--       body := '{}'::jsonb
--     );
--   $cron$
-- );
-- */


-- ── 8. Initial visibility ───────────────────────────────────────────────────
-- After this migration runs, you should see actual numbers. If pay_to_attend
-- shows 0% for early cohorts, the MindBody join is probably mismatching on
-- email (gmail vs yahoo, etc.).
SELECT 'cohort_stats' AS report, * FROM public.get_cohort_conversion_stats();
SELECT 'upsell_candidates' AS report, count(*) AS total_candidates
  FROM public.get_membership_conversion_candidates();
