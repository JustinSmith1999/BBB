-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Backfill the 24 comeback SMS we just sent into sms_messages.
--
-- The cron stamped trial_signups.comeback_sms_sent_at + comeback_sms_sid but
-- (before today's patch) did NOT also insert into sms_messages. So /homebase
-- comms thread on each of those 24 cards wouldn't show the text we sent.
--
-- Reconstruct the row from the data we have:
--   - trial_signup_id   ← trial_signups.id
--   - to_phone          ← trial_signups.phone
--   - body              ← reconstructed from cron's exact template
--   - twilio_sid        ← trial_signups.comeback_sms_sid
--   - sent_at           ← trial_signups.comeback_sms_sent_at
--   - send_path         ← 'comeback_sms'
--   - studio_slug       ← derived from location
--
-- Safe to re-run: skipped if a row with the same twilio_sid already exists.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.sms_messages (
  trial_signup_id,
  direction,
  from_phone,
  to_phone,
  body,
  twilio_sid,
  status,
  send_path,
  studio_slug,
  sent_at,
  created_at
)
SELECT
  ts.id,
  'outbound',
  '+18772860293', -- BBB toll-free from-number (TWILIO_FROM_NUMBER env value)
  ts.phone,
  -- Match the exact template from comeback-offer-cron line 211-215
  'Hey ' || split_part(COALESCE(ts.name, 'there'), ' ', 1) || ', it''s Better Body Bootcamp ' || l.name || '. ' ||
  'Noticed you didn''t finish signing up for our 2-Week Trial. ' ||
  'Want to give it a shot for just $29 / 1 week instead? ' ||
  'https://betterbodybootcamp.com/comeback/' || LOWER(REPLACE(l.name, ' ', '-')) ||
  '?t=backfill&c=sms' AS body,
  ts.comeback_sms_sid,
  'queued',
  'comeback_sms',
  LOWER(REPLACE(l.name, ' ', '-')),
  ts.comeback_sms_sent_at,
  ts.comeback_sms_sent_at
FROM public.trial_signups ts
JOIN public.locations l ON l.id = ts.location_id
WHERE ts.comeback_sms_sent_at IS NOT NULL
  AND ts.comeback_sms_sid IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.sms_messages sm
    WHERE sm.twilio_sid = ts.comeback_sms_sid
  );

-- Verify — show what landed
SELECT
  l.name AS studio,
  ts.name,
  ts.phone,
  ts.comeback_sms_sent_at,
  ts.comeback_sms_sid,
  sm.id IS NOT NULL AS logged_in_sms_messages
FROM public.trial_signups ts
JOIN public.locations l ON l.id = ts.location_id
LEFT JOIN public.sms_messages sm ON sm.twilio_sid = ts.comeback_sms_sid
WHERE ts.comeback_sms_sent_at IS NOT NULL
ORDER BY ts.comeback_sms_sent_at DESC;
