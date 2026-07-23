-- 20260722_lock_locations_secret_columns.sql  (v2)
--
-- SECURITY FIX: anon could read the live Stripe secret keys from public.locations.
-- v1 revoked SELECT from anon/authenticated only, but the read access was also
-- coming through a grant to PUBLIC (and/or an inherited role), so it kept
-- leaking. This version revokes every table-wide SELECT path, then grants back
-- SELECT on only the non-secret columns. service_role is left untouched, so the
-- edge functions that need the real keys keep working.
--
-- Run in the Supabase SQL editor. Safe to re-run. Includes an inline check.

BEGIN;

-- 1. Remove ALL table-wide SELECT paths for the public API roles.
REVOKE SELECT ON public.locations FROM PUBLIC;
REVOKE SELECT ON public.locations FROM anon;
REVOKE SELECT ON public.locations FROM authenticated;

-- 2. Grant back SELECT on only the non-secret columns (derived from the live
--    schema so it can't reference a column that doesn't exist).
DO $$
DECLARE
  safe_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ')
    INTO safe_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'locations'
    AND column_name NOT IN (
      'stripe_secret_key','stripe_webhook_secret','mindbody_api_key',
      'gohighlevel_api_key','gohighlevel_webhook_url','gbp_account_id',
      'gbp_refresh_token','mariana_tek_api_key','mindbody_site_id',
      'mindbody_location_id'
    );
  EXECUTE format('GRANT SELECT (%s) ON public.locations TO anon, authenticated', safe_cols);
END $$;

COMMIT;

-- ─── INLINE VERIFICATION ────────────────────────────────────────────────────
-- Run these after the COMMIT. Expected results noted.

-- Should ERROR: "permission denied for column stripe_secret_key"  ✅ locked
SET ROLE anon;
SELECT stripe_secret_key FROM public.locations LIMIT 1;
RESET ROLE;

-- Should SUCCEED and return a row (site still works)
SET ROLE anon;
SELECT id, name, stripe_publishable_key FROM public.locations LIMIT 1;
RESET ROLE;
