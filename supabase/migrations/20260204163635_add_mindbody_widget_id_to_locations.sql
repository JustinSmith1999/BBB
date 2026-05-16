/*
  # Add Mindbody Widget ID to Locations

  1. Changes
    - Add `mindbody_widget_id` column to store the Mindbody Schedules widget ID for each location
    
  2. Purpose
    - Enable direct embedding of Mindbody widgets with location-specific widget IDs
    - Support simple widget-based schedule display with dropdown selector
    
  3. Notes
    - Widget IDs are obtained from Mindbody's Branded Web platform
    - Each location can have its own unique widget ID
*/

-- Add mindbody_widget_id column to locations table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'mindbody_widget_id'
  ) THEN
    ALTER TABLE locations ADD COLUMN mindbody_widget_id text;
  END IF;
END $$;
