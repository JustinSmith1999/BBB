-- ─────────────────────────────────────────────────────────────────────────────
-- Homebase upgrade (May 26 2026)
--   1. mindbody_bookings_upcoming — per-client list of upcoming class bookings
--      pulled live from MindBody. Powers the "next class" chip on each card.
--   2. get_homebase_card_bookings(p_location_id) — RPC the front-desk Kanban
--      calls to render that chip alongside the existing lead data.
--   3. update_trial_signup_card(...) — SECURITY DEFINER RPC that lets the
--      front desk save name/phone/email/notes on a card without needing direct
--      write privileges to trial_signups.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mindbody_bookings_upcoming (
  mindbody_client_id text NOT NULL,
  mindbody_class_id  bigint NOT NULL,
  starts_at          timestamptz NOT NULL,
  service_name       text,
  studio_slug        text,
  synced_at          timestamptz DEFAULT now(),
  PRIMARY KEY (mindbody_client_id, mindbody_class_id)
);

CREATE INDEX IF NOT EXISTS mindbody_bookings_upcoming_client_idx
  ON public.mindbody_bookings_upcoming (mindbody_client_id, starts_at);

ALTER TABLE public.mindbody_bookings_upcoming ENABLE ROW LEVEL SECURITY;

-- ── RPC: bookings keyed by trial_signups.id so Homebase doesn't have to know
-- about MindBody IDs. Matches by email today (will pick up the phone-fallback
-- later, same as get_trial_journey).
CREATE OR REPLACE FUNCTION public.get_homebase_card_bookings(p_location_id uuid)
RETURNS TABLE(
  trial_id        uuid,
  next_class_at   timestamptz,
  next_class_name text,
  upcoming_count  integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_studio_slug text;
BEGIN
  SELECT lower(replace(name, ' ', '-'))
    INTO v_studio_slug
    FROM public.locations
   WHERE id = p_location_id;

  RETURN QUERY
  SELECT
    t.id AS trial_id,
    MIN(b.starts_at) AS next_class_at,
    (SELECT b2.service_name FROM public.mindbody_bookings_upcoming b2
      JOIN public.mindbody_clients mc2 ON mc2.mindbody_id = b2.mindbody_client_id
      WHERE lower(mc2.email) = lower(t.email)
        AND b2.starts_at >= now()
      ORDER BY b2.starts_at ASC LIMIT 1) AS next_class_name,
    COUNT(*)::int AS upcoming_count
  FROM public.trial_signups t
  JOIN public.mindbody_clients mc ON lower(mc.email) = lower(t.email)
  JOIN public.mindbody_bookings_upcoming b ON b.mindbody_client_id = mc.mindbody_id
  WHERE t.location_id = p_location_id
    AND b.starts_at >= now()
  GROUP BY t.id, t.email;
END;
$$;

REVOKE ALL ON FUNCTION public.get_homebase_card_bookings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_card_bookings(uuid) TO anon, authenticated;


-- ── RPC: in-place edit for a single lead/trial card.
-- Called from /homebase when staff updates name / phone / email / note.
-- Any blank input is treated as "leave unchanged"; trims whitespace.
CREATE OR REPLACE FUNCTION public.update_trial_signup_card(
  p_trial_id uuid,
  p_name     text DEFAULT NULL,
  p_email    text DEFAULT NULL,
  p_phone    text DEFAULT NULL,
  p_note     text DEFAULT NULL
)
RETURNS public.trial_signups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_signups;
BEGIN
  UPDATE public.trial_signups
     SET name              = COALESCE(NULLIF(trim(p_name),  ''), name),
         email             = COALESCE(NULLIF(trim(p_email), ''), email),
         phone             = COALESCE(NULLIF(trim(p_phone), ''), phone),
         front_desk_note   = CASE WHEN p_note IS NULL THEN front_desk_note ELSE trim(p_note) END,
         front_desk_updated_at = now()
   WHERE id = p_trial_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_trial_signup_card(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_trial_signup_card(uuid, text, text, text, text) TO anon, authenticated;
