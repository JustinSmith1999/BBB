-- 20260723_mt_oauth_store.sql
-- Persistent store for the Mariana Tek OAuth tokens so the sync self-renews.
-- The refresh token rotates on every use; keeping it here (instead of a static
-- env var) means each refresh saves the new one and the sync never dies.
-- Locked to service_role only — these are live credentials.

CREATE TABLE IF NOT EXISTS public.mt_oauth (
  id            text PRIMARY KEY,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mt_oauth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mt_oauth FROM PUBLIC, anon, authenticated;
-- No policy for public roles -> anon/authenticated read zero rows.
-- service_role (edge functions) bypasses RLS.
