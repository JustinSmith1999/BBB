import { useState, useEffect, useRef } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { CheckCircle, Clock, Users, Zap, MapPin, Phone, Lock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { getUtmParams, captureUtmsFromUrl } from '../lib/utm';

// ─── PER-GYM CONFIG ─────────────────────────────────────────────────────────
// `locationId` is the Supabase row UUID for the gym. The edge function
// `create-trial-checkout` looks up that row to find the gym's stripe_secret_key
// and stripe_price_id, so each gym charges to its own Stripe account.
// Address/phone/image are hardcoded here to keep first-paint fast (no Supabase
// fetch needed). Verified against the locations table on 2026-05-15.
// ─────────────────────────────────────────────────────────────────────────────
type LocationConfig = {
  slug: string;
  locationId: string;
  name: string;
  badge: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  image: string;
  metaPixelId: string | null; // each gym has its own Meta Pixel for ad attribution
  // 2026-06-29: per-studio Mariana Tek location ID. Used to scope the
  // /intro-offers widget so the customer only sees this studio's $49 trial
  // pass option (not all 4 studios' offers). Verified live in mt-public-classes
  // calls + WidgetLab.tsx.
  mtLocationId: number;
  // 2026-06-19: pre-rendered hero banner. When set, the trial page swaps the
  // gradient hero for this branded banner image (image already contains the
  // "TWO WEEKS FOR $49" headline + studio name baked in). Mobile + desktop
  // variants are crops of the same design tuned for each viewport.
  heroImageWeb?: string;
  heroImageMobile?: string;
};

const LOCATIONS: Record<string, LocationConfig> = {
  'astoria': {
    slug: 'astoria',
    locationId: 'dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45',
    name: 'Astoria',
    badge: 'ASTORIA · QUEENS',
    address: '31-18 Steinway Street',
    city: 'Astoria',
    state: 'NY',
    zip: '11103',
    phone: '(718) 704-9954',
    image: '/astoria-final.webp',
    metaPixelId: '1291566006435758',
    mtLocationId: 48717,
  },
  'bayside': {
    slug: 'bayside',
    locationId: '5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7',
    name: 'Bayside',
    badge: 'BAYSIDE · QUEENS',
    address: '3447 Bell Blvd',
    city: 'Bayside',
    state: 'NY',
    zip: '11361',
    phone: '(646) 566-8870',
    image: '/bayside-final.webp',
    metaPixelId: '931144729719242',
    mtLocationId: 48718,
    heroImageWeb: '/bayside-hero-web.jpg',
    heroImageMobile: '/bayside-hero-mobile.jpg',
  },
  'fresh-meadows': {
    slug: 'fresh-meadows',
    locationId: '6bbbe077-bcc6-4d9d-a10b-7605c1484752',
    name: 'Fresh Meadows',
    badge: 'FRESH MEADOWS · QUEENS',
    address: '76-46 164th Street',
    city: 'Fresh Meadows',
    state: 'NY',
    zip: '11366',
    phone: '(646) 566-8207',
    image: '/freshmeadows-final.webp',
    metaPixelId: '979328851475276',
    mtLocationId: 48719,
    heroImageWeb: '/fresh-meadows-hero-web.jpg',
    heroImageMobile: '/fresh-meadows-hero-mobile.jpg',
  },
  'williamsburg': {
    slug: 'williamsburg',
    locationId: '80536b45-df0e-42d1-880c-e9301372e1cf',
    name: 'Williamsburg',
    badge: 'WILLIAMSBURG · BROOKLYN',
    address: '487 Driggs Ave',
    city: 'Brooklyn',
    state: 'NY',
    zip: '11211',
    phone: '(718) 683-1864',
    image: '/williamsburg-final.webp',
    metaPixelId: '2160299368182872',
    mtLocationId: 48720,
  },
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Meta Pixel — typed globally so TS doesn't complain when we call window.fbq()
declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    _fbq?: unknown;
    // 2026-06-29: MT Web Integrations runtime — loaded site-wide via
    // index.html. .render(selector) (re-)mounts whichever
    // [data-mariana-integrations] div matches the selector.
    MTIntegrations?: { render: (selector?: string) => void };
  }
}

/**
 * Inject the Meta Pixel <script> for a specific gym, fire PageView once, and
 * return a cleanup function. We re-init the pixel for whichever gym the user
 * lands on so the conversion goes to that gym's Ads Manager.
 */
function loadMetaPixel(pixelId: string): () => void {
  if (typeof window === 'undefined') return () => {};
  const SCRIPT_ID = `meta-pixel-${pixelId}`;
  // Avoid double-injecting if the user re-navigates within SPA
  if (document.getElementById(SCRIPT_ID)) {
    window.fbq?.('init', pixelId);
    window.fbq?.('track', 'PageView');
    return () => {};
  }
  // Standard Meta Pixel snippet, inlined so we can scope it per-gym
  const inline = document.createElement('script');
  inline.id = SCRIPT_ID;
  inline.text = `
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '${pixelId}');
    fbq('track', 'PageView');
  `;
  document.head.appendChild(inline);
  // <noscript> fallback for bots / no-JS visitors
  const ns = document.createElement('noscript');
  ns.id = `${SCRIPT_ID}-ns`;
  ns.innerHTML = `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1" />`;
  document.head.appendChild(ns);
  return () => {
    document.getElementById(SCRIPT_ID)?.remove();
    document.getElementById(`${SCRIPT_ID}-ns`)?.remove();
  };
}

// Meta click identifiers for server-side Conversions API matching.
// _fbp is set by the pixel on every visit; _fbc is set when the visitor
// arrived from an ad (fbclid). These are the strongest signals Meta uses to
// tie a server-side Purchase event back to the ad that drove it — without
// them, ad conversions under-report badly. Threaded through checkout ->
// Stripe metadata -> stripe-webhook -> CAPI.
function getMetaClickIds(): { fbp: string; fbc: string } {
  if (typeof document === 'undefined') return { fbp: '', fbc: '' };
  const readCookie = (name: string): string => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  let fbc = readCookie('_fbc');
  if (!fbc) {
    const fbclid = new URLSearchParams(window.location.search).get('fbclid');
    if (fbclid) fbc = `fb.1.${Date.now()}.${fbclid}`;
  }
  return { fbp: readCookie('_fbp'), fbc };
}

export default function LocationTrialSignup() {
  const { location: locationParam } = useParams<{ location: string }>();
  // 2026-06-29: BBB Stripe form replaced by MT widget. The form state
  // (firstName/lastName/email/phone/smsConsent/newsletter), handleChange,
  // handleSubmit, isProcessing/error/submittingRef — all removed. MT now
  // owns the full transaction. Pixel + UTM + soft-conversion remain.
  const pageLoadAtRef = useRef<number>(Date.now());

  // ── Soft-conversion: "text me the schedule" mini-form ───────────────────
  // For visitors who won't commit to $49 today. Captures phone, sends the
  // schedule link via Twilio, writes a soft_conversion lead row. 2026-06-11.
  const [scheduleOpen,      setScheduleOpen]      = useState(false);
  const [scheduleFirstName, setScheduleFirstName] = useState('');
  const [scheduleLastName,  setScheduleLastName]  = useState('');
  const [scheduleEmail,     setScheduleEmail]     = useState('');
  const [schedulePhone,     setSchedulePhone]     = useState('');
  const [scheduleSending,   setScheduleSending]   = useState(false);
  const [scheduleError,     setScheduleError]     = useState('');
  const [scheduleSent,      setScheduleSent]      = useState(false);

  const handleScheduleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setScheduleError('');
    if (!scheduleFirstName.trim()) {
      setScheduleError('Please enter your first name.');
      return;
    }
    if (!scheduleLastName.trim()) {
      setScheduleError('Please enter your last name.');
      return;
    }
    // Light email validation — server-side normalization happens in the
    // edge function. Basic sanity here so we don't even fire the network call.
    const emailTrim = scheduleEmail.trim();
    if (!emailTrim || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
      setScheduleError('Please enter a valid email address.');
      return;
    }
    const phoneDigits = schedulePhone.replace(/\D/g, '');
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      setScheduleError('Please enter a valid US phone number.');
      return;
    }
    if (!location) return;
    setScheduleSending(true);
    try {
      // Capture every signal Meta gives us so the dashboard can attribute this
      // soft conversion back to the specific ad / campaign / creative.
      const { fbp, fbc } = getMetaClickIds();
      const utms = getUtmParams();
      const timeOnPageMs = pageLoadAtRef.current
        ? Math.max(0, Date.now() - pageLoadAtRef.current)
        : null;

      const res = await fetch(`${SUPABASE_URL}/functions/v1/request-schedule-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey':        SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          studio_slug:  location.slug,
          studio_name:  location.name,
          location_id:  location.locationId,
          phone:        schedulePhone.trim(),
          first_name:   scheduleFirstName.trim(),
          last_name:    scheduleLastName.trim(),
          email:        scheduleEmail.trim().toLowerCase(),
          // Full Meta + journey context for dashboard attribution
          fbp,
          fbc,
          ...utms,                                  // utm_source/medium/campaign/content
          referrer:        document.referrer || '',
          page_url:        window.location.href,
          time_on_page_ms: timeOnPageMs,
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        setScheduleError(data?.error || 'Could not send. Please try again.');
        setScheduleSending(false);
        return;
      }
      // Fire a Meta Pixel Lead event for the soft conversion too — different
      // value (we got contact info but no $) so Meta can score it appropriately.
      if (location.metaPixelId && window.fbq) {
        window.fbq('track', 'Lead', {
          content_name:     `${location.name} Schedule Request (soft)`,
          content_category: 'soft_conversion',
          value: 0,
          currency: 'USD',
        });
      }
      setScheduleSent(true);
      setScheduleSending(false);
    } catch (err) {
      setScheduleError('Network error. Please try again.');
      setScheduleSending(false);
    }
  };

  useEffect(() => {
    window.scrollTo(0, 0);
    // Persist UTM tags from the landing URL into sessionStorage immediately,
    // so attribution survives SPA re-renders / form refreshes. Without this,
    // submissions land as "Direct/untagged" whenever the URL has been mutated
    // between the user arriving via /ig and clicking submit.
    captureUtmsFromUrl();
  }, [locationParam]);

  const key = (locationParam ?? '').toLowerCase();
  const location = LOCATIONS[key];

  // Per-gym Meta Pixel — load that gym's pixel + fire PageView on mount.
  // Cleanup removes the script when navigating away so visiting a different
  // gym's trial page initializes the correct pixel instead of stacking them.
  useEffect(() => {
    if (location?.metaPixelId) {
      return loadMetaPixel(location.metaPixelId);
    }
    return undefined;
  }, [location?.metaPixelId]);

  // ─── MT widget mount (2026-06-29) ──────────────────────────────────────
  // Mariana Tek's Web Integrations runtime is loaded site-wide via
  // index.html. It auto-scans [data-mariana-integrations] divs on initial
  // page load — but React lazy-mounts this route AFTER that scan, so we
  // have to re-invoke MTIntegrations.render() once our div lands in the DOM.
  // (Same pattern as WidgetLab.tsx — see notes there for why we have to
  // call render() per-div with a unique selector.)
  //
  // The widget path `/intro-offers?location=<id>` mounts MT's native
  // new-customer signup + intro pass purchase flow, filtered to this
  // studio's offers. MT owns the entire transaction (account creation,
  // payment, pass issuance, confirmation). Replaces the gutted BBB Stripe
  // form below — kills the silent-failure bridge problem.
  useEffect(() => {
    if (!location?.mtLocationId) return;
    const tryInit = (attempts: number) => {
      if (typeof window.MTIntegrations?.render === 'function') {
        const divs = Array.from(
          document.querySelectorAll('[data-mariana-integrations]'),
        ) as HTMLElement[];
        divs.forEach((div, i) => {
          if (!div.dataset.mtId) div.dataset.mtId = `mt-trial-${i}-${Date.now()}`;
          if (div.children.length > 0) return; // already mounted
          try {
            window.MTIntegrations!.render(`[data-mt-id="${div.dataset.mtId}"]`);
          } catch (e) {
            console.warn('MT trial widget mount failed for', div.dataset.mtId, e);
          }
        });
        return;
      }
      if (attempts > 0) setTimeout(() => tryInit(attempts - 1), 500);
    };
    tryInit(20);
  }, [location?.mtLocationId]);

  // 2026-06-04: server-side PageView CAPI with hashed email when known.
  // 2026-06-11: REMOVED the email-required gate. Previously this only fired
  // for email-link visitors (?email=X), so Meta ad-driven traffic was
  // invisible to our backend — we couldn't tell if a click actually landed
  // on the page or if 0 form fills meant 0 visits or 0 conversions.
  // Now fires on EVERY page load. Email is optional; fbp/fbc cookies
  // (set by the Meta browser pixel) are enough for CAPI to match. When
  // email IS present, match quality jumps from ~6 to ~9.
  useEffect(() => {
    if (!location) return;
    const params = new URLSearchParams(window.location.search);
    const emailFromUrl = params.get('email') || '';
    const { fbp, fbc } = getMetaClickIds();
    // Need at least one identity signal — fbp from the Meta pixel cookie is
    // almost always present on ad-driven traffic. If none of the three are
    // available (very rare — private browsing + ad blocker), skip rather
    // than fire a low-trust event Meta will discard anyway.
    if (!emailFromUrl && !fbp && !fbc) return;
    const eventId = `pv_${location.slug}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // ── Client-side enrichment: device + locale + return-visitor count ──
    // All best-effort. The function gracefully ignores missing fields.
    let connType = '';
    try {
      const c = (navigator as unknown as { connection?: { effectiveType?: string } }).connection;
      connType = c?.effectiveType || '';
    } catch { /* ignore */ }
    const colorScheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    let timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
    const language = navigator.language || '';

    // Returning-visitor counter via localStorage (per studio).
    let visitNumber = 1, daysSinceFirst = 0;
    try {
      const key = `bbb_visit_${location.slug}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        visitNumber = (parsed.count || 0) + 1;
        const firstMs = Number(parsed.first || Date.now());
        daysSinceFirst = Math.floor((Date.now() - firstMs) / 86400000);
        localStorage.setItem(key, JSON.stringify({ count: visitNumber, first: firstMs }));
      } else {
        localStorage.setItem(key, JSON.stringify({ count: 1, first: Date.now() }));
      }
    } catch { /* private mode — fine */ }

    // Best-effort — never block the page render on this.
    fetch(`${SUPABASE_URL}/functions/v1/meta-capi-pageview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey':        SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        studio_slug:     location.slug,
        email:           emailFromUrl,
        fbp, fbc,
        page_url:        window.location.href,
        event_id:        eventId,
        // Client-side enrichment
        screen_width:    window.screen?.width  ?? null,
        viewport_width:  window.innerWidth     ?? null,
        language,
        timezone,
        connection_type: connType,
        color_scheme:    colorScheme,
        visit_number:    visitNumber,
        days_since_first: daysSinceFirst,
      }),
    }).catch(() => { /* non-blocking */ });
    // If we DO have an email (cart-recovery email-link click), re-init the
    // browser pixel with advanced matching so subsequent events (Lead,
    // InitiateCheckout) inherit the email match quality.
    if (emailFromUrl && window.fbq) {
      window.fbq('init', location.metaPixelId, { em: emailFromUrl });
    }
  }, [location?.metaPixelId, location?.slug]);

  if (!location) {
    return <Navigate to="/trial" replace />;
  }

  // 2026-06-29: handleChange/handleSubmit removed. MT widget now owns the
  // primary trial transaction (account creation + payment + pass issuance).
  // Browser-side Lead pixel + server-side meta-capi-pageview/create-trial-checkout
  // were tied to the dead BBB form — those signals are now generated MT-side
  // by mt-orders-sync firing CAPI Purchase on new $49 trials.

  return (
    <>
    <SEOHead
      title={`2 Weeks for $49 — ${location.name} | Better Body Bootcamp`}
      description={`Start your 2-week trial at Better Body Bootcamp ${location.name} for just $49. Unlimited classes, expert trainers, real results.`}
      canonical={`/trial/${location.slug}`}
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* HERO ─────────────────────────────────────────────────────────────── */}
      {/* 2026-06-19: Per-studio branded banner hero when heroImageWeb is set
          (Bayside + Fresh Meadows). Banner artwork already contains the
          "TWO WEEKS FOR $49" headline + studio name + subhead baked in, so we
          render the image alone — no text overlay needed. Astoria + WB still
          use the original red gradient hero below. */}
      {location.heroImageWeb ? (
        <div className="relative w-full pt-28 sm:pt-24 lg:pt-28 bg-black">
          <picture>
            <source media="(min-width: 640px)" srcSet={location.heroImageWeb} />
            <img
              src={location.heroImageMobile || location.heroImageWeb}
              alt={`Better Body Bootcamp ${location.name} — Two Weeks for $49`}
              className="w-full h-auto block"
              loading="eager"
              fetchPriority="high"
            />
          </picture>
        </div>
      ) : (
        <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-red-800 text-white pt-36 pb-10 sm:pt-32 sm:pb-16 lg:pt-36 lg:pb-20 overflow-hidden">
          <div className="absolute inset-0 bg-black/10"></div>
          <div className="absolute inset-0 opacity-10">
            <div className="absolute top-20 left-10 w-72 h-72 bg-white rounded-full blur-3xl"></div>
            <div className="absolute bottom-10 right-10 w-96 h-96 bg-white rounded-full blur-3xl"></div>
          </div>

          <div className="max-w-5xl mx-auto px-3 sm:px-6 lg:px-8 text-center relative z-10">
            <span className="inline-block px-3 py-1 sm:px-4 sm:py-1.5 bg-white/15 backdrop-blur-sm rounded-full text-[10px] sm:text-xs font-bold tracking-[0.2em] uppercase border border-white/30 mb-4 sm:mb-10 whitespace-nowrap">
              {location.badge}
            </span>
            <h1 className="font-black mb-3 sm:mb-6 leading-[0.95] tracking-tight">
              <span className="block text-3xl sm:text-6xl md:text-7xl lg:text-8xl">TWO WEEKS</span>
              <span className="block text-4xl sm:text-7xl md:text-8xl lg:text-[9rem] mt-1 sm:mt-3">FOR $49</span>
            </h1>
            <p className="text-sm sm:text-lg md:text-xl lg:text-2xl font-medium leading-snug sm:leading-relaxed max-w-md sm:max-w-3xl mx-auto mb-0 sm:mb-8 px-2">
              Unlimited classes at <span className="whitespace-nowrap">Better Body Bootcamp {location.name}</span>. Real training. Real results.
            </p>

            <div className="hidden sm:flex flex-nowrap justify-center items-center gap-1.5 sm:gap-4 lg:gap-8 mt-6 sm:mt-10 px-1">
              <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
                <Clock className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
                <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">14 Days</span>
              </div>
              <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
                <Users className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
                <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">Expert Trainers</span>
              </div>
              <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
                <Zap className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
                <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">High-Energy</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MAIN CARD ────────────────────────────────────────────────────────── */}
      {/* No overlap on mobile so the hero subtitle is fully visible. Desktop
          keeps the -mt-8 lift for the existing layered look. */}
      <div className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 mt-0 sm:-mt-8 relative z-20">
        <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl p-4 sm:p-10 lg:p-12 mb-8 sm:mb-12">

          <div className="grid lg:grid-cols-5 gap-6 sm:gap-8 lg:gap-12">

            {/* LEFT: Why + What's Included + Studio Card */}
            {/* order-2 on mobile so the FORM lands above this block (form is order-1).
                Desktop (lg) flips back to natural source order via lg:order-none. */}
            <div className="lg:col-span-2 space-y-5 sm:space-y-6 order-2 lg:order-none">
              <div>
                <h2 className="text-xl sm:text-2xl lg:text-3xl font-bold mb-4 sm:mb-6 text-gray-900 text-center lg:text-left">Why Better Body?</h2>
                <div className="space-y-3 sm:space-y-4 max-w-xs sm:max-w-none mx-auto">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">Real Strength Training</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">Proven methods that deliver lasting results.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">Dynamic Workouts</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">Never boring, always challenging.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">Engaged Trainers</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">Coaches who care about your progress.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">Community Driven</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">Train alongside people serious about their goals.</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-red-50 to-white border-2 border-red-100 rounded-2xl p-5 sm:p-6">
                <h3 className="font-bold text-base sm:text-lg text-gray-900 mb-3 text-center lg:text-left">Your 2-Week Trial Includes:</h3>
                <ul className="space-y-1.5 sm:space-y-2 text-gray-700 text-xs sm:text-sm max-w-xs sm:max-w-none mx-auto">
                  <li className="flex items-start gap-2"><span className="text-red-600 mt-0.5">•</span> Unlimited access to all classes</li>
                  <li className="flex items-start gap-2"><span className="text-red-600 mt-0.5">•</span> Complete fitness assessment</li>
                  <li className="flex items-start gap-2"><span className="text-red-600 mt-0.5">•</span> Personalized goal setting</li>
                  <li className="flex items-start gap-2"><span className="text-red-600 mt-0.5">•</span> Full access at our {location.name} studio</li>
                </ul>
                <div className="border-t border-red-100 mt-4 pt-3 flex justify-between items-center">
                  <span className="font-bold text-gray-700 uppercase text-xs tracking-wider">Total</span>
                  <span className="text-2xl sm:text-3xl font-black text-red-600">$49</span>
                </div>
                <p className="text-[10px] sm:text-xs text-gray-500 mt-2 italic">
                  You have 60 days to claim and start your trial.
                </p>
                <p className="text-xs sm:text-sm text-red-600 font-bold mt-2">
                  Two-week trial available only to New York City residents.
                </p>
                <p className="text-[9px] sm:text-[10px] text-gray-400 mt-3 leading-tight">
                  All trials non-refundable.
                </p>
              </div>

              <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 sm:p-5">
                <h4 className="font-bold text-gray-900 mb-2 sm:mb-3 text-xs sm:text-sm uppercase tracking-wide text-center lg:text-left">Your Studio</h4>
                <div className="space-y-2 text-xs sm:text-sm text-gray-700 max-w-xs sm:max-w-none mx-auto">
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                    <span>{location.address}<br/>{location.city}, {location.state} {location.zip}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4 text-red-600 flex-shrink-0" />
                    <a href={`tel:${location.phone}`} className="hover:text-red-600 transition-colors font-semibold">{location.phone}</a>
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT: Form ─────────────────────────────────────────────── */}
            {/* order-1 on mobile so the form sits at the TOP of the card,
                directly under the shrunk hero. Sticky bottom CTA scrolls here. */}
            <div className="lg:col-span-3 order-1 lg:order-none" id="trial-form">
              <div className="bg-gradient-to-br from-gray-50 to-white border border-gray-200 rounded-2xl p-4 sm:p-8 scroll-mt-24">
                <div className="mb-5 sm:mb-6 text-center lg:text-left">
                  <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-1">Claim Your Trial</h2>
                  <p className="text-xs sm:text-sm text-gray-600">
                    Two weeks of unlimited classes at <span className="font-semibold">{location.name}</span> for just $49.
                  </p>
                </div>

                {/* ── Mariana Tek native signup widget ────────────────────
                    2026-06-29: replaces the gutted BBB Stripe form. MT's
                    Web Integrations runtime (loaded in index.html) mounts
                    the new-customer signup + intro pass purchase flow in
                    an iframe scoped to this studio's location ID. MT owns
                    the entire transaction — account creation, payment,
                    pass issuance, confirmation. Kills the silent-failure
                    bridge problem (no more Joel Witten / Angelo Nunez
                    falling through cracks). See useEffect above for the
                    re-init pattern (React lazy-mount races MT auto-scan).
                    ─────────────────────────────────────────────────────── */}
                <div
                  key={`mt-trial-${location.slug}`}
                  data-mariana-integrations={`/intro-offers?location=${location.mtLocationId}`}
                  className="w-full bg-white rounded-xl overflow-hidden"
                  style={{ minHeight: '640px' }}
                />

                <p className="text-xs text-gray-600 leading-relaxed mt-4">
                  By starting your trial you agree to our{' '}
                  <a href="/privacy" className="underline">Privacy Policy</a> and{' '}
                  <a href="/terms" className="underline">Terms</a>. Payment +
                  account creation handled securely by Mariana Tek. Your account
                  works in the BBB / Mariana Tek app for booking classes.
                </p>

                <div className="flex items-center justify-center gap-2 text-xs text-gray-500 pt-2">
                  <Lock className="w-3.5 h-3.5" />
                  Powered by Mariana Tek — secure payments + native booking
                </div>

                {/* ── Soft-conversion: "text me the schedule" ───────────── */}
                <div className="mt-8 pt-6 border-t border-gray-200">
                  {!scheduleSent ? (
                    !scheduleOpen ? (
                      <div className="text-center">
                        <p className="text-sm text-gray-600 mb-3">
                          Not ready to commit to $49 today?
                        </p>
                        <button
                          type="button"
                          onClick={() => setScheduleOpen(true)}
                          className="text-sm font-semibold text-red-700 underline underline-offset-2 hover:text-red-800 transition"
                        >
                          Just text me the class schedule →
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleScheduleSubmit} className="bg-gray-50 border border-gray-200 rounded-xl p-4 sm:p-5" noValidate>
                        <h3 className="text-base font-bold text-gray-900 mb-1">No pressure — we'll text you the schedule.</h3>
                        <p className="text-xs text-gray-600 mb-4">
                          Drop in whenever it fits. No card, no commitment. We'll send the class schedule to your phone.
                        </p>
                        <div className="grid sm:grid-cols-2 gap-3">
                          <input
                            type="text"
                            value={scheduleFirstName}
                            onChange={(e) => setScheduleFirstName(e.target.value)}
                            required
                            placeholder="First name *"
                            autoComplete="given-name"
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900 text-sm"
                          />
                          <input
                            type="text"
                            value={scheduleLastName}
                            onChange={(e) => setScheduleLastName(e.target.value)}
                            required
                            placeholder="Last name *"
                            autoComplete="family-name"
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900 text-sm"
                          />
                          <input
                            type="email"
                            value={scheduleEmail}
                            onChange={(e) => setScheduleEmail(e.target.value)}
                            required
                            inputMode="email"
                            autoComplete="email"
                            placeholder="Email *"
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900 text-sm sm:col-span-2"
                          />
                          <input
                            type="tel"
                            value={schedulePhone}
                            onChange={(e) => setSchedulePhone(e.target.value)}
                            required
                            inputMode="tel"
                            autoComplete="tel"
                            placeholder="Mobile phone *"
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900 text-sm sm:col-span-2"
                          />
                        </div>
                        {scheduleError && (
                          <div className="mt-3 text-xs text-red-700">{scheduleError}</div>
                        )}
                        <p className="text-[10px] text-gray-500 mt-2">
                          One text with the schedule link. Reply STOP to opt out. Standard rates may apply.
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="submit"
                            disabled={scheduleSending}
                            className="flex-1 bg-gray-900 hover:bg-black text-white font-semibold text-sm py-2.5 px-4 rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {scheduleSending ? 'Sending…' : 'Text me the schedule'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setScheduleOpen(false)}
                            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-2"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )
                  ) : (
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                      <CheckCircle className="w-6 h-6 text-green-600 mx-auto mb-2" />
                      <h3 className="text-base font-bold text-gray-900 mb-1">Schedule sent!</h3>
                      <p className="text-sm text-gray-700">
                        Check your phone — we just texted you the schedule link. See you in class.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
