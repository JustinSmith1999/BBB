import { Component, lazy, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import { captureUtmsFromUrl } from './lib/utm';
import { HelmetProvider } from 'react-helmet-async';
import Header from './components/Header';
import Footer from './components/Footer';
import ScrollToTop from './components/ScrollToTop';
// Eager: the LCP target for paid ad traffic.
import LocationTrialSignup from './pages/LocationTrialSignup';
import TrialSuccess from './pages/TrialSuccess';
// Lazy: everything else — split out of the trial-page bundle.
const Home = lazy(() => import('./pages/Home'));
const About = lazy(() => import('./pages/About'));
const FAQ = lazy(() => import('./pages/FAQ'));
const Blog = lazy(() => import('./pages/Blog'));
const Careers = lazy(() => import('./pages/Careers'));
const Franchising = lazy(() => import('./pages/Franchising'));
const Testimonials = lazy(() => import('./pages/Testimonials'));
const Contact = lazy(() => import('./pages/Contact'));
const Services = lazy(() => import('./pages/Services'));
const Locations = lazy(() => import('./pages/Locations'));
const LocationDetail = lazy(() => import('./pages/LocationDetail'));
// 2026-06-19: /queens hub page. Targets the generic "gyms in queens" query
// (currently P66 with /locations/fresh-meadows wrongly ranking). Consolidates
// Astoria + Bayside + Fresh Meadows into one topically dense landing page.
const Queens = lazy(() => import('./pages/Queens'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Classes = lazy(() => import('./pages/Classes'));
const ClassDetail = lazy(() => import('./pages/ClassDetail'));
const MyBookings = lazy(() => import('./pages/MyBookings'));
const TrialSignup = lazy(() => import('./pages/TrialSignup'));
const LocationSpecialSignup = lazy(() => import('./pages/LocationSpecialSignup'));
const LocationComebackSignup = lazy(() => import('./pages/LocationComebackSignup'));
const ComebackIndex = lazy(() => import('./pages/ComebackIndex'));
const LocationResignSignup = lazy(() => import('./pages/LocationResignSignup'));
const LocationSchedule = lazy(() => import('./pages/LocationSchedule'));
// 2026-06-26: Native MT booking flow at /book/[studio] — replaces the MT
// iframe pattern on /schedule/[studio] with React components rendering the
// same data via the mt-public-classes Supabase proxy. Full BBB branding,
// no cross-domain iframe handshake. Phase 1 = read-only schedule rendered
// natively. Phase 2 = in-page reserve action (needs OAuth client from MT
// dev portal which is processing).
const Book = lazy(() => import('./pages/Book'));
const Terms = lazy(() => import('./pages/Terms'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Legal = lazy(() => import('./pages/Legal'));
// Mariana Tek staging pages — hidden behind basic-auth at the Netlify edge.
const Staging = lazy(() => import('./pages/Staging'));
// MT widget design lab — sandbox-tenant rendering of multiple embed treatments
// so we can pick the look before porting to prod. Also under /staging/* gate.
const WidgetLab = lazy(() => import('./pages/WidgetLab'));
// 404 page — caught by <Route path="*"> at the end of the route list.
const NotFound = lazy(() => import('./pages/NotFound'));

function ScrollProgress() {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      const total = el.scrollHeight - el.clientHeight;
      setWidth(total > 0 ? (el.scrollTop / total) * 100 : 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return <div id="scroll-progress" style={{ width: `${width}%` }} />;
}

// 2026-06-29 (MOBILE FIX): /locations/[slug] was rendering pure black on
// iPhone Safari. Root cause = `<Suspense fallback={null}>` below + a lazy
// chunk that intermittently fails to load on cellular (LocationDetail pulls
// in NativeClassList + MTBookingModal — ~50KB combined). When the chunk
// fetch failed, React threw, nothing caught the throw, and the visible
// page was just the dark page bg (no header, no content, no error UI).
// Trial pages worked because their chunk is smaller + always loaded.
// Fix: (a) Suspense now shows a real loader instead of null, (b) wrap
// routes in a chunk-load error boundary that recovers with a "Reload /
// Call us" UI on any chunk fetch failure or render error.
class ChunkErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to console + Sentry-equivalent if wired later
    console.error('[ChunkErrorBoundary] route crashed:', error, info);

    // 2026-08-05: the #1 cause of this boundary tripping is a STALE CHUNK —
    // after a deploy, Vite renames the lazy-loaded route chunks and deletes
    // the old ones. A visitor whose page (or CDN cache) predates the deploy
    // taps a location, the browser fetches the old chunk filename, gets a 404,
    // and the dynamic import() rejects. That's why it's intermittent and why
    // "reload usually fixes it." Detect that specific error and auto-reload
    // ONCE (sessionStorage guard prevents any reload loop) so the customer
    // sees a blink instead of an error screen. Genuine render bugs (non-chunk
    // errors) still fall through to the manual UI below — no infinite reload.
    const msg = String(error?.message || error || '');
    const isChunkError =
      /dynamically imported module|Importing a module script failed|ChunkLoadError|Failed to fetch|error loading dynamically imported/i.test(msg);
    try {
      if (isChunkError && !sessionStorage.getItem('bbb_chunk_reloaded')) {
        sessionStorage.setItem('bbb_chunk_reloaded', '1');
        window.location.reload();
      }
    } catch { /* sessionStorage unavailable — fall through to manual UI */ }
  }
  render() {
    if (!this.state.hasError) {
      // A route rendered successfully → the reload (if any) worked. Clear the
      // guard so a LATER deploy's stale-chunk error can auto-recover again.
      try { sessionStorage.removeItem('bbb_chunk_reloaded'); } catch { /* ignore */ }
      return this.props.children;
    }
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center px-6 py-24">
        <div className="max-w-md text-center">
          <h1 className="text-3xl font-black tracking-tight mb-4">
            Something went wrong loading this page.
          </h1>
          <p className="text-white/70 mb-8 leading-relaxed">
            We had trouble loading this section. Reloading usually fixes it.
            If not, you can still start a trial or call the studio directly.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="bg-red-600 hover:bg-red-700 text-white font-bold px-6 py-3 rounded-lg transition-colors"
            >
              Reload
            </button>
            <a
              href="/trial"
              className="bg-white/10 hover:bg-white/20 text-white font-bold px-6 py-3 rounded-lg transition-colors"
            >
              Start a Trial
            </a>
            <a
              href="tel:+16465668870"
              className="bg-white/10 hover:bg-white/20 text-white font-bold px-6 py-3 rounded-lg transition-colors"
            >
              Call Us
            </a>
          </div>
        </div>
      </div>
    );
  }
}

// Suspense loader — minimal, brand-aligned. Replaces the silent `null`
// fallback that produced a pure black screen during chunk loads.
function RouteLoader() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6 py-24">
      <div className="text-center">
        <div className="inline-block w-8 h-8 border-2 border-red-600/30 border-t-red-600 rounded-full animate-spin mb-4" />
        <p className="text-sm text-gray-500 font-semibold tracking-wide">Loading…</p>
      </div>
    </div>
  );
}

// 2026-07-23: Capture utm_* on EVERY page load and route change, not just the
// trial pages. So an ad click that lands anywhere on the site (homepage,
// /contact, a location page) still stores its source and carries it through to
// whatever form the visitor eventually submits. captureUtmsFromUrl only writes
// when the URL actually has utm params, so organic navigation never clobbers it.
function UtmCapture() {
  const location = useLocation();
  useEffect(() => { captureUtmsFromUrl(); }, [location.pathname, location.search]);
  return null;
}

function App() {
  return (
    <HelmetProvider>
    <Router>
      <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
        {/* 2026-06-26: Site-wide maintenance banner removed. Online booking is
            back via the MT widgets on /schedule/[slug], /locations/[slug], and
            /classes. Header reset to top:0. */}
        <UtmCapture />
        <ScrollProgress />
        <ScrollToTop />
        <Header />
        <ChunkErrorBoundary>
        <Suspense fallback={<RouteLoader />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/faq" element={<FAQ />} />
          <Route path="/blog" element={<Blog />} />
          <Route path="/careers" element={<Careers />} />
          <Route path="/franchising" element={<Franchising />} />
          <Route path="/testimonials" element={<Testimonials />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/services" element={<Services />} />
          <Route path="/locations" element={<Locations />} />
          <Route path="/locations/:slug" element={<LocationDetail />} />
          <Route path="/queens" element={<Queens />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/classes" element={<Classes />} />
          <Route path="/classes/:id" element={<ClassDetail />} />
          <Route path="/bookings" element={<MyBookings />} />
          <Route path="/trial" element={<TrialSignup />} />
          <Route path="/trial/:location" element={<LocationTrialSignup />} />
          <Route path="/special/:location" element={<LocationSpecialSignup />} />
          <Route path="/comeback" element={<ComebackIndex />} />
          <Route path="/comeback/:location" element={<LocationComebackSignup />} />
          <Route path="/resign/:location" element={<LocationResignSignup />} />
          <Route path="/schedule/:location" element={<LocationSchedule />} />
          {/* Native (no-iframe) booking flow — same data as /schedule, BBB-branded. */}
          <Route path="/book/:location"     element={<Book />} />
          <Route path="/trial-success" element={<TrialSuccess />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/legal" element={<Legal />} />
          {/* Mariana Tek staging — gated by basic auth at the Netlify edge. */}
          <Route path="/staging/buy"        element={<Staging kind="buy" />} />
          <Route path="/staging/schedule"   element={<Staging kind="schedule" />} />
          <Route path="/staging/account"    element={<Staging kind="account" />} />
          <Route path="/staging/login"      element={<Staging kind="login" />} />
          {/* Widget design lab — no auth, but obscure URL + noindex meta tag so
              it's not crawled or surfaced. Path is reachable to anyone who
              knows it; share it only with people designing. */}
          <Route path="/widget-lab"         element={<WidgetLab />} />
          {/* Catch-all 404 — MUST be the last <Route>. Any URL not matched
              above lands here. NotFound.tsx returns its own noindex meta tag
              so Google won't crawl/index soft-404s. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
        </ChunkErrorBoundary>
        <Footer />
      </div>
    </Router>
    </HelmetProvider>
  );
}

export default App;
