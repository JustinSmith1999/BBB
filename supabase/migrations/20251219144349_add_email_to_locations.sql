/*
  # Add email field to locations table

  1. Changes
    - Add `contact_email` column to `locations` table
      - Type: text
      - Purpose: Store location-specific email addresses for contact form routing
      - Optional field (can be null)

  2. Notes
    - Each location can have its own email address for contact form submissions
    - If no location-specific email is set, a default email will be used
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'locations' AND column_name = 'contact_email'
  ) THEN
    ALTER TABLE locations ADD COLUMN contact_email text;
  END IF;
END $$;
