-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-expire stale trials.
--
-- Problem: /homebase Board carry-over keeps stale leads visible forever. A
-- trial paid 21 days ago, still flagged 'new_lead' because nobody acted on
-- it, was still appearing on every studio's Board indefinitely. Cluttered
-- the active board and made the History view useless (those stale leads
-- never reached it).
--
-- Fix: nightly RPC moves any trial to 'lost' if ALL of:
--   - payment_date is older than 14 days (the trial window is over)
--   - converted_to_member is FALSE (they didn't upgrade — that's a 'member' move)
--   - current front_desk_stage is still in {new_lead, contacted, booked, attended}
--   - row isn't soft-deleted
--
-- "Lost" is the right bucket per Justin 2026-06-08: trial is over and they
-- didn't convert, so by definition they're a lost opportunity from the
-- front-desk-pipeline perspective. The card still surfaces in History view
-- (which shows all stages grouped by month) so staff can revisit if needed.
--
-- Manual override: if staff drags a card BACK to a funnel stage after expiry,
-- the change sticks until the NEXT nightly cron run (which will re-expire it
-- if payment_date is still > 14d). If they want to keep it active they need
-- to use a non-funnel stage like 'member' — the natural outcome anyway.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.expire_stale_trials()
RETURNS TABLE(
  studio_slug    TEXT,
  expired_count  INT,
  cutoff         TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := (now() AT TIME ZONE 'America/New_York' - INTERVAL '14 days') AT TIME ZONE 'America/New_York';
BEGIN
  -- Single UPDATE with RETURNING so we can roll up the count per studio for
  -- visibility into how many cards actually moved each night.
  RETURN QUERY
  WITH expired AS (
    UPDATE public.trial_signups t
       SET front_desk_stage = 'lost'
      WHERE t.payment_date IS NOT NULL
        AND t.payment_date < v_cutoff
        AND t.front_desk_stage IN ('new_lead','contacted','booked','attended','paid_trial','spoken_to')
        AND COALESCE(t.converted_to_member, FALSE) = FALSE
        AND t.deleted_at IS NULL
    RETURNING t.id, t.location_id
  ),
  with_studio AS (
    SELECT lower(replace(l.name, ' ', '-')) AS studio_slug
    FROM expired e
    LEFT JOIN public.locations l ON l.id = e.location_id
  )
  SELECT
    COALESCE(ws.studio_slug, 'unknown') AS studio_slug,
    COUNT(*)::INT                       AS expired_count,
    v_cutoff                            AS cutoff
  FROM with_studio ws
  GROUP BY 1
  ORDER BY 2 DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.expire_stale_trials() TO authenticated, anon, service_role;

-- ─── Schedule nightly via pg_cron ───────────────────────────────────────────
-- 06:00 ET every day = 10:00 UTC (winter) / 11:00 UTC (summer). Use 10:00 UTC
-- which is 06:00 ET in summer / 05:00 in winter — close enough. Front-desk
-- staff start their day around 6-7am, so by the time they open the board the
-- stale leads are already in 'lost'.
DO $$
BEGIN
  -- Drop any previous schedule with this name so re-running this migration
  -- doesn't double-register the cron.
  PERFORM cron.unschedule('expire-stale-trials-nightly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-stale-trials-nightly');
EXCEPTION WHEN OTHERS THEN NULL;
END$$;

SELECT cron.schedule(
  'expire-stale-trials-nightly',
  '0 10 * * *',  -- 10:00 UTC daily ≈ 06:00 ET
  $$SELECT public.expire_stale_trials();$$
);

-- ─── One-time backfill — clean up the current pile of stale leads ───────────
-- Surface the impact in the migration output so we can see how many cards
-- this cleans up RIGHT NOW (before the first scheduled run tomorrow).
SELECT * FROM public.expire_stale_trials();
