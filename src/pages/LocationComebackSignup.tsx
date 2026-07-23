import { useState, useEffect } from 'react';
import { useParams, useSearchParams, Navigate } from 'react-router-dom';
import { ArrowRight, CheckCircle, Clock, Users, Zap, MapPin, Phone, Lock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { captureUtmsFromUrl, getUtmParams } from '../lib/utm';

// ─── PER-GYM CONFIG ─────────────────────────────────────────────────────────
// $29 / 1-Week Comeback page. Sent ONLY to leads who started signing up for
// the $49 / 2-Week Trial more than 7 days ago and never paid. The link comes
// from comeback-offer-cron (SMS first, then email 3 days later).
//
// URL params we receive:
//   ?ref=<original_trial_signups_id>   — used to credit comeback_converted_at
//   ?t=<token>                          — short tamper-check, not security-critical
//   ?ch=sms|email                       — which channel sent them here
//   ?email=<addr>&first=<name>          — prefill so they don't retype
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
    address: '3447 Bell Blvd',
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
const OFFER_PRICE = 29;
const OFFER_DURATION = '1 Week';

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

export default function LocationComebackSignup() {
  const { location: slug } = useParams<{ location: string }>();
  const [searchParams] = useSearchParams();
  const location = slug ? LOCATIONS[slug] : null;

  // Comeback params — ref ties the conversion back to the original abandoned signup
  const refSignupId = searchParams.get('ref') || '';
  const arrivalChannel = searchParams.get('ch') || ''; // 'sms' | 'email' | ''

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string>('');
  const [formData, setFormData] = useState({
    firstName: searchParams.get('first') || '',
    lastName:  searchParams.get('last')  || '',
    email:     searchParams.get('email') || '',
    phone:     searchParams.get('phone') || '',
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

  // If they have a ref+anon-readable lookup token, prefill from the original
  // signup row. This is a soft enhancement; if it fails we just show the form.
  useEffect(() => {
    if (!refSignupId) return;
    (async () => {
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/trial_signups?id=eq.${encodeURIComponent(refSignupId)}&select=name,email,phone`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
        );
        if (!r.ok) return;
        const rows = await r.json();
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) return;
        const fullName = (row.name || '').trim();
        const [first, ...rest] = fullName.split(/\s+/);
        setFormData((prev) => ({
          ...prev,
          firstName: prev.firstName || first || '',
          lastName:  prev.lastName  || rest.join(' ') || '',
          email:     prev.email     || row.email || '',
          phone:     prev.phone     || row.phone || '',
        }));
        // Mark the click — best-effort, no failure handling needed
        fetch(
          `${SUPABASE_URL}/rest/v1/trial_signups?id=eq.${encodeURIComponent(refSignupId)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ comeback_clicked_at: new Date().toISOString() }),
          },
        ).catch(() => {});
      } catch {
        // Soft failure — empty form is fine
      }
    })();
  }, [refSignupId]);

  if (!location) return <Navigate to="/" replace />;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type } = e.target;
    const checked = type === 'checkbox' ? (e.target as HTMLInputElement).checked : undefined;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? !!checked : value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const first = formData.firstName.trim();
    const last  = formData.lastName.trim();
    const mail  = formData.email.trim();
    const tel   = formData.phone.trim();
    if (!first || first.length < 2) { setError('Please enter your first name.'); return; }
    if (!last  || last.length  < 2) { setError('Please enter your last name.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { setError('Please enter a valid email address.'); return; }
    const digits = tel.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) { setError('Please enter a valid US phone number.'); return; }

    if (location.metaPixelId && window.fbq) {
      window.fbq('track', 'Lead', {
        content_name: `${location.name} 1-Week Comeback`,
        content_category: 'comeback',
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
          customerEmail: mail,
          customerFirstName: first,
          customerLastName: last,
          customerName: `${first} ${last}`.trim(),
          customerPhone: tel,
          newsletter: formData.newsletter,
          ...getUtmParams(),
          priceVariant: 'comeback',
          comebackOriginalSignupId: refSignupId || undefined,
          comebackArrivalChannel: arrivalChannel || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.url) {
        throw new Error(data?.error || 'Could not start checkout. Please try again.');
      }

      if (location.metaPixelId && window.fbq) {
        window.fbq('track', 'InitiateCheckout', {
          content_name: `${location.name} 1-Week Comeback`,
          content_category: 'comeback',
          value: OFFER_PRICE,
          currency: 'USD',
        });
      }

      window.location.href = data.url;
    } catch (err) {
      console.error('Comeback checkout error:', err);
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setIsProcessing(false);
    }
  };

  return (
    <>
    <SEOHead
      title={`$${OFFER_PRICE} for 1 Week — ${location.name} | Better Body Bootcamp`}
      description={`$${OFFER_PRICE} for 1 week of unlimited classes at Better Body Bootcamp ${location.name}. No auto-renew.`}
      canonical={`/comeback/${location.slug}`}
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* HERO */}
      <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-red-900 text-white pt-36 pb-10 sm:pt-32 sm:pb-16 lg:pt-36 lg:pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-black/10"></div>
        {/* 2026-06-30: Hide giant blur radii on mobile — same iOS Safari
            crash pattern as /locations/[slug] (task #500). */}
        <div className="absolute inset-0 opacity-10 hidden lg:block">
          <div className="absolute top-20 left-10 w-72 h-72 bg-white rounded-full blur-3xl"></div>
          <div className="absolute bottom-10 right-10 w-96 h-96 bg-white rounded-full blur-3xl"></div>
        </div>

        <div className="max-w-5xl mx-auto px-3 sm:px-6 lg:px-8 text-center relative z-10">
          <span className="inline-block px-3 py-1 sm:px-4 sm:py-1.5 bg-white/95 text-red-900 backdrop-blur-sm rounded-full text-[10px] sm:text-xs font-black tracking-[0.2em] uppercase border border-white mb-4 sm:mb-10 whitespace-nowrap shadow-lg">
            {location.badge}
          </span>
          <h1 className="font-black mb-3 sm:mb-6 leading-[0.95] tracking-tight">
            <span className="block text-3xl sm:text-6xl md:text-7xl lg:text-8xl">{OFFER_DURATION.toUpperCase()}</span>
            <span className="block text-4xl sm:text-7xl md:text-8xl lg:text-[9rem] mt-1 sm:mt-3">FOR ${OFFER_PRICE}</span>
          </h1>
          <p className="text-sm sm:text-lg md:text-xl lg:text-2xl font-medium leading-snug sm:leading-relaxed max-w-md sm:max-w-3xl mx-auto mb-0 sm:mb-8 px-2">
            7 days of unlimited classes at <span className="whitespace-nowrap">Better Body Bootcamp {location.name}</span>.
          </p>

          <div className="hidden sm:flex flex-nowrap justify-center items-center gap-1.5 sm:gap-4 lg:gap-8 mt-6 sm:mt-10 px-1">
            <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
              <Clock className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
              <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">7 Days</span>
            </div>
            <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
              <Users className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
              <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">Unlimited Classes</span>
            </div>
            <div className="flex items-center justify-center gap-1 sm:gap-2 bg-white/10 backdrop-blur-sm px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/20 flex-1 sm:flex-initial">
              <Zap className="w-3.5 h-3.5 sm:w-5 sm:h-5 flex-shrink-0" />
              <span className="font-semibold text-[10px] sm:text-base whitespace-nowrap">No Auto-Renew</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 mt-0 sm:-mt-8 relative z-20">
        <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl p-4 sm:p-10 lg:p-12 mb-8 sm:mb-12">

          <div className="grid lg:grid-cols-5 gap-6 sm:gap-8 lg:gap-12">

            <div className="lg:col-span-2 space-y-5 sm:space-y-6 order-2 lg:order-none">
              <div>
                <h2 className="text-xl sm:text-2xl lg:text-3xl font-bold mb-4 sm:mb-6 text-gray-900 text-center lg:text-left">Why $29 for 1 week?</h2>
                <div className="space-y-3 sm:space-y-4 max-w-xs sm:max-w-none mx-auto">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">Pick up where you left off</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">A 1-week version of our trial — same classes, same results.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">$29 one-time</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">No auto-renew. No surprise charges.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">Unlimited classes</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">As many as you can fit in 7 days.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5 sm:mt-1" />
                    <div>
                      <h3 className="font-bold text-gray-900 mb-0.5 sm:mb-1 text-sm sm:text-base">If you love it, you're in</h3>
                      <p className="text-gray-600 text-xs sm:text-sm">If you don't, no hard feelings.</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-amber-50 to-white border-2 border-amber-200 rounded-2xl p-5 sm:p-6">
                <h3 className="font-bold text-base sm:text-lg text-gray-900 mb-3 text-center lg:text-left">Your $29 Week Includes:</h3>
                <ul className="space-y-1.5 sm:space-y-2 text-gray-700 text-xs sm:text-sm max-w-xs sm:max-w-none mx-auto">
                  <li className="flex items-start gap-2"><span className="text-orange-600 mt-0.5">•</span> Unlimited classes for 7 days</li>
                  <li className="flex items-start gap-2"><span className="text-orange-600 mt-0.5">•</span> Real trainers, real community</li>
                  <li className="flex items-start gap-2"><span className="text-orange-600 mt-0.5">•</span> Access at our {location.name} studio</li>
                  <li className="flex items-start gap-2"><span className="text-orange-600 mt-0.5">•</span> No card on file unless you opt in</li>
                </ul>
                <div className="border-t border-amber-200 mt-4 pt-3 flex justify-between items-baseline">
                  <div>
                    <div className="font-bold text-gray-700 uppercase text-xs tracking-wider">Today</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">7 days of unlimited classes</div></div>
                  <span className="text-2xl sm:text-3xl font-black text-orange-600">${OFFER_PRICE}</span>
                </div>
                <p className="text-xs sm:text-sm text-orange-600 font-bold mt-2">
                  Offer available only to New York City residents.
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
                    <a href={`tel:${location.phone}`} className="hover:text-orange-600 transition-colors font-semibold">{location.phone}</a>
                  </div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-3 order-1 lg:order-none" id="trial-form">
              <div className="bg-gradient-to-br from-gray-50 to-white border border-gray-200 rounded-2xl p-4 sm:p-8 scroll-mt-24">
                <div className="mb-5 sm:mb-6 text-center lg:text-left">
                  <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-1">Claim Your $29 Week</h2>
                  <p className="text-xs sm:text-sm text-gray-600">
                    Unlimited classes at <span className="font-semibold">{location.name}</span> for 7 days · ${OFFER_PRICE}.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">First Name *</label>
                      <input type="text" name="firstName" value={formData.firstName} onChange={handleChange} required minLength={2} autoComplete="given-name"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">Last Name *</label>
                      <input type="text" name="lastName" value={formData.lastName} onChange={handleChange} required minLength={2} autoComplete="family-name"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 text-gray-900" />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">Email *</label>
                      <input type="email" name="email" value={formData.email} onChange={handleChange} required autoComplete="email" placeholder="you@email.com"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 text-gray-900" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">Mobile Phone *</label>
                      <input type="tel" name="phone" value={formData.phone} onChange={handleChange} required inputMode="tel" autoComplete="tel" placeholder="(212) 555-0100"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 text-gray-900" />
                      <p className="text-[10px] text-gray-500 mt-1">We text class confirmations — must be a real US mobile.</p>
                    </div>
                  </div>

                  <div className="pt-3">
                    <label className="flex items-start gap-3 cursor-pointer text-sm text-gray-700 py-2 min-h-[44px]">
                      <input type="checkbox" name="newsletter" checked={formData.newsletter} onChange={handleChange}
                        className="mt-0.5 w-5 h-5 text-orange-600 border-gray-300 rounded focus:ring-orange-500" />
                      <span>Send me class schedules and updates</span>
                    </label>
                  </div>

                  {error && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{error}</div>
                  )}

                  <p className="text-xs text-gray-600 leading-relaxed">
                    By clicking <strong>Continue to Secure Checkout</strong>, you agree to receive transactional SMS from Better Body Bootcamp about your membership at the phone number provided. Message frequency varies; msg &amp; data rates may apply. Reply HELP for help or STOP to opt out. See our <a href="/privacy" className="underline">Privacy Policy</a> and <a href="/terms" className="underline">Terms</a>.
                  </p>

                  <button type="submit" disabled={isProcessing}
                    className="group w-full bg-gradient-to-r from-red-600 to-red-800 hover:from-red-700 hover:to-red-900 text-white px-6 py-4 rounded-xl font-black text-lg uppercase tracking-wider transition-all transform hover:scale-[1.01] shadow-lg hover:shadow-red-600/40 flex items-center justify-center gap-3 disabled:opacity-60 disabled:cursor-not-allowed disabled:transform-none">
                    {isProcessing ? 'Processing...' : (
                      <>Continue to Secure Checkout · ${OFFER_PRICE}<ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" /></>
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
