// 2026-06-26 v2: Typed client. The proxy now flattens MT's verbose JSON:API
// response into a render-ready shape — no JSON:API include-walking here.

import { supabase } from './supabase';

export type MTClassSession = {
  id: string;
  start_datetime:    string;
  end_datetime:      string;
  duration_min:      number;
  class_name:        string;
  studio_display:    string;
  instructor_names:  string[];
  location_display:  string | null;
  classroom_display: string | null;
  available_count:   number;
  capacity:          number;
  is_full:           boolean;
  waitlist_open:     boolean;
  waitlist_count:    number;
  standby_capacity:  number;
  /** Path consumed by the MT Web Integrations widget runtime (loaded in index.html). */
  widget_path:       string;
  /** Optional: MT internal class_type id, available when modal needs to deep-filter. */
  class_type_id?:    string;
  /** Legacy alias for widget_path. */
  direct_book_url:   string;
};

export async function fetchClassesForLocation(
  mtLocationId: number,
  opts: { days?: number } = {},
): Promise<{ ok: true; sessions: MTClassSession[] } | { ok: false; error: string }> {
  const { data, error } = await supabase.functions.invoke('mt-public-classes', {
    body: { mt_location_id: mtLocationId, days: opts.days ?? 7 },
  });
  if (error)         return { ok: false, error: error.message || 'fetch failed' };
  if (!data?.ok)     return { ok: false, error: data?.hint || data?.error || 'unknown error' };
  return { ok: true, sessions: Array.isArray(data.sessions) ? data.sessions : [] };
}
