// linkTracker.ts — one listener, every click on the site, forever.
//
// NOTE ON THE TABLE NAME: this writes to site_clicks, not link_clicks.
// link_clicks already existed and belongs to the EMAIL link tracking that
// get_link_performance reads. Two different things; do not merge them.
//
// Deliberately NOT per-link tagging. A delegated listener on document catches
// anything anyone adds later without someone remembering to instrument it.
// Add a button next year and it is tracked on day one.
//
// What it records: internal links, outbound links, tel:, mailto:, App Store
// and Play Store links, file downloads, and any element carrying data-track.
// Buttons are only recorded when they opt in with data-track, otherwise every
// stray UI toggle floods the table.
//
// Rules, same as track.ts: never throw, never block navigation, never send
// PII. It fires and forgets through sendBeacon so the row still lands when the
// click navigates the tab away.

import { visitorId } from './visitor';
import { getUtmParams } from './utm';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

declare const __BUILD_TS__: string;
const BUILD_ID = typeof __BUILD_TS__ !== 'undefined' ? __BUILD_TS__ : 'unknown';

const APP_STORE_HOSTS = ['apps.apple.com', 'itunes.apple.com', 'play.google.com'];
const DOWNLOAD_EXT = /\.(pdf|csv|xlsx?|docx?|zip|mp4|mov|png|jpe?g)$/i;

function sessionId(): string {
  try {
    let s = sessionStorage.getItem('bbb_sid');
    if (!s) {
      s = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('bbb_sid', s);
    }
    return s;
  } catch { return ''; }
}

function readCookie(name: string): string {
  try {
    const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : '';
  } catch { return ''; }
}

/** Which studio page is this, if any. /trial/bayside -> bayside */
function studioFromPath(path: string): string | null {
  const m = path.match(/\/(?:trial|schedule|month|twomonths|comeback|locations?)\/([a-z-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function classify(a: HTMLAnchorElement, href: string): string {
  if (href.startsWith('tel:')) return 'tel';
  if (href.startsWith('mailto:')) return 'mailto';
  if (href.startsWith('sms:')) return 'sms';
  try {
    const u = new URL(href, window.location.href);
    if (APP_STORE_HOSTS.some(h => u.hostname.endsWith(h))) return 'app_store';
    if (DOWNLOAD_EXT.test(u.pathname) || a.hasAttribute('download')) return 'download';
    if (u.hostname !== window.location.hostname) return 'outbound';
  } catch { /* relative or malformed */ }
  return 'internal';
}

// 2026-10-07: this used to try navigator.sendBeacon first. It silently lost
// every row. sendBeacon returns true the moment the request is QUEUED, not
// when it succeeds, and a Blob of type application/json is not a CORS-simple
// content type, so the cross-origin POST needs an OPTIONS preflight — which
// sendBeacon cannot perform. The browser dropped it and reported success.
// fetch with keepalive gives the same survives-unload behavior AND handles
// the preflight, which is what track.ts has always done for page_views.
function send(row: Record<string, unknown>): void {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  const url = `${SUPABASE_URL}/rest/v1/site_clicks`;
  const body = JSON.stringify(row);
  try {
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'return=minimal',
      },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch { /* analytics must never break the page */ }
}

let started = false;

/** Call once, at app start. Safe to call twice. */
export function startLinkTracking(): void {
  if (started || typeof document === 'undefined') return;
  started = true;

  document.addEventListener('click', (ev) => {
    try {
      const target = ev.target as Element | null;
      if (!target || !(target instanceof Element)) return;

      const a = target.closest('a') as HTMLAnchorElement | null;
      const tracked = target.closest('[data-track]') as HTMLElement | null;
      if (!a && !tracked) return;

      const href = a?.getAttribute('href') || '';
      // In-page anchors and javascript: hrefs are not journeys.
      if (a && (!href || href.startsWith('#') || href.startsWith('javascript:'))) {
        if (!tracked) return;
      }

      const el = (a || tracked) as HTMLElement;
      const path = window.location.pathname;
      // getUtmParams() returns camelCase (utmSource), not snake_case. Reading
      // utms.utm_source off it silently wrote null into every utm column.
      const utms = getUtmParams();

      send({
        visitor_id: visitorId() || null,
        session_id: sessionId() || null,
        kind: a ? classify(a, href) : 'button',
        href: href ? href.slice(0, 500) : null,
        link_text: (el.getAttribute('aria-label') || el.textContent || '')
          .replace(/\s+/g, ' ').trim().slice(0, 120) || null,
        element_id: el.getAttribute('data-track') || el.id || null,
        page_path: path,
        studio_slug: studioFromPath(path),
        fbp: readCookie('_fbp') || null,
        fbc: readCookie('_fbc') || null,
        utm_source: utms.utmSource || null,
        utm_medium: utms.utmMedium || null,
        utm_campaign: utms.utmCampaign || null,
        utm_content: utms.utmContent || null,
        referrer: (document.referrer || '').slice(0, 300) || null,
        device_hint: window.innerWidth < 768 ? 'mobile' : 'desktop',
        build_id: BUILD_ID,
      });
    } catch { /* never interfere with the click itself */ }
  }, { capture: true, passive: true });
}
