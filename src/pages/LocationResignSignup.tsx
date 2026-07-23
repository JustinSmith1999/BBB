import { useState, useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { ArrowRight, CheckCircle, Clock, Users, Zap, MapPin, Phone, Lock, Star } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { getUtmParams, captureUtmsFromUrl } from '../lib/utm';

// ─── PER-GYM CONFIG ─────────────────────────────────────────────────────────
type LocationConfig = {
  slug: string; locationId: string; name: string; badge: string;
  address: string; city: string; state: string; zip: string;
  phone: string; metaPixelId: string | null; heroImage: string;
};

const LOCATIONS: Record<string, LocationConfig> = {
  'astoria':       { slug: 'astoria',       locationId: 'dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45', name: 'Astoria',       badge: 'ASTORIA · QUEENS',         address: '31-18 Steinway Street',  city: 'Astoria',       state: 'NY', zip: '11103', phone: '(718) 704-9954', metaPixelId: '1291566006435758', heroImage: '/astoria-final.webp' },
  'bayside':       { slug: 'bayside',       locationId: '5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7', name: 'Bayside',       badge: 'BAYSIDE · QUEENS',         address: '3447 Bell Blvd',         city: 'Bayside',       state: 'NY', zip: '11361', phone: '(646) 566-8870', metaPixelId: '931144729719242',  heroImage: '/bayside-final.webp' },
  'fresh-meadows': { slug: 'fresh-meadows', locationId: '6bbbe077-bcc6-4d9d-a10b-7605c1484752', name: 'Fresh Meadows', badge: 'FRESH MEADOWS · QUEENS',   address: '76-46 164th Street',     city: 'Fresh Meadows', state: 'NY', zip: '11366', phone: '(646) 566-8207', metaPixelId: '979328851475276',  heroImage: '/freshmeadows-final.webp' },
  'williamsburg':  { slug: 'williamsburg',  locationId: '80536b45-df0e-42d1-880c-e9301372e1cf', name: 'Williamsburg',  badge: 'WILLIAMSBURG · BROOKLYN',  address: '487 Driggs Ave',         city: 'Brooklyn',      state: 'NY', zip: '11211', phone: '(718) 683-1864', metaPixelId: '2160299368182872', heroImage: '/williamsburg-final.webp' },
};

const SUPABASE_URL     = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const OFFER_PRICE = 99;
const OFFER_DURATION = '30 Days';

export default function LocationResignSignup() {
  const { location: slugParam } = useParams<{ location: string }>();
  const slug = (slugParam ?? '').toLowerCase();
  const location = LOCATIONS[slug];

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', newsletter: false });

  useEffect(() => {
    // Persist any utm_* on the URL so attribution survives re-renders.
    captureUtmsFromUrl();
  }, [slug]);

  useEffect(() => {
    if (!location?.metaPixelId) return;
    const id = location.metaPixelId;
    const s = document.createElement('script');
    s.innerHTML = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');fbq('track','ViewContent',{content_name:'Resign Win-Back ${OFFER_PRICE}',value:${OFFER_PRICE},currency:'USD'});`;
    document.head.appendChild(s);
  }, [location]);

  if (!location) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const first = form.firstName.trim();
    const last  = form.lastName.trim();
    const mail  = form.email.trim();
    const tel   = form.phone.trim();
    if (!first || first.length < 2)      { setError('Please enter your first name.'); return; }
    if (!last  || last.length  < 2)      { setError('Please enter your last name.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { setError('Please enter a valid email address.'); return; }
    const digits = tel.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) { setError('Please enter a valid US phone number.'); return; }
    setSubmitting(true);
    try {
      // @ts-ignore
      if (typeof fbq !== 'undefined') fbq('track', 'Lead', { content_name: 'Resign Win-Back', value: OFFER_PRICE, currency: 'USD' });
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-trial-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({
          locationId: location.locationId,
          locationName: location.name,
          customerEmail: form.email.trim(),
          customerFirstName: form.firstName.trim(),
          customerLastName: form.lastName.trim(),
          customerName: `${form.firstName.trim()} ${form.lastName.trim()}`.trim(),
          customerPhone: form.phone.trim(),
          newsletter: form.newsletter,
          ...getUtmParams(),
          priceVariant: 'resign',
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

  const tel = location.phone.replace(/\D+/g, '');

  return (
    <>
      <SEOHead
        title={`Come Back for $99 — ${location.name} | Better Body Bootcamp`}
        description={`Former members: come back to Better Body Bootcamp ${location.name} for $99 your first month. Standard pricing after, cancel anytime in-studio. ${location.address}, ${location.city}.`}
        canonical={`/resign/${location.slug}`}
      />

      <div className="min-h-screen bg-black text-white">

        {/* ── HERO (2-col on desktop, stacked on mobile) ───────────────────────── */}
        <section className="relative overflow-hidden pt-24 sm:pt-28">
          <div className="absolute inset-0 z-0">
            <div className="absolute inset-0 bg-gradient-to-b from-black via-zinc-950 to-black" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,rgba(220,38,38,0.22),transparent_55%)]" />
          </div>

          <div className="relative z-10 max-w-7xl mx-auto px-5 sm:px-8 lg:px-12 pb-14 sm:pb-16">
            <div className="grid lg:grid-cols-12 gap-8 lg:gap-12 items-center">

              {/* LEFT — copy + CTA */}
              <div className="lg:col-span-7 text-center lg:text-left">
                <span className="inline-flex items-center gap-2 bg-red-600/15 border border-red-500/40 text-red-300 text-[10px] sm:text-[11px] font-extrabold tracking-[0.22em] px-3.5 py-1.5 rounded-full mb-6 backdrop-blur-sm">
                  ❤ WELCOME BACK · {location.badge}
                </span>

                <h1 className="font-black leading-[0.95] tracking-[-0.025em] mb-5 text-[clamp(2.25rem,4.5vw,4rem)]">
                  30 Days Back<br />
                  <span className="text-red-600">For ${OFFER_PRICE}.</span>
                </h1>

                <p className="text-base sm:text-lg lg:text-xl text-zinc-300 max-w-xl mb-7 leading-relaxed mx-auto lg:mx-0">
                  Your spot at <span className="font-semibold text-white">{location.name}</span> is still here.
                  First month <span className="text-red-400 font-semibold">${OFFER_PRICE}</span>.
                  Standard pricing kicks in month 2. Cancel anytime in-studio.
                </p>

                <div className="flex flex-wrap justify-center lg:justify-start gap-2 sm:gap-2.5 mb-7">
                  <span className="inline-flex items-center gap-1.5 bg-white/[0.06] backdrop-blur-sm border border-white/15 px-3 py-1.5 rounded-lg text-xs font-semibold">
                    <Clock className="w-3.5 h-3.5 text-red-500" /> {OFFER_DURATION}
                  </span>
                  <span className="inline-flex items-center gap-1.5 bg-white/[0.06] backdrop-blur-sm border border-white/15 px-3 py-1.5 rounded-lg text-xs font-semibold">
                    <Users className="w-3.5 h-3.5 text-red-500" /> Unlimited Classes
                  </span>
                  <span className="inline-flex items-center gap-1.5 bg-white/[0.06] backdrop-blur-sm border border-white/15 px-3 py-1.5 rounded-lg text-xs font-semibold">
                    <Zap className="w-3.5 h-3.5 text-red-500" /> No Long Contract
                  </span>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 items-center lg:items-start justify-center lg:justify-start">
                  <a href="#resign-form"
                     className="inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-extrabold tracking-wide px-6 py-3 rounded-full text-sm sm:text-base transition-all shadow-lg shadow-red-900/30 hover:scale-[1.02] w-full sm:w-auto">
                    CLAIM YOUR SPOT · ${OFFER_PRICE}
                    <ArrowRight className="w-4 h-4" />
                  </a>
                  <a href={`tel:${tel}`}
                     className="inline-flex items-center gap-2 text-zinc-300 hover:text-white font-semibold text-sm">
                    <Phone className="w-4 h-4 text-red-500" /> {location.phone}
                  </a>
                </div>
              </div>

              {/* RIGHT — studio photo (desktop only, hidden on mobile) */}
              <div className="hidden lg:block lg:col-span-5">
                <div className="relative aspect-[4/5] rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-red-950/40">
                  <img src={location.heroImage}
                       alt={`Better Body Bootcamp ${location.name} studio`}
                       className="absolute inset-0 w-full h-full object-cover"
                       loading="eager" />
                  <div className="absolute inset-0 bg-gradient-to-tr from-black/60 via-transparent to-red-900/20" />
                  <div className="absolute bottom-5 left-5 right-5">
                    <div className="text-[10px] font-extrabold tracking-[0.22em] text-red-400 mb-1">YOUR STUDIO</div>
                    <div className="text-xl font-bold text-white leading-tight">{location.name}</div>
                    <div className="text-xs text-white/70 mt-1">{location.address}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Marquee — slim on desktop */}
          <div className="relative z-10 overflow-hidden border-y border-red-900/40 bg-red-950/20 py-2">
            <div className="flex whitespace-nowrap animate-marquee">
              {Array.from({ length: 10 }).map((_, i) => (
                <span key={i} className="text-red-500 font-extrabold text-[11px] tracking-[0.32em] mx-5">
                  COME BACK FOR ${OFFER_PRICE} · {location.badge} · 30 DAYS UNLIMITED ·
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ── MAIN CARD ────────────────────────────────────────────────────────── */}
        <section className="relative z-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 -mt-2 sm:-mt-6 mb-12 sm:mb-20">
          <div className="bg-white text-zinc-900 rounded-2xl sm:rounded-3xl shadow-[0_30px_80px_-20px_rgba(220,38,38,0.45)] p-5 sm:p-10 lg:p-12">

            <div className="grid lg:grid-cols-12 gap-8 lg:gap-12">

              {/* LEFT — why come back (5 of 12 cols on desktop) */}
              <div className="lg:col-span-5 space-y-6 order-2 lg:order-none">
                <div>
                  <div className="text-[10px] font-extrabold tracking-[0.18em] text-red-600 mb-2">WHY COME BACK</div>
                  <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-zinc-900 leading-[1.1]">
                    The studio you remember.<br />
                    Sharper.
                  </h2>
                </div>

                <div className="space-y-3.5">
                  {[
                    { h: 'Same studio, stronger program', p: "Coaches you'll recognize. Programming that's been dialed in since you left." },
                    { h: '$99 first month',               p: 'Covers your first 30 days back. Standard rate kicks in month 2 — cancel anytime in-studio.' },
                    { h: 'No long contract',              p: 'Auto-renews monthly. You decide when to stop. No cancellation fee, ever.' },
                    { h: 'Real progress this time',       p: "30 days is enough to feel results. Two weeks isn't — we did the math." },
                  ].map((b, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <CheckCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <h3 className="font-bold text-zinc-900 text-sm sm:text-base leading-tight">{b.h}</h3>
                        <p className="text-zinc-600 text-xs sm:text-sm leading-relaxed mt-0.5">{b.p}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-zinc-900 text-white rounded-2xl p-5 sm:p-6 relative overflow-hidden">
                  <div className="absolute -right-10 -top-10 w-32 h-32 bg-red-600/20 rounded-full blur-3xl pointer-events-none" />
                  <div className="relative">
                    <div className="text-[10px] font-extrabold tracking-[0.18em] text-red-400 mb-3">YOUR 30 DAYS BACK</div>
                    <ul className="space-y-2 text-zinc-200 text-sm mb-4">
                      <li className="flex items-start gap-2"><Star className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0 fill-red-500" /> Unlimited classes for 30 days</li>
                      <li className="flex items-start gap-2"><Star className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0 fill-red-500" /> Fitness reassessment with a coach</li>
                      <li className="flex items-start gap-2"><Star className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0 fill-red-500" /> Goal reset session</li>
                      <li className="flex items-start gap-2"><Star className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0 fill-red-500" /> Full access at {location.name}</li>
                    </ul>
                    <div className="border-t border-white/15 pt-3 flex justify-between items-baseline">
                      <div>
                        <div className="font-bold text-white/90 uppercase text-xs tracking-wider">Month 1</div>
                        <div className="text-[10px] text-zinc-400 mt-0.5">Standard rate kicks in month 2</div>
                      </div>
                      <span className="text-3xl sm:text-4xl font-black text-red-500 leading-none">${OFFER_PRICE}</span>
                    </div>
                    <p className="text-[10px] sm:text-xs text-zinc-400 mt-2 italic">
                      You have 60 days to claim and start your trial.
                    </p>
                    <p className="text-xs sm:text-sm text-red-400 font-bold mt-2">
                      Offer available only to New York City residents.
                    </p>
                    <p className="text-[9px] sm:text-[10px] text-zinc-500 mt-3 leading-tight">
                      All trials non-refundable.
                    </p>
                  </div>
                </div>
              </div>

              {/* RIGHT — form (7 of 12 cols on desktop, full width with constrained max) */}
              <div className="lg:col-span-7 order-1 lg:order-none">
                <form onSubmit={submit} id="resign-form" className="scroll-mt-24 max-w-xl lg:max-w-none">
                  <div className="mb-6">
                    <div className="text-[10px] font-extrabold tracking-[0.18em] text-red-600 mb-2">CLAIM YOUR SPOT</div>
                    <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-zinc-900 mb-1.5">
                      Come back for ${OFFER_PRICE}.
                    </h2>
                    <p className="text-zinc-600 text-sm sm:text-base">
                      First month ${OFFER_PRICE} at {location.name}. Standard pricing in month 2 — cancel anytime in-studio.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-[11px] font-extrabold text-zinc-700 mb-1.5 tracking-[0.1em]">FIRST NAME *</label>
                      <input type="text" required minLength={2} autoComplete="given-name"
                        value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })}
                        className="w-full px-4 py-3 border border-zinc-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/20 focus:outline-none transition-all" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-extrabold text-zinc-700 mb-1.5 tracking-[0.1em]">LAST NAME *</label>
                      <input type="text" required minLength={2} autoComplete="family-name"
                        value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })}
                        className="w-full px-4 py-3 border border-zinc-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/20 focus:outline-none transition-all" />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-[11px] font-extrabold text-zinc-700 mb-1.5 tracking-[0.1em]">EMAIL *</label>
                      <input type="email" required autoComplete="email" placeholder="you@email.com"
                        value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                        className="w-full px-4 py-3 border border-zinc-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/20 focus:outline-none transition-all" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-extrabold text-zinc-700 mb-1.5 tracking-[0.1em]">MOBILE PHONE *</label>
                      <input type="tel" required inputMode="tel" autoComplete="tel" placeholder="(212) 555-0100"
                        value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })}
                        className="w-full px-4 py-3 border border-zinc-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/20 focus:outline-none transition-all" />
                      <p className="text-[10px] text-zinc-500 mt-1">Real US mobile — class confirmations are texted.</p>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 mb-5 text-sm text-zinc-700 select-none cursor-pointer">
                    <input type="checkbox" checked={form.newsletter} onChange={e => setForm({ ...form, newsletter: e.target.checked })}
                      className="w-4 h-4 rounded border-zinc-300 text-red-600 focus:ring-red-500" />
                    Send me class schedules and updates
                  </label>

                  <p className="text-[11px] text-zinc-500 mb-4 leading-relaxed">
                    By clicking <strong>Continue to Secure Checkout</strong>, you agree to receive transactional SMS from Better Body Bootcamp about your membership at the phone number provided. Message frequency varies; msg &amp; data rates may apply. Reply HELP for help or STOP to opt out.
                    <span className="block mt-1">
                      <strong className="text-zinc-700">Pricing:</strong> First month ${OFFER_PRICE}. Standard monthly rate applies month 2 and auto-renews until you cancel in-studio. No cancellation fees.
                    </span>
                    <span className="block mt-1">
                      <a href="/privacy" className="underline hover:text-zinc-700">Privacy</a> · <a href="/terms" className="underline hover:text-zinc-700">Terms</a>
                    </span>
                  </p>

                  {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl mb-4 text-sm font-medium">{error}</div>}

                  <button type="submit" disabled={submitting}
                    className="group w-full bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-extrabold tracking-wide py-4 px-6 rounded-full text-base sm:text-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-red-900/30 hover:scale-[1.005]">
                    {submitting ? 'REDIRECTING…' : <>CONTINUE TO SECURE CHECKOUT · ${OFFER_PRICE} <ArrowRight className="w-5 h-5 group-hover:translate-x-0.5 transition-transform" /></>}
                  </button>

                  <p className="text-[11px] text-zinc-500 mt-3 inline-flex items-center gap-1.5 justify-center w-full">
                    <Lock className="w-3 h-3" /> Payment processed securely via Stripe
                  </p>

                  <div className="mt-7 pt-6 border-t border-zinc-100 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm text-zinc-600">
                    <span className="inline-flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-red-500" />
                      <span>{location.address}, {location.city}, {location.state} {location.zip}</span>
                    </span>
                    <a href={`tel:${tel}`} className="inline-flex items-center gap-2 font-semibold hover:text-red-700">
                      <Phone className="w-4 h-4 text-red-500" />
                      {location.phone}
                    </a>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </section>

      </div>

      <style>{`
        @keyframes marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .animate-marquee { animation: marquee 35s linear infinite; width: 200%; }
      `}</style>
    </>
  );
}
