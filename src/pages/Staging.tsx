// Mariana Tek staging pages — non-public URLs used during the migration QA
// pass. Gabriela @ Mariana Tek needs to see the integrations rendered on our
// site to sign off before launch. Each page injects the Mariana Tek JS loader
// (idempotent — only added once) and renders the appropriate placeholder div.
//
// Sandbox values per Gabriela's email:
//   tenant      = betterbodybootcamp.sandbox
//   location_id = 48730        (Williamsburg in the sandbox dataset)
//   region_id   = 48547
//
// These pages are gated by a Netlify edge function (basic auth) at the route
// level — see netlify/edge-functions/staging-auth.ts.

import { useEffect, useRef } from 'react';

const TENANT = 'betterbodybootcamp.sandbox';
const LOCATION_ID = 48730;
const REGION_ID = 48547;

// Idempotent loader injection — adds the Mariana Tek scripts once per page
// load. The vendor snippet appends `polyfills` + `js` from the tenant's
// marianaiframes.com host, so we replicate it.
function ensureMarianaLoader() {
  if (typeof window === 'undefined') return;
  if (document.getElementById('mariana-tek-loader')) return;
  const marker = document.createElement('meta');
  marker.id = 'mariana-tek-loader';
  document.head.appendChild(marker);
  for (const name of ['polyfills', 'js']) {
    const s = document.createElement('script');
    s.src = `https://${TENANT}.marianaiframes.com/${name}`;
    s.setAttribute('data-timestamp', String(Date.now()));
    document.head.appendChild(s);
  }
}

type Kind = 'account' | 'buy' | 'schedule' | 'login';

const PATHS: Record<Kind, string> = {
  // /account handles login + member portal. Login flow lives inside this
  // widget; Gabriela's email lists "login" as a separate page, so we expose
  // /staging/login as an alias that renders the same widget.
  account:  '/account',
  login:    '/account',
  buy:      `/buy/${LOCATION_ID}`,
  schedule: `/schedule/daily/${REGION_ID}?locations=${LOCATION_ID}`,
};

const TITLES: Record<Kind, string> = {
  account:  'Account · Staging',
  login:    'Login · Staging',
  buy:      `Buy · Williamsburg (Location ${LOCATION_ID})`,
  schedule: `Schedule · Williamsburg (Location ${LOCATION_ID})`,
};

export default function Staging({ kind }: { kind: Kind }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ensureMarianaLoader();
    // The loader hydrates any <div data-mariana-integrations="..."> already
    // in the DOM. We render the div via React; on mount, force the loader to
    // re-scan by dispatching a window resize (no-op for the loader but it
    // gives Mariana a chance if it batches detection).
  }, [kind]);

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0b', color: '#fff', padding: '24px 16px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{ width: 4, height: 22, background: '#e11d2a', borderRadius: 2 }} />
          <h1 style={{ margin: 0, fontFamily: 'Georgia, serif', fontSize: 22 }}>
            {TITLES[kind]}
          </h1>
          <span style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 999,
            background: '#1f2937', color: '#fbbf24', fontWeight: 700, letterSpacing: 0.5,
          }}>
            STAGING — SANDBOX DATA
          </span>
        </div>
        <p style={{ fontSize: 13, color: '#9ca3af', marginTop: 0, marginBottom: 18 }}>
          Mariana Tek integration · tenant <code>{TENANT}</code> · location <code>{LOCATION_ID}</code> · region <code>{REGION_ID}</code>.
          Other staging pages:
          {' '}<a href="/staging/buy"      style={{ color: '#60a5fa' }}>buy</a> ·
          {' '}<a href="/staging/schedule" style={{ color: '#60a5fa' }}>schedule</a> ·
          {' '}<a href="/staging/account"  style={{ color: '#60a5fa' }}>account</a> ·
          {' '}<a href="/staging/login"    style={{ color: '#60a5fa' }}>login</a>
        </p>
        <div ref={containerRef} style={{ background: '#fff', borderRadius: 8, overflow: 'hidden', minHeight: 600 }}>
          <div data-mariana-integrations={PATHS[kind]} />
        </div>
      </div>
    </div>
  );
}
