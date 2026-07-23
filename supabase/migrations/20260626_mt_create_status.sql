-- 2026-06-26 · MT auto-signup observability + per-row outcome
--
-- WHY: stripe-webhook now persists the result of every
-- mariana-tek-create-trial-client (or mindbody-create-trial-client) call so
-- we can surface failures on /ops and let paid-trials-realtime-monitor retry
-- silently failed rows. Before this migration the outcome was console.log
-- only — meaning every $49 paid customer whose MT/MB account creation
-- silently failed disappeared into the void.
--
-- Columns:
--   mt_create_status        – 'created' | 'skipped' | 'failed' | 'http_error' |
--                              'exception' | 'unknown' | NULL (never attempted)
--   mt_create_attempted_at  – when stripe-webhook last fired the create call
--   mt_create_response      – full JSON body from the create function (debug)
--   mt_create_function      – which fn we called ('mariana-tek-create-trial-client'
--                              or 'mindbody-create-trial-client'), for postmortem
--
-- All nullable / defaultable so existing rows are untouched.

ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS mt_create_status       text,
  ADD COLUMN IF NOT EXISTS mt_create_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS mt_create_response     jsonb,
  ADD COLUMN IF NOT EXISTS mt_create_function     text;

-- Drop + recreate the partial index so re-running the migration is safe.
DROP INDEX IF EXISTS trial_signups_mt_create_failed_idx;
CREATE INDEX trial_signups_mt_create_failed_idx
  ON public.trial_signups (mt_create_attempted_at DESC)
  WHERE mt_create_status IN ('failed', 'http_error', 'exception');

COMMENT ON COLUMN public.trial_signups.mt_create_status IS
  'Outcome of the post-payment create-trial-client call. created / skipped / failed / http_error / exception / unknown. NULL = never attempted (pre-2026-06-26 row).';
COMMENT ON COLUMN public.trial_signups.mt_create_response IS
  'Full JSON body returned by mariana-tek-create-trial-client (or mindbody-create-trial-client). Used for postmortem when status != ''created''.';

-- ─── data_source flip (uncomment per-studio when ready) ────────────────────
-- After running mariana-tek-create-trial-client probe mode for a studio and
-- confirming it returns ok:true, uncomment that studio's UPDATE below and
-- re-run this migration. The change is instant — next $49 payment for that
-- studio routes to MT instead of MindBody.
--
-- DANGER: do NOT flip a studio until its mariana_tek_api_key is populated on
-- the locations row AND probe mode returns ok. Flipping prematurely means
-- every paid trial silently fails (we'll catch it in mt_create_status above,
-- but the customer experience is broken until flipped back).
--
-- Probe each studio first:
--   curl -X POST https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mariana-tek-create-trial-client \
--     -H "x-bbb-secret: bbb-test-2026-05-27" \
--     -H "Content-Type: application/json" \
--     -d '{"mode":"probe","studio_slug":"bayside"}'
--
-- Then flip:
-- UPDATE public.locations SET data_source = 'mariana_tek' WHERE lower(replace(name, ' ', '-')) = 'bayside';
-- UPDATE public.locations SET data_source = 'mariana_tek' WHERE lower(replace(name, ' ', '-')) = 'fresh-meadows';
-- UPDATE public.locations SET data_source = 'mariana_tek' WHERE lower(replace(name, ' ', '-')) = 'astoria';
-- UPDATE public.locations SET data_source = 'mariana_tek' WHERE lower(replace(name, ' ', '-')) = 'williamsburg';
