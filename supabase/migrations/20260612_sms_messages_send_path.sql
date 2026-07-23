-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 NIGHT · Add send_path to sms_messages so every outbound SMS
-- has a labeled identity (mirrors email_log.send_path). Without this column,
-- request-schedule-sms (+ future SMS senders) write rows that fail with
-- 42703 column-does-not-exist, then get swallowed by try/catch — leaving
-- sms_messages permanently empty even though Twilio is delivering.
--
-- Plus: backfill the two manual schedule-SMS sends we fired tonight (Gian
-- + Adrienne, both Fresh Meadows), using the Twilio SIDs returned from the
-- API. This way /homebase + /ops will show them as part of the comms
-- history immediately.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add the column ───────────────────────────────────────────────────────
ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS send_path TEXT;

CREATE INDEX IF NOT EXISTS idx_sms_send_path
  ON public.sms_messages (send_path, sent_at DESC)
  WHERE send_path IS NOT NULL;

COMMENT ON COLUMN public.sms_messages.send_path IS
  'Internal label for which code path sent the SMS — e.g. schedule_request_sms, stripe_customer_welcome_sms, comeback_offer_sms. Mirrors email_log.send_path.';

-- ── 2. Backfill the 2 manual schedule sends from tonight ────────────────────
-- These went through Twilio successfully (SIDs returned) but never got an
-- sms_messages row because the function insert hit the missing-column bug.
-- We ON CONFLICT-DO-NOTHING against the unique index on twilio_sid so this
-- migration is safe to re-run.
-- Use NOT EXISTS guard instead of ON CONFLICT. The unique index on
-- twilio_sid is PARTIAL (WHERE twilio_sid IS NOT NULL), and Postgres
-- won't match ON CONFLICT against a partial index without the same
-- predicate — and even then it's finicky across versions. NOT EXISTS
-- is straightforward and idempotent.
INSERT INTO public.sms_messages (
  direction, from_phone, to_phone, body, twilio_sid, status, send_path,
  studio_slug, sent_at, created_at
)
SELECT
  'outbound',
  '+1XXXXXXXXXX',  -- placeholder; real from-number lives in env, not DB
  '+19294719575',
  'Hi Gian! Class schedule for Better Body Bootcamp Fresh Meadows: https://betterbodybootcamp.com/mb/fresh-meadows' || E'\n\n' ||
  'Drop in any time! Reply HELP for help or STOP to opt out.',
  'SMc1d856e2fe6c741b4595facc66f7972b',
  'queued',
  'schedule_request_sms',
  'fresh-meadows',
  now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.sms_messages
  WHERE twilio_sid = 'SMc1d856e2fe6c741b4595facc66f7972b'
);

INSERT INTO public.sms_messages (
  direction, from_phone, to_phone, body, twilio_sid, status, send_path,
  studio_slug, sent_at, created_at
)
SELECT
  'outbound',
  '+1XXXXXXXXXX',
  '+14075340429',
  'Hi Adrienne! Class schedule for Better Body Bootcamp Fresh Meadows: https://betterbodybootcamp.com/mb/fresh-meadows' || E'\n\n' ||
  'Drop in any time! Reply HELP for help or STOP to opt out.',
  'SMb1330a50dac685b79144406101d751e1',
  'queued',
  'schedule_request_sms',
  'fresh-meadows',
  now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.sms_messages
  WHERE twilio_sid = 'SMb1330a50dac685b79144406101d751e1'
);

-- ── 3. Verify ───────────────────────────────────────────────────────────────
SELECT
  send_path,
  COUNT(*) AS rows,
  MAX(sent_at) AS most_recent
FROM public.sms_messages
WHERE send_path IS NOT NULL
GROUP BY send_path
ORDER BY most_recent DESC;
