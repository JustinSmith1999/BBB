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
    title: 'Gym in Astoria, Queens · Group Fitness Classes · $49 Trial',
    description:
      'Bootcamp and HIIT gym on Steinway Street in Astoria, Queens. Coach-led classes 7 days a week for all levels, expert trainers, real results. Try 2 weeks for $49.',
    address: '31-18 Steinway Street, Astoria, NY 11103',
    phone: '(718) 704-9954',
    nearby: 'in the heart of the Steinway Street shopping district, a short walk from the N and W trains',
    serves: 'Astoria, Long Island City, Sunnyside, Woodside, Ditmars, and Astoria Heights',
    unique: [
      'Our Astoria studio sits right on Steinway Street, so you can hit a class before or after work and grab everything else you need on the same block. It is one of the most convenient bootcamp gyms in Astoria for anyone living or working around Ditmars, Steinway, and Long Island City.',
      'Classes here draw a genuine cross-section of Astoria — first-timers, busy professionals, and longtime members who train together and push each other. Every session is coach-led and scaled to you, so you are never lost in a crowd.',
      'Comparing gyms in Astoria? Blink Fitness, Planet Fitness, and Club Fitness are equipment-and-space gyms: solid if you already know your program. Better Body Bootcamp is a coaching gym: classes cap at 20, a coach programs and runs every session, and the $49 two-week trial lets you compare both models before committing anywhere. People also weigh us against local studios like Unlimited Body and The Row Astoria; the things to check there are class size caps and who actually programs the workout.',
    ],
  },
  {
    path: '/locations/bayside',
    name: 'Bayside',
    borough: 'Queens',
    title: 'Gym in Bayside, Queens · Group Fitness Classes · $49 Trial',
    description:
      'Bootcamp, HIIT, and personal training on Bell Blvd in Bayside, Queens. Coach-led group classes plus 1-on-1 and small group training. Try 2 weeks for $49.',
    address: '34-47 Bell Blvd, Bayside, NY 11361',
    phone: '(646) 566-8870',
    nearby: 'right on Bell Boulevard, steps from the LIRR Bayside station and Bell Blvd’s restaurant row',
    serves: 'Bayside, Bay Terrace, Whitestone, Auburndale, Douglaston, Little Neck, and Oakland Gardens',
    unique: [
      'Our Bayside studio is on Bell Boulevard, minutes from the LIRR and the shops and restaurants Bayside is known for. It is a top choice for bootcamp classes in northeast Queens, serving Bayside, Douglaston, Little Neck, and Auburndale.',
      'Bayside is one of our two studios that also offers 1-on-1 personal training and small group training, so you can mix high-energy group classes with focused, private coaching all in one place.',
    ],
  },
  {
    path: '/locations/fresh-meadows',
    name: 'Fresh Meadows',
    borough: 'Queens',
    title: 'Gym in Fresh Meadows, Queens · Group Fitness Classes · $49 Trial',
    description:
      'Bootcamp, HIIT, and personal training on 164th Street in Fresh Meadows, Queens. Coach-led group classes plus 1-on-1 and small group training. Try 2 weeks for $49.',
    address: '76-46 164th Street, Fresh Meadows, NY 11366',
    phone: '(646) 566-8207',
    nearby: 'on 164th Street near the Fresh Meadows shopping center and Utopia Parkway',
    serves: 'Fresh Meadows, Utopia, Hillcrest, Jamaica Estates, Flushing, Kew Gardens Hills, and Briarwood',
    unique: [
      'Our Fresh Meadows studio on 164th Street is easy to reach from the Fresh Meadows shopping center, Utopia Parkway, and the surrounding neighborhoods of Flushing, Jamaica Estates, and Hillcrest. Free-flowing parking and a welcoming room make it an easy place to build a real routine.',
      'Fresh Meadows also offers 1-on-1 personal training and small group training alongside our group classes, so whether you want the energy of a full class or a private coach, you have both under one roof.',
    ],
  },
  {
    path: '/locations/williamsburg',
    name: 'Williamsburg',
    borough: 'Brooklyn',
    title: 'Gym in Williamsburg, Brooklyn · Group Fitness Classes · $49 Trial',
    description:
      'Bootcamp and HIIT gym on Driggs Ave in Williamsburg, Brooklyn. Coach-led group classes 7 days a week for all levels. Try 2 weeks for $49.',
    address: '487 Driggs Ave, Brooklyn, NY 11211',
    phone: '(718) 683-1864',
    nearby: 'on Driggs Avenue near McCarren Park and the Bedford Avenue L train',
    serves: 'Williamsburg, Greenpoint, East Williamsburg, Bushwick, and Bedford-Stuyvesant',
    unique: [
      'Our Williamsburg studio is on Driggs Avenue, a short walk from McCarren Park and the Bedford Avenue L, putting a high-energy bootcamp right in the middle of North Brooklyn. It is a favorite for anyone in Williamsburg, Greenpoint, and East Williamsburg looking for a workout with real structure.',
      'Every class is coach-led and programmed to challenge all levels, from your first workout back to your hundredth. Come for the energy, stay for the community and the results.',
      'If you are searching for a gym in Brooklyn, Williamsburg is an easy place to start: we are on Driggs Ave near the Bedford L. Comparing studios? Barry’s Williamsburg runs treadmill-and-floor classes; ours are strength-first bootcamp with a 20-person cap and one coach running the whole room. The $49 two-week trial makes it cheap to test the difference yourself.',
    ],
  },
];

// Shared FAQ (facts are true for every studio). Rendered as visible text +
// FAQPage JSON-LD so answer engines can cite specific questions.
const faqFor = (loc) => {
  const offersPrivate = loc.name === 'Bayside' || loc.name === 'Fresh Meadows';
  return [
    {
      // 2026-09-02: new-ownership story first — mirrors the React FAQ so the
      // crawler-visible HTML answers "is BBB under new management" too.
      q: `Is Better Body Bootcamp ${loc.name} under new ownership?`,
      a: `Yes. Better Body Bootcamp has been under new ownership since October 2025, with new coaches and new programming across all four studios. The ${loc.name} community you know is the same; the training, coaching staff, and member experience have been rebuilt from the ground up.`,
    },
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
        ? `Every group session is coach-programmed: strength training, HIIT training, bootcamp classes, and hybrid training for all levels. Our ${loc.name} studio also offers 1-on-1 personal training and small group training for more focused, private coaching.`
        : `Every session is coach-programmed: strength training, HIIT training, bootcamp classes, and hybrid training in a supportive group setting in ${loc.name}, ${loc.borough}. All levels welcome — trainers scale each movement to you.`,
    },
  ];
};

const bodyFor = (loc) => [
  `Better Body Bootcamp ${loc.name} is a group fitness and bootcamp gym in ${loc.name}, ${loc.borough}, New York, located at ${loc.address} — ${loc.nearby}. Under new ownership since October 2025, with new coaches and new programming. We run high-energy, coach-led group fitness classes 7 days a week for all fitness levels: strength training, HIIT training, bootcamp classes, and hybrid training.`,
  ...loc.unique,
  `Classes run about 45 minutes and cap at 20 people, so the coach knows your name, can fix your form in the moment, and scales the work to your fitness goals. The first class of the day usually starts at 6:00 AM and the last wraps by 9:00 PM, 7 days a week. Most members settle into the same 3 or 4 time slots each week and it becomes a routine fast.`,
  `Membership includes unlimited group classes. InBody body composition scans and nutrition consultations are available too, so you track muscle and body fat numbers instead of guessing from the mirror. Better Body Bootcamp has been training New Yorkers since 2011, and the ${loc.name} studio serves ${loc.serves}.`,
  `New to the studio? The $49 trial is 2 weeks of unlimited classes with no enrollment fee. Book your first class online, tell the coach it is your first time, and they will take it from there. Reserve online or call ${loc.phone}.`,
];

// Non-location SEO routes.
const EXTRA_ROUTES = [
  {
    path: '/queens',
    title: 'Gyms in Queens, NY · $49 Trial | Better Body Bootcamp',
    description:
      'Better Body Bootcamp has 3 gyms in Queens — Astoria, Bayside, and Fresh Meadows. High-energy bootcamp, HIIT, and strength classes 7 days a week. Try 2 weeks for $49.',
    body: [
      'Better Body Bootcamp operates three gyms in Queens, New York: Astoria (31-18 Steinway Street), Bayside (34-47 Bell Blvd), and Fresh Meadows (76-46 164th Street). Each studio offers coach-led bootcamp, HIIT, strength, and conditioning classes 7 days a week for all fitness levels.',
      'Try any Queens location with a 2-week trial for $49. Find your nearest studio and reserve a class online.',
      'Looking for HIIT classes in Queens? Every Better Body Bootcamp class blends HIIT with strength work: intervals that push your heart rate, then weights that build muscle. Classes cap at 20 people so the coach can actually watch your form, and they run 7 days a week at all three Queens studios, generally from 6:00 AM to 9:00 PM.',
      'Between them, the three studios cover most of Queens: Astoria reaches Long Island City, Sunnyside, and Woodside; Bayside reaches Whitestone, Douglaston, and Little Neck; Fresh Meadows reaches Flushing, Jamaica Estates, and Kew Gardens Hills.',
    ],
    faq: [
      {
        q: 'How many Better Body Bootcamp gyms are in Queens?',
        a: 'Three — Astoria, Bayside, and Fresh Meadows. A fourth Better Body Bootcamp studio is in Williamsburg, Brooklyn.',
      },
      {
        q: 'Where can I take HIIT classes in Queens?',
        a: 'Better Body Bootcamp runs coach-led HIIT and strength classes 7 days a week at three Queens studios: Astoria (Steinway Street), Bayside (Bell Blvd), and Fresh Meadows (164th Street). Classes cap at 20 people. New members get 2 weeks unlimited for $49.',
      },
      {
        q: 'How much is a Better Body Bootcamp membership in Queens?',
        a: 'New members start with a 2-week trial for $49 that includes unlimited classes at any Queens studio. Monthly and annual memberships are available after the trial.',
      },
    ],
  },
  {
    path: '/brooklyn',
    title: 'Best Gym in Williamsburg, Brooklyn · $49 Trial | Better Body Bootcamp',
    description:
      'The top coach-led gym in Williamsburg, Brooklyn. Bootcamp, HIIT, strength & group fitness classes on Driggs Ave, capped at 20 per class. Serving Williamsburg, Greenpoint, East Williamsburg & Bushwick. 2 weeks for $49.',
    body: [
      'Better Body Bootcamp is a coach-led gym in Williamsburg, Brooklyn, at 487 Driggs Ave, a few minutes from the Bedford Ave L. Every class caps at 20 people and is programmed and run by a coach, so you get real coaching instead of a self-serve floor of machines.',
      'We serve Williamsburg and nearby Greenpoint, East Williamsburg, and Bushwick with bootcamp, HIIT, strength, and conditioning classes seven days a week. Start with a 2-week unlimited trial for $49.',
      'Comparing gyms in Williamsburg? The big-box gyms nearby sell equipment and space, and the boutique studios sell one class format. Better Body Bootcamp is a coaching gym: classes cap at 20, a coach programs and runs every session, and every movement gets scaled to your level. The $49 two-week trial exists so you can compare the models before committing anywhere.',
      'Classes run about 45 minutes, 7 days a week, with the first session around 6:00 AM and the last ending by 9:00 PM. Membership includes unlimited classes, plus InBody body composition scans and nutrition consultations. Better Body Bootcamp has been training New Yorkers since 2011.',
    ],
    faq: [
      {
        q: 'What is the best gym in Williamsburg, Brooklyn?',
        a: 'Better Body Bootcamp is a top-rated coach-led gym in Williamsburg on Driggs Ave near the Bedford Ave L. Every class caps at 20 with a coach programming the session. New members start with a 2-week trial for $49.',
      },
      {
        q: 'Is there a bootcamp or group fitness gym in Williamsburg?',
        a: 'Yes. Better Body Bootcamp Williamsburg runs coach-led bootcamp, HIIT, strength, and conditioning classes seven days a week at 487 Driggs Ave, serving Williamsburg, Greenpoint, East Williamsburg, and Bushwick.',
      },
    ],
  },
  {
    path: '/pricing',
    title: 'Pricing · $49 Two-Week Trial | Better Body Bootcamp NYC',
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
    title: 'Group Fitness Classes & Schedule | Better Body Bootcamp NYC',
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
    path: '/services',
    title: 'Personal Training, Group Classes & InBody | Better Body Bootcamp',
    description:
      'Explore Better Body Bootcamp services: coach-led group training, small group training, 1-on-1 personal training, InBody body composition scans, and nutritional consultations across our Astoria, Bayside, Fresh Meadows, and Williamsburg studios.',
    body: [
      'Better Body Bootcamp offers more than one way to train. Our signature coach-led group classes blend HIIT, strength, and conditioning for every level. Small group training gives you a tighter setting with more coaching attention, and 1-on-1 personal training builds a plan entirely around your goals.',
      'Beyond the workouts, InBody body composition scans track your real progress — muscle, fat, and more — and nutritional consultations help you fuel it. Small group and 1-on-1 personal training are available at our Bayside and Fresh Meadows studios; group training, InBody, and nutrition are offered across all four NYC locations.',
    ],
    faq: [
      {
        q: 'What services does Better Body Bootcamp offer?',
        a: 'Coach-led group training, small group training, 1-on-1 personal training, InBody body composition scans, and nutritional consultations. Group training, InBody, and nutrition are available at all four studios; small group and 1-on-1 personal training are offered at Bayside and Fresh Meadows.',
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

// Per-studio conversion + schedule pages. These are in the sitemap but had no
// prerender, so non-JS crawlers (and the Semrush audit) got the homepage shell
// at every one of them — 10 duplicate/thin pages. Derived from LOCATIONS so
// addresses/phones stay in one place.
const STUDIO_SUB_ROUTES = LOCATIONS.flatMap((l) => {
  const slug = l.path.split('/').pop();
  return [
    {
      path: `/trial/${slug}`,
      title: `$49 Two-Week Trial in ${l.name} | Better Body Bootcamp`,
      description: `Start a 2-week unlimited trial for $49 at Better Body Bootcamp ${l.name} (${l.address}). Coach-led bootcamp, HIIT, and strength classes for all levels. Reserve online.`,
      body: [
        `Start your Better Body Bootcamp ${l.name} trial: 2 weeks of unlimited coach-led classes for $49. Our studio is at ${l.address}, ${l.nearby}.`,
        `Every class is programmed and run by a coach and scaled to your level, so first-timers are welcome. Pick a class time, reserve your spot, and just show up. Questions? Call ${l.phone}.`,
      ],
      faq: [
        {
          q: `How do I start the $49 trial at Better Body Bootcamp ${l.name}?`,
          a: `Sign up online on this page, then reserve your first class at the ${l.name} studio (${l.address}). The trial includes 2 weeks of unlimited coach-led classes and is for new members.`,
        },
      ],
    },
    {
      path: `/schedule/${slug}`,
      title: `${l.name} Class Schedule | Better Body Bootcamp`,
      description: `See the live class schedule for Better Body Bootcamp ${l.name} (${l.address}). Coach-led bootcamp, HIIT, and strength classes 7 days a week. Reserve your spot online.`,
      body: [
        `Better Body Bootcamp ${l.name} runs coach-led bootcamp, HIIT, strength, and conditioning classes 7 days a week, generally between 6:00 AM and 9:00 PM, at ${l.address}.`,
        `The live schedule on this page updates in real time — pick a class, reserve online, and arrive 10–15 minutes early for your first session. New members can start with a 2-week unlimited trial for $49. Questions? Call ${l.phone}.`,
      ],
      faq: [],
    },
  ];
});

// Remaining sitemap pages that previously served the homepage shell to non-JS
// crawlers. Copy is lifted from the live React components — nothing invented.
const MORE_ROUTES = [
  {
    path: '/locations',
    title: 'Our 4 NYC Gym Locations · Queens & Brooklyn | Better Body Bootcamp',
    description:
      'Better Body Bootcamp has 4 NYC studios: Astoria, Bayside, and Fresh Meadows in Queens, plus Williamsburg in Brooklyn. Coach-led classes 7 days a week. Try 2 weeks for $49.',
    body: [
      'Better Body Bootcamp operates four studios across New York City: Astoria (31-18 Steinway Street), Bayside (34-47 Bell Blvd), and Fresh Meadows (76-46 164th Street) in Queens, plus Williamsburg (487 Driggs Ave) in Brooklyn.',
      'Every studio runs coach-led bootcamp, HIIT, strength, and conditioning classes 7 days a week for all levels. Pick the studio nearest you and start with a 2-week unlimited trial for $49.',
    ],
    faq: [],
  },
  {
    path: '/franchising',
    title: 'Franchise Opportunities | Better Body Bootcamp',
    description:
      'Own a Better Body Bootcamp franchise. Join a growing NYC bootcamp brand with a proven coach-led group fitness model operating since 2011.',
    body: [
      'Better Body Bootcamp has been running coach-led group fitness in New York City since 2011 and now operates four studios across Queens and Brooklyn. Our franchise program brings that proven model — capped coach-led classes, a $49 trial funnel, and a strong neighborhood community — to new owners and new markets.',
      'Interested in owning a Better Body Bootcamp? Get in touch through our contact page to learn about territories, investment, and support.',
    ],
    faq: [],
  },
  {
    path: '/careers',
    title: 'Careers · Join Our Team | Better Body Bootcamp NYC',
    description:
      'Join the Better Body Bootcamp team. We hire group fitness trainers, personal trainers, and front desk associates across our 4 NYC studios.',
    body: [
      'Better Body Bootcamp hires group fitness trainers, personal trainers, and front desk associates across our four NYC studios in Astoria, Bayside, Fresh Meadows, and Williamsburg.',
      'If you love coaching people and building community, we would love to hear from you. Reach out through our contact page with your experience and preferred studio.',
    ],
    faq: [],
  },
  {
    path: '/blog',
    title: 'Fitness Blog · Tips & Success Stories | Better Body Bootcamp NYC',
    description:
      'Fitness tips, workout insights, nutrition advice, and member success stories from Better Body Bootcamp, a coach-led group fitness community in NYC since 2011.',
    body: [
      'Fitness tips, workout insights, nutrition advice, and success stories from Better Body Bootcamp — a coach-led group fitness community with four studios across Queens and Brooklyn, training New Yorkers since 2011.',
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

// Crawlable internal-link block baked into every prerendered page's #root.
// React replaces #root on mount so real users never see it — but non-JS
// crawlers (AI answer engines + the audit crawler) use it to discover every
// money page from the raw HTML, and the descriptive anchors pass local
// keyword signals ("Williamsburg gym", "Gyms in Queens") to each target.
// NOTE: trailing slashes are deliberate — Netlify serves these directories at
// the slashed URL (301 from unslashed). Linking straight to the slashed form
// avoids 182 redirect hops the audit flagged and gives the sitemap URLs
// direct internal links (kills the "orphaned pages in sitemap" notice).
const SITE_LINKS = [
  ['/queens/', 'Gyms in Queens, NY'],
  ['/brooklyn/', 'Gym in Williamsburg, Brooklyn'],
  ['/locations/astoria/', 'Gym in Astoria, Queens'],
  ['/locations/bayside/', 'Gym in Bayside, Queens'],
  ['/locations/fresh-meadows/', 'Gym in Fresh Meadows, Queens'],
  ['/locations/williamsburg/', 'Williamsburg gym on Driggs Ave'],
  ['/services/', 'Training services'],
  ['/pricing/', 'Pricing & membership'],
  ['/classes/', 'Class schedule'],
  ['/about/', 'About us'],
  ['/faq/', 'FAQ'],
  ['/trial/', 'Start your $49 trial'],
  ['/trial/astoria/', '$49 trial in Astoria'],
  ['/trial/bayside/', '$49 trial in Bayside'],
  ['/trial/fresh-meadows/', '$49 trial in Fresh Meadows'],
  ['/trial/williamsburg/', '$49 trial in Williamsburg'],
  ['/schedule/astoria/', 'Astoria class schedule'],
  ['/schedule/bayside/', 'Bayside class schedule'],
  ['/schedule/fresh-meadows/', 'Fresh Meadows class schedule'],
  ['/schedule/williamsburg/', 'Williamsburg class schedule'],
  ['/locations/', 'All gym locations'],
  ['/testimonials/', 'Member reviews'],
  ['/careers/', 'Careers'],
  ['/franchising/', 'Franchise opportunities'],
  ['/blog/', 'Fitness blog'],
  ['/contact/', 'Contact'],
];
const navLinksHtml =
  '\n      <nav aria-label="Better Body Bootcamp pages">\n' +
  SITE_LINKS.map(([href, label]) => `        <a href="${href}">${escHtml(label)}</a>`).join('\n') +
  '\n      </nav>';

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
  return `<div id="prerender-seo">\n      <h1>${h1}</h1>\n${paras}${faqHtml}${navLinksHtml}\n    </div>`;
}

function renderRoute(template, route) {
  const url = route.path ? `${BASE}${route.path}/` : `${BASE}/`;
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

// Homepage — the most important page, previously shipped with an empty #root
// (no h1, no copy, no links) so non-JS + AI crawlers saw a blank page. path ''
// keeps the canonical/og:url at the bare domain (no trailing slash).
const HOME_ROUTE = {
  path: '',
  title: 'Better Body Bootcamp | NYC Group Fitness & Bootcamp Classes',
  description:
    "New York's premier group fitness bootcamp since 2011. High-energy HIIT, strength training, and fat-burning workouts at 4 NYC locations. Try 2 weeks for $49.",
  body: [
    'Better Body Bootcamp is a coach-led group fitness gym with four studios across New York City: Astoria, Bayside, and Fresh Meadows in Queens, plus Williamsburg in Brooklyn. Every class caps at 20 people and is programmed and run by a coach, so you get real coaching and real results instead of a self-serve floor of machines.',
    'We have been getting New Yorkers stronger since 2011 with fitness bootcamp, HIIT, strength, and conditioning classes seven days a week for every level. Under new ownership since October 2025, with new coaches and new programming across all four studios. New members start with a two-week unlimited trial for $49.',
  ],
  faq: [
    {
      q: 'Is Better Body Bootcamp under new ownership?',
      a: 'Yes. Better Body Bootcamp has been under new ownership since October 2025, with new coaches and new programming across all four studios in Queens and Brooklyn. Same neighborhood community, completely rebuilt training and member experience.',
    },
    {
      q: 'What is a fitness bootcamp class like at Better Body Bootcamp?',
      a: 'A coach-led group workout, capped at 20 people, that mixes strength training with high-intensity conditioning. The coach programs the session and scales every movement to your level, so first-timers and veterans train in the same room. Most classes run about 45 minutes.',
    },
    {
      q: 'Where are Better Body Bootcamp gyms located?',
      a: 'Four NYC studios: Astoria (Steinway Street), Bayside (Bell Blvd), and Fresh Meadows (164th Street) in Queens, plus Williamsburg (Driggs Ave) in Brooklyn.',
    },
    {
      q: 'How much does Better Body Bootcamp cost?',
      a: 'New members start with a two-week unlimited trial for $49. Monthly and annual memberships are available afterward, with no enrollment fee.',
    },
  ],
};

const routes = [
  ...LOCATIONS.map((l) => ({
    path: l.path,
    title: l.title,
    description: l.description,
    body: bodyFor(l),
    faq: faqFor(l),
  })),
  ...EXTRA_ROUTES,
  ...STUDIO_SUB_ROUTES,
  ...MORE_ROUTES,
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
// Homepage last: overwrite dist/index.html with prerendered content. Safe to do
// after the loop because `template` is already held in memory (the loop cloned
// it), so overwriting the file on disk doesn't affect the routes just written.
writeFileSync(join(DIST, 'index.html'), renderRoute(template, HOME_ROUTE), 'utf8');
count++;
console.log('[prerender] wrote / (homepage index.html)');

console.log(`[prerender] done — ${count} static SEO routes generated.`);
