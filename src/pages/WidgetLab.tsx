// 2026-06-25: Mariana Tek widget design lab — sandbox page for iterating on
// how we embed the schedule widget on customer pages. Uses the MT sandbox
// tenant so we see real sample classes.
//
// PRIVACY MODEL: this page is NOT password-protected. It's reachable to anyone
// who knows the URL (/widget-lab). To keep it out of public discovery:
//   - Path is not linked from anywhere on the site (no nav, no sitemap, no
//     internal links).
//   - <Helmet> below injects noindex,nofollow,noarchive,nosnippet meta tags.
//   - No SEO schema, no canonical, no OG tags.
// If we ever need real privacy on this, move the route back under /staging/*
// (which is gated by netlify/edge-functions/staging-auth.ts).
//
// Each "Variant" below is a different presentation treatment of the SAME MT
// widget. Goal: pick the look we want for production, then port it back into
// LocationSchedule.tsx + LocationDetail.tsx.

import { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { MapPin, Phone, Calendar, ArrowRight, Clock } from 'lucide-react';

// 2026-06-25: Switched from MT sandbox to PRODUCTION tenant. Sandbox loader
// collided with index.html's production runtime (two MT JS instances fight for
// the same [data-mariana-integrations] divs and one of them ends up rendering
// nothing). Using production tenant means we only need the runtime that's
// already loaded site-wide, and we see real BBB class data — useful for design.
const PROD_TENANT          = 'betterbodybootcamp';
const PROD_CLASS_TYPE_ID   = 48541;                              // matches LocationSchedule.tsx
const PROD_BAYSIDE_LOCATION = 48718;                             // Bayside (per-studio location ID)
const SCHEDULE_PATH = `/schedule/daily/${PROD_CLASS_TYPE_ID}?locations=${PROD_BAYSIDE_LOCATION}`;

// Force the MT runtime to re-scan any [data-mariana-integrations] divs after
// our component mounts (the runtime auto-scans on initial load, before React
// has mounted lazy-loaded routes — so we have to nudge it).
// 2026-06-26 (REAL FIX): MT exposes `window.MTIntegrations.render(selector)` —
// `document.querySelector` matches the FIRST element only. For multi-widget
// lab pages we have to call render() once per div with a unique selector.
declare global {
  interface Window {
    MTIntegrations?: { render: (selector?: string) => void };
  }
}
function reInitMT() {
  const tryInit = (attempts: number) => {
    if (typeof window.MTIntegrations?.render === 'function') {
      // Walk every MT div and mount each one individually via a unique data-mt-id.
      const divs = Array.from(document.querySelectorAll('[data-mariana-integrations]')) as HTMLElement[];
      divs.forEach((div, i) => {
        if (!div.dataset.mtId) div.dataset.mtId = `mt-${i}-${Date.now()}`;
        if (div.children.length > 0) return; // already mounted
        try { window.MTIntegrations!.render(`[data-mt-id="${div.dataset.mtId}"]`); }
        catch (e) { console.warn('MT mount failed for', div.dataset.mtId, e); }
      });
      return;
    }
    if (attempts > 0) setTimeout(() => tryInit(attempts - 1), 500);
  };
  tryInit(10);
}

// Compact widget shell — each variant wraps this. We give each instance a
// unique `key` so React doesn't try to share the iframe DOM between variants.
function MTWidget({ minHeight = 600, variantKey }: { minHeight?: number; variantKey: string }) {
  return (
    <div
      key={variantKey}
      data-mariana-integrations={SCHEDULE_PATH}
      style={{ minHeight, width: '100%' }}
    />
  );
}

// Variant wrapper — standard label + description + variant body. Encourages
// us to write down WHAT we're trying with each one.
function Variant({
  letter, title, notes, children,
}: {
  letter: string;
  title: string;
  notes: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-16">
      <div className="max-w-5xl mx-auto px-4 mb-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-red-600 text-white font-black text-base">
            {letter}
          </span>
          <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight">{title}</h2>
        </div>
        <p className="text-gray-400 text-sm sm:text-base max-w-3xl leading-relaxed">{notes}</p>
      </div>
      {children}
      <div className="text-center mt-3">
        <span className="inline-block text-xs text-gray-600 italic">— end variant {letter} —</span>
      </div>
    </section>
  );
}

export default function WidgetLab() {
  const [studioName, setStudioName] = useState('Williamsburg');
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Production MT runtime is loaded in index.html — we just need to nudge
    // it to re-scan once React mounts our integration divs.
    reInitMT();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-white pb-24">
      {/* Keep search engines + previewers out of this page entirely.
          robots: prevent indexing/following. googlebot adds nosnippet so
          even a manual fetch can't surface a preview snippet anywhere. */}
      <Helmet>
        <title>Widget Lab · Internal</title>
        <meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />
        <meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet, noimageindex" />
        <meta name="referrer" content="no-referrer" />
      </Helmet>

      {/* Lab header */}
      <div className="bg-gradient-to-br from-red-700 to-red-900 border-b-4 border-red-500" ref={heroRef}>
        <div className="max-w-5xl mx-auto px-4 py-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/30 border border-red-300/40 mb-4">
            <span className="text-yellow-300 text-[11px] font-black tracking-[0.25em] uppercase">
              ⚠ Design Lab · Not Public
            </span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-black tracking-tight mb-3">
            MT Widget Embed Design Lab
          </h1>
          <p className="text-red-100 text-base sm:text-lg leading-relaxed max-w-3xl">
            Iterate on how we present the Mariana Tek schedule widget on{' '}
            <code className="bg-black/30 px-1.5 py-0.5 rounded text-xs">/schedule/[slug]</code>{' '}
            and{' '}
            <code className="bg-black/30 px-1.5 py-0.5 rounded text-xs">/locations/[slug]</code>.
            Each variant below renders the same widget against MT's sandbox
            tenant. Pick the treatment that feels right and we port it to prod.
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-6 text-xs text-red-200/80">
            <span>Tenant: <code className="bg-black/30 px-1.5 py-0.5 rounded">{PROD_TENANT}</code></span>
            <span>Class type: <code className="bg-black/30 px-1.5 py-0.5 rounded">{PROD_CLASS_TYPE_ID}</code></span>
            <span>Location: <code className="bg-black/30 px-1.5 py-0.5 rounded">{PROD_BAYSIDE_LOCATION} (Bayside)</code></span>
          </div>
        </div>
      </div>

      {/* Studio name field — just affects the surrounding context copy, not
          the MT data (sandbox tenant is fixed at Williamsburg). */}
      <div className="bg-zinc-900 border-b border-zinc-800 py-4">
        <div className="max-w-5xl mx-auto px-4 flex items-center gap-3 text-sm">
          <label className="text-gray-400">Mock studio name (for variant context only):</label>
          <input
            type="text"
            value={studioName}
            onChange={e => setStudioName(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-red-500"
          />
        </div>
      </div>

      <div className="py-12">

        {/* ─────────────────────────────────────────────────────────────────
            VARIANT A — Minimal flush embed (no card, no chrome)
            ───────────────────────────────────────────────────────────────── */}
        <Variant
          letter="A"
          title="Flush embed — no chrome"
          notes="Widget sits directly on the page background. No card wrapper. Cleanest, least visual noise. Tradeoff: widget edges may feel exposed if MT's own UI doesn't have padding."
        >
          <div className="bg-white">
            <div className="max-w-5xl mx-auto">
              <MTWidget variantKey="variant-a" minHeight={650} />
            </div>
          </div>
        </Variant>

        {/* ─────────────────────────────────────────────────────────────────
            VARIANT B — Card-wrapped, soft shadow (current production style)
            ───────────────────────────────────────────────────────────────── */}
        <Variant
          letter="B"
          title="Soft card — current style"
          notes="Widget inside a rounded white card with thin border + shadow. Centered on a light gray page background. This is what we had before hiding the widget — safe default."
        >
          <div className="bg-gray-50 py-10">
            <div className="max-w-5xl mx-auto px-4">
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-3 sm:p-5 md:p-6">
                <MTWidget variantKey="variant-b" minHeight={650} />
              </div>
            </div>
          </div>
        </Variant>

        {/* ─────────────────────────────────────────────────────────────────
            VARIANT C — Branded header strip + clean white body
            ───────────────────────────────────────────────────────────────── */}
        <Variant
          letter="C"
          title="Branded header strip"
          notes="Dark BBB header band sits on top of the widget card with studio name + 'Book a class' eyebrow. Anchors the widget to the brand without dominating it."
        >
          <div className="bg-gray-50 py-10">
            <div className="max-w-5xl mx-auto px-4">
              <div className="rounded-2xl overflow-hidden shadow-md border border-gray-200">
                <div className="bg-gradient-to-r from-zinc-950 to-black px-6 py-5 text-white flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <div className="text-red-400 text-[11px] font-black tracking-[0.25em] uppercase mb-1">
                      Book a Class · {studioName}
                    </div>
                    <h3 className="text-xl sm:text-2xl font-black tracking-tight">
                      This Week's Schedule
                    </h3>
                  </div>
                  <a
                    href="tel:+16465668870"
                    className="inline-flex items-center gap-2 text-sm font-bold text-white/80 hover:text-white"
                  >
                    <Phone className="w-4 h-4 text-red-400" />
                    Or call (646) 566-8870
                  </a>
                </div>
                <div className="bg-white p-2 sm:p-4">
                  <MTWidget variantKey="variant-c" minHeight={650} />
                </div>
              </div>
            </div>
          </div>
        </Variant>

        {/* ─────────────────────────────────────────────────────────────────
            VARIANT D — Side context (studio info card alongside widget)
            ───────────────────────────────────────────────────────────────── */}
        <Variant
          letter="D"
          title="Side-by-side: studio context + widget"
          notes="Studio info pinned to the left (address, phone, hours, 'first time?' CTA), widget takes the rest of the space on desktop. On mobile it stacks. Best for sticky context — visitors don't have to scroll back up to find the address."
        >
          <div className="bg-gray-50 py-10">
            <div className="max-w-6xl mx-auto px-4">
              <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
                <aside className="bg-white border border-gray-200 rounded-2xl p-6 self-start lg:sticky lg:top-24">
                  <div className="text-red-600 text-[11px] font-black tracking-[0.25em] uppercase mb-2">
                    {studioName} · Studio
                  </div>
                  <h3 className="text-xl font-black text-black mb-4 tracking-tight">
                    {studioName}
                  </h3>
                  <div className="space-y-3 text-sm text-gray-700 mb-5">
                    <div className="flex items-start gap-2">
                      <MapPin className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                      <span>487 Driggs Ave, Brooklyn, NY 11211</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <Phone className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                      <a href="tel:+17186831864" className="hover:text-red-600">
                        (718) 683-1864
                      </a>
                    </div>
                    <div className="flex items-start gap-2">
                      <Clock className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                      <span>Mon–Fri 6a–9p · Sat/Sun 8a–12p</span>
                    </div>
                  </div>
                  <a
                    href="/trial/williamsburg"
                    className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2.5 rounded-full text-sm transition-all w-full justify-center"
                  >
                    Start 2-Week Trial · $49
                    <ArrowRight className="w-3.5 h-3.5" />
                  </a>
                </aside>
                <div className="bg-white border border-gray-200 rounded-2xl p-2 sm:p-4 shadow-sm">
                  <MTWidget variantKey="variant-d" minHeight={650} />
                </div>
              </div>
            </div>
          </div>
        </Variant>

        {/* ─────────────────────────────────────────────────────────────────
            VARIANT E — Full-bleed dark surround (widget pops out of darkness)
            ───────────────────────────────────────────────────────────────── */}
        <Variant
          letter="E"
          title="Dark surround — widget as spotlight"
          notes="Page background is BBB dark. Widget card sits on top with strong shadow + soft red glow. Feels more premium. Use this if we want the schedule to feel like the centerpiece of the page rather than an iframe stapled on."
        >
          <div className="bg-black py-14 relative overflow-hidden">
            {/* Brand glow */}
            <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full bg-red-600/20 blur-[120px] pointer-events-none" />
            <div className="absolute -bottom-32 -right-32 w-[500px] h-[500px] rounded-full bg-red-700/15 blur-[140px] pointer-events-none" />
            <div className="max-w-5xl mx-auto px-4 relative">
              <div className="text-center mb-6">
                <span className="inline-block text-red-400 text-[11px] font-black tracking-[0.25em] uppercase mb-2">
                  This Week · {studioName}
                </span>
                <h3 className="text-3xl sm:text-4xl font-black text-white tracking-tight">
                  Find your class
                </h3>
              </div>
              <div className="bg-white rounded-2xl shadow-2xl shadow-red-900/30 ring-1 ring-red-500/20 p-2 sm:p-4">
                <MTWidget variantKey="variant-e" minHeight={650} />
              </div>
            </div>
          </div>
        </Variant>

        {/* ─────────────────────────────────────────────────────────────────
            VARIANT F — Compact "this week glance" + full schedule link
            ───────────────────────────────────────────────────────────────── */}
        <Variant
          letter="F"
          title="Glance + drilldown"
          notes="On /locations/[slug] we don't need the full schedule fighting for attention — show a short preview (today + tomorrow), then link out to the full /schedule/[slug]. Reduces clutter on the location page itself."
        >
          <div className="bg-gray-50 py-10">
            <div className="max-w-3xl mx-auto px-4">
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Calendar className="w-5 h-5 text-red-600" />
                    <h3 className="text-base font-black text-black tracking-tight">
                      Next 48 hours at {studioName}
                    </h3>
                  </div>
                  <a
                    href="/schedule/williamsburg"
                    className="text-red-600 hover:text-red-700 text-xs font-black tracking-wide flex items-center gap-1"
                  >
                    FULL SCHEDULE
                    <ArrowRight className="w-3.5 h-3.5" />
                  </a>
                </div>
                <div className="p-2 sm:p-3">
                  <MTWidget variantKey="variant-f" minHeight={420} />
                </div>
              </div>
            </div>
          </div>
        </Variant>

        <div className="max-w-5xl mx-auto px-4 text-center pt-4">
          <div className="inline-block bg-zinc-900 border border-zinc-800 rounded-2xl px-8 py-6 text-sm text-gray-400">
            That's it — pick a variant and tell me to ship.
            <br />
            <span className="text-xs text-gray-600">
              Or add a new one by copying a &lt;Variant&gt; block above and tweaking the styles.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
