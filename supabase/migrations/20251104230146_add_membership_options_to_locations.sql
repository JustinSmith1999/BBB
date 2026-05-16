/*
  # Add Membership Options to Locations

  1. Changes
    - Add `memberships_available` column to track what membership types can be purchased at each location
    - Add `is_flagship` boolean to highlight premier locations
    - Add `special_features` text array for location-specific perks
    - Update existing locations with membership data

  2. Notes
    - memberships_available: array of membership types (e.g., 'trial', 'monthly', 'annual')
    - is_flagship: highlights locations with premium features
    - special_features: unique amenities or offerings at each location
*/

-- Add new columns to locations table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'memberships_available'
  ) THEN
    ALTER TABLE locations ADD COLUMN memberships_available text[] DEFAULT ARRAY['trial', 'monthly', 'annual'];
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'is_flagship'
  ) THEN
    ALTER TABLE locations ADD COLUMN is_flagship boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'special_features'
  ) THEN
    ALTER TABLE locations ADD COLUMN special_features text[] DEFAULT ARRAY[]::text[];
  END IF;
END $$;

-- Update locations with unique membership options and features
UPDATE locations SET 
  memberships_available = ARRAY['trial', 'monthly', 'annual'],
  is_flagship = true,
  special_features = ARRAY['Premium Equipment', 'Extended Hours', 'VIP Locker Rooms', 'Nutrition Bar']
WHERE name = 'Astoria';

UPDATE locations SET 
  memberships_available = ARRAY['trial', 'monthly', 'annual'],
  is_flagship = false,
  special_features = ARRAY['Family Friendly', 'Outdoor Training Area', 'Free Parking']
WHERE name = 'Bayside';

UPDATE locations SET 
  memberships_available = ARRAY['trial', 'monthly'],
  is_flagship = false,
  special_features = ARRAY['Community Hub', 'Beginner Friendly', 'Small Group Focus']
WHERE name = 'Fresh Meadows';

UPDATE locations SET 
  memberships_available = ARRAY['trial', 'monthly', 'annual'],
  is_flagship = true,
  special_features = ARRAY['Rooftop Workouts', 'Premium Showers', 'Recovery Lounge', 'Late Night Sessions']
WHERE name = 'Williamsburg';
