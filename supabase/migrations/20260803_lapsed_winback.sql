-- 20260803_lapsed_winback.sql
-- Send-log for the lapsed-member winback (the 271-per-studio list).
-- No cron: every send is a manual, explicit invocation of lapsed-winback.
CREATE TABLE IF NOT EXISTS lapsed_winback_sends (
  email          text PRIMARY KEY,
  mindbody_id    bigint,
  name           text,
  studio_slug    text,
  email_sent_at  timestamptz,
  email_error    text,
  sms_sent_at    timestamptz,
  sms_error      text,
  converted_at   timestamptz,
  created_at     timestamptz DEFAULT now()
);
ALTER TABLE lapsed_winback_sends ENABLE ROW LEVEL SECURITY;
-- service-role only; no anon policies on purpose.
