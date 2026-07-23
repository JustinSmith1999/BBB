-- ─────────────────────────────────────────────────────────────────────────────
-- email_log — every email Resend processes for us, ingested via their webhook.
--
-- Mirrors the role sms_messages plays for Twilio. Lets /ops show a live feed
-- of every send: who, when, what subject, status (delivered/bounced/complained).
--
-- The resend-webhook edge function POSTs into this table on every Resend event.
-- See supabase/functions/resend-webhook/index.ts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resend_id     text,                       -- Resend's email_id
  event_type    text NOT NULL,              -- 'sent', 'delivered', 'bounced', 'complained', 'opened', 'clicked', 'delivery_delayed'
  from_addr     text,
  to_addrs      text[],
  subject       text,
  send_path     text,                       -- our internal label (e.g. 'stripe_owner_email', 'stripe_customer_welcome_email')
  raw           jsonb                       -- full webhook payload for forensics
);

CREATE INDEX IF NOT EXISTS email_log_created_at_idx ON public.email_log (created_at DESC);
CREATE INDEX IF NOT EXISTS email_log_resend_id_idx  ON public.email_log (resend_id);
CREATE INDEX IF NOT EXISTS email_log_event_type_idx ON public.email_log (event_type);

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

-- Only authenticated dashboard users can read.
DROP POLICY IF EXISTS email_log_read ON public.email_log;
CREATE POLICY email_log_read ON public.email_log FOR SELECT TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- get_email_24h — quick counts for the /ops pipeline view.
-- Lives here so the dashboard does one round trip not five.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_email_24h()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v jsonb;
BEGIN
  PERFORM public.assert_ops_admin();
  SELECT jsonb_build_object(
    'window_hours', 24,
    'sent',       COUNT(*) FILTER (WHERE event_type = 'sent'),
    'delivered',  COUNT(*) FILTER (WHERE event_type = 'delivered'),
    'bounced',    COUNT(*) FILTER (WHERE event_type = 'bounced'),
    'complained', COUNT(*) FILTER (WHERE event_type = 'complained'),
    'by_path',    (
      SELECT COALESCE(jsonb_object_agg(send_path, n), '{}'::jsonb)
      FROM (
        SELECT COALESCE(send_path, '(unknown)') AS send_path, COUNT(*) AS n
        FROM email_log
        WHERE created_at >= now() - interval '24 hours' AND event_type = 'sent'
        GROUP BY 1
      ) s
    )
  ) INTO v FROM email_log WHERE created_at >= now() - interval '24 hours';
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_email_24h() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_email_24h() TO authenticated;
