-- ─────────────────────────────────────────────────────────────────────────────
-- Supports the new mindbody-visits-sync edge function. Run in the Supabase SQL
-- editor. Idempotent.
--
-- 1. Unique indexes so the sync's upsert(onConflict=…) works whether or not
--    the existing tables already have PKs.
-- 2. A composite (client_id, starts_at) index that speeds up every visit-count
--    lookup `get_trial_journey` does per paid trial.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS mindbody_visits_visit_id_uidx
  ON public.mindbody_visits (mindbody_visit_id);

CREATE UNIQUE INDEX IF NOT EXISTS mindbody_clients_mindbody_id_uidx
  ON public.mindbody_clients (mindbody_id);

CREATE INDEX IF NOT EXISTS mindbody_visits_client_starts_idx
  ON public.mindbody_visits (mindbody_client_id, starts_at DESC);

-- Sanity check — after the first sync run, fresh visit rows should show up here.
-- SELECT studio_slug, max(starts_at), count(*) FROM public.mindbody_visits
-- WHERE starts_at >= '2026-05-16' GROUP BY studio_slug;
