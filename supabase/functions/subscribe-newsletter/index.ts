// Supabase Edge Function: subscribe-newsletter
//
// Captures email-only signups from the "JOIN THE LIST" form in the site footer
// (and any other email-only capture surface). Inserts a row into `leads` so
// the contact lands in the BBB CRM for follow-up.
//
// POST body:
//   { email: "foo@bar.com", source?: "footer-newsletter", studio_slug?: string }
//
// Returns 200 { ok: true } on success (idempotent on email).

// deno-lint-ignore-file
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  let body: { email?: string; source?: string; studio_slug?: string | null } = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }

  const email = (body.email ?? '').toString().trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: 'valid email required' }, 400);
  }

  const source = (body.source ?? 'footer-newsletter').toString().slice(0, 60);
  const studioSlug = body.studio_slug && typeof body.studio_slug === 'string'
    ? body.studio_slug.toLowerCase()
    : null;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const fields = {
    email,
    source,
    stage: 'newsletter',
    studio_slug: studioSlug,
    last_touch_at: new Date().toISOString(),
    notes: 'Signed up via site newsletter form',
  };

  try {
    // Manual upsert pattern — leads.email has no unique constraint.
    const { data: existing, error: updErr } = await supabase
      .from('leads')
      .update(fields)
      .eq('email', email)
      .select('id');

    if (updErr) {
      console.error('newsletter update failed:', updErr.message);
      return json({ ok: false, error: 'database error' }, 500);
    }

    if (!existing || existing.length === 0) {
      const { error: insErr } = await supabase.from('leads').insert(fields);
      if (insErr) {
        console.error('newsletter insert failed:', insErr.message);
        return json({ ok: false, error: 'database error' }, 500);
      }
    }
  } catch (e) {
    console.error('newsletter exception:', e);
    return json({ ok: false, error: 'unexpected error' }, 500);
  }

  return json({ ok: true });
});
