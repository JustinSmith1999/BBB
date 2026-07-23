-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill trial_signups.abandoned_email_sent_at from Resend CSV ground truth.
-- 51 real cart-recovery recipients since 2026-05-17.
-- Why: the function's markPersonHandled call set the flag inconsistently across
-- 18 days of runs (some via different code paths, some via manual curls). The
-- Resend export is the only source of truth for 'who actually got an email'.
-- After this runs, the Cart Recovery card will show the real 4 recoveries
-- (Helena, Suleydy, Jane Maravilla, Vanessa Cruz) and stop counting phantoms.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.trial_signups
   SET abandoned_email_sent_at = NULL
 WHERE abandoned_email_sent_at IS NOT NULL;

WITH csv_truth(email, first_cart_at) AS (
  VALUES
    ('baysidelabubu@gmail.com', '2026-05-18T09:44:16Z'::TIMESTAMPTZ),
    ('cvicto11@gmail.com', '2026-05-20T01:00:03Z'::TIMESTAMPTZ),
    ('anahiza2011@hotmail.com', '2026-05-20T11:30:01Z'::TIMESTAMPTZ),
    ('valeriecaseres17@gmail.com', '2026-05-20T12:30:02Z'::TIMESTAMPTZ),
    ('varsha.srivastava02@gmail.com', '2026-05-20T19:45:03Z'::TIMESTAMPTZ),
    ('rion.forde@gmail.com', '2026-05-20T20:15:01Z'::TIMESTAMPTZ),
    ('lizzy.gesensway@gmail.com', '2026-05-21T13:15:06Z'::TIMESTAMPTZ),
    ('lynvkf@gmail.com', '2026-05-21T15:00:04Z'::TIMESTAMPTZ),
    ('evelynvkf@gmail.com', '2026-05-21T15:00:05Z'::TIMESTAMPTZ),
    ('jrobertonalonzo@gmail.com', '2026-05-21T18:00:10Z'::TIMESTAMPTZ),
    ('mstallworth08@gmail.com', '2026-05-21T18:30:06Z'::TIMESTAMPTZ),
    ('elisabete.pviveiros@gmail.com', '2026-05-22T02:30:05Z'::TIMESTAMPTZ),
    ('teena.m.tucker@gmail.com', '2026-05-22T02:45:02Z'::TIMESTAMPTZ),
    ('sfn817@yahoo.com', '2026-05-22T13:00:13Z'::TIMESTAMPTZ),
    ('cabrerakarla4@gmail.com', '2026-05-22T20:00:08Z'::TIMESTAMPTZ),
    ('plousadise@gmail.com', '2026-05-23T00:30:01Z'::TIMESTAMPTZ),
    ('rsuleydy@icloud.com', '2026-05-24T13:15:02Z'::TIMESTAMPTZ),
    ('nettiepoo26@gmail.com', '2026-05-24T14:30:06Z'::TIMESTAMPTZ),
    ('jhamilee.rose@gmail.com', '2026-05-24T16:30:05Z'::TIMESTAMPTZ),
    ('gracezhou1010@163.com', '2026-05-25T08:15:02Z'::TIMESTAMPTZ),
    ('rosiegbadillo@gmail.com', '2026-05-25T23:00:07Z'::TIMESTAMPTZ),
    ('tatem343@gmail.com', '2026-05-26T12:30:07Z'::TIMESTAMPTZ),
    ('womeningold7@gmail.com', '2026-05-26T20:45:06Z'::TIMESTAMPTZ),
    ('giselgaviria3@gmail.com', '2026-05-26T21:45:05Z'::TIMESTAMPTZ),
    ('lpmcgrath@bacardi.com', '2026-05-26T22:45:05Z'::TIMESTAMPTZ),
    ('raymondpimentel18@icloud.com', '2026-05-27T16:00:10Z'::TIMESTAMPTZ),
    ('genesis1.productions@gmail.com', '2026-05-27T17:45:06Z'::TIMESTAMPTZ),
    ('cguimaraes105@gmail.com', '2026-05-28T01:00:10Z'::TIMESTAMPTZ),
    ('judyannjavier0312@gmail.com', '2026-05-28T12:15:06Z'::TIMESTAMPTZ),
    ('shalliniprasad@yahoo.com', '2026-05-28T15:45:01Z'::TIMESTAMPTZ),
    ('charliekramer89@gmail.com', '2026-05-28T18:00:10Z'::TIMESTAMPTZ),
    ('vanessamcruz513@gmail.com', '2026-05-29T01:15:05Z'::TIMESTAMPTZ),
    ('arlinda.selmani@icloud.com', '2026-05-29T03:45:01Z'::TIMESTAMPTZ),
    ('shane809@yahoo.com', '2026-05-29T05:30:05Z'::TIMESTAMPTZ),
    ('cristina37@me.com', '2026-05-29T14:30:04Z'::TIMESTAMPTZ),
    ('bioclassacademy@gmail.com', '2026-05-29T14:30:05Z'::TIMESTAMPTZ),
    ('chenkellyw@gmail.com', '2026-05-29T15:00:06Z'::TIMESTAMPTZ),
    ('fabiolamartinezt5@gmail.com', '2026-05-29T18:45:05Z'::TIMESTAMPTZ),
    ('igmarcy55@gmail.com', '2026-05-29T20:00:02Z'::TIMESTAMPTZ),
    ('oriananinop@gmail.com', '2026-05-29T20:00:02Z'::TIMESTAMPTZ),
    ('jfmaravilla@gmail.com', '2026-05-30T22:45:05Z'::TIMESTAMPTZ),
    ('shanira.sanchez@gmail.com', '2026-05-31T15:00:09Z'::TIMESTAMPTZ),
    ('geovyrt@hotmail.com', '2026-05-31T16:00:07Z'::TIMESTAMPTZ),
    ('hvojak@yahoo.com', '2026-05-31T16:45:05Z'::TIMESTAMPTZ),
    ('sierraschast@gmail.com', '2026-06-01T00:30:05Z'::TIMESTAMPTZ),
    ('bwalsh1194@gmail.com', '2026-06-01T00:45:05Z'::TIMESTAMPTZ),
    ('angelayakubov@yahoo.com', '2026-06-02T19:32:26Z'::TIMESTAMPTZ),
    ('farhana10@gmail.com', '2026-06-02T19:32:26Z'::TIMESTAMPTZ),
    ('amarissantana6@gmail.com', '2026-06-02T19:32:26Z'::TIMESTAMPTZ),
    ('camilacubas1907@gmail.com', '2026-06-02T19:32:26Z'::TIMESTAMPTZ),
    ('lbocanegradonayre@gmail.com', '2026-06-02T19:32:27Z'::TIMESTAMPTZ)
)
UPDATE public.trial_signups t
   SET abandoned_email_sent_at = c.first_cart_at
  FROM csv_truth c
 WHERE LOWER(TRIM(t.email)) = LOWER(TRIM(c.email))
   AND t.deleted_at IS NULL;

-- Sanity: lists every true recovery (paid AFTER cart-email landed).
SELECT t.name, lower(replace(l.name,' ','-')) AS studio,
       to_char(t.abandoned_email_sent_at AT TIME ZONE 'America/New_York', 'Mon DD HH24:MI') AS cart_emailed_et,
       to_char(t.payment_date AT TIME ZONE 'America/New_York', 'Mon DD HH24:MI') AS paid_et,
       ROUND(EXTRACT(EPOCH FROM (t.payment_date - t.abandoned_email_sent_at))/3600, 1) AS hours_to_pay
  FROM public.trial_signups t
  LEFT JOIN public.locations l ON l.id = t.location_id
 WHERE t.payment_status = 'completed'
   AND t.abandoned_email_sent_at IS NOT NULL
   AND t.payment_date > t.abandoned_email_sent_at
   AND t.deleted_at IS NULL
 ORDER BY t.payment_date;
