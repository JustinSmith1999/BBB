-- ─────────────────────────────────────────────────────────────────────────────
-- Abandoned-cart attribution RPC.
--
-- Returns, per studio (optional filter), in a given month:
--   - paid_count          — total paid trials in window
--   - recovered_count     — paid trials whose email got an abandoned_cart_email
--                            BEFORE their payment_date
--   - recovered_revenue   — recovered_count × $49
--   - recovery_rate       — recovered_count / abandoned_emails_sent
--   - abandoned_sent_count — total abandoned_cart_email sends in window
--
-- Join logic: an "abandoned cart" email is matched to a paid trial if (a) the
-- email_log row tagged send_path='abandoned_cart_email' shares trial_signup_id
-- with the paid row, OR (b) the email recipient matches the paid email
-- (case-insensitive). The "BEFORE payment" guard prevents counting welcome
-- emails as cart-recovery.
--
-- Backs the "Cart recovery · $X recovered" card on owner dashboard + /homebase.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop any prior overloads so the new 3-param signature is unambiguous.
-- Wrap in DO block to swallow "function does not exist" if the overload
-- was already removed by a prior partial run.
DO $$
BEGIN
  BEGIN
    EXECUTE 'DROP FUNCTION IF EXISTS public.get_abandoned_cart_attribution(TEXT, TEXT)';
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    EXECUTE 'DROP FUNCTION IF EXISTS public.get_abandoned_cart_attribution(TEXT, TEXT, BOOLEAN)';
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END$$;

CREATE OR REPLACE FUNCTION public.get_abandoned_cart_attribution(
  p_month        TEXT DEFAULT NULL,    -- 'YYYY-MM' or NULL = current month ET. Ignored if p_since_launch.
  p_studio_slug  TEXT DEFAULT NULL,    -- NULL = all studios
  p_since_launch BOOLEAN DEFAULT FALSE -- TRUE = May 15, 2026 → end of current month (lifetime view)
)
RETURNS TABLE(
  studio_slug          TEXT,
  month                TEXT,
  paid_count           INT,
  abandoned_sent_count INT,
  recovered_count      INT,
  recovered_revenue    NUMERIC,
  recovery_rate        NUMERIC
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_month_text TEXT;
  v_start      TIMESTAMPTZ;
  v_end        TIMESTAMPTZ;
BEGIN
  -- Resolve window. Since-launch mode runs from BBB launch (May 15, 2026)
  -- through the end of the current month — gives owners the lifetime
  -- recovery view that doesn't disappear when the calendar flips.
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
  WITH
  -- Paid trials in window
  paid AS (
    SELECT
      t.id,
      t.email,
      lower(replace(l.name, ' ', '-')) AS studio_slug,
      t.payment_date
    FROM public.trial_signups t
    LEFT JOIN public.locations l ON l.id = t.location_id
    WHERE t.payment_status = 'completed'
      AND t.deleted_at IS NULL
      AND t.payment_date >= v_start
      AND t.payment_date <  v_end
      AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
  ),
  -- Abandoned-cart sends in window. email_log has no studio_slug column,
  -- so we resolve it via trial_signup_id → trial_signups → locations.
  -- Rows with no trial_signup_id are unattributable to a studio and excluded.
  abandoned AS (
    SELECT
      e.id,
      e.trial_signup_id,
      e.created_at,
      e.to_addrs,
      lower(replace(l.name, ' ', '-')) AS studio_slug
    FROM public.email_log e
    LEFT JOIN public.trial_signups t ON t.id = e.trial_signup_id
    LEFT JOIN public.locations l     ON l.id = t.location_id
    WHERE e.send_path = 'abandoned_cart_email'
      AND e.created_at >= v_start
      AND e.created_at <  v_end
      AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
  ),
  -- Recovered: paid trial THIS MONTH whose record shows they got an
  -- abandoned-cart email at any earlier point. Two signals are honored —
  -- either the persistent flag on the row (abandoned_email_sent_at) OR a
  -- matching email_log entry. This lets us count people who got the email
  -- in May and paid in June (the "backdated" case) without double-counting
  -- legit duplicates.
  recovered AS (
    SELECT DISTINCT p.id, p.studio_slug
    FROM paid p
    LEFT JOIN public.trial_signups t_self ON t_self.id = p.id
    WHERE
      -- 1. The trial_signups flag is set and predates payment
      (t_self.abandoned_email_sent_at IS NOT NULL
        AND t_self.abandoned_email_sent_at < p.payment_date)
      -- 2. OR — there's any earlier email_log row with the cart path matching this person
      OR EXISTS (
        SELECT 1 FROM public.email_log e
         WHERE e.send_path = 'abandoned_cart_email'
           AND e.created_at < p.payment_date
           AND (
                e.trial_signup_id = p.id
             OR (p.email IS NOT NULL
                 AND LOWER(TRIM(p.email)) = ANY (ARRAY(SELECT LOWER(TRIM(addr)) FROM unnest(e.to_addrs) AS addr)))
           )
      )
      -- 3. OR — any other trial_signups row from the SAME PERSON (matched
      -- by email or phone) had abandoned_email_sent_at set before this
      -- payment date. Covers people who filled the form twice — once got
      -- the email, then a separate row paid.
      OR EXISTS (
        SELECT 1 FROM public.trial_signups t_other
         WHERE t_other.id <> p.id
           AND t_other.deleted_at IS NULL
           AND t_other.abandoned_email_sent_at IS NOT NULL
           AND t_other.abandoned_email_sent_at < p.payment_date
           AND (
                (p.email IS NOT NULL AND LOWER(TRIM(t_other.email)) = LOWER(TRIM(p.email)))
             OR (t_other.phone IS NOT NULL
                 AND REGEXP_REPLACE(COALESCE(t_other.phone,''),'\D','','g') =
                     REGEXP_REPLACE(COALESCE(
                       (SELECT phone FROM public.trial_signups WHERE id = p.id),
                       ''),'\D','','g'))
           )
      )
  ),
  -- Group by studio (or roll up to single row if studio filter active)
  by_studio AS (
    SELECT
      COALESCE(p_studio_slug, p.studio_slug) AS studio_slug,
      COUNT(*) AS paid_count
    FROM paid p
    GROUP BY 1
  ),
  abandoned_by_studio AS (
    SELECT
      COALESCE(p_studio_slug, a.studio_slug) AS studio_slug,
      COUNT(*) AS sent_count
    FROM abandoned a
    GROUP BY 1
  ),
  recovered_by_studio AS (
    SELECT
      COALESCE(p_studio_slug, r.studio_slug) AS studio_slug,
      COUNT(*) AS recovered_count
    FROM recovered r
    GROUP BY 1
  )
  SELECT
    bs.studio_slug,
    v_month_text,
    bs.paid_count::INT,
    COALESCE(abs2.sent_count, 0)::INT,
    COALESCE(rbs.recovered_count, 0)::INT,
    (COALESCE(rbs.recovered_count, 0) * 49)::NUMERIC,
    -- Rate denominator: union of (emails sent this month) + (recovered this
    -- month). When recoveries trail their original send by months, sent=0 in
    -- the current month but recovered>0 — without this fix the rate reads
    -- 0% even though the recovery happened. Cap at 100%.
    CASE
      WHEN COALESCE(abs2.sent_count, 0) + COALESCE(rbs.recovered_count, 0) = 0 THEN 0::NUMERIC
      ELSE LEAST(100, ROUND(
        COALESCE(rbs.recovered_count, 0)::NUMERIC
          / GREATEST(COALESCE(abs2.sent_count, 0), COALESCE(rbs.recovered_count, 0))::NUMERIC
          * 100, 1))
    END
  FROM by_studio bs
  LEFT JOIN abandoned_by_studio abs2 USING (studio_slug)
  LEFT JOIN recovered_by_studio rbs  USING (studio_slug)
  ORDER BY bs.studio_slug;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_abandoned_cart_attribution(TEXT, TEXT, BOOLEAN)
  TO anon, authenticated;

-- Sanity check — call with explicit named params so the new 3-param
-- signature is unambiguous even if older overloads linger in the cache.
SELECT * FROM public.get_abandoned_cart_attribution(
  p_month := NULL,
  p_studio_slug := NULL,
  p_since_launch := TRUE
);
