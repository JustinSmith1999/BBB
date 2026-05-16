/*
  # Add image_url to locations table

  1. Changes
    - Add `image_url` column to `locations` table to store location images
    - Update existing locations with their respective image URLs

  2. Notes
    - Images are stored in the public folder and referenced as public URLs
*/

-- Add image_url column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'image_url'
  ) THEN
    ALTER TABLE locations ADD COLUMN image_url text;
  END IF;
END $$;

-- Update existing locations with their image URLs
UPDATE locations SET image_url = '/astoria.jpeg' WHERE name = 'Astoria';
UPDATE locations SET image_url = '/bayside.png' WHERE name = 'Bayside';
UPDATE locations SET image_url = '/freshmeadows.jpeg' WHERE name = 'Fresh Meadows';
UPDATE locations SET image_url = '/williamsburg-new.jpeg' WHERE name = 'Williamsburg';
