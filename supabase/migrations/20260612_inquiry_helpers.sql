-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · /homebase Inquiries section helpers.
--
-- Two pieces:
--   1. leads.contacted_at + contacted_by_user_id columns so staff can mark
--      an inquiry as handled directly from /homebase.
--   2. RPC get_recent_inquiries(p_studio_slug) for the front-desk view.
--      Returns contact-form leads with their message + their conversion
--      state (in case they later signed up for a paid trial).
--   3. RPC mark_lead_contacted(p_lead_id) — sets contacted_at = now() so
--      the inquiry rolls off the "needs attention" list.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS contacted_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contacted_by_user_id UUID;

COMMENT ON COLUMN public.leads.contacted_at IS
  'Set when a staff member clicks "Mark contacted" on the /homebase Inquiries view. Prevents the same inquiry from re-surfacing as needing attention.';


DROP FUNCTION IF EXISTS public.get_recent_inquiries(text);
CREATE OR REPLACE FUNCTION public.get_recent_inquiries(p_studio_slug TEXT DEFAULT NULL)
RETURNS TABLE(
  lead_id        UUID,
  full_name      TEXT,
  email          TEXT,
  phone          TEXT,
  studio_slug    TEXT,
  studio_name    TEXT,
  message        TEXT,
  created_at     TIMESTAMPTZ,
  contacted_at   TIMESTAMPTZ,
  converted_at   TIMESTAMPTZ,
  has_converted  BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT
    l.id,
    l.full_name,
    l.email,
    l.phone,
    l.studio_slug,
    loc.name AS studio_name,
    COALESCE(l.notes, l.meta->>'message') AS message,
    l.created_at,
    l.contacted_at,
    ts.payment_date AS converted_at,
    (ts.id IS NOT NULL AND ts.payment_status = 'completed') AS has_converted
  FROM public.leads l
  LEFT JOIN public.locations loc
         ON LOWER(REPLACE(loc.name, ' ', '-')) = l.studio_slug
  LEFT JOIN public.trial_signups ts
         ON ts.lead_id = l.id AND ts.payment_status = 'completed'
  WHERE l.source = 'contact_form'
    AND (p_studio_slug IS NULL OR l.studio_slug = p_studio_slug)
  ORDER BY
    -- Surface uncontacted first, then most recent
    (l.contacted_at IS NULL) DESC,
    l.created_at DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.get_recent_inquiries(TEXT) TO anon, authenticated;


-- Mark-contacted helper. Returns the updated row.
DROP FUNCTION IF EXISTS public.mark_lead_contacted(uuid);
CREATE OR REPLACE FUNCTION public.mark_lead_contacted(p_lead_id UUID)
RETURNS TABLE(lead_id UUID, contacted_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.leads
     SET contacted_at = now(),
         contacted_by_user_id = auth.uid()
   WHERE id = p_lead_id
     AND contacted_at IS NULL
   RETURNING id, contacted_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_lead_contacted(UUID) TO authenticated;
