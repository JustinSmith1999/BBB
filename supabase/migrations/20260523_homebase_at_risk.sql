-- ─────────────────────────────────────────────────────────────────────────────
-- "At risk" flag for paid trial members on the Homebase Kanban.
-- Run in the Supabase SQL editor. Idempotent.
--
-- A paid trial signup is AT RISK if it's been ≥2 days since payment and the
-- person has not attended a single class yet (no MindBody check-in since
-- payment_date). The dashboard's Trial Journey card computes at-risk
-- client-side from data get_trial_journey already returns; the Homebase
-- runs as the anon role and can't read mindbody_visits / mindbody_clients
-- directly because of RLS, so it needs this SECURITY DEFINER RPC.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_homebase_at_risk(p_location_id uuid)
RETURNS TABLE(
  trial_id    uuid,
  visit_count integer,
  last_visit  timestamptz,
  days_in     integer,
  at_risk     boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_studio_slug text;
BEGIN
  -- Resolve the studio slug from the location id (matches the convention used
  -- elsewhere: lowercase, spaces -> dashes; e.g. "Fresh Meadows" -> "fresh-meadows").
  SELECT lower(replace(name, ' ', '-'))
    INTO v_studio_slug
    FROM public.locations
   WHERE id = p_location_id;

  RETURN QUERY
  SELECT
    t.id AS trial_id,
    COALESCE(v.cnt, 0)::int      AS visit_count,
    v.last_visit                 AS last_visit,
    GREATEST(0, (CURRENT_DATE - t.payment_date::date))::int AS days_in,
    (
      t.payment_status = 'completed'
      AND COALESCE(v.cnt, 0) = 0
      AND GREATEST(0, (CURRENT_DATE - t.payment_date::date)) >= 2
    ) AS at_risk
  FROM public.trial_signups t
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS cnt, max(mv.starts_at) AS last_visit
    FROM public.mindbody_visits  mv
    JOIN public.mindbody_clients mc ON mc.mindbody_id = mv.mindbody_client_id
    WHERE lower(mc.email) = lower(t.email)
      AND mv.studio_slug = v_studio_slug
      AND mv.starts_at >= t.payment_date
      AND mv.signed_in = true
  ) v ON TRUE
  WHERE t.location_id     = p_location_id
    AND t.payment_status  = 'completed'
    AND t.payment_date    >= now() - interval '30 days';
END;
$$;

-- Homebase uses the anon key for studio-scoped sign-in.
REVOKE ALL ON FUNCTION public.get_homebase_at_risk(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_homebase_at_risk(uuid) TO anon, authenticated;

-- Sanity check — flips ad-hoc through every studio.
-- SELECT id, name FROM public.locations ORDER BY name;
-- SELECT * FROM public.get_homebase_at_risk('5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7'::uuid); -- bayside
