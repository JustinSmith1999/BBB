-- ─────────────────────────────────────────────────────────────────────────────
-- get_funnel_health — per-studio trial funnel breakdown for the owner
-- dashboard. Counts form fills → paid → pending (abandoned) and computes
-- the pay rate so Justin can see at a glance which studios are leaking
-- customers between "filled the form" and "completed checkout".
--
-- Numbers are May-15-launch-forward to stay parallel with the rest of the
-- dashboard. Deleted rows excluded. Single row per studio.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_funnel_health(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date
)
RETURNS TABLE(
  studio_slug      text,
  studio_name      text,
  form_fills       int,
  paid             int,
  abandoned        int,
  pay_rate_pct     numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  v_allowed text[];
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  RETURN QUERY
  SELECT
    lower(replace(l.name, ' ', '-'))                                   AS studio_slug,
    l.name                                                              AS studio_name,
    COUNT(*)::int                                                       AS form_fills,
    COUNT(*) FILTER (WHERE t.payment_status = 'completed')::int         AS paid,
    COUNT(*) FILTER (WHERE t.payment_status = 'pending')::int           AS abandoned,
    CASE WHEN COUNT(*) > 0
      THEN ROUND(100.0 * COUNT(*) FILTER (WHERE t.payment_status = 'completed') / COUNT(*), 1)
      ELSE 0 END                                                        AS pay_rate_pct
  FROM public.trial_signups t
  JOIN public.locations l ON l.id = t.location_id
  WHERE t.created_at >= p_since
    AND t.deleted_at IS NULL
    AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
    AND lower(replace(l.name, ' ', '-')) = ANY(v_allowed)
  GROUP BY 1, 2
  ORDER BY 2;
END;
$$;

REVOKE ALL ON FUNCTION public.get_funnel_health(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_funnel_health(text, date) TO authenticated;

-- Quick sanity:
-- SELECT * FROM public.get_funnel_health();
-- SELECT * FROM public.get_funnel_health('astoria');
