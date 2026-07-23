import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// 2026-07-22 SECURITY: the browser must NEVER pull secret columns from the
// locations table (stripe_secret_key, stripe_webhook_secret, *_api_key,
// gbp_refresh_token). Using select('*') shipped those live keys to every
// visitor. Always select this explicit safe column list instead of '*'.
// Secret columns are only ever read server-side by edge functions using the
// service-role key.
export const LOCATION_PUBLIC_COLUMNS =
  'id, name, address, city, state, zip, phone, contact_email, image_url, ' +
  'schedule_url, is_active, display_order, created_at, updated_at, ' +
  'stripe_publishable_key, stripe_price_id, stripe_special_price_id, ' +
  'stripe_comeback_price_id, mindbody_widget_id, mariana_tek_subdomain, ' +
  'mariana_tek_location_id, gbp_location_id, data_source';

export interface Location {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  contact_email: string | null;
  image_url: string | null;
  schedule_url: string | null;
  is_active: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface Testimonial {
  id: string;
  name: string;
  title: string;
  content: string;
  image_url: string | null;
  video_url: string | null;
  is_featured: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface ContactSubmission {
  name: string;
  email: string;
  phone?: string;
  location_id?: string;
  message: string;
}

export interface TrialSignup {
  name: string;
  email: string;
  phone?: string;
  location_id?: string;
}

export interface MindbodyConfig {
  id: string;
  location_id: string;
  site_id: string;
  api_key: string;
  is_active: boolean;
  last_sync_at: string | null;
  sync_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface Class {
  id: string;
  mindbody_class_id: string;
  location_id: string;
  site_id: string;
  name: string;
  description: string | null;
  class_type: string | null;
  instructor_name: string | null;
  instructor_id: string | null;
  start_datetime: string;
  end_datetime: string;
  duration_minutes: number | null;
  max_capacity: number | null;
  total_booked: number;
  total_waitlist: number;
  is_available: boolean;
  is_canceled: boolean;
  is_virtual: boolean;
  virtual_stream_link: string | null;
  image_url: string | null;
  level: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  mindbody_client_id: string | null;
  mindbody_unique_id: string | null;
  date_of_birth: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClassBooking {
  id: string;
  class_id: string;
  user_profile_id: string;
  mindbody_visit_id: string | null;
  status: string;
  booking_type: string;
  payment_status: string;
  payment_amount: number | null;
  notes: string | null;
  booked_at: string;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}
