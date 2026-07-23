// Basic-auth gate for /staging/* — Mariana Tek QA pages must not be reachable
// by the public. This runs at the Netlify edge before the SPA HTML is served.
//
// Credentials are configured via two env vars on the betterbodybootcamp Netlify
// site (Site settings → Build & deploy → Environment):
//   STAGING_USERNAME — defaults to "marianatek" if unset
//   STAGING_PASSWORD — must be set; if empty, the gate refuses all traffic
//
// Browsers cache basic-auth credentials per origin until the tab closes, so
// Gabriela enters them once and can navigate between all four /staging URLs.

import type { Context } from 'https://edge.netlify.com';

const REALM = 'BBB Mariana Tek Staging';

export default async (req: Request, _ctx: Context) => {
  const url = new URL(req.url);
  // Defense in depth: only protect /staging/*. The path-matching config in
  // netlify.toml already scopes us here, but a typo there shouldn't break the
  // public site, so check the path again.
  if (!url.pathname.startsWith('/staging')) return;

  const expectedUser = Deno.env.get('STAGING_USERNAME') || 'marianatek';
  const expectedPass = Deno.env.get('STAGING_PASSWORD') || '';
  if (!expectedPass) {
    // Misconfigured — refuse all traffic rather than silently letting it
    // through. This forces Justin to set the secret before staging is reachable.
    return new Response('Staging password not configured. Set STAGING_PASSWORD in Netlify env.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const header = req.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      const idx = decoded.indexOf(':');
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (user === expectedUser && pass === expectedPass) {
        // Authorized — fall through to the SPA.
        return;
      }
    } catch {
      // bad header — fall through to the 401 below
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain',
    },
  });
};

export const config = { path: '/staging/*' };
