-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 NIGHT · Extend location_owners so we can route inbound SMS
-- replies to the right human(s) per studio. Schema currently only has
-- id/location_id/phone/created_at — no name, no role, no enable flag.
--
-- New columns:
--   name              — display name in the forwarded alert ("Carlos", "Steve")
--   role              — 'owner' | 'front_desk' (lets us trim notifications later)
--   notify_on_inbound — gate: only forward to phones with this = true
--
-- Used by twilio-inbound-sms — on every customer reply, look up all rows
-- with notify_on_inbound=true for that studio's location_id, send each one
-- a forward SMS, log each to sms_messages.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.location_owners
  ADD COLUMN IF NOT EXISTS name              TEXT,
  ADD COLUMN IF NOT EXISTS role              TEXT NOT NULL DEFAULT 'owner'
    CHECK (role IN ('owner', 'front_desk', 'manager')),
  ADD COLUMN IF NOT EXISTS notify_on_inbound BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_location_owners_notify
  ON public.location_owners (location_id)
  WHERE notify_on_inbound = true;

COMMENT ON COLUMN public.location_owners.notify_on_inbound IS
  'When true, this phone gets an SMS forward whenever a customer replies to a BBB text for this studio. Wired by supabase/functions/twilio-inbound-sms.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Phone numbers to populate — PASTE Justin's owner + front-desk cells below
-- and run this block. ON CONFLICT lets the script run twice safely.
-- ─────────────────────────────────────────────────────────────────────────────

-- Sanity unique constraint so re-running doesn't duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_location_owners_loc_phone
  ON public.location_owners (location_id, phone);

-- ── Bayside ─────────────────────────────────────────────────────────────────
INSERT INTO public.location_owners (location_id, owner_name, name, role, phone, notify_on_inbound)
VALUES
  ('5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7', 'Carlos', 'Carlos', 'owner', '+15169985020', true)
ON CONFLICT (location_id, phone) DO UPDATE
  SET owner_name = EXCLUDED.owner_name, name = EXCLUDED.name, role = EXCLUDED.role, notify_on_inbound = EXCLUDED.notify_on_inbound;

-- ── Fresh Meadows ───────────────────────────────────────────────────────────
INSERT INTO public.location_owners (location_id, owner_name, name, role, phone, notify_on_inbound)
VALUES
  ('6bbbe077-bcc6-4d9d-a10b-7605c1484752', 'Carlos', 'Carlos', 'owner', '+15169985020', true)
ON CONFLICT (location_id, phone) DO UPDATE
  SET owner_name = EXCLUDED.owner_name, name = EXCLUDED.name, role = EXCLUDED.role, notify_on_inbound = EXCLUDED.notify_on_inbound;

-- ── Williamsburg ────────────────────────────────────────────────────────────
INSERT INTO public.location_owners (location_id, owner_name, name, role, phone, notify_on_inbound)
VALUES
  ('80536b45-df0e-42d1-880c-e9301372e1cf', 'Steve', 'Steve', 'owner', '+19172940761', true),
  ('80536b45-df0e-42d1-880c-e9301372e1cf', 'Chris', 'Chris', 'owner', '+19172075092', true)
ON CONFLICT (location_id, phone) DO UPDATE
  SET owner_name = EXCLUDED.owner_name, name = EXCLUDED.name, role = EXCLUDED.role, notify_on_inbound = EXCLUDED.notify_on_inbound;

-- ── Astoria ─────────────────────────────────────────────────────────────────
INSERT INTO public.location_owners (location_id, owner_name, name, role, phone, notify_on_inbound)
VALUES
  ('dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45', 'Steve', 'Steve', 'owner', '+19172940761', true),
  ('dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45', 'Chris', 'Chris', 'owner', '+19172075092', true)
ON CONFLICT (location_id, phone) DO UPDATE
  SET owner_name = EXCLUDED.owner_name, name = EXCLUDED.name, role = EXCLUDED.role, notify_on_inbound = EXCLUDED.notify_on_inbound;

-- After populating, verify with:
-- SELECT l.name AS studio, lo.name, lo.role, lo.phone, lo.notify_on_inbound
-- FROM public.location_owners lo
-- JOIN public.locations l ON l.id = lo.location_id
-- ORDER BY l.name, lo.role, lo.name;
