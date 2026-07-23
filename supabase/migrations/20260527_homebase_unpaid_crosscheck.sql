-- ─────────────────────────────────────────────────────────────────────────────
-- Homebase / "Not Paid" cross-check (May 27 2026)
--
-- A trial_signup with payment_status = 'pending' just means they didn't
-- finish the $49 Stripe checkout. But many of those people still walked
-- into the studio later and got registered in MindBody — and a chunk of
-- them eventually bought a class pack or membership through the studio's
-- POS. The "Not Paid" column on /homebase ignores all of that.
--
-- This RPC joins trial_signups → mindbody_clients (by email) → MindBody
-- visit data, so each unpaid lead carries a status that reflects what
-- actually happened, not just whether our Stripe webhook saw a checkout.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_homebase_unpaid_status(p_location_id uuid)
RETURNS TABLE(
  trial_id          uuid,
  email             text,
  in_mindbody       boolean,
  mindbody_status   text,
  visit_count       integer,
  first_visit_at    timestamptz,
  last_visit_at     timestamptz,
  member_since      timestamptz
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
  WITH unpaid AS (
    -- Form-filled but no completed Stripe checkout — the "Not Paid" column.
    SELECT t.id AS trial_id, lower(trim(t.email)) AS email_n
    FROM public.trial_signups t
    WHERE t.location_id = p_location_id
      AND COALESCE(t.payment_status, 'pending') <> 'completed'
      AND t.email IS NOT NULL
  ),
  mb AS (
    SELECT lower(trim(mc.email)) AS email_n,
           mc.mindbody_id,
           mc.status,
           mc.member_since
    FROM public.mindbody_clients mc
    WHERE mc.email IS NOT NULL
  ),
  visits AS (
    -- Aggregate MindBody check-ins per client at this studio (since launch).
    SELECT mv.mindbody_client_id,
           COUNT(*)::int AS cnt,
           MIN(mv.starts_at) AS first_visit,
           MAX(mv.starts_at) AS last_visit
    FROM public.mindbody_visits mv
    WHERE mv.studio_slug = v_studio_slug
      AND mv.signed_in = true
    GROUP BY mv.mindbody_client_id
  )
  SELECT
    u.trial_id,
    u.email_n,
    mb.mindbody_id IS NOT NULL AS in_mindbody,
    mb.status,
    COALESCE(v.cnt, 0)        AS visit_count,
    v.first_visit             AS first_visit_at,
    v.last_visit              AS last_visit_at,
    mb.member_since
  FROM unpaid u
  LEFT JOIN mb     ON mb.email_n = u.email_n
  LEFT JOIN visits v ON v.mindbody_client_id = mb.mindbody_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_homebase_unpaid_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_unpaid_status(uuid) TO anon, authenticated;
