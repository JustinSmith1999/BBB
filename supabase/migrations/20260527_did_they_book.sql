-- ─────────────────────────────────────────────────────────────────────────────
-- did_they_book_a_class — for every paid trial since launch, returns whether
-- that person has shown up in MindBody (matched by email, then phone, then
-- last name), how many visits they've had, and when their last one was.
-- One query, no per-customer round trips. SECURITY DEFINER so the dashboard
-- can call it without RLS blocking mindbody_clients reads.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.did_they_book_a_class()
RETURNS TABLE(
  trial_id          uuid,
  name              text,
  studio            text,
  paid_date         timestamptz,
  front_desk_stage  text,
  front_desk_note   text,
  mb_match_by       text,
  mb_full_name      text,
  mb_email          text,
  mb_status         text,
  total_visits      int,
  signed_in_visits  int,
  last_visit_at     timestamptz,
  upcoming_visit_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  WITH trials AS (
    SELECT t.id, t.name, t.email, t.phone, t.payment_date,
           t.front_desk_stage, t.front_desk_note,
           l.name AS studio_name
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.payment_status = 'completed'
      AND t.created_at >= '2026-05-15'::date
  ),
  -- Per trial, find the BEST MindBody match — email first, then phone, then last-name.
  matched AS (
    SELECT
      tr.id AS trial_id,
      tr.name, tr.email, tr.phone, tr.payment_date, tr.front_desk_stage, tr.front_desk_note, tr.studio_name,
      -- Email match
      (SELECT mc.mindbody_id FROM public.mindbody_clients mc
        WHERE lower(mc.email) = lower(tr.email) LIMIT 1) AS mb_id_email,
      -- Phone match (strip non-digits, drop leading 1)
      (SELECT mc.mindbody_id FROM public.mindbody_clients mc
        WHERE regexp_replace(coalesce(mc.phone,''), '\D', '', 'g')
              ILIKE '%' || regexp_replace(coalesce(tr.phone,''), '\D', '', 'g') || '%'
          AND length(regexp_replace(coalesce(tr.phone,''), '\D', '', 'g')) >= 10
        LIMIT 1) AS mb_id_phone,
      -- Last-name match (only when last name is 3+ chars)
      (SELECT mc.mindbody_id FROM public.mindbody_clients mc
        WHERE lower(mc.last_name) = lower(split_part(tr.name, ' ', array_length(string_to_array(tr.name, ' '), 1)))
          AND length(split_part(tr.name, ' ', array_length(string_to_array(tr.name, ' '), 1))) >= 3
        LIMIT 1) AS mb_id_lastname
    FROM trials tr
  ),
  final AS (
    SELECT
      m.*,
      COALESCE(m.mb_id_email, m.mb_id_phone, m.mb_id_lastname) AS mb_id,
      CASE
        WHEN m.mb_id_email    IS NOT NULL THEN 'email'
        WHEN m.mb_id_phone    IS NOT NULL THEN 'phone'
        WHEN m.mb_id_lastname IS NOT NULL THEN 'lastname'
        ELSE NULL
      END AS match_by
    FROM matched m
  )
  SELECT
    f.trial_id, f.name, f.studio_name, f.payment_date,
    f.front_desk_stage, f.front_desk_note,
    f.match_by,
    (mc.first_name || ' ' || mc.last_name)::text,
    mc.email,
    mc.status,
    COALESCE(vstats.total, 0)::int,
    COALESCE(vstats.signed_in, 0)::int,
    vstats.last_visit,
    vstats.upcoming_visit
  FROM final f
  LEFT JOIN public.mindbody_clients mc ON mc.mindbody_id = f.mb_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)                                              AS total,
           COUNT(*) FILTER (WHERE v.signed_in)                   AS signed_in,
           MAX(v.starts_at)  FILTER (WHERE v.starts_at <= now()) AS last_visit,
           MIN(v.starts_at)  FILTER (WHERE v.starts_at >  now()) AS upcoming_visit
    FROM public.mindbody_visits v
    WHERE v.mindbody_client_id = f.mb_id
  ) vstats ON TRUE
  ORDER BY f.payment_date DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.did_they_book_a_class() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.did_they_book_a_class() TO authenticated;

-- Quick sanity: SELECT * FROM public.did_they_book_a_class();
