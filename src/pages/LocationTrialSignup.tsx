import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { ArrowRight, CheckCircle, Clock, Users, Zap, MapPin, Phone, Lock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { getUtmParams } from '../lib/utm';

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
  },
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Meta Pixel — typed globally so TS doesn't complain when we call window.fbq()
declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    _fbq?: unknown;
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
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    smsConsent: false,
    newsletter: false,
  });

  useEffect(() => {
    window.scrollTo(0, 0);
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

  if (!location) {
    return <Navigate to="/trial" replace />;
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Client-side guard — fast feedback before we hit the server. Server still
    // re-validates (don't trust the browser).
    const first = formData.firstName.trim();
    const last  = formData.lastName.trim();
    const mail  = formData.email.trim();
    const tel   = formData.phone.trim();
    if (!first || first.length < 2)      { setError('Please enter your first name.'); return; }
    if (!last  || last.length  < 2)      { setError('Please enter your last name.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { setError('Please enter a valid email address.'); return; }
    const digits = tel.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) { setError('Please enter a valid US phone number.'); return; }
    // Explicit SMS opt-in is required — this consent checkbox is what the
    // Twilio Toll-Free Verification submission points to as opt-in proof.
    if (!formData.smsConsent) { setError('Please agree to receive class confirmations by text to continue.'); return; }

    setIsProcessing(true);

    // Meta Pixel — fire Lead the moment they submit (counts pre-checkout)
    if (location.metaPixelId && window.fbq) {
      window.fbq('track', 'Lead', {
        content_name: `${location.name} 2-Week Trial`,
        content_category: 'trial',
        value: 49,
        currency: 'USD',
      });
    }

    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/create-trial-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          locationId: location.locationId,
          locationName: location.name,
          customerEmail: formData.email.trim(),
          customerFirstName: formData.firstName.trim(),
          customerLastName: formData.lastName.trim(),
          customerName: `${formData.firstName.trim()} ${formData.lastName.trim()}`.trim(),
          customerPhone: formData.phone.trim(),
          newsletter: formData.newsletter,
          ...getUtmParams(),
          ...getMetaClickIds(),
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.url) {
        throw new Error(data.error || 'Could not start checkout. Please try again or call us.');
      }

      // Meta Pixel — fire InitiateCheckout right before Stripe redirect
      if (location.metaPixelId && window.fbq) {
        window.fbq('track', 'InitiateCheckout', {
          content_name: `${location.name} 2-Week Trial`,
          content_category: 'trial',
          value: 49,
          currency: 'USD',
        });
      }

      // Redirect to gym-specific Stripe Checkout
      window.location.href = data.url;
    } catch (err) {
      console.error('Trial checkout error:', err);
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setIsProcessing(false);
    }
  };

  return (
    <>
    <SEOHead
      title={`2 Weeks for $49 — ${location.name} | Better Body Bootcamp`}
      description={`Start your 2-week trial at Better Body Bootcamp ${location.name} for just $49. Unlimited classes, expert trainers, real results.`}
      canonical={`/trial/${location.slug}`}
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* HERO ─────────────────────────────────────────────────────────────── */}
      {/* Mobile hero: pt-36 clears the fixed header + marquee strip (≈120px
          combined). Type sized so the full badge+headline+subtitle block fits
          inside a 390x844 viewport above the card. */}
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

                <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">First Name *</label>
                      <input
                        type="text"
                        name="firstName"
                        value={formData.firstName}
                        onChange={handleChange}
                        required
                        minLength={2}
                        autoComplete="given-name"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">Last Name *</label>
                      <input
                        type="text"
                        name="lastName"
                        value={formData.lastName}
                        onChange={handleChange}
                        required
                        minLength={2}
                        autoComplete="family-name"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900"
                      />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">Email *</label>
                      <input
                        type="email"
                        name="email"
                        value={formData.email}
                        onChange={handleChange}
                        required
                        autoComplete="email"
                        placeholder="you@email.com"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">Mobile Phone *</label>
                      <input
                        type="tel"
                        name="phone"
                        value={formData.phone}
                        onChange={handleChange}
                        required
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="(212) 555-0100"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900"
                      />
                      <p className="text-[10px] text-gray-500 mt-1">We text class confirmations — must be a real US mobile.</p>
                    </div>
                  </div>

                  <div className="pt-3">
                    <label className="flex items-start gap-3 cursor-pointer text-sm text-gray-700">
                      <input
                        type="checkbox"
                        name="smsConsent"
                        checked={formData.smsConsent}
                        onChange={handleChange}
                        required
                        className="mt-0.5 w-5 h-5 text-red-600 border-gray-300 rounded focus:ring-red-500 flex-shrink-0"
                      />
                      <span>
                        <span className="font-semibold">I agree to receive transactional text messages</span> — class confirmations and trial updates — from Better Body Bootcamp {location.name} at the mobile number provided. Msg &amp; data rates may apply. Msg frequency varies. Reply STOP to opt out, HELP for help. *
                      </span>
                    </label>
                  </div>

                  <div className="pt-3">
                    <label className="flex items-start gap-3 cursor-pointer text-sm text-gray-700 py-2 min-h-[44px]">
                      <input
                        type="checkbox"
                        name="newsletter"
                        checked={formData.newsletter}
                        onChange={handleChange}
                        className="mt-0.5 w-5 h-5 text-red-600 border-gray-300 rounded focus:ring-red-500"
                      />
                      <span>Send me class schedules and updates</span>
                    </label>
                  </div>

                  {error && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
                      {error}
                    </div>
                  )}

                  <p className="text-xs text-gray-600 leading-relaxed">
                    By continuing you agree to our <a href="/privacy" className="underline">Privacy Policy</a> and <a href="/terms" className="underline">Terms</a>. We never share your phone number with third parties.
                  </p>

                  <button
                    type="submit"
                    disabled={isProcessing}
                    className="group w-full bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-6 py-4 rounded-xl font-black text-lg uppercase tracking-wider transition-all transform hover:scale-[1.01] shadow-lg hover:shadow-red-600/40 flex items-center justify-center gap-3 disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
                  >
                    {isProcessing ? 'Processing...' : (
                      <>
                        Continue to Secure Checkout · $49
                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                      </>
                    )}
                  </button>

                  <div className="flex items-center justify-center gap-2 text-xs text-gray-500 pt-2">
                    <Lock className="w-3.5 h-3.5" />
                    Payment processed securely via Stripe
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
