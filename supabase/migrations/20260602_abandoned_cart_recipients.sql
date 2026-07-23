-- ─────────────────────────────────────────────────────────────────────────────
-- get_abandoned_cart_recipients — list every person we cart-emailed in the
-- given month, with their studio + payment status. Used by the Cart
-- Recovery card on the owner dashboard so the card can SHOW NAMES, not
-- just counts. Returns one row per person, joined back to trial_signups
-- and locations.
--
-- Marks each as 'paid' if they've since paid, 'pending' if not yet, and
-- includes the cart-email timestamp so we can sort by recency.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop any prior overloads so the new 4-param signature is unambiguous.
-- Wrap in DO block to swallow "function does not exist" on partial reruns.
DO $$
BEGIN
  BEGIN
    EXECUTE 'DROP FUNCTION IF EXISTS public.get_abandoned_cart_recipients(TEXT, TEXT, INT)';
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    EXECUTE 'DROP FUNCTION IF EXISTS public.get_abandoned_cart_recipients(TEXT, TEXT, INT, BOOLEAN)';
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END$$;

CREATE OR REPLACE FUNCTION public.get_abandoned_cart_recipients(
  p_month        TEXT DEFAULT NULL,
  p_studio_slug  TEXT DEFAULT NULL,
  p_limit        INT  DEFAULT 50,
  p_since_launch BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(
  trial_signup_id     UUID,
  name                TEXT,
  email               TEXT,
  phone               TEXT,
  studio_slug         TEXT,
  cart_emailed_at     TIMESTAMPTZ,
  payment_status      TEXT,
  payment_date        TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_month_text TEXT;
  v_start      TIMESTAMPTZ;
  v_end        TIMESTAMPTZ;
BEGIN
  IF p_since_launch THEN
    v_month_text := 'since_launch';
    v_start := '2026-05-15'::DATE AT TIME ZONE 'America/New_York';
    v_end   := (date_trunc('month', now() AT TIME ZONE 'America/New_York') + INTERVAL '1 month') AT TIME ZONE 'America/New_York';
  ELSE
    v_month_text := COALESCE(p_month, to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM'));
    v_start := (v_month_text || '-01')::DATE AT TIME ZONE 'America/New_York';
    v_end   := (v_start + INTERVAL '1 month');
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.name,
    t.email,
    t.phone,
    lower(replace(l.name, ' ', '-')) AS studio_slug,
    t.abandoned_email_sent_at,
    t.payment_status,
    t.payment_date
  FROM public.trial_signups t
  LEFT JOIN public.locations l ON l.id = t.location_id
  WHERE t.deleted_at IS NULL
    AND t.abandoned_email_sent_at >= v_start
    AND t.abandoned_email_sent_at <  v_end
    AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
  ORDER BY t.abandoned_email_sent_at DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_abandoned_cart_recipients(TEXT, TEXT, INT, BOOLEAN)
  TO anon, authenticated;

-- Sanity check — named params so the 4-param signature is unambiguous.
SELECT studio_slug, name, payment_status, cart_emailed_at
  FROM public.get_abandoned_cart_recipients(
    p_month := NULL,
    p_studio_slug := NULL,
    p_limit := 20,
    p_since_launch := TRUE
  );
