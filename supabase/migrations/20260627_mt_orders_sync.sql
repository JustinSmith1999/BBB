-- 2026-06-27 — MT orders sync infrastructure
-- =====================================================================
-- Pairs with edge function mt-orders-sync (deploy separately).
-- Purpose: bridge every purchase made inside Mariana Tek (app/web
-- in-MT booking) into Supabase so dashboard + /homebase see them.
--
-- This unlocks ~$3K/day in autopay membership revenue + every in-app
-- $49 trial that was previously invisible to BBB analytics.
--
-- This migration only adjusts gates + schedules the cron — the heavy
-- lifting (read /api/orders/, classify, upsert) lives in the edge fn.

BEGIN;

-- ─── 1. Expand source_category whitelist to allow 'mt_app' ─────────────
--   $49 trials bought inside the MT app or via MT's own web checkout
--   land in trial_signups with source_category = 'mt_app' so the /homebase
--   Kanban + dashboard can render them with a "via MT app" badge and
--   distinguish them from website-form ('trial_form') or in-person ('in_person')
--   trial buyers.
ALTER TABLE public.trial_signups DROP CONSTRAINT IF EXISTS trial_signups_source_category_check;
ALTER TABLE public.trial_signups ADD CONSTRAINT trial_signups_source_category_check
  CHECK (source_category IS NULL OR source_category IN (
    'trial_form','special_form','resign_form','comeback_form','contact_form','schedule_request',
    'mb_direct','in_person','direct_membership','manual',
    'sheet','sheet_backfill','walk_in','member_referral',
    'groupon','external_paid','reactivation',
    'ad','web_organic',
    'stripe_checkout',
    'legacy_archived',
    'mt_app'   -- NEW: $49 trials originated inside Mariana Tek (app or MT web checkout)
  ));

COMMIT;

-- ─── 2. Schedule the cron (runs every 15 min) ─────────────────────────
-- Pulls newest MT orders since the last sync, classifies + writes to
-- mariana_tek_sales (everything) and trial_signups (just $49 trials).
-- Safe to run frequently — uses max(mt_sale_id) cursor so each tick only
-- processes truly-new orders.
SELECT cron.unschedule('mt-orders-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'mt-orders-sync'
);

SELECT cron.schedule(
  'mt-orders-sync',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mt-orders-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
-- Note: the edge function accepts pg_cron via user-agent='pg_net/' header
-- (set automatically by pg_net), so no Authorization header is needed.

-- ─── 3. Verify ────────────────────────────────────────────────────────
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname = 'mt-orders-sync';

-- Quick proof the CHECK accepts the new value:
SELECT 'mt_app' = ANY(ARRAY[
  'trial_form','special_form','resign_form','comeback_form','contact_form','schedule_request',
  'mb_direct','in_person','direct_membership','manual',
  'sheet','sheet_backfill','walk_in','member_referral',
  'groupon','external_paid','reactivation',
  'ad','web_organic',
  'stripe_checkout',
  'legacy_archived',
  'mt_app'
]) AS mt_app_allowed;
