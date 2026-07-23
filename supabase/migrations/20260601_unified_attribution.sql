-- ─────────────────────────────────────────────────────────────────────────────
-- Unified attribution RPC — one table, every channel, full economics.
--
-- THE QUESTION THIS ANSWERS:
--   "Of every dollar I spent (or didn't), where are paid trials actually
--    coming from? Which channel has the best CAC? Where is the leverage?"
--
-- INPUTS (three tables joined by the channel a customer arrived through):
--   meta_insights_daily   — paid Meta ad clicks + spend per studio
--   link_clicks           — organic tracked shortlinks (/ig, /flyer, /email, /gbp)
--   trial_signups         — actual conversions (leads + paid) by utm_source
--
-- OUTPUT (one row per channel):
--   channel_key, channel_label, channel_kind, clicks, leads, paid, spend,
--   cac, click_to_paid_pct, share_of_paid_pct
--
-- CHANNEL CLASSIFICATION:
--   paid_meta_ads     — utm_source='ads' OR ('facebook'/'instagram' WITH utm_medium='cpc')
--   organic_facebook  — utm_source='facebook' AND utm_medium != 'cpc'
--   organic_instagram — utm_source='instagram' AND utm_medium = 'social' (covers /ig/ shortlinks)
--   tracked_flyer     — utm_source='flyer'
--   tracked_email     — utm_source='email'
--   organic_google    — utm_source='google'
--   direct            — utm_source IS NULL or empty
--   other             — anything else (rare)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_unified_attribution(text, date);

CREATE OR REPLACE FUNCTION public.get_unified_attribution(
  p_studio text DEFAULT NULL,
  p_since  date DEFAULT '2026-05-15'::date
)
RETURNS TABLE (
  channel_key         text,
  channel_label       text,
  channel_kind        text,   -- 'paid' | 'organic' | 'owned' | 'direct' | 'other'
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
DECLARE
  v_total_paid int;
BEGIN
  -- ── Helper: normalize trial_signups row to a channel_key ────────────────
  -- Each utm_source / utm_medium combination collapses to one of the
  -- buckets above. This logic mirrors the dashboard's normalizeSource()
  -- function so the JS UI and SQL agree.
  --
  -- #variable_conflict use_column above: the RETURNS TABLE column names
  -- (clicks, leads, paid, etc.) would otherwise shadow column references
  -- inside the CTEs and SELECT. use_column tells PL/pgSQL to always prefer
  -- the SQL column when names collide.

  RETURN QUERY
  WITH
  -- Paid Meta clicks + spend per studio in the window (best-effort — depends
  -- on meta_insights_daily having rows for the date range)
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
  -- Tracked link clicks grouped by which shortlink path they came from.
  -- link_clicks uses the standard Supabase 'created_at' column (DEFAULT NOW()
  -- on insert from the track-link edge function — no explicit timestamp is set
  -- by the function, so the DB default fills it).
  tracked_clicks AS (
    SELECT
      CASE
        WHEN c.utm_source = 'instagram' AND c.utm_medium = 'social' THEN 'organic_instagram'
        WHEN c.utm_source = 'flyer'                                 THEN 'tracked_flyer'
        WHEN c.utm_source = 'email'                                 THEN 'tracked_email'
        WHEN c.utm_source = 'google'                                THEN 'organic_google'
        ELSE 'other'
      END                                              AS channel_key,
      COUNT(*)::int                                    AS clicks
    FROM public.link_clicks c
    WHERE c.created_at >= p_since
      AND (p_studio IS NULL OR c.studio = p_studio)
    GROUP BY 1
  ),
  -- Trial signups (leads + paid) classified by utm_source / utm_medium
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
  -- Full channel catalog — every row even if some columns are zero.
  -- Drives the row order in the output.
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
  -- Compute total paid (excluding 'other' for the share-of-paid % so the
  -- legitimate channels sum cleanly to ~100%).
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

-- ── Initial check — should return real numbers per studio ──────────────────
SELECT 'fresh-meadows' AS studio_under_test, * FROM public.get_unified_attribution('fresh-meadows');
