-- 2026-07-08 · Auto-advance trials to "Attended" when Mariana Tek says they
-- attended.
--
-- THE PROBLEM: the /homebase board columns are driven by front_desk_stage — a
-- field that only changes when a human drags a card. A synced MT check-in only
-- rendered a green "✓ Attended" chip ON the card; nothing moved the card into
-- the Attended column. So people who showed up stayed stuck in New Lead /
-- Contacted / Booked. (Justin: "It says attended, but they never got moved
-- over — if Mariana Tek says they attended, move them.")
--
-- THE FIX: promote_attended_trials() moves any trial that Mariana Tek recorded
-- at a past, non-cancelled class (on/after their payment date) from a
-- pre-attended column into 'attended'. It is FORWARD-ONLY — it never touches a
-- card already at attended / member / lost, so nothing gets demoted and manual
-- "Converted Member" / "Lost" tags are safe.
--
-- "Actually attended" = Mariana Tek recorded a real check-in for them
-- (signed_in = true, i.e. a check_in_date on the reservation, or a checked-in /
-- attended status). A booked-but-no-showed class does NOT count — we only move
-- people who genuinely walked in. NOTE: this requires your front desk to tap
-- people in on the Mariana Tek side; if a class is never checked in there, MT
-- has no proof of attendance and the card won't move.
--
-- Run: paste into the Supabase SQL editor and Run. It (1) creates the function,
-- (2) moves everyone currently stuck right now, and (3) schedules itself every
-- 15 minutes so the board keeps itself current going forward.

CREATE OR REPLACE FUNCTION public.promote_attended_trials()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_n integer;
BEGIN
  WITH promoted AS (
    UPDATE public.trial_signups ts
       SET front_desk_stage = 'attended'
      FROM public.locations l
     WHERE l.id = ts.location_id
       AND ts.deleted_at IS NULL
       AND ts.mariana_tek_id IS NOT NULL
       -- Only promote FORWARD — from a pre-attended column (or untagged).
       AND (ts.front_desk_stage IS NULL
            OR ts.front_desk_stage IN ('new_lead', 'contacted', 'booked', 'paid_trial'))
       -- ...and only if Mariana Tek recorded a real CHECK-IN for them (they
       -- actually walked in — not just booked a class they may have no-showed).
       AND EXISTS (
         SELECT 1
           FROM public.mariana_tek_visits mtv
          WHERE mtv.mt_client_id = ts.mariana_tek_id
            AND mtv.studio_slug  = lower(replace(l.name, ' ', '-'))
            AND mtv.starts_at   <= now()
            AND (ts.payment_date IS NULL OR mtv.starts_at >= ts.payment_date)
            AND (
                  mtv.signed_in = true
                  OR lower(coalesce(mtv.status, '')) IN
                     ('check in', 'checked in', 'checked_in', 'checked-in', 'attended', 'completed')
                )
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM promoted;
  RETURN v_n;
END
$function$;

REVOKE ALL ON FUNCTION public.promote_attended_trials() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promote_attended_trials() TO authenticated, service_role;

-- (1) Move everyone currently stuck. The returned number = how many moved now.
SELECT public.promote_attended_trials() AS promoted_now;

-- (2) Keep it current — run every 15 minutes, right alongside the other syncs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'promote-attended-trials') THEN
    PERFORM cron.unschedule('promote-attended-trials');
  END IF;
END $$;

SELECT cron.schedule(
  'promote-attended-trials',
  '*/15 * * * *',
  $$SELECT public.promote_attended_trials();$$
);
