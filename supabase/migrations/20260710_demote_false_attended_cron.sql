-- 2026-07-10 · Make the Attended column self-heal in BOTH directions.
--
-- promote_attended_trials() (20260708) only ever moves people INTO Attended.
-- Nothing moved the false ones back OUT, so a card parked in 'attended' with no
-- real check-in (old buggy logic, a hopeful manual drag, or a cancel/no-show)
-- stayed there forever. This adds the mirror image: demote_false_attended()
-- pulls an 'attended' card back to its true stage once it's clear they didn't
-- come, and runs on the SAME 15-minute cadence — so the stranded-in-Attended
-- bug can never accumulate again.
--
-- SAFETY — this is the careful part, because a naive "0 visits → demote" would
-- yank someone who genuinely attended 5 minutes ago before their check-in has
-- synced. Guards:
--   1. 24-HOUR GRACE. Only demote if the card has sat in Attended (last touched)
--      for >24h. Visits sync every cycle + we keep a 7-day window, so 24h with
--      zero synced check-ins is real non-attendance, not sync lag.
--   2. POSITIVE non-attendance. NOT EXISTS a verified check-in (MB or MT) since
--      payment date — the exact same check-in test promote uses.
--   3. FORWARD-SAFE TARGET. Demote to the truest earlier stage: 'booked' if MT
--      shows any past reservation (they booked, didn't show), else 'contacted'
--      if a contact was logged, else 'new_lead'. Never touches member / lost.
-- Idempotent. Run in the Supabase SQL editor.

CREATE OR REPLACE FUNCTION public.demote_false_attended()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_n integer;
BEGIN
  WITH demoted AS (
    UPDATE public.trial_signups ts
       SET front_desk_stage = CASE
             WHEN EXISTS (
               SELECT 1 FROM public.mariana_tek_visits mtv
                WHERE ts.mariana_tek_id IS NOT NULL
                  AND mtv.mt_client_id = ts.mariana_tek_id
                  AND mtv.studio_slug  = lower(replace(l.name, ' ', '-'))
                  AND mtv.starts_at   <= now()
                  AND (ts.payment_date IS NULL OR mtv.starts_at >= ts.payment_date)
             ) THEN 'booked'
             WHEN ts.day_contacted IS NOT NULL THEN 'contacted'
             ELSE 'new_lead'
           END,
           front_desk_updated_at = now()
      FROM public.locations l
     WHERE l.id = ts.location_id
       AND ts.deleted_at IS NULL
       AND ts.front_desk_stage = 'attended'
       -- (1) 24h grace so a fresh check-in has time to sync before we act.
       AND COALESCE(ts.front_desk_updated_at, ts.created_at) < now() - interval '24 hours'
       -- (2) NO verified check-in anywhere since payment → they did not attend.
       AND NOT EXISTS (
         SELECT 1 FROM public.mindbody_visits mv
          JOIN public.mindbody_clients mc ON mc.mindbody_id = mv.mindbody_client_id
         WHERE lower(mc.email) = lower(ts.email)
           AND mv.studio_slug  = lower(replace(l.name, ' ', '-'))
           AND (ts.payment_date IS NULL OR mv.starts_at >= ts.payment_date)
           AND mv.starts_at <= now()
           AND COALESCE(mv.late_cancelled, false) = false
           AND COALESCE(mv.cancelled,      false) = false
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.mariana_tek_visits mtv
          WHERE ts.mariana_tek_id IS NOT NULL
            AND mtv.mt_client_id = ts.mariana_tek_id
            AND mtv.studio_slug  = lower(replace(l.name, ' ', '-'))
            AND (ts.payment_date IS NULL OR mtv.starts_at >= ts.payment_date)
            AND mtv.starts_at <= now()
            AND (
                  mtv.signed_in = true
                  OR lower(COALESCE(mtv.status, '')) IN
                     ('check in','checked in','checked_in','checked-in','attended','complete','completed')
                )
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM demoted;
  RETURN v_n;
END
$function$;

REVOKE ALL ON FUNCTION public.demote_false_attended() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.demote_false_attended() TO authenticated, service_role;

-- Run once now (returns how many it corrected on this pass).
SELECT public.demote_false_attended() AS demoted_now;

-- Schedule every 15 minutes, offset from the promote job so they don't collide.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'demote-false-attended') THEN
    PERFORM cron.unschedule('demote-false-attended');
  END IF;
END $$;

SELECT cron.schedule(
  'demote-false-attended',
  '7-59/15 * * * *',   -- :07 :22 :37 :52 — between the promote runs
  $$SELECT public.demote_false_attended();$$
);
