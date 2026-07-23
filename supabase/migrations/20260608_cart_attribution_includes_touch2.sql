-- ─────────────────────────────────────────────────────────────────────────────
-- Fix get_abandoned_cart_attribution to count touch-2 sends.
--
-- BUG: 2026-06-02 version hardcoded send_path = 'abandoned_cart_email'.
-- When abandoned-cart-followup-2 shipped 2026-06-06 with send_path
-- 'abandoned_cart_email_2' (a 14-email burst that day plus subsequent cron
-- runs), the Cart Recovery card silently undercounted them. Dashboard showed
-- 16 sent network-wide on 2026-06-08; email_log truth = 28 (18 touch-1 + 10
-- touch-2). Owners couldn't see the impact of the second-touch retargeting.
--
-- FIX: Replace the two hardcoded equality checks with IN clauses that include
-- both send_paths. Future touch-3 etc. can be added the same way.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  BEGIN
    EXECUTE 'DROP FUNCTION IF EXISTS public.get_abandoned_cart_attribution(TEXT, TEXT, BOOLEAN)';
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END$$;

CREATE OR REPLACE FUNCTION public.get_abandoned_cart_attribution(
  p_month        TEXT DEFAULT NULL,
  p_studio_slug  TEXT DEFAULT NULL,
  p_since_launch BOOLEAN DEFAULT FALSE
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
  -- Single source of truth for which send_paths count as cart-recovery.
  -- Adding a touch-3 / touch-N? Add the path here and the card picks it up.
  v_cart_paths TEXT[] := ARRAY['abandoned_cart_email', 'abandoned_cart_email_2'];
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
  WITH
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
  -- 2026-06-08 FIX: include touch-2 (abandoned_cart_email_2) in the sent count.
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
    WHERE e.send_path = ANY (v_cart_paths)
      AND e.created_at >= v_start
      AND e.created_at <  v_end
      AND (p_studio_slug IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio_slug)
  ),
  recovered AS (
    SELECT DISTINCT p.id, p.studio_slug
    FROM paid p
    LEFT JOIN public.trial_signups t_self ON t_self.id = p.id
    WHERE
      (t_self.abandoned_email_sent_at IS NOT NULL
        AND t_self.abandoned_email_sent_at < p.payment_date)
      -- 2026-06-08 FIX: include touch-2 in the recovery match.
      OR EXISTS (
        SELECT 1 FROM public.email_log e
         WHERE e.send_path = ANY (v_cart_paths)
           AND e.created_at < p.payment_date
           AND (
                e.trial_signup_id = p.id
             OR (p.email IS NOT NULL
                 AND LOWER(TRIM(p.email)) = ANY (ARRAY(SELECT LOWER(TRIM(addr)) FROM unnest(e.to_addrs) AS addr)))
           )
      )
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

-- Sanity check — should now show 28 sent network-wide since launch
-- (18 touch-1 + 10 touch-2) instead of the bugged 16.
SELECT
  studio_slug,
  abandoned_sent_count AS sent,
  recovered_count      AS recovered,
  recovered_revenue    AS revenue
FROM public.get_abandoned_cart_attribution(
  p_month := NULL,
  p_studio_slug := NULL,
  p_since_launch := TRUE
)
ORDER BY abandoned_sent_count DESC;
