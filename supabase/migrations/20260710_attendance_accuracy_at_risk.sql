-- 2026-07-10 · Attendance ACCURACY fix for the /homebase board.
--
-- BUG (Justin, verified against live data): get_homebase_at_risk counted a
-- Mariana Tek reservation as an ATTENDED visit unless its status was in a short
-- exact-match list ('cancelled','no_show', ...). But MT actually uses statuses
-- like "standard cancel" and "pending" that were NOT in that list — so a
-- CANCELLATION was counted as a visit, and the board showed cancelled /
-- no-showed people as "Attended". Example that exposed it:
--   { mt_client_id: 66417, starts_at: 2026-07-10, signed_in: false,
--     status: "standard cancel" }  ← she cancelled, never came.
--
-- FIX:
--   1. A MT visit counts as ATTENDED only on a real check-in — signed_in = true,
--      or an explicit checked-in / attended / completed status. This matches the
--      definition promote_attended_trials() already uses. Past reservations that
--      were cancelled, no-showed, or left un-checked-in do NOT count.
--   2. Return the most recent PAST non-attended MT reservation (missed_status /
--      missed_at) so the board can show WHY someone booked but didn't come
--      ("Cancelled · Jul 10", "No-show · Jul 8") instead of nothing.
--
-- Column set changes (added missed_status, missed_at) so we DROP + CREATE.
-- Run in the Supabase SQL editor.

DROP FUNCTION IF EXISTS public.get_homebase_at_risk(uuid);

CREATE FUNCTION public.get_homebase_at_risk(p_location_id uuid)
RETURNS TABLE(
  trial_id        uuid,
  visit_count     integer,
  first_visit     timestamptz,
  last_visit      timestamptz,
  days_in         integer,
  at_risk         boolean,
  missed_status   text,
  missed_at       timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_studio_slug text;
BEGIN
  SELECT lower(replace(name, ' ', '-'))
    INTO v_studio_slug
    FROM public.locations
   WHERE id = p_location_id;

  RETURN QUERY
  SELECT
    t.id AS trial_id,
    COALESCE(v.cnt, 0)::int AS visit_count,
    v.first_visit           AS first_visit,
    v.last_visit            AS last_visit,
    GREATEST(0, (CURRENT_DATE - t.payment_date::date))::int AS days_in,
    (
      t.payment_status = 'completed'
      AND COALESCE(v.cnt, 0) = 0
      AND GREATEST(0, (CURRENT_DATE - t.payment_date::date)) >= 2
    ) AS at_risk,
    m.missed_status,
    m.missed_at
  FROM public.trial_signups t
  -- ── Real ATTENDED visits only (MindBody + Mariana Tek) ──────────────────
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int      AS cnt,
      min(u.starts_at)   AS first_visit,
      max(u.starts_at)   AS last_visit
    FROM (
      SELECT mv.starts_at
        FROM public.mindbody_visits  mv
        JOIN public.mindbody_clients mc ON mc.mindbody_id = mv.mindbody_client_id
       WHERE lower(mc.email) = lower(t.email)
         AND mv.studio_slug  = v_studio_slug
         AND mv.starts_at    >= t.payment_date
         AND mv.starts_at    <= now()
         AND COALESCE(mv.late_cancelled, false) = false
         AND COALESCE(mv.cancelled,      false) = false

      UNION ALL

      SELECT mtv.starts_at
        FROM public.mariana_tek_visits mtv
       WHERE t.mariana_tek_id IS NOT NULL
         AND mtv.mt_client_id = t.mariana_tek_id
         AND mtv.studio_slug  = v_studio_slug
         AND mtv.starts_at    >= t.payment_date
         AND mtv.starts_at    <= now()
         -- POSITIVE check-in test — the only thing that proves attendance.
         AND (
               mtv.signed_in = true
               OR lower(COALESCE(mtv.status, '')) IN
                  ('check in', 'checked in', 'checked_in', 'checked-in', 'attended', 'complete', 'completed')
             )
    ) u
  ) v ON TRUE
  -- ── Most recent PAST reservation they did NOT attend → reason for board ──
  LEFT JOIN LATERAL (
    SELECT mtv.status AS missed_status, mtv.starts_at AS missed_at
      FROM public.mariana_tek_visits mtv
     WHERE t.mariana_tek_id IS NOT NULL
       AND mtv.mt_client_id = t.mariana_tek_id
       AND mtv.studio_slug  = v_studio_slug
       AND mtv.starts_at   <= now()
       AND mtv.starts_at   >= t.payment_date
       AND mtv.signed_in IS NOT TRUE
       AND lower(COALESCE(mtv.status, '')) NOT IN
           ('check in', 'checked in', 'checked_in', 'checked-in', 'attended', 'complete', 'completed')
     ORDER BY mtv.starts_at DESC
     LIMIT 1
  ) m ON TRUE
  WHERE t.location_id     = p_location_id
    AND t.payment_status  = 'completed'
    AND t.payment_date    >= now() - interval '30 days'
    AND lower(trim(t.email)) NOT IN (SELECT lower(s.email) FROM public.dashboard_suppressed_emails s);
END;
$$;

REVOKE ALL ON FUNCTION public.get_homebase_at_risk(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_at_risk(uuid) TO anon, authenticated;
