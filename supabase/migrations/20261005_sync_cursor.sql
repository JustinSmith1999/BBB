-- 20261005_sync_cursor.sql
-- ===========================================================================
-- A tiny key/value cursor table so a long sync can resume where it stopped
-- instead of restarting from the beginning on every invocation.
--
-- Added for mariana-tek-clients-sync, which has to walk 162 pages of MT users
-- and cannot finish inside one edge-function invocation. Generic on purpose —
-- any other paged sync can use it with its own key.
--
-- Service-role only. No RLS policies are added, so with RLS enabled the anon
-- and authenticated roles get nothing, which is what we want: this is
-- machinery, never customer-facing.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.sync_cursor (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sync_cursor ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.sync_cursor IS
  'Resume points for paged background syncs. Service-role only; one row per sync key.';

NOTIFY pgrst, 'reload schema';
