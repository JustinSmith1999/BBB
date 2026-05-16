/*
  # Add Video URL to Testimonials

  1. Changes
    - Add `video_url` column to testimonials table to store YouTube video URLs
    - This allows testimonials to include embedded videos alongside or instead of text content

  2. Notes
    - Video URL is optional, testimonials can have text only, video only, or both
    - Use YouTube embed URLs in format: https://www.youtube.com/embed/VIDEO_ID
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'testimonials' AND column_name = 'video_url'
  ) THEN
    ALTER TABLE testimonials ADD COLUMN video_url text;
  END IF;
END $$;
