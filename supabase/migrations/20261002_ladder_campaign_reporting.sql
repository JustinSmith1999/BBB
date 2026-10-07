-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-02 · Offer-ladder campaign reporting (Bayside + Fresh Meadows).
--
-- Powers the owner-facing campaign view: a summary card in index.html and the
-- standalone page at /ladder.html. MONEY FIRST — purchases and revenue lead,
-- funnel mechanics sit underneath.
--
-- WHY IT READS FROM email_log, NOT trial_signups
--   trial_signups has no generic campaign-history column (`campaigns_received`
--   does not exist), and adding nine new *_sent_at columns for one campaign is
--   the wrong shape. email_log already carries, per send, the send_path and the
--   trial_signup_id — written by resend-webhook from the Resend tags. So the
--   cohort IS "everyone who received a ladder_% email", which also means this
--   view reports zero until the first send, which is correct.
--
-- CONTRACT WITH THE SENDER (must hold or these numbers are empty):
--   Every ladder email must go out with Resend tags:
--     { name: "send_path",       value: "ladder_<offer>_l<look>" }   e.g. ladder_99_l2
--     { name: "trial_signup_id", value: <the trial_signups.id uuid> }
--     { name: "studio",          value: <studio slug> }
--   send_path vocabulary (11 values):
--     ladder_99_l1  ladder_99_l2  ladder_99_l3
--     ladder_49_l1  ladder_49_l2  ladder_49_l3
--     ladder_29_l1  ladder_29_l2  ladder_29_l3
--     ladder_menu            (day 26, all offers)
--     ladder_sms_99 / ladder_sms_29 are SMS and live in sms_messages, not here.
--   NOTE: winback-blast writes to email_log directly with NO trial_signup_id.
--   The ladder sender must NOT copy that pattern — send through Resend with
--   tags and let resend-webhook do the logging, like comeback-offer-cron does.
--
-- PURCHASE ATTRIBUTION
--   A sale counts for the campaign when the buyer's email matches a cohort
--   member AND the sale lands on/after that person's first ladder send.
--   The offer is identified by total_cents (exact, and immune to product
--   renames): 2900→$29, 4900→$49, 9900→$99, 29900→$299. Anything else is
--   counted in revenue but bucketed as "other" — that is usually a membership,
--   which is a win worth seeing.
--   The sale is credited to the LAST ladder send that reached that person
--   before the sale. Last-touch within the campaign.
--
-- Deploy: paste into the Supabase SQL editor (migrations are not run via CLI
-- on this project). Both functions are SECURITY DEFINER and granted to
-- authenticated only — email_log is not anon-readable and must stay that way.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── shared: the cohort, one row per person ───────────────────────────────────
-- Not a view, because both RPCs want it with different grouping. Kept as a
-- function returning a table so the logic lives in exactly one place.
DROP FUNCTION IF EXISTS public.ladder_cohort();
CREATE OR REPLACE FUNCTION public.ladder_cohort()
RETURNS TABLE(
  trial_signup_id UUID,
  studio_slug     TEXT,
  studio_name     TEXT,
  person_name     TEXT,
  email           TEXT,
  sends           INTEGER,
  opens           INTEGER,
  clicks          INTEGER,
  first_send_at   TIMESTAMPTZ,
  last_send_at    TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT
    el.trial_signup_id,
    LOWER(REPLACE(l.name, ' ', '-')),
    l.name,
    ts.name,
    LOWER(TRIM(ts.email)),
    COUNT(*) FILTER (WHERE el.event_type IN ('email.sent', 'sent'))::INTEGER,
    COUNT(*) FILTER (WHERE el.event_type IN ('email.opened', 'opened'))::INTEGER,
    COUNT(*) FILTER (WHERE el.event_type IN ('email.clicked', 'clicked'))::INTEGER,
    MIN(el.created_at) FILTER (WHERE el.event_type IN ('email.sent', 'sent')),
    MAX(el.created_at) FILTER (WHERE el.event_type IN ('email.sent', 'sent'))
  FROM public.email_log el
  JOIN public.trial_signups ts ON ts.id = el.trial_signup_id
  JOIN public.locations     l  ON l.id  = ts.location_id
  WHERE el.send_path LIKE 'ladder\_%'
    AND el.trial_signup_id IS NOT NULL
    AND ts.deleted_at IS NULL
  GROUP BY el.trial_signup_id, l.name, ts.name, LOWER(TRIM(ts.email));
$$;
GRANT EXECUTE ON FUNCTION public.ladder_cohort() TO authenticated;


-- ── shared: sales attributed to the campaign ─────────────────────────────────
DROP FUNCTION IF EXISTS public.ladder_sales();
CREATE OR REPLACE FUNCTION public.ladder_sales()
RETURNS TABLE(
  trial_signup_id UUID,
  studio_slug     TEXT,
  mt_sale_id      TEXT,
  sale_date_time  TIMESTAMPTZ,
  total_cents     BIGINT,
  offer           TEXT,
  credited_path   TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT
    c.trial_signup_id,
    c.studio_slug,
    s.mt_sale_id,
    s.sale_date_time,
    s.total_cents,
    CASE s.total_cents
      WHEN 2900  THEN '29'
      WHEN 4900  THEN '49'
      WHEN 9900  THEN '99'
      WHEN 29900 THEN '299'
      ELSE 'other'
    END,
    -- last ladder send that reached this person before the sale
    (SELECT el2.send_path
       FROM public.email_log el2
      WHERE el2.trial_signup_id = c.trial_signup_id
        AND el2.send_path LIKE 'ladder\_%'
        AND el2.event_type IN ('email.sent', 'sent')
        AND el2.created_at <= s.sale_date_time
      ORDER BY el2.created_at DESC
      LIMIT 1)
  FROM public.ladder_cohort() c
  JOIN public.mariana_tek_sales s
    ON LOWER(TRIM(s.customer_email)) = c.email
   AND s.sale_date_time >= c.first_send_at
   AND s.total_cents > 0;
$$;
GRANT EXECUTE ON FUNCTION public.ladder_sales() TO authenticated;


-- ── 1. get_ladder_overview · one row per studio, money first ────────────────
DROP FUNCTION IF EXISTS public.get_ladder_overview();
CREATE OR REPLACE FUNCTION public.get_ladder_overview()
RETURNS TABLE(
  studio_slug          TEXT,
  studio_name          TEXT,
  revenue_cents        BIGINT,
  buyers               INTEGER,
  people               INTEGER,
  conv_rate_pct        NUMERIC,
  rev_per_person_cents INTEGER,
  buyers_29            INTEGER,
  buyers_49            INTEGER,
  buyers_99            INTEGER,
  buyers_299           INTEGER,
  buyers_other         INTEGER,
  emails_sent          INTEGER,
  opened               INTEGER,
  clicked              INTEGER,
  gone_dark            INTEGER,
  first_send_at        TIMESTAMPTZ,
  last_send_at         TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH c AS (SELECT * FROM public.ladder_cohort()),
       s AS (SELECT * FROM public.ladder_sales()),
  people AS (
    SELECT
      c.studio_slug,
      MAX(c.studio_name)                                         AS studio_name,
      COUNT(*)::INTEGER                                          AS people,
      SUM(c.sends)::INTEGER                                      AS emails_sent,
      COUNT(*) FILTER (WHERE c.opens  > 0)::INTEGER              AS opened,
      COUNT(*) FILTER (WHERE c.clicks > 0)::INTEGER              AS clicked,
      -- "Gone dark" is NOT merely zero opens — someone one send in has simply
      -- not been reached yet. It is zero opens AND zero clicks AFTER six sends
      -- (i.e. they have been through step 1 and step 2 in full), which is the
      -- point the plan drops them off email and onto the call list. MPP
      -- inflates opens, so it never invents a zero: a zero here is trustworthy.
      COUNT(*) FILTER (WHERE c.opens = 0 AND c.clicks = 0 AND c.sends >= 6)::INTEGER AS gone_dark,
      MIN(c.first_send_at)                                       AS first_send_at,
      MAX(c.last_send_at)                                        AS last_send_at
    FROM c GROUP BY c.studio_slug
  ),
  money AS (
    SELECT
      s.studio_slug,
      SUM(s.total_cents)::BIGINT                                              AS revenue_cents,
      COUNT(DISTINCT s.trial_signup_id)::INTEGER                              AS buyers,
      COUNT(DISTINCT s.trial_signup_id) FILTER (WHERE s.offer = '29')::INTEGER  AS buyers_29,
      COUNT(DISTINCT s.trial_signup_id) FILTER (WHERE s.offer = '49')::INTEGER  AS buyers_49,
      COUNT(DISTINCT s.trial_signup_id) FILTER (WHERE s.offer = '99')::INTEGER  AS buyers_99,
      COUNT(DISTINCT s.trial_signup_id) FILTER (WHERE s.offer = '299')::INTEGER AS buyers_299,
      COUNT(DISTINCT s.trial_signup_id) FILTER (WHERE s.offer = 'other')::INTEGER AS buyers_other
    FROM s GROUP BY s.studio_slug
  )
  SELECT
    p.studio_slug,
    p.studio_name,
    COALESCE(m.revenue_cents, 0),
    COALESCE(m.buyers, 0),
    p.people,
    CASE WHEN p.people = 0 THEN 0
         ELSE ROUND(100.0 * COALESCE(m.buyers, 0) / p.people, 1) END,
    CASE WHEN p.people = 0 THEN 0
         ELSE (COALESCE(m.revenue_cents, 0) / p.people)::INTEGER END,
    COALESCE(m.buyers_29, 0),
    COALESCE(m.buyers_49, 0),
    COALESCE(m.buyers_99, 0),
    COALESCE(m.buyers_299, 0),
    COALESCE(m.buyers_other, 0),
    p.emails_sent,
    p.opened,
    p.clicked,
    p.gone_dark,
    p.first_send_at,
    p.last_send_at
  FROM people p
  LEFT JOIN money m ON m.studio_slug = p.studio_slug
  ORDER BY p.studio_slug;
$$;
GRANT EXECUTE ON FUNCTION public.get_ladder_overview() TO authenticated;


-- ── 2. get_ladder_detail · one row per step × look ──────────────────────────
-- Answers the two questions the design exists to answer: which STEP sells, and
-- whether looks 2 and 3 earn their place. p_studio_slug = NULL → all studios.
DROP FUNCTION IF EXISTS public.get_ladder_detail(TEXT);
CREATE OR REPLACE FUNCTION public.get_ladder_detail(p_studio_slug TEXT DEFAULT NULL)
RETURNS TABLE(
  send_path      TEXT,
  step           TEXT,
  look           INTEGER,
  sort_order     INTEGER,
  sent           INTEGER,
  opened         INTEGER,
  clicked        INTEGER,
  buyers         INTEGER,
  revenue_cents  BIGINT,
  first_sent_at  TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  WITH sends AS (
    SELECT
      el.send_path,
      split_part(el.send_path, '_', 2)                         AS step,
      COALESCE(NULLIF(regexp_replace(split_part(el.send_path, '_', 3), '\D', '', 'g'), ''), '1')::INTEGER AS look,
      el.event_type,
      el.trial_signup_id
    FROM public.email_log el
    JOIN public.trial_signups ts ON ts.id = el.trial_signup_id
    JOIN public.locations     l  ON l.id  = ts.location_id
    WHERE el.send_path LIKE 'ladder\_%'
      AND el.trial_signup_id IS NOT NULL
      AND ts.deleted_at IS NULL
      AND (p_studio_slug IS NULL
           OR LOWER(REPLACE(l.name, ' ', '-')) = p_studio_slug)
  ),
  agg AS (
    SELECT
      x.send_path,
      MAX(x.step) AS step,
      MAX(x.look) AS look,
      COUNT(*) FILTER (WHERE x.event_type IN ('email.sent', 'sent'))::INTEGER    AS sent,
      COUNT(DISTINCT x.trial_signup_id) FILTER (WHERE x.event_type IN ('email.opened', 'opened'))::INTEGER  AS opened,
      COUNT(DISTINCT x.trial_signup_id) FILTER (WHERE x.event_type IN ('email.clicked', 'clicked'))::INTEGER AS clicked
    FROM sends x GROUP BY x.send_path
  ),
  credited AS (
    SELECT
      s.credited_path                             AS send_path,
      COUNT(DISTINCT s.trial_signup_id)::INTEGER  AS buyers,
      SUM(s.total_cents)::BIGINT                  AS revenue_cents
    FROM public.ladder_sales() s
    WHERE s.credited_path IS NOT NULL
      AND (p_studio_slug IS NULL OR s.studio_slug = p_studio_slug)
    GROUP BY s.credited_path
  ),
  firsts AS (
    SELECT el.send_path, MIN(el.created_at) AS first_sent_at
    FROM public.email_log el
    WHERE el.send_path LIKE 'ladder\_%'
      AND el.event_type IN ('email.sent', 'sent')
    GROUP BY el.send_path
  )
  SELECT
    a.send_path,
    a.step,
    a.look,
    (CASE a.step WHEN '99' THEN 100 WHEN '49' THEN 200 WHEN '29' THEN 300
                 WHEN 'menu' THEN 400 ELSE 900 END + a.look)::INTEGER,
    a.sent,
    a.opened,
    a.clicked,
    COALESCE(cr.buyers, 0),
    COALESCE(cr.revenue_cents, 0),
    f.first_sent_at
  FROM agg a
  LEFT JOIN credited cr ON cr.send_path = a.send_path
  LEFT JOIN firsts   f  ON f.send_path  = a.send_path
  ORDER BY 4;
$$;
GRANT EXECUTE ON FUNCTION public.get_ladder_detail(TEXT) TO authenticated;
