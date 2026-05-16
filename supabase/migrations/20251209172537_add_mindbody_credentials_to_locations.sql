/*
  # Add MindBody API Credentials to Locations

  1. Changes
    - Add `mindbody_site_id` column to store the MindBody site ID for API calls
    - Add `mindbody_api_key` column to store the MindBody API key
    - Add `mindbody_location_id` column to store the location ID in MindBody system
    
  2. Purpose
    - Enable direct API integration with MindBody to fetch real class schedules
    - Support both widget-based and API-based class display options
    
  3. Notes
    - These fields are optional, allowing locations without MindBody integration
    - API credentials should be kept secure and not exposed to frontend
*/

-- Add MindBody credential columns to locations table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'mindbody_site_id'
  ) THEN
    ALTER TABLE locations ADD COLUMN mindbody_site_id text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'mindbody_api_key'
  ) THEN
    ALTER TABLE locations ADD COLUMN mindbody_api_key text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'mindbody_location_id'
  ) THEN
    ALTER TABLE locations ADD COLUMN mindbody_location_id integer;
  END IF;
END $$;
