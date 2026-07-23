-- ─────────────────────────────────────────────────────────────────────────────
-- Add per-location GBP refresh token so each studio uses the right Google
-- account. Carlos owns Bayside + Fresh Meadows, Steve/Chris own Williamsburg
-- + Astoria — they're on different Google accounts so they need separate
-- OAuth refresh tokens.
--
-- gbp-sync will read locations.gbp_refresh_token per studio; if NULL on a
-- location it falls back to the GBP_REFRESH_TOKEN env var (so the existing
-- token Justin just generated still works for the rows where it's not
-- overridden).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS gbp_refresh_token text;

COMMENT ON COLUMN public.locations.gbp_refresh_token IS
  'OAuth refresh token specific to the Google account that owns this studio''s GBP. Carlos''s account for Bayside/Fresh Meadows, Steve/Chris''s for Williamsburg/Astoria. If NULL, gbp-sync falls back to the GBP_REFRESH_TOKEN env var.';
