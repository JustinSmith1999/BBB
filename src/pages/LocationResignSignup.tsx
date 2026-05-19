import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { ArrowRight, CheckCircle, Clock, Users, Heart, MapPin, Phone, Lock } from 'lucide-react';
import SEOHead from '../components/SEOHead';

// ─── PER-GYM CONFIG ─────────────────────────────────────────────────────────
// $99 first-month win-back for FORMER members (Expired/Terminated/Suspended
// 12+ months ago, no recent visits). Uses Stripe SUBSCRIPTION with a one-time
// first-month coupon — not a Payment Link / one-time charge.
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
    city: 'Astoria', state: 'NY', zip: '11103',
    phone: '(718) 704-9954',
    metaPixelId: '1291566006435758',
  },
  'bayside': {
    slug: 'bayside',
    locationId: '5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7',
    name: 'Bayside',
    badge: 'BAYSIDE · QUEENS',
    address: '34-47 Bell Boulevard',
    city: 'Bayside', state: 'NY', zip: '11361',
    phone: '(646) 566-8870',
    metaPixelId: '931144729719242',
  },
  'fresh-meadows': {
    slug: 'fresh-meadows',
    locationId: '6bbbe077-bcc6-4d9d-a10b-7605c1484752',
    name: 'Fresh Meadows',
    badge: 'FRESH MEADOWS · QUEENS',
    address: '76-46 164th Street',
    city: 'Fresh Meadows', state: 'NY', zip: '11366',
    phone: '(646) 566-8207',
    metaPixelId: '979328851475276',
  },
  'williamsburg': {
    slug: 'williamsburg',
    locationId: '80536b45-df0e-42d1-880c-e9301372e1cf',
    name: 'Williamsburg',
    badge: 'WILLIAMSBURG · BROOKLYN',
    address: '487 Driggs Ave',
    city: 'Brooklyn', state: 'NY', zip: '11211',
    phone: '(718) 683-1864',
    metaPixelId: '2160299368182872',
  },
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const OFFER_PRICE = 99;
const OFFER_DURATION = '30 Days';

export default function LocationResignSignup() {
  const { location: slugParam } = useParams<{ location: string }>();
  const slug = (slugParam ?? '').toLowerCase();
  const location = LOCATIONS[slug];

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', newsletter: false });

  useEffect(() => {
    if (!location?.metaPixelId) return;
    const id = location.metaPixelId;
    const s = document.createElement('script');
    s.innerHTML = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');fbq('track','ViewContent',{content_name:'Resign Win-Back',value:${OFFER_PRICE},currency:'USD'});`;
    document.head.appendChild(s);
  }, [location]);

  if (!location) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim() || !form.email.trim() || !form.phone.trim()) {
      setError('Please complete name, email, and phone.');
      return;
    }
    setSubmitting(true);
    try {
      // @ts-ignore — fbq is injected by Meta Pixel
      if (typeof fbq !== 'undefined') fbq('track', 'Lead', { content_name: 'Resign Win-Back', value: OFFER_PRICE, currency: 'USD' });
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-trial-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({
          locationId: location.locationId,
          locationName: location.name,
          customerEmail: form.email.trim(),
          customerName: form.name.trim(),
          customerPhone: form.phone.trim(),
          newsletter: form.newsletter,
          priceVariant: 'resign', // ← new variant; create-trial-checkout creates a Subscription + coupon
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Checkout failed');
      // @ts-ignore
      if (typeof fbq !== 'undefined') fbq('track', 'InitiateCheckout', { content_name: 'Resign Win-Back', value: OFFER_PRICE, currency: 'USD' });
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again or call us.');
      setSubmitting(false);
    }
  }

  return (
    <>
      <SEOHead
        title={`Come Back for $99 — ${location.name} | Better Body Bootcamp`}
        description={`Former members: come back to Better Body Bootcamp ${location.name} for $99 your first month. Standard pricing after, cancel anytime in-studio. ${location.address}, ${location.city}.`}
        canonical={`/resign/${location.slug}`}
      />

      <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-black text-white">
        {/* HERO */}
        <div className="pt-28 sm:pt-32 pb-12 sm:pb-16">
          <div className="container mx-auto px-4 sm:px-6 text-center">
            <span className="inline-block bg-emerald-600/15 text-emerald-400 text-xs font-bold tracking-[0.18em] px-4 py-1.5 rounded-full mb-5">
              ❤️ WELCOME BACK · {location.badge}
            </span>
            <h1 className="text-5xl sm:text-7xl md:text-8xl font-black leading-[0.95] mb-5">
              30 Days<br />
              <span className="text-emerald-400">For ${OFFER_PRICE}.</span>
            </h1>
            <p className="text-base sm:text-xl text-zinc-300 max-w-2xl mx-auto mb-8">
              First month for ${OFFER_PRICE}. Standard pricing starts month 2.
              Cancel anytime in-studio. We saved your spot at {location.name}.
            </p>
            <div className="flex flex-wrap justify-center gap-3 sm:gap-4">
              <span className="inline-flex items-center gap-2 bg-white/10 border border-white/20 px-4 py-2 rounded-lg text-sm font-semibold">
                <Clock className="w-4 h-4" /> {OFFER_DURATION}
              </span>
              <span className="inline-flex items-center gap-2 bg-white/10 border border-white/20 px-4 py-2 rounded-lg text-sm font-semibold">
                <Users className="w-4 h-4" /> Unlimited Classes
              </span>
              <span className="inline-flex items-center gap-2 bg-white/10 border border-white/20 px-4 py-2 rounded-lg text-sm font-semibold">
                <Heart className="w-4 h-4" /> No Long Contract
              </span>
            </div>
          </div>
        </div>

        {/* MAIN CARD */}
        <div className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 mt-0 sm:-mt-8 relative z-20">
          <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl p-4 sm:p-10 lg:p-12 mb-8 sm:mb-12 text-zinc-900">
            <div className="grid lg:grid-cols-5 gap-6 sm:gap-12">
              {/* LEFT — why come back */}
              <div className="lg:col-span-2 space-y-5 sm:space-y-6 order-2 lg:order-none">
                <h2 className="text-xl sm:text-2xl lg:text-3xl font-bold text-center lg:text-left">Why come back?</h2>
                <div className="space-y-4">
                  {[
                    { h: 'Same studio, new program', p: 'Coaches are stronger, programming is dialed in, classes are full.' },
                    { h: 'Half the walk-in rate', p: '$99 for 30 days. Standard rate kicks in month 2 — cancel anytime in-studio.' },
                    { h: 'No long contract', p: 'Auto-renews monthly. You decide when to stop.' },
                    { h: 'Real progress this time', p: '30 days is enough to feel results. Two weeks isn\'t.' },
                  ].map((b, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <h3 className="font-bold text-zinc-900 mb-0.5 text-sm sm:text-base">{b.h}</h3>
                        <p className="text-zinc-600 text-xs sm:text-sm">{b.p}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-gradient-to-br from-emerald-50 to-white border-2 border-emerald-200 rounded-2xl p-5 sm:p-6">
                  <h3 className="font-bold text-base sm:text-lg text-zinc-900 mb-3">Your 30 Days Back Includes:</h3>
                  <ul className="space-y-1.5 sm:space-y-2 text-zinc-700 text-xs sm:text-sm">
                    <li className="flex items-start gap-2"><span className="text-emerald-600 mt-0.5">•</span> Unlimited classes for 30 days</li>
                    <li className="flex items-start gap-2"><span className="text-emerald-600 mt-0.5">•</span> Full fitness reassessment with a coach</li>
                    <li className="flex items-start gap-2"><span className="text-emerald-600 mt-0.5">•</span> Goal reset</li>
                    <li className="flex items-start gap-2"><span className="text-emerald-600 mt-0.5">•</span> Access at our {location.name} studio</li>
                  </ul>
                  <div className="border-t border-emerald-200 mt-4 pt-3 flex justify-between items-baseline">
                    <div>
                      <div className="font-bold text-zinc-700 uppercase text-xs tracking-wider">Month 1</div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">Standard rate applies month 2</div>
                    </div>
                    <span className="text-2xl sm:text-3xl font-black text-emerald-600">${OFFER_PRICE}</span>
                  </div>
                </div>
              </div>

              {/* RIGHT — form */}
              <div className="lg:col-span-3 order-1 lg:order-none">
                <form onSubmit={submit} id="resign-form" className="scroll-mt-24">
                  <h2 className="text-2xl sm:text-3xl font-bold mb-2">Come Back for ${OFFER_PRICE}</h2>
                  <p className="text-zinc-600 mb-6 text-sm sm:text-base">First month ${OFFER_PRICE} at {location.name}. Standard pricing kicks in month 2 — cancel anytime in-studio.</p>

                  <label className="block text-xs font-bold text-zinc-700 mb-1 tracking-wide">FULL NAME</label>
                  <input type="text" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                    className="w-full px-4 py-3 border border-zinc-200 rounded-lg mb-4 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-xs font-bold text-zinc-700 mb-1 tracking-wide">EMAIL</label>
                      <input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                        className="w-full px-4 py-3 border border-zinc-200 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-zinc-700 mb-1 tracking-wide">PHONE</label>
                      <input type="tel" required value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })}
                        className="w-full px-4 py-3 border border-zinc-200 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                    </div>
                  </div>

                  <label className="flex items-center gap-2 mb-5 text-sm text-zinc-700">
                    <input type="checkbox" checked={form.newsletter} onChange={e => setForm({ ...form, newsletter: e.target.checked })}
                      className="w-4 h-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500" />
                    Send me class schedules and updates
                  </label>

                  <p className="text-[11px] text-zinc-500 mb-4 leading-relaxed">
                    By clicking Continue to Secure Checkout, you agree to receive transactional SMS from Better Body Bootcamp about your membership at the phone number provided. Message frequency varies; msg &amp; data rates may apply. Reply HELP for help or STOP to opt out. <strong className="text-zinc-700">Pricing:</strong> First month ${OFFER_PRICE}. Standard monthly rate applies month 2 and auto-renews until you cancel in-studio. No cancellation fees. <a href="/privacy" className="underline">Privacy</a> · <a href="/terms" className="underline">Terms</a>.
                  </p>

                  {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>}

                  <button type="submit" disabled={submitting}
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 px-6 rounded-full text-base sm:text-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/20">
                    {submitting ? 'Redirecting…' : <>CONTINUE TO SECURE CHECKOUT · ${OFFER_PRICE} <ArrowRight className="w-5 h-5" /></>}
                  </button>

                  <p className="text-[11px] text-zinc-500 mt-3 inline-flex items-center gap-1.5 justify-center w-full">
                    <Lock className="w-3 h-3" /> Payment processed securely via Stripe
                  </p>
                </form>

                <div className="mt-8 pt-6 border-t border-zinc-100 text-xs text-zinc-500 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5" /> {location.address}, {location.city}, {location.state} {location.zip}
                  </span>
                  <a href={`tel:${location.phone.replace(/\D+/g, '')}`} className="inline-flex items-center gap-1.5 hover:text-emerald-700">
                    <Phone className="w-3.5 h-3.5" /> {location.phone}
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
