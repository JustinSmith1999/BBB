// 2026-08-31: First-party page-view analytics.
//
// Why not GA4/etc: we needed page views TODAY, owned by us, with zero new
// accounts and zero third-party scripts (nothing for ad-blockers to eat).
// Every page view inserts one row into public.page_views in our Supabase
// (anon INSERT-only via RLS; nobody can read the data back without the
// service key). The owner dashboard can then chart visitors/pages live.
//
// Design rules:
// - NEVER throw, NEVER block rendering. Analytics must not be able to break
//   the site. Everything is wrapped and fire-and-forget.
// - No PII. Path, referrer, UTMs, a random per-tab session id, viewport
//   class, and the user agent (for device debugging). No names/emails/IPs
//   (Supabase doesn't get the IP into the row).
// - sendBeacon when available so views still record when someone closes the
//   tab mid-navigation; fetch(keepalive) fallback.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Baked in by vite.config define — identifies which deploy the visitor runs.
declare const __BUILD_TS__: string;
export const BUILD_ID: string = typeof __BUILD_TS__ !== 'undefined' ? __BUILD_TS__ : 'unknown';

function sessionId(): string {
  try {
    let sid = sessionStorage.getItem('bbb_sid');
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('bbb_sid', sid);
    }
    return sid;
  } catch {
    return 'no-storage';
  }
}

export function trackPageView(path: string): void {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
    // Don't record our own staging/lab traffic.
    if (path.startsWith('/staging')) return;

    const params = new URLSearchParams(window.location.search);
    const row = {
      path,
      referrer: document.referrer ? document.referrer.slice(0, 300) : null,
      utm_source: params.get('utm_source'),
      utm_medium: params.get('utm_medium'),
      utm_campaign: params.get('utm_campaign'),
      studio: params.get('studio'),
      sid: sessionId(),
      device: window.innerWidth < 768 ? 'mobile' : window.innerWidth < 1100 ? 'tablet' : 'desktop',
      ua: navigator.userAgent ? navigator.userAgent.slice(0, 300) : null,
    };

    const url = `${SUPABASE_URL}/rest/v1/page_views`;
    const body = JSON.stringify(row);

    // sendBeacon can't set headers, so it goes through fetch; keepalive gives
    // us the same "survives page unload" behavior.
    fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'return=minimal',
      },
      body,
    }).catch(() => { /* analytics must never surface errors */ });
  } catch { /* never break the site over analytics */ }
}

// 2026-08-31: Client error telemetry. Every time the error boundary trips,
// the visitor's browser reports WHAT crashed, on WHICH page, on WHICH build,
// on WHAT device — into public.client_errors. Ends the guessing game when
// someone texts "the site is down" with a screenshot.
export function trackError(message: string, componentStack?: string): void {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
    fetch(`${SUPABASE_URL}/rest/v1/client_errors`, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        message: String(message).slice(0, 500),
        component_stack: componentStack ? String(componentStack).slice(0, 800) : null,
        path: window.location.pathname,
        build: BUILD_ID,
        sid: sessionId(),
        ua: navigator.userAgent ? navigator.userAgent.slice(0, 300) : null,
        vw: window.innerWidth,
      }),
    }).catch(() => { /* telemetry must never surface errors */ });
  } catch { /* never break the site over telemetry */ }
}
