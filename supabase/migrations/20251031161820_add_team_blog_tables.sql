/*
  # Add Team Members and Blog Posts Tables

  1. New Tables
    - `team_members`
      - `id` (uuid, primary key)
      - `name` (text) - Team member full name
      - `title` (text) - Job title/role
      - `bio` (text) - Biography
      - `image_url` (text) - Profile photo URL
      - `display_order` (integer) - Display order
      - `is_active` (boolean) - Whether member is active
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `blog_posts`
      - `id` (uuid, primary key)
      - `title` (text) - Post title
      - `slug` (text) - URL-friendly slug
      - `excerpt` (text) - Short summary
      - `content` (text) - Full post content
      - `image_url` (text) - Featured image URL
      - `author` (text) - Author name
      - `published` (boolean) - Whether post is published
      - `published_at` (timestamptz) - Publication date
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
  
  2. Security
    - Enable RLS on both tables
    - Public read access for active team members and published blog posts
*/

-- Team members table
CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  title text NOT NULL,
  bio text NOT NULL,
  image_url text,
  display_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active team members"
  ON team_members FOR SELECT
  USING (is_active = true);

-- Blog posts table
CREATE TABLE IF NOT EXISTS blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  slug text UNIQUE NOT NULL,
  excerpt text NOT NULL,
  content text NOT NULL,
  image_url text,
  author text NOT NULL,
  published boolean DEFAULT false,
  published_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view published blog posts"
  ON blog_posts FOR SELECT
  USING (published = true);

-- Insert sample team members
INSERT INTO team_members (name, title, bio, display_order) VALUES
  ('John Smith', 'Head Coach & Founder', 'With over 15 years of experience in fitness training, John founded Better Body Bootcamp in 2011 with a vision to create the most effective and fun group training program in New York.', 1),
  ('Sarah Johnson', 'Lead Trainer - Astoria', 'Sarah brings her competitive athletic background and passion for helping others achieve their fitness goals. Her energy and expertise make every class unforgettable.', 2),
  ('Mike Rodriguez', 'Lead Trainer - Williamsburg', 'Mike specializes in strength training and body sculpting. His motivational coaching style has helped hundreds of members achieve their dream physique.', 3),
  ('Emily Chen', 'Nutrition Specialist', 'Emily provides nutrition guidance to help members maximize their results. Her holistic approach combines fitness and nutrition for lasting transformation.', 4)
ON CONFLICT DO NOTHING;

-- Insert sample blog posts
INSERT INTO blog_posts (title, slug, excerpt, content, author, published, published_at) VALUES
  ('5 Tips for Maximizing Your Bootcamp Results', '5-tips-maximizing-bootcamp-results', 'Get the most out of every workout with these expert tips from our trainers.', 'Starting a bootcamp program is exciting, but knowing how to maximize your results can take your transformation to the next level. Here are our top 5 tips: 1. Consistency is key - aim for at least 3-4 sessions per week. 2. Focus on proper form over speed. 3. Stay hydrated before, during, and after workouts. 4. Fuel your body with proper nutrition. 5. Get adequate rest and recovery. Follow these principles and watch your results soar!', 'John Smith', true, now()),
  ('The Science Behind High-Intensity Interval Training', 'science-behind-hiit', 'Discover why HIIT is one of the most effective training methods for fat loss and fitness.', 'High-Intensity Interval Training (HIIT) has taken the fitness world by storm, and for good reason. Research shows that HIIT can burn more calories in less time compared to traditional cardio. The secret lies in the afterburn effect, where your body continues burning calories for hours after your workout. At Better Body Bootcamp, we have perfected the art of HIIT to deliver maximum results while keeping workouts fun and engaging.', 'Sarah Johnson', true, now()),
  ('Nutrition Basics: Fueling Your Fitness Journey', 'nutrition-basics-fueling-fitness', 'Learn the fundamentals of nutrition to support your fitness goals and boost your energy.', 'Proper nutrition is just as important as your workouts when it comes to achieving results. In this guide, we will cover the basics of macronutrients, meal timing, hydration, and how to create sustainable eating habits that support your fitness journey. Remember, you cannot out-train a bad diet, but you can fuel great results with smart nutrition choices.', 'Emily Chen', true, now())
ON CONFLICT DO NOTHING;