-- ─────────────────────────────────────────────────────────────────────────────
-- SMS Gateway — capture every text in and out, attached to the trial_signup
-- card it relates to. Goal: when a card sits "untouched" in /homebase, that
-- means staff actually didn't text/call. Right now we have no record of
-- texts so we can't tell.
--
-- Architecture:
--   • Customer texts our Twilio number       → twilio-inbound-sms (extended)
--   • Studio FD sends from /homebase modal   → twilio-outbound-sms (new)
--   • Both write to sms_messages, keyed to a trial_signups row by phone
--   • /homebase modal renders the thread (oldest at top)
--   • Each new inbound bumps last_inbound_at on the trial_signup so the card
--     surfaces as "needs reply" when the thread has an unanswered customer msg
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sms_messages (
  id              BIGSERIAL PRIMARY KEY,
  trial_signup_id UUID         NULL REFERENCES public.trial_signups(id) ON DELETE SET NULL,
  studio_slug     TEXT         NULL,
  direction       TEXT         NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_phone      TEXT         NOT NULL,
  to_phone        TEXT         NOT NULL,
  body            TEXT         NOT NULL,
  twilio_sid      TEXT         NULL,
  status          TEXT         NULL,         -- queued, sent, delivered, failed, undelivered, received
  error_code      TEXT         NULL,
  error_message   TEXT         NULL,
  sent_by         TEXT         NULL,         -- staff name for outbound
  sent_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_trial         ON public.sms_messages (trial_signup_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_from_phone    ON public.sms_messages (from_phone);
CREATE INDEX IF NOT EXISTS idx_sms_studio_recent ON public.sms_messages (studio_slug, sent_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_twilio_sid ON public.sms_messages (twilio_sid) WHERE twilio_sid IS NOT NULL;

ALTER TABLE public.sms_messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='sms_messages' AND policyname='sms_read_authenticated') THEN
    CREATE POLICY "sms_read_authenticated"
      ON public.sms_messages FOR SELECT
      TO anon, authenticated USING (true);
  END IF;
END$$;


-- ── Normalize phone → +1XXXXXXXXXX (E.164 US). Twilio always returns +E164,
--    but the trial_signup phone column has mixed formats from form input.
CREATE OR REPLACE FUNCTION public.normalize_us_phone(p TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  d TEXT := regexp_replace(COALESCE(p, ''), '\D', '', 'g');
BEGIN
  IF length(d) = 11 AND left(d, 1) = '1' THEN
    RETURN '+' || d;
  ELSIF length(d) = 10 THEN
    RETURN '+1' || d;
  ELSE
    RETURN NULL;
  END IF;
END;
$$;


-- ── Best-effort phone → trial_signup lookup. Returns the most recent
--    matching trial_signup id for a given E.164 phone, preferring rows that
--    have actually paid (those are the customers FD cares about most).
CREATE OR REPLACE FUNCTION public.match_trial_by_phone(p_phone TEXT, p_studio_slug TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_e164 TEXT := public.normalize_us_phone(p_phone);
  v_id   UUID;
BEGIN
  IF v_e164 IS NULL THEN RETURN NULL; END IF;
  SELECT t.id INTO v_id
  FROM public.trial_signups t
  LEFT JOIN public.locations l ON l.id = t.location_id
  WHERE t.deleted_at IS NULL
    AND public.normalize_us_phone(t.phone) = v_e164
    AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
  ORDER BY
    (t.payment_status = 'completed') DESC,    -- paid first
    t.created_at DESC                         -- then newest
  LIMIT 1;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.match_trial_by_phone(TEXT, TEXT) TO anon, authenticated;


-- ── Read thread for /homebase card modal
CREATE OR REPLACE FUNCTION public.get_sms_thread(p_trial_id UUID)
RETURNS TABLE(
  id          BIGINT,
  direction   TEXT,
  body        TEXT,
  from_phone  TEXT,
  to_phone    TEXT,
  status      TEXT,
  sent_by     TEXT,
  sent_at     TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  SELECT id, direction, body, from_phone, to_phone, status, sent_by, sent_at
  FROM public.sms_messages
  WHERE trial_signup_id = p_trial_id
  ORDER BY sent_at ASC;
$$;
GRANT EXECUTE ON FUNCTION public.get_sms_thread(UUID) TO anon, authenticated;


-- ── Each new inbound message bumps last_inbound_at on the trial_signup so
-- /homebase can flag "needs reply" cards. Outbound bumps last_outbound_at.
CREATE OR REPLACE FUNCTION public._sms_bump_last_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.trial_signup_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.direction = 'inbound' THEN
    UPDATE public.trial_signups
       SET last_inbound_at = NEW.sent_at,
           last_inbound_body = LEFT(NEW.body, 500)
     WHERE id = NEW.trial_signup_id;
  ELSE
    -- We don't have last_outbound_at column yet — skip silently if missing.
    BEGIN
      UPDATE public.trial_signups
         SET last_attempt_at = NEW.sent_at
       WHERE id = NEW.trial_signup_id;
    EXCEPTION WHEN undefined_column THEN
      -- column doesn't exist; ignore
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sms_bump_last_touch ON public.sms_messages;
CREATE TRIGGER sms_bump_last_touch
  AFTER INSERT ON public.sms_messages
  FOR EACH ROW EXECUTE FUNCTION public._sms_bump_last_touch();


-- Quick sanity:
--   SELECT * FROM public.sms_messages ORDER BY sent_at DESC LIMIT 10;
--   SELECT * FROM public.get_sms_thread('<trial_id>');
