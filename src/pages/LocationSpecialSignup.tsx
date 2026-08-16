import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { ArrowRight, CheckCircle, Clock, Users, Zap, MapPin, Phone, Lock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { captureUtmsFromUrl, getUtmParams } from '../lib/utm';

// ─── PER-GYM CONFIG ─────────────────────────────────────────────────────────
// $129 win-back offer page. Same gym infrastructure as /trial/* but charges
// a different Stripe price (locations.stripe_special_price_id). Send this URL
// only to people who tried the $49 trial and didn't convert — it's not linked
// from the public site.
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
  metaPixelId: string | null;
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
    metaPixelId: '1291566006435758',
  },
  'bayside': {
    slug: 'bayside',
    locationId: '5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7',
    name: 'Bayside',
    badge: 'BAYSIDE · QUEENS',
    address: '34-47 Bell Blvd',
    city: 'Bayside',
    state: 'NY',
    zip: '11361',
    phone: '(646) 566-8870',
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
    metaPixelId: '2160299368182872',
  },
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const OFFER_PRICE = 129;
const OFFER_DURATION = '30 Days';

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    _fbq?: unknown;
  }
}

function loadMetaPixel(pixelId: string): () => void {
  if (typeof window === 'undefined') return () => {};
  const SCRIPT_ID = `meta-pixel-${pixelId}`;
  if (document.getElementById(SCRIPT_ID)) return () => {};
  const inline = document.createElement('script');
  inline.id = SCRIPT_ID;
  inline.text = `
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){
    n.callMethod ? n.callMethod.apply(n,arguments) : n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '${pixelId}');
    fbq('track', 'PageView');
  `;
  document.head.appendChild(inline);
  return () => {
    const el = document.getElementById(SCRIPT_ID);
    if (el) el.remove();
  };
}

export default function LocationSpecialSignup() {
  const { location: slug } = useParams<{ location: string }>();
  const location = slug ? LOCATIONS[slug] : null;

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string>('');
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    newsletter: false,
  });

  useEffect(() => {
    if (location?.metaPixelId) {
      return loadMetaPixel(location.metaPixelId);
    }
    return undefined;
  }, [location?.metaPixelId]);

  // Persist any utm_* on the URL so attribution survives re-renders / refresh.
  useEffect(() => { captureUtmsFromUrl(); }, []);

  if (!location) return <Navigate to="/" replace />;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type } = e.target;
    const checked = type === 'checkbox' ? (e.target as HTMLInputElement).checked : undefined;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? !!checked : value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Client-side guard — fast feedback before we hit the server.
    const first = formData.firstName.trim();
    const last  = formData.lastName.trim();
    const mail  = formData.email.trim();
    const tel   = formData.phone.trim();
    if (!first || first.length < 2)      { setError('Please enter your first name.'); return; }
    if (!last  || last.length  < 2)      { setError('Please enter your last name.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { setError('Please enter a valid email address.'); return; }
    const digits = tel.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) { setError('Please enter a valid US phone number.'); return; }

    // Meta Pixel — Lead event on form submit
    if (location.metaPixelId && window.fbq) {
      window.fbq('track', 'Lead', {
        content_name: `${location.name} 30-Day Special`,
        content_category: 'win-back',
        value: OFFER_PRICE,
        currency: 'USD',
      });
    }

    setIsProcessing(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-trial-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
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
          priceVariant: 'special', // tells edge fn to use stripe_special_price_id
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.url) {
        throw new Error(data?.error || 'Could not start checkout. Please try again.');
      }

      if (location.metaPixelId && window.fbq) {
        window.fbq('track', 'InitiateCheckout', {
          content_name: `${location.name} 30-Day Special`,
          content_category: 'win-back',
          value: OFFER_PRICE,
          currency: 'USD',
        });
      }

      window.location.href = data.url;
    } catch (err) {
      console.error('Special checkout error:', err);
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setIsProcessing(false);
    }
  };

  return (
    <>
    <SEOHead
      title={`30 Days for $${OFFER_PRICE} — ${location.name} | Better Body Bootcamp`}
      description={`Special come-back offer at Better Body Bootcamp ${location.name}: 30 days of unlimited classes for just $${OFFER_PRICE}. For folks who've trained with us before.`}
      canonical={`/special/${location.slug}`}
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* HERO ─────────────────────────────────────────────────────────────── */}
      <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-red-800 text-white pt-36 pb-10 sm:pt-32 sm:pb-16 lg:pt-36 lg:pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-black/10"></div>
        {/* 2026-06-30: Hide giant blur radii on mobile — same iOS Safari
            crash pattern as /locations/[slug] (task #500). Heavy
            blur-3xl on inset-0 layers triggers a paint failure on
            iPhone Safari and renders a black screen. */}
        <div className="absolute inset-0 opacity-10 hidden lg:block">
          <div className="absolute top-20 left-10 w-72 h-72 bg-white rounded-full blur-3xl"></div>
          <div className="absolute bottom-10 right-10 w-96 h-96 bg-white rounded-full blur-3xl"></div>
        </div>

        <div className="max-w-5xl mx-auto px-3 sm:px-6 lg:px-8 text-center relative z-10">
          <span className="inline-block px-3 py-1 sm:px-4 sm:py-1.5 bg-amber-400/95 text-red-900 backdrop-blur-sm rounded-full text-[10px] sm:text-xs font-black tracking-[0.2em] uppercase border border-amber-300 mb-4 sm:mb-10 whitespace-nowrap shadow-lg">
            ★ COMEBACK OFFER · {location.badge}
          </span>
          <h1 className="font-black mb-3 sm:mb-6 leading-[0.95] tracking-tight">
            <span className="block text-3xl sm:text-6xl md:text-7xl lg:text-8xl">{OFFER_DURATION.toUpperCase()}</span>
            <span className="block text-4xl sm:text-7xl md:text-8xl lg:text-[9rem] mt-1 sm:mt-3">FOR ${OFFER_PRICE}</span>
          </h1>
          <p className="text-sm sm:text-lg md:text-xl lg:text-2xl font-medium leading-snug sm:leading-relaxed max-w-md sm:max-w-3xl mx-auto mb-0 sm:mb-8 px-2">
            Welcome back. A full month of unlimited classes at <span className="whitespace-nowrap">Better Body Bootcamp {location.name}</span>.
          </p>

          <div className="hidden sm:flex flex-nowrap justify-center items-center gap-1.5 sm:gap-4 lg:gap-8 mt-6 sm:mt-10 px-1">
            <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
              <Clock className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
              <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">30 Days</span>
            </div>
            <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
              <Users className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
              <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">Unlimited Classes</span>
            </div>
            <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
              <Zap className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
              <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">No Contract</span>
            </div>
          </div>
        </div>
      </div>

      {/* MAIN CARD ────────────────────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 mt-0 sm:-mt-8 relative z-20">
        <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl p-4 sm:p-10 lg:p-12 mb-8 sm:mb-12">

          <div className="grid lg:grid-cols-5 gap-6 sm:gap-8 lg:gap-12">

            {/* LEFT */}
            <div className="lg:col-span-2 space-y-5 sm:space-y-6 order-2 lg:order-none">
              <div>
                <h2 className="text-xl sm:text-2xl lg:text-3xl font-bold mb-4 sm:mb-6 text-gray-900 text-center lg:text-left">Why come back?</h2>
                <div className="space-y-3 sm:space-y-4 max-w-xs sm:max-w-none mx-auto">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">Same studio, new program</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">We've upgraded everything since your last trial.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">$129 first month</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">$129 covers 30 days of unlimited classes.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">No long contract</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">One-time charge. Stay or step away after 30 days.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">Real progress this time</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">A month is enough to feel results. Two weeks isn't.</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-amber-50 to-white border-2 border-amber-200 rounded-2xl p-5 sm:p-6">
                <h3 className="font-bold text-base sm:text-lg text-gray-900 mb-3 text-center lg:text-left">Your 30-Day Comeback Includes:</h3>
                <ul className="space-y-1.5 sm:space-y-2 text-gray-700 text-xs sm:text-sm max-w-xs sm:max-w-none mx-auto">
                  <li className="flex items-start gap-2"><span className="text-red-600 mt-0.5">•</span> Unlimited classes for 30 days</li>
                  <li className="flex items-start gap-2"><span className="text-red-600 mt-0.5">•</span> Full fitness reassessment</li>
                  <li className="flex items-start gap-2"><span className="text-red-600 mt-0.5">•</span> Goal reset with a coach</li>
                  <li className="flex items-start gap-2"><span className="text-red-600 mt-0.5">•</span> Access at our {location.name} studio</li>
                </ul>
                <div className="border-t border-amber-200 mt-4 pt-3 flex justify-between items-baseline">
                  <div>
                    <div className="font-bold text-gray-700 uppercase text-xs tracking-wider">Today</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">30 days of unlimited classes</div></div>
                  <span className="text-2xl sm:text-3xl font-black text-red-600">${OFFER_PRICE}</span>
                </div>
                <p className="text-[10px] sm:text-xs text-gray-500 mt-2 italic">
                  You have 60 days to claim and start your trial.
                </p>
                <p className="text-xs sm:text-sm text-red-600 font-bold mt-2">
                  Offer available only to New York City residents.
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

            {/* RIGHT: Form */}
            <div className="lg:col-span-3 order-1 lg:order-none" id="trial-form">
              <div className="bg-gradient-to-br from-gray-50 to-white border border-gray-200 rounded-2xl p-4 sm:p-8 scroll-mt-24">
                <div className="mb-5 sm:mb-6 text-center lg:text-left">
                  <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-1">Claim Your 30-Day Comeback</h2>
                  <p className="text-xs sm:text-sm text-gray-600">
                    Unlimited classes at <span className="font-semibold">{location.name}</span> for 30 days · ${OFFER_PRICE}.
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
                    By clicking <strong>Continue to Secure Checkout</strong>, you agree to receive transactional SMS from Better Body Bootcamp about your membership at the phone number provided. Message frequency varies; msg &amp; data rates may apply. Reply HELP for help or STOP to opt out. See our <a href="/privacy" className="underline">Privacy Policy</a> and <a href="/terms" className="underline">Terms</a>.
                  </p>

                  <button
                    type="submit"
                    disabled={isProcessing}
                    className="group w-full bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-6 py-4 rounded-xl font-black text-lg uppercase tracking-wider transition-all transform hover:scale-[1.01] shadow-lg hover:shadow-red-600/40 flex items-center justify-center gap-3 disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none"
                  >
                    {isProcessing ? 'Processing...' : (
                      <>
                        Continue to Secure Checkout · ${OFFER_PRICE}
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
