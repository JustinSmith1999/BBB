-- ─────────────────────────────────────────────────────────────────────────────
-- email_log: thread emails to the customer card they belong to.
--
-- Why: today email_log gets one row per Resend webhook event, but with no
-- way to know WHICH trial_signup that event belongs to. /homebase can't
-- show per-customer email threads as a result. SMS gets this right via
-- sms_messages.trial_signup_id; we mirror that pattern here.
--
-- How:
--   1. Add trial_signup_id column to email_log (nullable — old rows + non-
--      customer emails like the owner notification have no obvious match).
--   2. Senders include trial_signup_id in Resend's `tags` parameter at send
--      time. Resend echoes it back on every webhook event for that email.
--   3. resend-webhook parses the tag and stores it on the email_log row.
--   4. get_email_thread RPC returns every event for a trial_signup, ready
--      for /homebase per-customer rendering.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.email_log
  ADD COLUMN IF NOT EXISTS trial_signup_id UUID NULL
  REFERENCES public.trial_signups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_log_trial_signup
  ON public.email_log (trial_signup_id, created_at DESC)
  WHERE trial_signup_id IS NOT NULL;


-- ── Per-customer email thread for /homebase modal ────────────────────────────
-- Mirrors the shape of get_sms_thread: one row per Resend event so staff can
-- see the full delivery story (sent → delivered → opened → clicked). Newest
-- last so it reads chronologically.
CREATE OR REPLACE FUNCTION public.get_email_thread(p_trial_id UUID)
RETURNS TABLE(
  id         BIGINT,
  resend_id  TEXT,
  event_type TEXT,
  from_addr  TEXT,
  to_addrs   TEXT[],
  subject    TEXT,
  send_path  TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  -- email_log.id is uuid in the existing schema; the dashboard expects bigint
  -- for thread ordering. We use row_number() instead so the API stays simple
  -- and stable even when the underlying id type differs.
  SELECT
    ROW_NUMBER() OVER (ORDER BY created_at ASC)::BIGINT AS id,
    resend_id,
    event_type,
    from_addr,
    to_addrs,
    subject,
    send_path,
    created_at
  FROM public.email_log
  WHERE trial_signup_id = p_trial_id
  ORDER BY created_at ASC;
$$;

REVOKE ALL ON FUNCTION public.get_email_thread(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_email_thread(UUID) TO authenticated;


-- ── Sanity check ─────────────────────────────────────────────────────────────
SELECT
  to_regclass('public.email_log')                          AS email_log_exists,
  (
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='email_log' AND column_name='trial_signup_id'
  )                                                        AS trial_signup_id_column_present;
