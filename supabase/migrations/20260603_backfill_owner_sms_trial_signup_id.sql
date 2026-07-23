-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-03: owner SMS notifications (Chris, Steve, Carlos getting "new $49
-- trial signup" pings) were inserted into sms_messages with trial_signup_id
-- = null, so /homebase comms history can't link them back to the customer
-- card. Backfill by matching the customer email embedded in the SMS body.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.sms_messages sm
   SET trial_signup_id = t.id
  FROM public.trial_signups t
 WHERE sm.trial_signup_id IS NULL
   AND sm.direction = 'outbound'
   AND sm.sent_by IN ('manual_owner_alert', 'stripe_owner_sms', 'manual_studio_alert')
   AND t.email IS NOT NULL
   AND t.email <> ''
   AND sm.body ILIKE '%' || t.email || '%';

-- Returning count for sanity
SELECT
  'backfilled owner SMS with trial_signup_id' AS report,
  COUNT(*) FILTER (WHERE trial_signup_id IS NOT NULL) AS now_linked,
  COUNT(*) FILTER (WHERE trial_signup_id IS NULL AND sent_by IN ('manual_owner_alert','stripe_owner_sms','manual_studio_alert')) AS still_orphan
  FROM public.sms_messages
 WHERE direction = 'outbound';
