import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, MapPin, ChevronDown, Lock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { captureUtmsFromUrl, getUtmParams } from '../lib/utm';

// ─── /backtoschool — 2 Months for $299 promo ────────────────────────────────
// Bio links /bts and /bts/<studio> (netlify.toml) land here with UTMs.
//
// 2026-08-28: MT WIDGET REMOVED. Checkout is native: a BBB form posts to
// create-trial-checkout with product:'bts299' → Stripe Checkout ($299 inline
// price_data) → stripe-webhook fires mt-provision, which attaches MT contract
// 14913 via the Admin API. Same outcome as the widget — active member in MT.
//
// 2026-08-30: flyer-style cream redesign REVERTED at Justin's request — this
// is the dark ad-card design restored.
//
// Design follows the BBB ad style: BlackLives condensed caps over darkened
// live footage, brand red CTA. NOTE: the BlackLives font renders "·" as
// garbage glyphs — never use middots in headline text.
// ─────────────────────────────────────────────────────────────────────────────

type Studio = { slug: string; name: string; locationId: string; address: string };

// locationId = locations.id (Supabase UUID) — what create-trial-checkout keys on.
const STUDIOS: Studio[] = [
  { slug: 'astoria',       name: 'Astoria',       locationId: 'dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45', address: '31-18 Steinway Street' },
  { slug: 'bayside',       name: 'Bayside',       locationId: '5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7', address: '34-47 Bell Blvd' },
  { slug: 'fresh-meadows', name: 'Fresh Meadows', locationId: '6bbbe077-bcc6-4d9d-a10b-7605c1484752', address: '76-46 164th Street' },
  { slug: 'williamsburg',  name: 'Williamsburg',  locationId: '80536b45-df0e-42d1-880c-e9301372e1cf', address: '487 Driggs Ave' },
];

const redText: React.CSSProperties = { color: '#E11D2A' };
const headline: React.CSSProperties = { fontFamily: "'BlackLives', Impact, sans-serif", letterSpacing: '0.02em' };

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export default function BackToSchool() {
  const [params] = useSearchParams();
  const paramStudio = params.get('studio') ?? '';
  const [slug, setSlug] = useState<string>(
    STUDIOS.some((s) => s.slug === paramStudio) ? paramStudio : '',
  );
  const studio = STUDIOS.find((s) => s.slug === slug) ?? null;

  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);

  // Persist UTMs from the /bts redirect so the attribution bridge can stamp
  // the eventual signup row, same as the trial pages.
  useEffect(() => {
    captureUtmsFromUrl();
  }, []);

  const scrollToCheckout = () => {
    document.getElementById('bts-checkout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || !studio) return;
    setError('');
    const first = form.firstName.trim();
    const last = form.lastName.trim();
    const mail = form.email.trim();
    const tel = form.phone.trim();
    if (!first) { setError('Please enter your first name.'); return; }
    if (!last) { setError('Please enter your last name.'); return; }
    if (!mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { setError('Please enter a valid email address.'); return; }
    if (!tel || tel.replace(/\D/g, '').length < 10) { setError('Please enter a valid phone number.'); return; }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-trial-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          product: 'bts299',
          locationId: studio.locationId,
          locationName: studio.name,
          customerEmail: mail,
          customerFirstName: first,
          customerLastName: last,
          customerName: `${first} ${last}`.trim(),
          customerPhone: tel,
          ...getUtmParams(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.url) {
        throw new Error(data?.error || 'Could not start checkout. Please try again.');
      }
      window.location.href = data.url;
    } catch (err) {
      setError((err as Error).message || 'Something went wrong. Please try again.');
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-black">
      <SEOHead
        title="Back to School: 2 Months for $299 | Better Body Bootcamp"
        description="Back to School special: 2 months of unlimited coach-led classes for $299, one-time payment. All four Better Body Bootcamp studios in Queens and Brooklyn."
        noindex
      />

      {/* ── Video hero, ad-card style ── */}
      {/* 2026-08-28: was lg:min-h-[calc(100svh-5.5rem)] — full-height centering
          left a huge dead band above the headline on desktop ("hero is too
          low"). The follow-up lg:pt-24 over-compacted it. Middle ground: 72vh
          min-height with centered content — presence without the dead band. */}
      <section className="relative flex items-center overflow-hidden pt-40 pb-12 sm:pt-40 sm:pb-14 lg:min-h-[88vh] lg:pt-28 lg:pb-16 text-center text-white">
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src="/services/hero.mp4"
          poster="/services/hero-poster.webp"
          autoPlay
          muted
          loop
          playsInline
        />
        <div className="absolute inset-0 bg-black/70" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black" />

        <div className="relative z-10 mx-auto w-full max-w-4xl px-4">
          <p className="mb-3 inline-block border border-red-600/60 bg-red-600/15 px-4 py-1.5 text-xs sm:text-sm font-bold uppercase tracking-[0.3em] text-red-500">
            Back to School Special
          </p>
          <h1 style={headline} className="uppercase leading-[0.95]">
            <span className="block text-[clamp(2.4rem,7vw,4.8rem)]">2 Months Unlimited</span>
            <span style={{ ...headline, ...redText }} className="block text-[clamp(3.2rem,10vw,6.5rem)] drop-shadow-[0_2px_14px_rgba(225,29,42,0.4)]">
              $299
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base sm:text-lg text-gray-300">
            One payment. No auto-renewal. Your 2 months start at your first class.
          </p>

          <div className="mx-auto mt-5 flex flex-col items-center justify-center gap-y-1.5 text-sm text-gray-200 sm:flex-row sm:gap-x-6 sm:gap-y-0 sm:whitespace-nowrap">
            <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-500" />Unlimited classes</span>
            <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-500" />One payment, nothing recurring</span>
            <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-500" />Starts at your first class</span>
          </div>

          <button
            onClick={scrollToCheckout}
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-red-600 px-10 py-4 text-base sm:text-lg font-extrabold uppercase tracking-wider text-white shadow-[0_8px_30px_rgba(225,29,42,0.45)] transition-transform hover:scale-105 hover:bg-red-700"
          >
            Claim the offer
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>
      </section>

      {/* ── Checkout ── */}
      <section id="bts-checkout" className="bg-gradient-to-b from-black via-gray-950 to-black px-4 sm:px-8 py-10 sm:py-14 scroll-mt-20">
        <div className="mx-auto max-w-6xl">
          <h2 style={headline} className="mb-2 text-center uppercase text-white text-[clamp(1.6rem,4.5vw,2.6rem)]">
            {studio ? (
              <>Sign up at <span style={{ ...headline, ...redText }}>{studio.name}</span></>
            ) : (
              'Pick your studio'
            )}
          </h2>
          <p className="mb-7 text-center text-sm text-gray-400">
            {studio ? 'Checkout is open below. Two minutes and you are in.' : 'Choose where you train and checkout opens right here.'}
          </p>

          <div className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {STUDIOS.map((s) => (
              <button
                key={s.slug}
                onClick={() => setSlug(s.slug)}
                className={`rounded-xl border p-4 sm:p-5 text-center transition-all ${
                  slug === s.slug
                    ? 'border-red-600 bg-red-600/15 text-white shadow-[0_0_20px_rgba(225,29,42,0.25)]'
                    : 'border-white/15 bg-white/5 text-gray-300 hover:border-white/40 hover:text-white'
                }`}
              >
                <span style={headline} className="block text-base sm:text-xl uppercase tracking-wide">{s.name}</span>
                <span className="mt-1 flex items-center justify-center gap-1 text-[11px] sm:text-xs text-gray-400">
                  <MapPin className="h-3 w-3" />{s.address}
                </span>
              </button>
            ))}
          </div>

          {studio ? (
            <div className="mx-auto grid max-w-4xl gap-6 lg:grid-cols-5 lg:gap-0 lg:overflow-hidden lg:rounded-2xl lg:border lg:border-white/10">
              {/* Offer panel */}
              <div className="rounded-xl border border-red-600/40 bg-red-600/10 p-5 text-center lg:col-span-2 lg:flex lg:flex-col lg:justify-center lg:rounded-none lg:border-0 lg:bg-red-950/40 lg:p-8 lg:text-left">
                <p style={headline} className="uppercase text-white text-2xl lg:text-3xl">
                  <span style={redText}>$299.</span> Two months.
                </p>
                <p style={headline} className="uppercase text-white text-2xl lg:text-3xl">Every class at {studio.name}.</p>
                <p className="mt-3 text-sm text-gray-300">
                  Pay once, train for two months. When it ends, it ends. Nothing renews, nothing to cancel.
                </p>
                <ul className="mt-5 hidden space-y-2 text-sm text-gray-200 lg:block">
                  <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 flex-shrink-0 text-red-500" />Unlimited classes, 7 days a week</li>
                  <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 flex-shrink-0 text-red-500" />Starts at your first class, not today</li>
                  <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 flex-shrink-0 text-red-500" />{studio.address}</li>
                </ul>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-5 sm:p-6 lg:col-span-3 lg:rounded-none lg:border-0 lg:p-8">
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text" required autoComplete="given-name" placeholder="First name"
                    value={form.firstName}
                    onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                    disabled={submitting}
                    className="px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                  />
                  <input
                    type="text" required autoComplete="family-name" placeholder="Last name"
                    value={form.lastName}
                    onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                    disabled={submitting}
                    className="px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                  />
                </div>
                <input
                  type="email" required autoComplete="email" placeholder="Email address"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  disabled={submitting}
                  className="w-full px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                />
                <input
                  type="tel" required autoComplete="tel" placeholder="Phone number"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  disabled={submitting}
                  className="w-full px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                />
                {error && <p className="text-xs text-red-400 leading-relaxed">{error}</p>}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-xl bg-red-600 py-4 text-base font-extrabold uppercase tracking-wider text-white transition-colors hover:bg-red-700 disabled:cursor-wait disabled:opacity-60"
                >
                  {submitting ? 'Starting checkout…' : 'Get 2 months for $299 →'}
                </button>
                <p className="text-xs leading-relaxed text-gray-500">
                  By signing up you agree to our{' '}
                  <a href="/privacy" className="underline">Privacy Policy</a> and{' '}
                  <a href="/terms" className="underline">Terms</a>. Payment handled securely by Stripe;
                  your membership is activated automatically.
                </p>
                <div className="flex items-center justify-center gap-2 pt-1 text-xs text-gray-500">
                  <Lock className="h-3.5 w-3.5" />
                  Secure checkout — Apple Pay, Google Pay, Link supported
                </div>
              </form>
            </div>
          ) : (
            <p className="text-center text-sm text-gray-500">The checkout appears once you pick a studio.</p>
          )}

          <p className="mt-8 text-center text-xs uppercase tracking-[0.25em] text-gray-600">
            New York's group fitness bootcamp since 2011
          </p>
        </div>
      </section>
    </div>
  );
}
