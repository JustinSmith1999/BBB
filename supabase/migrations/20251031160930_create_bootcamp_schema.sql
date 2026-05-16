/*
  # Better Body Bootcamp Database Schema

  1. New Tables
    - `locations`
      - `id` (uuid, primary key)
      - `name` (text) - Location name (e.g., "Astoria")
      - `address` (text) - Full street address
      - `city` (text) - City name
      - `state` (text) - State code
      - `zip` (text) - Zip code
      - `phone` (text) - Contact phone number
      - `schedule_url` (text) - URL to schedule page
      - `is_active` (boolean) - Whether location is active
      - `display_order` (integer) - Order to display locations
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `testimonials`
      - `id` (uuid, primary key)
      - `name` (text) - Member name
      - `title` (text) - Testimonial headline
      - `content` (text) - Full testimonial text
      - `image_url` (text) - Member photo URL
      - `is_featured` (boolean) - Show on homepage
      - `display_order` (integer) - Order to display
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `contact_submissions`
      - `id` (uuid, primary key)
      - `name` (text) - Contact name
      - `email` (text) - Contact email
      - `phone` (text) - Contact phone
      - `location_id` (uuid) - Preferred location
      - `message` (text) - Contact message
      - `created_at` (timestamptz)
    
    - `trial_signups`
      - `id` (uuid, primary key)
      - `name` (text) - Signup name
      - `email` (text) - Signup email
      - `phone` (text) - Signup phone
      - `location_id` (uuid) - Preferred location
      - `created_at` (timestamptz)
  
  2. Security
    - Enable RLS on all tables
    - Public read access for locations and testimonials
    - Authenticated insert access for contact submissions and trial signups
*/

-- Locations table
CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text NOT NULL,
  city text NOT NULL,
  state text NOT NULL DEFAULT 'NY',
  zip text NOT NULL,
  phone text NOT NULL,
  schedule_url text,
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active locations"
  ON locations FOR SELECT
  USING (is_active = true);

-- Testimonials table
CREATE TABLE IF NOT EXISTS testimonials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  image_url text,
  is_featured boolean DEFAULT true,
  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE testimonials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view featured testimonials"
  ON testimonials FOR SELECT
  USING (is_featured = true);

-- Contact submissions table
CREATE TABLE IF NOT EXISTS contact_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  location_id uuid REFERENCES locations(id),
  message text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE contact_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit contact form"
  ON contact_submissions FOR INSERT
  WITH CHECK (true);

-- Trial signups table
CREATE TABLE IF NOT EXISTS trial_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  location_id uuid REFERENCES locations(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE trial_signups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can sign up for trial"
  ON trial_signups FOR INSERT
  WITH CHECK (true);

-- Insert initial location data
INSERT INTO locations (name, address, city, state, zip, phone, schedule_url, display_order) VALUES
  ('Astoria', '31-18 Steinway Street', 'Astoria', 'NY', '11103', '(718) 704-9954', '#', 1),
  ('Bayside', '3447 Bell Blvd', 'Bayside', 'NY', '11361', '(646) 566-8870', '#', 2),
  ('Fresh Meadows', '76-46 164th Street', 'Fresh Meadows', 'NY', '11366', '(646) 566-8207', '#', 3),
  ('Williamsburg', '487 Driggs Ave', 'Brooklyn', 'NY', '11211', '(718) 683-1864', '#', 4)
ON CONFLICT DO NOTHING;

-- Insert sample testimonials
INSERT INTO testimonials (name, title, content, display_order) VALUES
  ('Carine', 'Five years later, Carine''s Love For Better Body Is Stronger Than Ever', 'Carine continues to make Bootcamp the number one priority day in and day out. A five-year member, Carine isn''t slowing down any time soon.', 1),
  ('Karine', 'Karine Found Her Love For Fitness The Day She Started Bootcamp', 'Karine searched endlessly for the perfect gym and when she found BBB in November 2021 her fitness love blossomed. The results speak for themselves.', 2),
  ('Lauren', 'Lauren Got Into The Best Shape Of Her Life And Isn''t Slowing Down', 'She''s miraculously transformed physically, dropping roughly 70 pounds and six pants sizes, and BBB made her believe there''s no obstacle she can''t conquer.', 3),
  ('Imelda', 'Imelda Discovered The Perfect Mix of Personal and Group Training at BBB', 'Imelda is a U.S. Army vet, but Bootcamp was still one of the toughest workouts she endured in her life. Yet that made her push herself even further.', 4)
ON CONFLICT DO NOTHING;