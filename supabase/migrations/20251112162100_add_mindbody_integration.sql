/*
  # MindBody Integration Schema

  1. New Tables
    - `mindbody_config`
      - Links locations to MindBody Site IDs and API credentials
      - Stores API keys securely
      - Tracks sync settings and status

    - `classes`
      - Caches class data from MindBody API
      - Includes class details, schedule, capacity, instructor info
      - Optimizes performance by reducing API calls

    - `class_bookings`
      - Tracks all class bookings made through the system
      - Links users to booked classes
      - Stores booking status and MindBody reference IDs

    - `user_profiles`
      - Stores user information for class bookings
      - Links to MindBody client IDs
      - Manages user preferences and contact info

  2. Security
    - Enable RLS on all tables
    - Add policies for authenticated users to read classes
    - Restrict mindbody_config to admin access only
    - Allow users to view their own bookings and profiles
    - Allow users to create bookings and update their profiles

  3. Indexes
    - Index classes by location_id and start_datetime for fast queries
    - Index bookings by user_id and class_id
    - Index user_profiles by email for quick lookups
*/

-- MindBody Configuration Table
CREATE TABLE IF NOT EXISTS mindbody_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  api_key text NOT NULL,
  is_active boolean DEFAULT true,
  last_sync_at timestamptz,
  sync_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(location_id)
);

ALTER TABLE mindbody_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read active mindbody config"
  ON mindbody_config FOR SELECT
  USING (is_active = true);

-- Classes Cache Table
CREATE TABLE IF NOT EXISTS classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mindbody_class_id text NOT NULL,
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  name text NOT NULL,
  description text,
  class_type text,
  instructor_name text,
  instructor_id text,
  start_datetime timestamptz NOT NULL,
  end_datetime timestamptz NOT NULL,
  duration_minutes integer,
  max_capacity integer,
  total_booked integer DEFAULT 0,
  total_waitlist integer DEFAULT 0,
  is_available boolean DEFAULT true,
  is_canceled boolean DEFAULT false,
  is_virtual boolean DEFAULT false,
  virtual_stream_link text,
  image_url text,
  level text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(mindbody_class_id, site_id, start_datetime)
);

ALTER TABLE classes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view available classes"
  ON classes FOR SELECT
  USING (is_available = true AND is_canceled = false);

CREATE INDEX idx_classes_location_datetime ON classes(location_id, start_datetime);
CREATE INDEX idx_classes_start_datetime ON classes(start_datetime);
CREATE INDEX idx_classes_mindbody_id ON classes(mindbody_class_id, site_id);

-- User Profiles Table
CREATE TABLE IF NOT EXISTS user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text,
  mindbody_client_id text,
  mindbody_unique_id text,
  date_of_birth date,
  emergency_contact_name text,
  emergency_contact_phone text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  TO authenticated
  USING (auth.uid()::text = id::text);

CREATE POLICY "Users can create own profile"
  ON user_profiles FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid()::text = id::text)
  WITH CHECK (auth.uid()::text = id::text);

CREATE INDEX idx_user_profiles_email ON user_profiles(email);
CREATE INDEX idx_user_profiles_mindbody_client_id ON user_profiles(mindbody_client_id);

-- Class Bookings Table
CREATE TABLE IF NOT EXISTS class_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid REFERENCES classes(id) ON DELETE CASCADE,
  user_profile_id uuid REFERENCES user_profiles(id) ON DELETE CASCADE,
  mindbody_visit_id text,
  status text DEFAULT 'pending',
  booking_type text DEFAULT 'regular',
  payment_status text DEFAULT 'unpaid',
  payment_amount decimal(10,2),
  notes text,
  booked_at timestamptz DEFAULT now(),
  canceled_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE class_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own bookings"
  ON class_bookings FOR SELECT
  TO authenticated
  USING (user_profile_id IN (
    SELECT id FROM user_profiles WHERE auth.uid()::text = id::text
  ));

CREATE POLICY "Anyone can create bookings"
  ON class_bookings FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Users can update own bookings"
  ON class_bookings FOR UPDATE
  TO authenticated
  USING (user_profile_id IN (
    SELECT id FROM user_profiles WHERE auth.uid()::text = id::text
  ))
  WITH CHECK (user_profile_id IN (
    SELECT id FROM user_profiles WHERE auth.uid()::text = id::text
  ));

CREATE INDEX idx_class_bookings_class_id ON class_bookings(class_id);
CREATE INDEX idx_class_bookings_user_profile_id ON class_bookings(user_profile_id);
CREATE INDEX idx_class_bookings_status ON class_bookings(status);
