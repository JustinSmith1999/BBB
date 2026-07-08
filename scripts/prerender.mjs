// ─────────────────────────────────────────────────────────────────────────────
// scripts/prerender.mjs  ·  Static SEO prerender (2026-07-08)
//
// WHY: the site is a client-side React SPA. Per-page <title>, <meta
// description>, canonical, and JSON-LD are injected by react-helmet AFTER the
// JS runs. Google renders JS so it eventually sees them, but the AI answer
// engines (GPTBot, PerplexityBot, ClaudeBot) and social scrapers do NOT run
// JS — they read the raw HTML Netlify serves, which for every /locations/*
// URL is the generic homepage index.html. So the neighborhood-specific SEO is
// invisible to exactly the crawlers that matter for local + AI visibility.
//
// WHAT: after `vite build`, this clones dist/index.html into a static file per
// key SEO route with the correct <title>, description, canonical, OG/Twitter
// tags, a FAQ JSON-LD block, and a real text content block baked into
// <div id="root">. Netlify serves these static files ahead of the SPA
// fallback (/*  → /index.html 200), so crawlers get neighborhood content and
// users still get the full React app (createRoot replaces #root on mount).
//
// Pure Node string manipulation — no puppeteer, no headless browser, nothing
// that can flake on the Netlify build. If a route file can't be written the
// build fails loudly rather than shipping silently-wrong HTML.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DIST defaults to ../dist (the Vite output). Overridable via PRERENDER_DIST
// for local verification builds that write to a temp directory.
const DIST = process.env.PRERENDER_DIST || join(__dirname, '..', 'dist');
const BASE = 'https://betterbodybootcamp.com';
const OG_IMAGE =
  'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png';

// ── Small HTML/attr escapers ────────────────────────────────────────────────
const escAttr = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Route definitions ───────────────────────────────────────────────────────
// path: URL path (written to dist/<path>/index.html). title/description drive
// the <head>; body[] is the no-JS fallback text; faq[] becomes FAQPage JSON-LD
// AND renders as visible text so AI engines have real Q&A to cite.
const LOCATIONS = [
  {
    path: '/locations/astoria',
    name: 'Astoria',
    borough: 'Queens',
    title: 'Gyms in Astoria, Queens · $49 Trial | Better Body Bootcamp',
    description:
      'Top-rated gym in Astoria, Queens at 31-18 Steinway Street. Bootcamp classes, expert trainers, real results. Try 2 weeks for $49. Under new ownership since Oct 2025.',
    address: '31-18 Steinway Street, Astoria, NY 11103',
    phone: '(718) 704-9954',
  },
  {
    path: '/locations/bayside',
    name: 'Bayside',
    borough: 'Queens',
    title: 'Gyms in Bayside, Queens · $49 Trial | Better Body Bootcamp',
    description:
      'Top-rated gym in Bayside, Queens at 3447 Bell Blvd. Bootcamp classes, expert trainers, real results. Try 2 weeks for $49. Under new ownership since Oct 2025.',
    address: '3447 Bell Blvd, Bayside, NY 11361',
    phone: '(646) 566-8870',
  },
  {
    path: '/locations/fresh-meadows',
    name: 'Fresh Meadows',
    borough: 'Queens',
    title: 'Gyms in Fresh Meadows, Queens · $49 Trial | Better Body Bootcamp',
    description:
      'Top-rated gym in Fresh Meadows at 76-46 164th Street. Bootcamp classes, expert trainers, real results. Try 2 weeks for $49. Under new ownership since Oct 2025.',
    address: '76-46 164th Street, Fresh Meadows, NY 11366',
    phone: '(646) 566-8207',
  },
  {
    path: '/locations/williamsburg',
    name: 'Williamsburg',
    borough: 'Brooklyn',
    title: 'Gyms in Williamsburg, Brooklyn · $49 Trial | Better Body Bootcamp',
    description:
      'Top-rated gym in Williamsburg, Brooklyn at 487 Driggs Ave. Bootcamp classes, expert trainers, real results. Try 2 weeks for $49. Under new ownership since Oct 2025.',
    address: '487 Driggs Ave, Brooklyn, NY 11211',
    phone: '(718) 683-1864',
  },
];

// Shared FAQ (facts are true for every studio). Rendered as visible text +
// FAQPage JSON-LD so answer engines can cite specific questions.
const faqFor = (loc) => [
  {
    q: `How much does Better Body Bootcamp ${loc.name} cost?`,
    a: `New members start with a 2-week trial for $49, which includes unlimited bootcamp and group fitness classes at our ${loc.name} studio (${loc.address}). After the trial, monthly and annual memberships are available — ask the front desk or call ${loc.phone}.`,
  },
  {
    q: `What are the class hours at the ${loc.name} studio?`,
    a: `Better Body Bootcamp ${loc.name} runs coached classes 7 days a week, generally between 6:00 AM and 9:00 PM. Live class times update on the schedule page — reserve your spot online or call ${loc.phone}.`,
  },
  {
    q: `What kind of workouts does Better Body Bootcamp ${loc.name} offer?`,
    a: `Every session is coach-programmed: high-energy bootcamp, HIIT, strength training, and conditioning in a supportive group setting in ${loc.name}, ${loc.borough}. All levels welcome — trainers scale each movement to you.`,
  },
];

const bodyFor = (loc) => [
  `Better Body Bootcamp ${loc.name} is a group fitness and bootcamp gym in ${loc.name}, ${loc.borough}, New York, located at ${loc.address}. We run high-energy, coach-led bootcamp, HIIT, and strength classes 7 days a week for all fitness levels.`,
  `New to the studio? Try 2 weeks of unlimited classes for $49. Reserve a class online or call ${loc.phone}.`,
];

// Non-location SEO routes.
const EXTRA_ROUTES = [
  {
    path: '/queens',
    title: 'Gyms in Queens, NY · Bootcamp Classes · $49 Trial | Better Body Bootcamp',
    description:
      'Better Body Bootcamp has 3 gyms in Queens — Astoria, Bayside, and Fresh Meadows. High-energy bootcamp, HIIT, and strength classes 7 days a week. Try 2 weeks for $49.',
    body: [
      'Better Body Bootcamp operates three gyms in Queens, New York: Astoria (31-18 Steinway Street), Bayside (3447 Bell Blvd), and Fresh Meadows (76-46 164th Street). Each studio offers coach-led bootcamp, HIIT, strength, and conditioning classes 7 days a week for all fitness levels.',
      'Try any Queens location with a 2-week trial for $49. Find your nearest studio and reserve a class online.',
    ],
    faq: [
      {
        q: 'How many Better Body Bootcamp gyms are in Queens?',
        a: 'Three — Astoria, Bayside, and Fresh Meadows. A fourth Better Body Bootcamp studio is in Williamsburg, Brooklyn.',
      },
      {
        q: 'How much is a Better Body Bootcamp membership in Queens?',
        a: 'New members start with a 2-week trial for $49 that includes unlimited classes at any Queens studio. Monthly and annual memberships are available after the trial.',
      },
    ],
  },
];

// ── HTML builders ────────────────────────────────────────────────────────────
function faqJsonLd(faq, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    mainEntity: faq.map((e, i) => ({
      '@type': 'Question',
      '@id': `${url}#faq-q${i + 1}`,
      name: e.q,
      acceptedAnswer: { '@type': 'Answer', text: e.a },
    })),
  };
}

function fallbackBody({ title, body, faq }) {
  // Rendered inside <div id="root"> — React's createRoot(...).render() replaces
  // this on mount, so real users never see it; non-JS crawlers keep it.
  const h1 = escHtml(title.split('|')[0].split('·')[0].trim());
  const paras = body.map((p) => `      <p>${escHtml(p)}</p>`).join('\n');
  const faqHtml = faq && faq.length
    ? '\n      <h2>Frequently asked questions</h2>\n' +
      faq
        .map((e) => `      <h3>${escHtml(e.q)}</h3>\n      <p>${escHtml(e.a)}</p>`)
        .join('\n')
    : '';
  return `<div id="prerender-seo">\n      <h1>${h1}</h1>\n${paras}${faqHtml}\n    </div>`;
}

function renderRoute(template, route) {
  const url = `${BASE}${route.path}`;
  const fullTitle = route.title;
  const desc = route.description;
  let html = template;

  // <title>
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escHtml(fullTitle)}</title>`);
  // meta description
  html = html.replace(
    /<meta name="description"[^>]*>/,
    `<meta name="description" content="${escAttr(desc)}" />`
  );
  // canonical
  html = html.replace(
    /<link rel="canonical"[^>]*>/,
    `<link rel="canonical" href="${escAttr(url)}" />`
  );
  // OG + Twitter title/description/url
  html = html
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${escAttr(fullTitle)}" />`)
    .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${escAttr(desc)}" />`)
    .replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${escAttr(url)}" />`)
    .replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${escAttr(fullTitle)}" />`)
    .replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${escAttr(desc)}" />`);

  // FAQ JSON-LD (the Organization + 4 LocalBusiness @graph is already in the
  // template head from index.html, so we only add the page-specific FAQPage).
  if (route.faq && route.faq.length) {
    const ld = `    <script type="application/ld+json">\n${JSON.stringify(
      faqJsonLd(route.faq, url),
      null,
      2
    )}\n    </script>\n  </head>`;
    html = html.replace('</head>', ld);
  }

  // No-JS body fallback inside #root.
  const fallback = fallbackBody(route);
  html = html.replace('<div id="root"></div>', `<div id="root">${fallback}</div>`);

  return html;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const templatePath = join(DIST, 'index.html');
let template;
try {
  template = readFileSync(templatePath, 'utf8');
} catch (e) {
  console.error(`[prerender] FATAL: cannot read ${templatePath}. Did vite build run?`);
  process.exit(1);
}

const routes = [
  ...LOCATIONS.map((l) => ({
    path: l.path,
    title: l.title,
    description: l.description,
    body: bodyFor(l),
    faq: faqFor(l),
  })),
  ...EXTRA_ROUTES,
];

let count = 0;
for (const route of routes) {
  const outDir = join(DIST, route.path.replace(/^\//, ''));
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'index.html');
  const html = renderRoute(template, route);
  writeFileSync(outFile, html, 'utf8');
  count++;
  console.log(`[prerender] wrote ${route.path}/index.html`);
}
console.log(`[prerender] done — ${count} static SEO routes generated.`);
