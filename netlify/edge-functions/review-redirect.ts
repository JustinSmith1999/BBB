// review-redirect.ts — runs at /review/[studio] on betterbodybootcamp.com
//
// Purpose: customers scanning the printed flyer QR code (or typing the URL)
// land here. We log the click for attribution, then 302 to the official
// Google "Write a review" URL for that studio.
//
// Logging is best-effort + non-blocking — if Supabase is slow or rejects
// the insert, the customer still gets redirected to Google immediately so
// the conversion isn't lost.
//
// Studios hardcoded for v1 (Bayside + Fresh Meadows only — Williamsburg +
// Astoria don't have flyers in circulation yet). Add new entries to the
// REVIEW_URLS map when those studios opt in.
//
// Companion table: public.gbp_review_clicks (see migration).
// Dashboard card: bbb-marketing/index.html → renderGoogleReviewClicks().

import type { Context } from 'https://edge.netlify.com';

// Source: business.google.com → Carlos's account → each studio's
// "Get more reviews" panel → "Review link" field. These are the official
// g.page short URLs Google itself generates, which deep-link straight into
// the Maps app's review-writing UI on mobile.
const REVIEW_URLS: Record<string, string> = {
  'bayside':       'https://g.page/r/CWxO8GcU4lTvEAE/review',
  'fresh-meadows': 'https://g.page/r/CUH6861dmrPZEBM/review',
};

// Fallback if a customer scans a flyer but the slug is wrong (typo on a
// reprinted batch, e.g.). Lands them on the studio picker so they still get
// to Google with one extra tap.
const FALLBACK = 'https://www.google.com/search?q=Better+Body+Bootcamp';

export default async (req: Request, ctx: Context) => {
  const url = new URL(req.url);
  // Strip the leading /review/ and any trailing slash. Lowercase so
  // /Review/Bayside still routes correctly.
  const slug = url.pathname.replace(/^\/review\//, '').replace(/\/$/, '').toLowerCase();
  const destination = REVIEW_URLS[slug] || FALLBACK;

  // ── Background logging via ctx.waitUntil ────────────────────────────
  // 2026-06-05 fix: Netlify's edge runtime terminates in-flight promises
  // the moment the response is returned, so the previous fire-and-forget
  // fetch() got killed before it could POST to Supabase (resulting in
  // zero rows in gbp_review_clicks despite working redirects). waitUntil
  // tells the runtime to keep the fetch alive past the redirect — the
  // customer still gets to Google immediately, AND we log the click.
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (supabaseUrl && supabaseAnonKey && REVIEW_URLS[slug]) {
    const clientIp =
      req.headers.get('x-nf-client-connection-ip') ||
      (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
      null;
    const userAgent = (req.headers.get('user-agent') || '').slice(0, 1024) || null;
    const referrer  = req.headers.get('referer') || null;
    const logPromise = fetch(`${supabaseUrl}/rest/v1/gbp_review_clicks`, {
      method: 'POST',
      headers: {
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        studio_slug: slug,
        client_ip: clientIp,
        client_user_agent: userAgent,
        referrer: referrer,
        // Track WHICH flyer/source if it's later distinguished via ?src=…
        source: url.searchParams.get('src') || 'flyer',
      }),
    }).catch(() => { /* non-blocking: swallow errors so redirect always fires */ });
    // Keep the fetch alive past the response return.
    ctx.waitUntil(logPromise);
  }

  return Response.redirect(destination, 302);
};

export const config = { path: '/review/*' };
