-- 2026-07-10 · One-time cleanup: pull FALSE "Attended" cards back to the truth.
--
-- Audit (live data, 4 studios): 54 cards sit in the 'attended' stage, but 9 of
-- them have ZERO verified check-ins in Mariana Tek OR MindBody. Two of those had
-- an outright cancel / no-show on record (Kristal Munoz "penalty no show",
-- Robyn Okeahialam "standard cancel"); the other seven have no visit and no
-- booking at all. They were parked in 'attended' by the pre-2026-07-08 logic
-- (which counted cancels as visits) or by an optimistic manual drag, and the
-- board's forward-only promote never moved them back — so they read as
-- "Attended" despite never walking in.
--
-- FIX: for every trial currently in 'attended' with NO real check-in on/after
-- their payment date, set front_desk_stage to the most accurate earlier stage:
--   • 'booked'    if MT shows any past reservation (they booked, didn't attend)
--   • 'contacted' if the front desk had logged a contact day
--   • 'new_lead'  otherwise
-- "Real check-in" = the same positive test used by get_homebase_at_risk and
-- promote_attended_trials (signed_in = true, or a checked-in/attended/complete
-- status). Cancels, no-shows and un-checked-in bookings do NOT count.
--
-- SAFE: touches ONLY 'attended' rows that fail the check-in test. It never
-- touches member / lost, and never demotes anyone with a genuine visit. Idempotent.
-- Run in the Supabase SQL editor. The final SELECT shows exactly what moved.

WITH bad AS (
  SELECT ts.id,
         lower(replace(l.name, ' ', '-')) AS slug
    FROM public.trial_signups ts
    JOIN public.locations l ON l.id = ts.location_id
   WHERE ts.deleted_at IS NULL
     AND ts.front_desk_stage = 'attended'
     -- NO verified check-in anywhere (MindBody OR Mariana Tek) since payment.
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
)
UPDATE public.trial_signups ts
   SET front_desk_stage = CASE
         WHEN EXISTS (
           SELECT 1 FROM public.mariana_tek_visits mtv
            WHERE ts.mariana_tek_id IS NOT NULL
              AND mtv.mt_client_id = ts.mariana_tek_id
              AND mtv.studio_slug  = bad.slug
              AND mtv.starts_at   <= now()
              AND (ts.payment_date IS NULL OR mtv.starts_at >= ts.payment_date)
         ) THEN 'booked'
         WHEN ts.day_contacted IS NOT NULL THEN 'contacted'
         ELSE 'new_lead'
       END,
       front_desk_updated_at = now()
  FROM bad
 WHERE ts.id = bad.id
RETURNING ts.name, ts.front_desk_stage AS moved_to;
