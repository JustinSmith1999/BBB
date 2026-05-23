-- ─────────────────────────────────────────────────────────────────────────────
-- Per-ad creatives + per-ad daily metrics for the owner dashboard.
-- Run in the Supabase SQL editor. Idempotent.
--
-- Adds two tables the extended `meta-insights-sync` edge function writes to:
--   • meta_ads               — one row per Meta ad: identity + creative content
--   • meta_ad_insights_daily — one row per ad per day: spend / impressions / etc.
-- …and the get_meta_ad_creatives() RPC the dashboard's new "Creatives" widget
-- reads. Every window is floored at the May 15, 2026 launch, exactly like
-- get_meta_ad_metrics, so pre-launch campaign data can never leak in.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── TABLES ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.meta_ads (
  ad_id          text PRIMARY KEY,
  studio_slug    text NOT NULL,
  ad_name        text,
  adset_name     text,
  campaign_name  text,
  status         text,                       -- ACTIVE / PAUSED / ...
  creative_id    text,
  image_url      text,                       -- full creative image (may rotate)
  thumbnail_url  text,                       -- small thumbnail
  headline       text,                       -- ad headline / title
  body           text,                       -- primary text / message
  updated_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_ads_studio_idx ON public.meta_ads (studio_slug);

CREATE TABLE IF NOT EXISTS public.meta_ad_insights_daily (
  ad_id              text NOT NULL,
  studio_slug        text NOT NULL,
  date_start         date NOT NULL,
  spend_cents        bigint  DEFAULT 0,
  impressions        bigint  DEFAULT 0,
  reach              bigint  DEFAULT 0,
  clicks             bigint  DEFAULT 0,
  inline_link_clicks bigint  DEFAULT 0,
  ctr                numeric DEFAULT 0,
  cpm_cents          bigint  DEFAULT 0,
  frequency          numeric DEFAULT 0,
  leads              bigint  DEFAULT 0,
  purchases          bigint  DEFAULT 0,
  synced_at          timestamptz DEFAULT now(),
  PRIMARY KEY (ad_id, date_start)
);
CREATE INDEX IF NOT EXISTS meta_ad_insights_date_idx   ON public.meta_ad_insights_daily (date_start);
CREATE INDEX IF NOT EXISTS meta_ad_insights_studio_idx ON public.meta_ad_insights_daily (studio_slug);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- The service-role sync writes; the dashboard reads only through the
-- SECURITY DEFINER function below. RLS enabled with no policy = deny all
-- direct access (anon + authenticated), which is what we want.
ALTER TABLE public.meta_ads               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ad_insights_daily ENABLE ROW LEVEL SECURITY;

-- ── RPC: per-ad creatives + rolled-up metrics for a window ──────────────────
CREATE OR REPLACE FUNCTION public.get_meta_ad_creatives(p_window text DEFAULT 'last_30'::text)
RETURNS TABLE(
  ad_id text, studio_slug text, studio_name text, ad_name text,
  campaign_name text, status text, image_url text, thumbnail_url text,
  headline text, body text,
  spend_cents bigint, impressions bigint, clicks bigint, reach bigint,
  leads bigint, purchases bigint, ctr numeric, cpm_cents bigint,
  last_synced timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed text[];
BEGIN
  -- Per-user studio scope, consistent with the other dashboard RPCs.
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  RETURN QUERY
  WITH bounds AS (
    -- Every window floored at the May 15, 2026 launch.
    SELECT GREATEST(
      CASE p_window
        WHEN 'today'    THEN CURRENT_DATE
        WHEN 'last_7'   THEN CURRENT_DATE - 7
        WHEN 'last_30'  THEN CURRENT_DATE - 30
        WHEN 'last_90'  THEN CURRENT_DATE - 90
        WHEN 'lifetime' THEN '2024-01-01'::date
        ELSE CURRENT_DATE - 30
      END,
      '2026-05-15'::date
    ) AS start_date
  ),
  agg AS (
    SELECT
      d.ad_id,
      SUM(d.spend_cents)::bigint AS spend_cents,
      SUM(d.impressions)::bigint AS impressions,
      SUM(d.clicks)::bigint      AS clicks,
      SUM(d.reach)::bigint       AS reach,
      SUM(d.leads)::bigint       AS leads,
      SUM(d.purchases)::bigint   AS purchases,
      MAX(d.synced_at)           AS last_synced
    FROM meta_ad_insights_daily d, bounds
    WHERE d.date_start >= bounds.start_date
    GROUP BY d.ad_id
  )
  SELECT
    a.ad_id,
    a.studio_slug,
    s.name,
    a.ad_name,
    a.campaign_name,
    a.status,
    a.image_url,
    a.thumbnail_url,
    a.headline,
    a.body,
    COALESCE(agg.spend_cents, 0),
    COALESCE(agg.impressions, 0),
    COALESCE(agg.clicks, 0),
    COALESCE(agg.reach, 0),
    COALESCE(agg.leads, 0),
    COALESCE(agg.purchases, 0),
    CASE WHEN COALESCE(agg.impressions, 0) > 0
      THEN ROUND(100.0 * agg.clicks / agg.impressions, 2) ELSE 0 END,
    CASE WHEN COALESCE(agg.impressions, 0) > 0
      THEN ROUND(agg.spend_cents::numeric / agg.impressions * 1000)::bigint ELSE 0 END,
    agg.last_synced
  FROM meta_ads a
  LEFT JOIN studios s ON s.slug = a.studio_slug
  JOIN agg            ON agg.ad_id = a.ad_id      -- only ads that delivered in-window
  WHERE a.studio_slug = ANY(v_allowed)
    AND agg.impressions > 0
  ORDER BY a.studio_slug, agg.spend_cents DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_meta_ad_creatives(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_ad_creatives(text) TO authenticated;

-- ── Sanity check ────────────────────────────────────────────────────────────
-- After the first sync runs, this should list the live ads with their spend.
SELECT studio_slug, ad_name, headline, spend_cents, impressions, ctr
FROM public.get_meta_ad_creatives('last_30')
ORDER BY studio_slug, spend_cents DESC;
