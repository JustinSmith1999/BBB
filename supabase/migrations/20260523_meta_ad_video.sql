-- ─────────────────────────────────────────────────────────────────────────────
-- Add video playback to the Meta creatives feature.
-- Run in the Supabase SQL editor, AFTER 20260523_add_meta_ad_creatives.sql.
-- Idempotent.
--
-- Adds media_type ('image' | 'video') and video_url (a playable MP4 source)
-- to meta_ads, and rebuilds get_meta_ad_creatives() to return them so the
-- dashboard can render a real <video> player for video ads.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.meta_ads ADD COLUMN IF NOT EXISTS media_type text DEFAULT 'image';
ALTER TABLE public.meta_ads ADD COLUMN IF NOT EXISTS video_url  text;

-- Return type changes, so the function must be dropped + recreated.
DROP FUNCTION IF EXISTS public.get_meta_ad_creatives(text);

CREATE FUNCTION public.get_meta_ad_creatives(p_window text DEFAULT 'last_30'::text)
RETURNS TABLE(
  ad_id text, studio_slug text, studio_name text, ad_name text,
  campaign_name text, status text, image_url text, thumbnail_url text,
  headline text, body text, media_type text, video_url text,
  spend_cents bigint, impressions bigint, clicks bigint, reach bigint,
  leads bigint, purchases bigint, ctr numeric, cpm_cents bigint,
  last_synced timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed text[];
BEGIN
  BEGIN
    v_allowed := public.dashboard_allowed_studios();
  EXCEPTION WHEN undefined_function THEN
    v_allowed := ARRAY['astoria','williamsburg','bayside','fresh-meadows'];
  END;

  RETURN QUERY
  WITH bounds AS (
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
    COALESCE(a.media_type, 'image'),
    a.video_url,
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
  JOIN agg            ON agg.ad_id = a.ad_id
  WHERE a.studio_slug = ANY(v_allowed)
    AND agg.impressions > 0
  ORDER BY a.studio_slug, agg.spend_cents DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_meta_ad_creatives(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_meta_ad_creatives(text) TO authenticated;

-- Sanity check — media_type should read 'video' for any video ads.
SELECT studio_slug, ad_name, media_type,
       (video_url IS NOT NULL) AS has_video_url, spend_cents
FROM public.get_meta_ad_creatives('last_30')
ORDER BY media_type DESC, studio_slug;
