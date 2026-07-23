-- 20260605_gbp_review_clicks.sql
--
-- Tracks every scan/click of the /review/<studio> flyer redirect on
-- betterbodybootcamp.com. The Netlify edge function `review-redirect.ts`
-- inserts a row here for every QR scan, then 302s the customer on to the
-- per-studio g.page review URL.
--
-- Why a separate table from link_clicks:
--   link_clicks is keyed by Supabase track-link function's link-id format
--   (l=gbp-bayside, l=ig-astoria, etc.) and joins to trial_signups via UTM.
--   Review scans never become trial_signups — they become Google reviews —
--   so they don't fit that schema's attribution joins. Keeping them in a
--   dedicated table also makes the dashboard query simpler.
--
-- Schema decisions:
--   - INSERTs are public via the anon role because the edge function only
--     has the anon key. The RLS policy below restricts what can be read
--     back (authenticated only) so anon can write but can't snoop.
--   - We store client_ip + client_user_agent as plain text. This is for
--     anti-spam / dedupe (the same phone hitting reload 50 times shouldn't
--     pollute the count) and isn't shown on the dashboard.
--   - studio_slug is text (not a FK) because the edge function doesn't
--     have a Supabase client; it just POSTs JSON. The slug is validated
--     against the REVIEW_URLS map in the edge function before insert.

CREATE TABLE IF NOT EXISTS public.gbp_review_clicks (
  id                bigserial PRIMARY KEY,
  studio_slug       text NOT NULL,
  client_ip         text,
  client_user_agent text,
  referrer          text,
  -- 'flyer' (the printed QR), 'email', 'sms' — set via ?src=… query param
  -- on the URL printed in the channel. Defaults to 'flyer' since that's
  -- the primary use case.
  source            text NOT NULL DEFAULT 'flyer',
  clicked_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gbp_review_clicks_studio_clicked_idx
  ON public.gbp_review_clicks (studio_slug, clicked_at DESC);

ALTER TABLE public.gbp_review_clicks ENABLE ROW LEVEL SECURITY;

-- INSERT-only for anon. The edge function only sends POSTs, never reads.
DROP POLICY IF EXISTS gbp_review_clicks_anon_insert ON public.gbp_review_clicks;
CREATE POLICY gbp_review_clicks_anon_insert ON public.gbp_review_clicks
  FOR INSERT TO anon WITH CHECK (true);

-- Read access for the owner dashboard. Authenticated role only.
DROP POLICY IF EXISTS gbp_review_clicks_auth_read ON public.gbp_review_clicks;
CREATE POLICY gbp_review_clicks_auth_read ON public.gbp_review_clicks
  FOR SELECT TO authenticated USING (true);

-- ─── Dashboard RPC ────────────────────────────────────────────────────
-- Returns per-studio totals + time-bucketed counts so the dashboard card
-- can show "234 scans this week (vs 198 last week)" without firing a
-- bunch of small queries. Filter to studios that have any clicks so the
-- card hides studios that haven't started using the flyer yet.

CREATE OR REPLACE FUNCTION public.get_gbp_review_clicks_summary()
RETURNS TABLE (
  studio_slug      text,
  total_clicks     bigint,
  clicks_today     bigint,
  clicks_this_week bigint,
  clicks_last_week bigint,
  clicks_last_30d  bigint,
  last_clicked_at  timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      (date_trunc('day',  now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York') AS today_start,
      (date_trunc('week', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York') AS week_start,
      (date_trunc('week', now() AT TIME ZONE 'America/New_York') - INTERVAL '1 week') AT TIME ZONE 'America/New_York' AS last_week_start,
      (date_trunc('week', now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York' AS last_week_end,
      (now() - INTERVAL '30 days') AS thirty_days_ago
  )
  SELECT
    c.studio_slug,
    COUNT(*)::bigint                                                                         AS total_clicks,
    COUNT(*) FILTER (WHERE c.clicked_at >= b.today_start)::bigint                            AS clicks_today,
    COUNT(*) FILTER (WHERE c.clicked_at >= b.week_start)::bigint                             AS clicks_this_week,
    COUNT(*) FILTER (WHERE c.clicked_at >= b.last_week_start AND c.clicked_at < b.last_week_end)::bigint AS clicks_last_week,
    COUNT(*) FILTER (WHERE c.clicked_at >= b.thirty_days_ago)::bigint                        AS clicks_last_30d,
    MAX(c.clicked_at)                                                                        AS last_clicked_at
  FROM public.gbp_review_clicks c
  CROSS JOIN bounds b
  GROUP BY c.studio_slug
  ORDER BY total_clicks DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_gbp_review_clicks_summary() TO authenticated;

-- Sanity probe — should return zero rows immediately after this runs.
SELECT * FROM public.get_gbp_review_clicks_summary();
