-- Add stripe_special_price_id to locations for the $129 / 30-day "comeback"
-- offer on /special/[slug]. Each gym LLC's Stripe account holds its own
-- Price object — paste the price_… id into the matching row below.
--
-- Run from Supabase SQL editor.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'stripe_special_price_id'
  ) THEN
    ALTER TABLE locations ADD COLUMN stripe_special_price_id text;
  END IF;
END $$;

COMMENT ON COLUMN locations.stripe_special_price_id IS
  '$129 comeback-offer Stripe Price ID (separate from the $49 trial price). Used by create-trial-checkout when priceVariant=special.';

-- Bayside BB LLC — Stripe account ends sk_live_…HR9Y
UPDATE locations
SET stripe_special_price_id = 'price_1TYOZqCq9Nh4WwhSeAM9H58u'
WHERE lower(replace(name, ' ', '-')) = 'bayside';

-- Fresh Meadows BB LLC — Stripe account ends sk_live_…lIen
UPDATE locations
SET stripe_special_price_id = 'price_1TYOPMI3UZVjGNrB8XRW1ICc'
WHERE lower(replace(name, ' ', '-')) = 'fresh-meadows';

-- Astoria LLC — Stripe account ends with BWwuqvKmt1
UPDATE locations
SET stripe_special_price_id = 'price_1TYOppBWwuqvKmt12sgVS0MY'
WHERE lower(replace(name, ' ', '-')) = 'astoria';

-- Williamsburg LLC — Stripe account ends with LjlX8j0xc8
UPDATE locations
SET stripe_special_price_id = 'price_1TYOqJLjlX8j0xc8zJohmTin'
WHERE lower(replace(name, ' ', '-')) = 'williamsburg';

-- Sanity check — confirm the 4 studios + their special price id
SELECT name, stripe_special_price_id
FROM locations
WHERE is_active = true
ORDER BY name;
