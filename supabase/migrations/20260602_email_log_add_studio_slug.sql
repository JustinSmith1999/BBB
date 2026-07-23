-- ─────────────────────────────────────────────────────────────────────────────
-- email_log.studio_slug column — silently missing since launch.
--
-- stripe-webhook line ~461 has been inserting { studio_slug: studioSlug, ... }
-- as a top-level field for every studio-inbox email. The column never existed,
-- so PostgREST has been silently dropping that field on every insert. Effect:
-- every email_log row carries a NULL studio (only the to_addrs hint at it).
--
-- Funnel Health customer RPC uses studio_slug for the studio chip on every
-- recipient row. Adding the column lets historical + future rows carry studio
-- attribution.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.email_log
  ADD COLUMN IF NOT EXISTS studio_slug TEXT;

CREATE INDEX IF NOT EXISTS email_log_studio_slug_idx
  ON public.email_log(studio_slug)
  WHERE studio_slug IS NOT NULL;

-- Backfill studio_slug from the raw JSON blob where stripe-webhook tucked it.
UPDATE public.email_log
   SET studio_slug = (raw ->> 'studio_slug')
 WHERE studio_slug IS NULL
   AND raw ? 'studio_slug';

-- Backfill from trial_signups → locations for rows that have trial_signup_id.
UPDATE public.email_log e
   SET studio_slug = lower(replace(l.name, ' ', '-'))
  FROM public.trial_signups t
  LEFT JOIN public.locations l ON l.id = t.location_id
 WHERE e.studio_slug IS NULL
   AND e.trial_signup_id IS NOT NULL
   AND t.id = e.trial_signup_id
   AND l.name IS NOT NULL;

-- Backfill by matching to_addrs against trial_signups.email (best-effort).
UPDATE public.email_log e
   SET studio_slug = lower(replace(l.name, ' ', '-'))
  FROM public.trial_signups t
  LEFT JOIN public.locations l ON l.id = t.location_id
 WHERE e.studio_slug IS NULL
   AND e.to_addrs IS NOT NULL
   AND l.name IS NOT NULL
   AND lower(trim(t.email)) = ANY(
     ARRAY(SELECT lower(trim(addr)) FROM unnest(e.to_addrs) AS addr)
   );

-- Sanity: how many rows still NULL studio after backfill, and breakdown.
SELECT
  studio_slug,
  COUNT(*) AS row_count
FROM public.email_log
GROUP BY studio_slug
ORDER BY row_count DESC;
