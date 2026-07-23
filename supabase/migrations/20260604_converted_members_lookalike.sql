-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: get_converted_members_for_lookalike
--
-- Exports the converted-members roster as a Meta-compatible Customer List for
-- building a Lookalike Audience. Returns SHA-256-hashed email/phone/first/last
-- in the exact columns Meta Custom Audiences accepts:
--   EMAIL, PHONE, FN (first), LN (last), COUNTRY, ZIP
--
-- Why hashed: Meta requires SHA-256 of trimmed/lowercased email + lowercased
-- name fields. Phone is digits-only with country code (no +). This RPC does
-- the hashing server-side so Justin can copy-paste straight into Meta without
-- a separate hashing step.
--
-- 8 members today. Meta Lookalikes start working at 100+ source rows; below
-- that the algorithm leans heavily on the demographic/geo overlap rather
-- than the actual customer list. Still worth uploading now — Meta will
-- backfill more matches as members convert over time.
-- ─────────────────────────────────────────────────────────────────────────────

-- pgcrypto provides digest() — lives in the `extensions` schema on Supabase.
-- We extend the function's search_path to include it so digest() resolves.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DROP FUNCTION IF EXISTS public.get_converted_members_for_lookalike();

CREATE OR REPLACE FUNCTION public.get_converted_members_for_lookalike()
RETURNS TABLE (
  email_sha256 text,
  phone_sha256 text,
  fn_sha256    text,
  ln_sha256    text,
  country      text,
  studio_slug  text,
  customer_name text  -- plaintext for sanity-check; strip before uploading
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_catalog
AS $$
  WITH members AS (
    SELECT
      m.studio_slug,
      m.customer_name,
      m.stripe_email,
      m.mindbody_id,
      m.mb_email
    FROM public.get_converted_members() m
  ),
  enriched AS (
    SELECT
      mb.studio_slug,
      mb.customer_name,
      -- Prefer the email that's actually on the MB account if different
      lower(trim(COALESCE(NULLIF(mb.mb_email, ''), mb.stripe_email))) AS email_clean,
      -- Lift phone from trial_signups (Stripe doesn't store phone)
      regexp_replace(t.phone, '\D', '', 'g') AS phone_digits,
      lower(trim(NULLIF(split_part(mb.customer_name, ' ', 1), ''))) AS fn_clean,
      lower(trim(NULLIF(split_part(mb.customer_name, ' ', -1), ''))) AS ln_clean
    FROM members mb
    LEFT JOIN public.trial_signups t
      ON lower(t.email) = lower(COALESCE(NULLIF(mb.mb_email, ''), mb.stripe_email))
     AND t.deleted_at IS NULL
  )
  SELECT
    encode(extensions.digest(email_clean, 'sha256'), 'hex')                    AS email_sha256,
    CASE WHEN length(phone_digits) >= 10
         THEN encode(extensions.digest('1' || right(phone_digits, 10), 'sha256'), 'hex')
         ELSE NULL END                                                          AS phone_sha256,
    encode(extensions.digest(fn_clean, 'sha256'), 'hex')                       AS fn_sha256,
    encode(extensions.digest(ln_clean, 'sha256'), 'hex')                       AS ln_sha256,
    'us'                                                                        AS country,
    studio_slug,
    customer_name
  FROM enriched
  WHERE email_clean IS NOT NULL AND email_clean <> '';
$$;

GRANT EXECUTE ON FUNCTION public.get_converted_members_for_lookalike() TO authenticated;

-- Sanity probe — should return 8 rows with non-null hashes.
SELECT customer_name, studio_slug,
       LEFT(email_sha256, 12) || '…' AS email_hash_preview,
       phone_sha256 IS NOT NULL AS has_phone
FROM public.get_converted_members_for_lookalike();
