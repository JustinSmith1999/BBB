/*
  # Create team_members table

  1. New Tables
    - `team_members`
      - `id` (uuid, primary key)
      - `name` (text) - Team member's full name
      - `title` (text) - Job title or role
      - `bio` (text) - Biography or description
      - `image_url` (text, nullable) - Profile image URL
      - `is_active` (boolean) - Whether the member should be displayed
      - `display_order` (integer) - Order for displaying members
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on `team_members` table
    - Add policy for public read access to active team members
*/

CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  title text NOT NULL,
  bio text NOT NULL,
  image_url text,
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active team members"
  ON team_members
  FOR SELECT
  USING (is_active = true);