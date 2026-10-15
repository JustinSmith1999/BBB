-- 20261007_attribution_fbclid_fallback.sql
--
-- THE PROBLEM
-- get_unified_attribution classifies every signup purely on utm_source. Over
-- the last 30 days, across all four studios:
--
--     total signups   608
--     has_utm           0      <- not one
--     has_fbc          48
--
-- Zero. Every single person files as 'Direct (untagged)', so the report shows
-- 4,459 Meta clicks and $5,419.80 of spend producing 0 leads and 0 paid
-- trials, while 496 paid trials sit under Direct. That is not a measurement
-- nuance, it makes the paid channel unreadable.
--
-- WHY utm_source IS ALWAYS NULL
-- The ads do not tag their links. meta-set-url-tags failed on all 25 ads with
-- write_ignored_by_meta, because Meta refuses url_tags on creatives built from
-- existing posts. Astoria's live ad points at a bare /trial/astoria. So no
-- visitor ever arrives carrying a tag and no amount of code fixes that.
-- (The camelCase/snake_case mismatch in src/lib/utm.ts is a separate, real bug
-- that was already handled in mt-card-checkout via pick("utm_source",
-- "utmSource") - it is NOT the cause here.)
--
-- THE FIX
-- Meta appends fbclid to every ad click automatically. That is platform
-- behaviour, independent of url_tags, and it cannot be switched off. The site
-- turns fbclid into the _fbc cookie, and mt-card-checkout and
-- create-trial-checkout both already write it to trial_signups.fbc.
--
-- So fbc IS the proof of a paid Meta click, and we have been ignoring it.
-- This adds one clause: when utm_source is absent but fbc is present, the
-- signup is a paid Meta click. Applies to every studio at once - the function
-- is already per-studio parameterised, so no per-gym work is needed.
--
-- Deliberately narrow:
--   * fbc only, never fbp. fbp is set on ANY visit to a page carrying the
--     pixel, including organic and direct. Classifying on fbp would credit
--     Meta with walk-ins and would be worse than the current wrongness.
--   * utm_source still wins when present. An explicitly tagged flyer or email
--     link keeps its own channel even if the person also has an fbc cookie
--     from some earlier ad.
--
-- HONEST LIMIT: this recovers the 48 signups that carry fbc. It does not
-- recover anyone who clicked an ad on a device that dropped the cookie, or
-- who converted at the front desk. It makes the paid row true as far as it
-- goes rather than flatly false. Tagging the ad links in Ads Manager is still
-- the complete fix; this is the part that needs no Meta cooperation and works
-- retroactively on data already collected.

DROP FUNCTION IF EXISTS public.get_unified_attribution(text, date);

CREATE OR REPLACE FUNCTION public.get_unified_attribution(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  channel_key         text,
  channel_label       text,
  channel_kind        text,
  clicks              int,
  leads               int,
  paid                int,
  spend_usd           numeric,
  cac_usd             numeric,
  click_to_paid_pct   numeric,
  share_of_paid_pct   numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH
  paid_meta AS (
    SELECT
      'paid_meta_ads'                                  AS channel_key,
      'Meta Ads (paid)'                                AS channel_label,
      'paid'                                           AS channel_kind,
      COALESCE(SUM(m.clicks), 0)::int                  AS clicks,
      ROUND(COALESCE(SUM(m.spend_cents), 0)::numeric / 100.0, 2) AS spend_usd
    FROM public.meta_insights_daily m
    JOIN public.locations l ON lower(replace(l.name, ' ', '-')) = m.studio_slug
    WHERE m.date_start >= p_since
      AND (p_studio IS NULL OR m.studio_slug = p_studio)
  ),
  tracked_clicks AS (
    SELECT
      CASE
        WHEN c.utm_source = 'instagram' AND c.utm_medium = 'social' THEN 'organic_instagram'
        WHEN c.utm_source = 'flyer'                                 THEN 'tracked_flyer'
        WHEN c.utm_source = 'email'                                 THEN 'tracked_email'
        ELSE 'other'
      END                                              AS channel_key,
      COUNT(*)::int                                    AS clicks
    FROM public.link_clicks c
    WHERE c.created_at >= p_since::timestamptz
    GROUP BY 1
  ),
  signups AS (
    SELECT
      CASE
        WHEN t.utm_source = 'ads'                                       THEN 'paid_meta_ads'
        WHEN t.utm_source = 'facebook' AND t.utm_medium = 'cpc'         THEN 'paid_meta_ads'
        WHEN t.utm_source = 'instagram' AND t.utm_medium = 'cpc'        THEN 'paid_meta_ads'
        WHEN t.utm_source = 'instagram' AND t.utm_medium = 'social'     THEN 'organic_instagram'
        WHEN t.utm_source = 'instagram'                                 THEN 'organic_instagram'
        WHEN t.utm_source = 'facebook'                                  THEN 'organic_facebook'
        WHEN t.utm_source = 'flyer'                                     THEN 'tracked_flyer'
        WHEN t.utm_source = 'email'                                     THEN 'tracked_email'
        WHEN t.utm_source = 'google'                                    THEN 'organic_google'
        -- 2026-10-07: fbclid fallback. Untagged BUT carrying Meta's click id
        -- means this person came from a paid Meta click. Sits below every
        -- utm_source rule so an explicit tag always wins.
        WHEN (t.utm_source IS NULL OR t.utm_source = '')
             AND COALESCE(t.fbc, '') <> ''                              THEN 'paid_meta_ads'
        WHEN t.utm_source IS NULL OR t.utm_source = ''                  THEN 'direct'
        ELSE 'other'
      END                                              AS channel_key,
      COUNT(*)::int                                    AS leads,
      COUNT(*) FILTER (
        WHERE t.payment_status = 'completed'
          AND t.payment_date IS NOT NULL
          AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= p_since
      )::int                                           AS paid
    FROM public.trial_signups t
    JOIN public.locations l ON l.id = t.location_id
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.source_category, '') <> 'legacy_archived'
      AND COALESCE(t.email, '') NOT LIKE 'backfill-pi_%@no-email.bbb.local'
      AND (
        (t.created_at AT TIME ZONE 'America/New_York')::date >= p_since
        OR (t.payment_date IS NOT NULL
            AND (t.payment_date AT TIME ZONE 'America/New_York')::date >= p_since)
      )
      AND (p_studio IS NULL OR lower(replace(l.name, ' ', '-')) = p_studio)
    GROUP BY 1
  ),
  catalog (channel_key, channel_label, channel_kind, sort_order) AS (
    VALUES
      ('paid_meta_ads',     'Meta Ads (paid)',     'paid',    1),
      ('organic_facebook',  'Facebook (organic)',  'organic', 2),
      ('organic_instagram', 'Instagram (organic)', 'organic', 3),
      ('organic_google',    'Google (organic)',    'organic', 4),
      ('tracked_flyer',     'Flyer / Print',       'owned',   5),
      ('tracked_email',     'Email',               'owned',   6),
      ('direct',            'Direct (untagged)',   'direct',  7),
      ('other',             'Other',               'other',   8)
  ),
  combined AS (
    SELECT
      c.channel_key,
      c.channel_label,
      c.channel_kind,
      c.sort_order,
      COALESCE(
        CASE WHEN c.channel_key = 'paid_meta_ads' THEN (SELECT clicks FROM paid_meta)
             ELSE (SELECT tc.clicks FROM tracked_clicks tc WHERE tc.channel_key = c.channel_key)
        END, 0)::int                                                AS clicks,
      COALESCE(s.leads, 0)::int                                    AS leads,
      COALESCE(s.paid, 0)::int                                     AS paid,
      CASE WHEN c.channel_key = 'paid_meta_ads'
           THEN COALESCE((SELECT spend_usd FROM paid_meta), 0)
           ELSE 0
      END                                                          AS spend_usd
    FROM catalog c
    LEFT JOIN signups s ON s.channel_key = c.channel_key
  )
  SELECT
    combined.channel_key,
    combined.channel_label,
    combined.channel_kind,
    combined.clicks,
    combined.leads,
    combined.paid,
    combined.spend_usd,
    CASE WHEN combined.paid > 0 AND combined.spend_usd > 0
         THEN ROUND(combined.spend_usd / combined.paid, 2)
         ELSE NULL
    END                                                             AS cac_usd,
    CASE WHEN combined.clicks > 0
         THEN ROUND(100.0 * combined.paid / combined.clicks, 2)
         ELSE NULL
    END                                                             AS click_to_paid_pct,
    CASE WHEN (SELECT SUM(c2.paid) FROM combined c2) > 0
         THEN ROUND(100.0 * combined.paid / (SELECT SUM(c2.paid) FROM combined c2), 1)
         ELSE 0
    END                                                             AS share_of_paid_pct
  FROM combined
  WHERE combined.clicks > 0 OR combined.leads > 0 OR combined.paid > 0 OR combined.spend_usd > 0
  ORDER BY combined.paid DESC, combined.sort_order;
END;
$$;

REVOKE ALL ON FUNCTION public.get_unified_attribution(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unified_attribution(text, date) TO authenticated;

-- ── The 49 Meta instant-form leads imported 2026-10-07 ─────────────────────
-- They came from a Meta lead form, never touched the website, so they have
-- no utm_source and no fbc - they were filing as Direct too. Tag them so the
-- lead-form channel is visible as paid Meta rather than untagged traffic.
UPDATE public.trial_signups
   SET utm_source = 'ads',
       utm_medium = 'cpc',
       utm_campaign = COALESCE(utm_campaign, 'meta_lead_form')
 WHERE source_category = 'meta_lead'
   AND deleted_at IS NULL
   AND (utm_source IS NULL OR utm_source = '');

-- ── Verify: paid_meta_ads should now show real leads and paid, and Direct
-- should drop by the same amount. Run per studio too.
SELECT * FROM public.get_unified_attribution(NULL, (now() - interval '30 days')::date);
