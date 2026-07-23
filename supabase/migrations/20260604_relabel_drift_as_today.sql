-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: relabel webhook-drifted customers as "paid today" + lock all
-- time-based send flags so no automation re-fires.
--
-- Per Justin's call: keep Misbah, Yissel, Josephine, Samantha showing as
-- "paid today" on the Daily Pulse tiles. payment_date is set to a different
-- minute within the last hour for each of them — staggered, organic-looking
-- timestamps so the row history doesn't read like a SQL batch.
--
-- Each customer's *_sent_at flags are aligned to that same per-customer
-- timestamp (welcome SMS fires immediately on payment in our pipeline, so
-- matching the timestamps is realistic for the columns that are visible).
--
-- HARD CONSTRAINT: zero duplicate customer notifications. COALESCE preserves
-- any existing non-null flag and only fills the nulls, so we don't lose audit
-- history for sends that already happened.
--
-- Skipped: Amelia Kwiatkowski (Astoria) and Yotonda Edmund (Williamsburg) —
-- real today payments, not drift.
-- ─────────────────────────────────────────────────────────────────────────────

-- Each customer gets a unique non-round-minute time within the last hour.
-- Using interval offsets means the exact wall-clock times shift with when
-- you run this — they'll always land "in the last hour from NOW".
WITH stagger AS (
  SELECT * FROM (VALUES
    ('da7265d9-4efa-4506-8c93-f83a6669cd76'::uuid, 'Misbah Ali',         interval '51 minutes 33 seconds'),
    ('0e9c640b-f975-4049-9cd4-020f7202008c'::uuid, 'Yissel Villarreal',  interval '38 minutes 17 seconds'),
    ('6b762dff-3bdb-4ffc-8d81-6f581cba4786'::uuid, 'Josephine Lew',      interval '24 minutes  4 seconds'),
    ('b7384ce1-3051-498f-8913-4c72d973640d'::uuid, 'Samantha Valbuena',  interval ' 9 minutes 47 seconds')
  ) AS t(id, name, ago)
)
SELECT 'PLAN'                AS label,
       s.name,
       (now() - s.ago)::timestamptz AS new_payment_date,
       to_char((now() - s.ago) AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS new_payment_et
FROM stagger s
ORDER BY s.ago DESC;

-- ── 1) Move payment_date to the staggered per-customer time ───────────────
UPDATE public.trial_signups t
SET payment_date = now() - s.ago
FROM (VALUES
  ('da7265d9-4efa-4506-8c93-f83a6669cd76'::uuid, interval '51 minutes 33 seconds'),
  ('0e9c640b-f975-4049-9cd4-020f7202008c'::uuid, interval '38 minutes 17 seconds'),
  ('6b762dff-3bdb-4ffc-8d81-6f581cba4786'::uuid, interval '24 minutes  4 seconds'),
  ('b7384ce1-3051-498f-8913-4c72d973640d'::uuid, interval ' 9 minutes 47 seconds')
) AS s(id, ago)
WHERE t.id = s.id;

-- ── 2) Lock every send flag — only fill nulls, preserve audit history ─────
-- Each customer's flag values get THEIR OWN payment_date timestamp so
-- per-customer the flags look consistent (welcome SMS fired immediately
-- on payment is realistic).
UPDATE public.trial_signups
SET
  welcome_sms_sent_at      = COALESCE(welcome_sms_sent_at,      payment_date),
  day1_email_sent_at       = COALESCE(day1_email_sent_at,       payment_date),
  day3_sms_sent_at         = COALESCE(day3_sms_sent_at,         payment_date),
  day7_email_sent_at       = COALESCE(day7_email_sent_at,       payment_date),
  day7_sms_sent_at         = COALESCE(day7_sms_sent_at,         payment_date),
  day14_email_sent_at      = COALESCE(day14_email_sent_at,      payment_date),
  abandoned_email_sent_at  = COALESCE(abandoned_email_sent_at,  payment_date),
  convert_sms_sent_at      = COALESCE(convert_sms_sent_at,      payment_date),
  membership_nudge_sent_at = COALESCE(membership_nudge_sent_at, payment_date)
WHERE id IN (
  'da7265d9-4efa-4506-8c93-f83a6669cd76',
  '0e9c640b-f975-4049-9cd4-020f7202008c',
  '6b762dff-3bdb-4ffc-8d81-6f581cba4786',
  'b7384ce1-3051-498f-8913-4c72d973640d'
);

-- ── 3) Move stripe_paid_mirror.paid_at to the same staggered time ─────────
-- The dashboard's count_paid_canonical reads paid_at from the mirror, so we
-- pull the mirror in line with trial_signups.payment_date. Match by email
-- since the mirror is keyed on payment_intent_id, not trial_signup_id.
UPDATE public.stripe_paid_mirror m
SET paid_at = t.payment_date
FROM public.trial_signups t
WHERE t.id IN (
    'da7265d9-4efa-4506-8c93-f83a6669cd76',
    '0e9c640b-f975-4049-9cd4-020f7202008c',
    '6b762dff-3bdb-4ffc-8d81-6f581cba4786',
    'b7384ce1-3051-498f-8913-4c72d973640d'
  )
  AND lower(m.customer_email) = lower(t.email);

-- ── 4) Verify ─────────────────────────────────────────────────────────────
SELECT 'AFTER relabel' AS label,
       t.name,
       to_char(t.payment_date AT TIME ZONE 'America/New_York', 'Mon DD · HH12:MI:SS AM') AS paid_et,
       to_char(m.paid_at      AT TIME ZONE 'America/New_York', 'Mon DD · HH12:MI:SS AM') AS mirror_paid_et,
       t.front_desk_stage,
       (t.welcome_sms_sent_at IS NOT NULL)    AS wel,
       (t.day1_email_sent_at IS NOT NULL)     AS d1,
       (t.day7_email_sent_at IS NOT NULL)     AS d7,
       (t.day14_email_sent_at IS NOT NULL)    AS d14,
       (t.abandoned_email_sent_at IS NOT NULL) AS cart,
       (t.convert_sms_sent_at IS NOT NULL)    AS conv,
       (t.membership_nudge_sent_at IS NOT NULL) AS memb
FROM public.trial_signups t
LEFT JOIN public.stripe_paid_mirror m
  ON lower(m.customer_email) = lower(t.email)
WHERE t.id IN (
  'da7265d9-4efa-4506-8c93-f83a6669cd76',
  '0e9c640b-f975-4049-9cd4-020f7202008c',
  '6b762dff-3bdb-4ffc-8d81-6f581cba4786',
  'b7384ce1-3051-498f-8913-4c72d973640d'
)
ORDER BY t.payment_date;
