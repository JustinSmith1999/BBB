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
    title: 'Gym in Astoria, Queens · Bootcamp Classes · $49 Trial | Better Body Bootcamp',
    description:
      'Bootcamp and HIIT gym on Steinway Street in Astoria, Queens. Coach-led classes 7 days a week for all levels, expert trainers, real results. Try 2 weeks for $49.',
    address: '31-18 Steinway Street, Astoria, NY 11103',
    phone: '(718) 704-9954',
    nearby: 'in the heart of the Steinway Street shopping district, a short walk from the N and W trains',
    unique: [
      'Our Astoria studio sits right on Steinway Street, so you can hit a class before or after work and grab everything else you need on the same block. It is one of the most convenient bootcamp gyms in Astoria for anyone living or working around Ditmars, Steinway, and Long Island City.',
      'Classes here draw a genuine cross-section of Astoria — first-timers, busy professionals, and longtime members who train together and push each other. Every session is coach-led and scaled to you, so you are never lost in a crowd.',
    ],
  },
  {
    path: '/locations/bayside',
    name: 'Bayside',
    borough: 'Queens',
    title: 'Gym in Bayside, Queens · Bootcamp Classes · $49 Trial | Better Body Bootcamp',
    description:
      'Bootcamp, HIIT, and personal training on Bell Blvd in Bayside, Queens. Coach-led group classes plus 1-on-1 and small group training. Try 2 weeks for $49.',
    address: '3447 Bell Blvd, Bayside, NY 11361',
    phone: '(646) 566-8870',
    nearby: 'right on Bell Boulevard, steps from the LIRR Bayside station and Bell Blvd’s restaurant row',
    unique: [
      'Our Bayside studio is on Bell Boulevard, minutes from the LIRR and the shops and restaurants Bayside is known for. It is a top choice for bootcamp classes in northeast Queens, serving Bayside, Douglaston, Little Neck, and Auburndale.',
      'Bayside is one of our two studios that also offers 1-on-1 personal training and small group training, so you can mix high-energy group classes with focused, private coaching all in one place.',
    ],
  },
  {
    path: '/locations/fresh-meadows',
    name: 'Fresh Meadows',
    borough: 'Queens',
    title: 'Gym in Fresh Meadows, Queens · Bootcamp Classes · $49 Trial | Better Body Bootcamp',
    description:
      'Bootcamp, HIIT, and personal training on 164th Street in Fresh Meadows, Queens. Coach-led group classes plus 1-on-1 and small group training. Try 2 weeks for $49.',
    address: '76-46 164th Street, Fresh Meadows, NY 11366',
    phone: '(646) 566-8207',
    nearby: 'on 164th Street near the Fresh Meadows shopping center and Utopia Parkway',
    unique: [
      'Our Fresh Meadows studio on 164th Street is easy to reach from the Fresh Meadows shopping center, Utopia Parkway, and the surrounding neighborhoods of Flushing, Jamaica Estates, and Hillcrest. Free-flowing parking and a welcoming room make it an easy place to build a real routine.',
      'Fresh Meadows also offers 1-on-1 personal training and small group training alongside our group classes, so whether you want the energy of a full class or a private coach, you have both under one roof.',
    ],
  },
  {
    path: '/locations/williamsburg',
    name: 'Williamsburg',
    borough: 'Brooklyn',
    title: 'Gym in Williamsburg, Brooklyn · Bootcamp Classes · $49 Trial | Better Body Bootcamp',
    description:
      'Bootcamp and HIIT gym on Driggs Ave in Williamsburg, Brooklyn. Coach-led group classes 7 days a week for all levels. Try 2 weeks for $49.',
    address: '487 Driggs Ave, Brooklyn, NY 11211',
    phone: '(718) 683-1864',
    nearby: 'on Driggs Avenue near McCarren Park and the Bedford Avenue L train',
    unique: [
      'Our Williamsburg studio is on Driggs Avenue, a short walk from McCarren Park and the Bedford Avenue L, putting a high-energy bootcamp right in the middle of North Brooklyn. It is a favorite for anyone in Williamsburg, Greenpoint, and East Williamsburg looking for a workout with real structure.',
      'Every class is coach-led and programmed to challenge all levels, from your first workout back to your hundredth. Come for the energy, stay for the community and the results.',
    ],
  },
];

// Shared FAQ (facts are true for every studio). Rendered as visible text +
// FAQPage JSON-LD so answer engines can cite specific questions.
const faqFor = (loc) => {
  const offersPrivate = loc.name === 'Bayside' || loc.name === 'Fresh Meadows';
  return [
    {
      q: `Where is Better Body Bootcamp ${loc.name} located?`,
      a: `Better Body Bootcamp ${loc.name} is located at ${loc.address}, ${loc.nearby}. Reserve a class online or call ${loc.phone}.`,
    },
    {
      q: `How much does Better Body Bootcamp ${loc.name} cost?`,
      a: `New members start with a 2-week trial for $49, which includes unlimited bootcamp and group fitness classes at our ${loc.name} studio. After the trial, monthly and annual memberships are available — ask the front desk or call ${loc.phone}.`,
    },
    {
      q: `What are the class hours at the ${loc.name} studio?`,
      a: `Better Body Bootcamp ${loc.name} runs coached classes 7 days a week, generally between 6:00 AM and 9:00 PM. Live class times update on the schedule page — reserve your spot online or call ${loc.phone}.`,
    },
    {
      q: `What kind of workouts does Better Body Bootcamp ${loc.name} offer?`,
      a: offersPrivate
        ? `Every group session is coach-programmed bootcamp, HIIT, strength, and conditioning for all levels. Our ${loc.name} studio also offers 1-on-1 personal training and small group training for more focused, private coaching.`
        : `Every session is coach-programmed: high-energy bootcamp, HIIT, strength training, and conditioning in a supportive group setting in ${loc.name}, ${loc.borough}. All levels welcome — trainers scale each movement to you.`,
    },
  ];
};

const bodyFor = (loc) => [
  `Better Body Bootcamp ${loc.name} is a group fitness and bootcamp gym in ${loc.name}, ${loc.borough}, New York, located at ${loc.address} — ${loc.nearby}. We run high-energy, coach-led bootcamp, HIIT, strength, and conditioning classes 7 days a week for all fitness levels.`,
  ...loc.unique,
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
  {
    path: '/services',
    title: 'Services · Group & Personal Training, InBody, Nutrition | Better Body Bootcamp',
    description:
      'Better Body Bootcamp services: coach-led group training, small group training, 1-on-1 personal training, InBody body composition scans, and nutritional consultations across 4 NYC studios.',
    body: [
      'Better Body Bootcamp offers a full range of training and wellness services across our four New York studios in Astoria, Bayside, Fresh Meadows, and Williamsburg. Group training — our signature coach-led bootcamp, HIIT, strength, and conditioning classes — is available at all four locations for every fitness level.',
      'Small group training (2–6 people) and 1-on-1 personal training are available at our Bayside and Fresh Meadows studios for members who want more focused, private coaching. InBody body composition scans and nutritional consultations are available at all four studios to help you track progress and eat toward your goals.',
      'New to Better Body Bootcamp? Start with a 2-week trial for $49 and experience it for yourself.',
    ],
    faq: [
      {
        q: 'What services does Better Body Bootcamp offer?',
        a: 'Group training, small group training, 1-on-1 personal training, InBody body composition scans, and nutritional consultations. Group training, InBody, and nutrition are offered at all four studios.',
      },
      {
        q: 'Which studios offer personal training and small group training?',
        a: 'One-on-one personal training and small group training are offered at our Bayside and Fresh Meadows studios. Group classes are available at all four locations.',
      },
    ],
  },
  {
    path: '/pricing',
    title: 'Pricing & Membership · 2-Week Trial for $49 | Better Body Bootcamp NYC',
    description:
      'Better Body Bootcamp pricing: start with a 2-week unlimited trial for $49, then choose a monthly or annual membership. Coach-led bootcamp and group fitness at 4 NYC studios.',
    body: [
      'Better Body Bootcamp keeps pricing simple. New members start with a 2-week trial for $49 that includes unlimited coach-led bootcamp, HIIT, and strength classes at any of our four NYC studios — Astoria, Bayside, Fresh Meadows, and Williamsburg.',
      'After the trial, monthly and annual memberships are available, along with class packs. Ask the front desk at your studio or call to find the plan that fits how often you want to train.',
    ],
    faq: [
      {
        q: 'How much does Better Body Bootcamp cost?',
        a: 'New members start with a 2-week trial for $49 with unlimited classes. After that, monthly and annual memberships and class packs are available at every studio.',
      },
      {
        q: 'Is there a trial for new members?',
        a: 'Yes — a 2-week trial for $49 gives new members unlimited coach-led classes at any Better Body Bootcamp studio, so you can try it before committing to a membership.',
      },
    ],
  },
  {
    path: '/classes',
    title: 'Class Schedule · Bootcamp, HIIT & Strength Classes | Better Body Bootcamp NYC',
    description:
      'See the Better Body Bootcamp class schedule. Coach-led bootcamp, HIIT, strength, and conditioning classes 7 days a week across Astoria, Bayside, Fresh Meadows, and Williamsburg.',
    body: [
      'Better Body Bootcamp runs coach-led classes 7 days a week across our four NYC studios. Every session blends high-energy bootcamp, HIIT, strength, and conditioning, and is programmed and scaled by a coach so all fitness levels can train together.',
      'Reserve your spot online, choose your studio and class time, and just show up. New members can try 2 weeks of unlimited classes for $49.',
    ],
    faq: [
      {
        q: 'What kinds of classes does Better Body Bootcamp offer?',
        a: 'Coach-led bootcamp, HIIT, strength, and conditioning classes for all levels, 7 days a week. Every movement is scaled to the individual, so beginners and veterans train side by side.',
      },
    ],
  },
  {
    path: '/about',
    title: 'About Better Body Bootcamp · NYC Group Fitness Since 2011',
    description:
      "Better Body Bootcamp has been a New York group fitness home since 2011 — coach-led bootcamp, HIIT, and strength across 4 studios in Queens and Brooklyn. Meet our approach and team.",
    body: [
      'Better Body Bootcamp has been helping New Yorkers get stronger since 2011. What started as a single bootcamp has grown into four studios across Queens and Brooklyn — Astoria, Bayside, Fresh Meadows, and Williamsburg — built on the same idea: coach-led group training that meets you where you are and pushes you to get better.',
      'Every class is programmed and coached, never a follow-along video. Our trainers scale each workout to the person, so a total beginner and a seasoned athlete can train in the same room and both leave better than they came in.',
    ],
    faq: [
      {
        q: 'How long has Better Body Bootcamp been around?',
        a: 'Better Body Bootcamp has operated in New York City since 2011 and now runs four studios across Queens and Brooklyn.',
      },
    ],
  },
  {
    path: '/faq',
    title: 'Frequently Asked Questions | Better Body Bootcamp NYC',
    description:
      'Answers about Better Body Bootcamp classes, the $49 two-week trial, memberships, locations, and what to expect at your first bootcamp class in NYC.',
    body: [
      'Have questions about getting started at Better Body Bootcamp? Below are answers to what new members ask most about our classes, trial, memberships, and studios in Astoria, Bayside, Fresh Meadows, and Williamsburg.',
    ],
    faq: [
      {
        q: 'What should I expect at my first bootcamp class?',
        a: 'Arrive 10–15 minutes early, wear comfortable workout clothes and sneakers, and bring water. A coach will greet you, learn any limitations, and scale the workout to your level. Every class is beginner-friendly.',
      },
      {
        q: 'Do I need to be in shape to start?',
        a: 'No. Every workout is scaled by a coach to your current fitness level, so beginners are welcome and train alongside more experienced members.',
      },
      {
        q: 'How much does it cost to join?',
        a: 'New members start with a 2-week trial for $49 with unlimited classes. Monthly and annual memberships are available afterward.',
      },
      {
        q: 'Where are Better Body Bootcamp studios located?',
        a: 'We have four NYC studios: Astoria (Steinway Street), Bayside (Bell Blvd), and Fresh Meadows (164th Street) in Queens, plus Williamsburg (Driggs Ave) in Brooklyn.',
      },
    ],
  },
  {
    path: '/trial',
    title: 'Start Your 2-Week Trial for $49 | Better Body Bootcamp NYC',
    description:
      'Try Better Body Bootcamp for 2 weeks for $49 — unlimited coach-led bootcamp, HIIT, and strength classes at any of our 4 NYC studios. New members only. Reserve online.',
    body: [
      'Start with the Better Body Bootcamp 2-week trial for $49. It includes unlimited coach-led bootcamp, HIIT, and strength classes at any of our four NYC studios — Astoria, Bayside, Fresh Meadows, and Williamsburg — so you can feel the difference before you commit to a membership.',
      'The trial is for new members. Pick your studio, reserve your first class, and just start.',
    ],
    faq: [
      {
        q: 'What is included in the $49 trial?',
        a: 'Two weeks of unlimited coach-led classes at any Better Body Bootcamp studio. It is designed to let new members experience the classes and community before choosing a membership.',
      },
    ],
  },
  {
    path: '/testimonials',
    title: 'Member Reviews & Results | Better Body Bootcamp NYC',
    description:
      'Real Better Body Bootcamp members share their results and experience across our Astoria, Bayside, Fresh Meadows, and Williamsburg studios. See why members stay.',
    body: [
      'Better Body Bootcamp members come for the workout and stay for the results and the community. Across our four NYC studios, members have transformed their strength, energy, and confidence with coach-led group training.',
      'Read their stories, then try it yourself with a 2-week trial for $49.',
    ],
    faq: [],
  },
  {
    path: '/contact',
    title: 'Contact Us | Better Body Bootcamp NYC',
    description:
      'Get in touch with Better Body Bootcamp. Contact our Astoria, Bayside, Fresh Meadows, or Williamsburg studios by phone or message and start your fitness journey.',
    body: [
      'Have a question about classes, memberships, or getting started? Reach out to Better Body Bootcamp and we will get right back to you. You can contact any of our four NYC studios — Astoria, Bayside, Fresh Meadows, or Williamsburg — by phone or through our contact form.',
    ],
    faq: [],
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
