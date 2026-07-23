-- ─────────────────────────────────────────────────────────────────────────────
-- Per-studio owner notification phones — texted on every new paid trial.
-- One row per (location, owner). Multiple owners per location are allowed
-- and each gets their own SMS. Toggle off with `notify_signups = false`.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.location_owners (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  owner_name      text NOT NULL,
  phone           text NOT NULL,                -- E.164, e.g. +15169985020
  notify_signups  boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  UNIQUE (location_id, phone)
);

CREATE INDEX IF NOT EXISTS location_owners_loc_idx
  ON public.location_owners (location_id) WHERE notify_signups = true;

ALTER TABLE public.location_owners ENABLE ROW LEVEL SECURITY;

-- The stripe-webhook reads with service-role; no client-side reads needed
-- (yet). RLS-enabled-with-no-policy = deny direct anon/auth reads, which is
-- what we want — these are internal phone numbers.

-- ── Seed owner phones ──────────────────────────────────────────────────────
-- Idempotent: re-running won't double-insert thanks to UNIQUE(location_id, phone).
WITH locs AS (
  SELECT id, lower(replace(name, ' ', '-')) AS slug FROM public.locations
)
INSERT INTO public.location_owners (location_id, owner_name, phone) VALUES
  -- Bayside + Fresh Meadows → Carlos
  ((SELECT id FROM locs WHERE slug = 'bayside'),       'Carlos', '+15169985020'),
  ((SELECT id FROM locs WHERE slug = 'fresh-meadows'), 'Carlos', '+15169985020'),
  -- Astoria + Williamsburg → Chris AND Steve (both get a copy)
  ((SELECT id FROM locs WHERE slug = 'astoria'),       'Chris',  '+19172075092'),
  ((SELECT id FROM locs WHERE slug = 'astoria'),       'Steve',  '+19172940761'),
  ((SELECT id FROM locs WHERE slug = 'williamsburg'),  'Chris',  '+19172075092'),
  ((SELECT id FROM locs WHERE slug = 'williamsburg'),  'Steve',  '+19172940761')
ON CONFLICT (location_id, phone) DO UPDATE
  SET owner_name = EXCLUDED.owner_name,
      notify_signups = true;

-- Sanity check after running:
-- SELECT lo.owner_name, lo.phone, l.name AS studio, lo.notify_signups
-- FROM public.location_owners lo
-- JOIN public.locations l ON l.id = lo.location_id
-- ORDER BY l.name, lo.owner_name;
