import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { MapPin, Lock } from 'lucide-react';
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

// Meta click ids for CAPI match quality (same logic as LocationTrialSignup).
function getMetaClickIds(): { fbp: string; fbc: string } {
  if (typeof document === 'undefined') return { fbp: '', fbc: '' };
  const readCookie = (n: string) =>
    document.cookie.split('; ').find((c) => c.startsWith(`${n}=`))?.slice(n.length + 1) ?? '';
  let fbc = readCookie('_fbc');
  const fbclid = new URLSearchParams(window.location.search).get('fbclid');
  if (!fbc && fbclid) fbc = `fb.1.${Date.now()}.${fbclid}`;
  return { fbp: readCookie('_fbp'), fbc };
}

export default function BackToSchool() {
  // 2026-10-05: also mounted at /twomonths/:studio for the offer ladder, so
  // accept the studio from the PATH as well as ?studio=. The old /bts and
  // /backtoschool links only ever used the query form; both still work.
  const { studio: pathStudio } = useParams<{ studio?: string }>();
  const [params] = useSearchParams();
  const paramStudio = (pathStudio || params.get('studio') || '').toLowerCase();
  const [slug, setSlug] = useState<string>(
    STUDIOS.some((s) => s.slug === paramStudio) ? paramStudio : '',
  );
  const studio = STUDIOS.find((s) => s.slug === slug) ?? null;

  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  // 2026-09-03: card capture through MT's Stripe (mt-card-checkout), same as
  // the trial pages. MT vaults + charges the card; our Stripe is out of it.
  const [cardForm, setCardForm] = useState({ number: '', exp: '', ccv: '', zip: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);

  // Persist UTMs from the /bts redirect so the attribution bridge can stamp
  // the eventual signup row, same as the trial pages.
  useEffect(() => {
    captureUtmsFromUrl();
  }, []);

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

    // card validation (in-page card, charged + stored via MT's Stripe)
    const cardNumber = cardForm.number.replace(/[\s-]/g, '');
    const expMatch = cardForm.exp.trim().match(/^(0?[1-9]|1[0-2])\s*[\/\s-]?\s*(\d{2}|\d{4})$/);
    if (!/^\d{12,19}$/.test(cardNumber)) { setError('Please enter a valid card number.'); return; }
    if (!expMatch) { setError('Expiration should look like MM/YY.'); return; }
    if (!/^\d{3,4}$/.test(cardForm.ccv.trim())) { setError('Please enter the 3 or 4 digit security code.'); return; }
    if (!/^\d{5}(-\d{4})?$/.test(cardForm.zip.trim())) { setError('Please enter your billing ZIP code.'); return; }
    const expMonth = expMatch[1].padStart(2, '0');
    const expYear = expMatch[2].length === 2 ? `20${expMatch[2]}` : expMatch[2];

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const { fbp, fbc } = getMetaClickIds();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/mt-card-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          first_name: first,
          last_name: last,
          email: mail,
          phone: tel,
          studio_slug: studio.slug,
          kind: 'bts299',
          card: { number: cardNumber, exp_month: expMonth, exp_year: expYear, ccv: cardForm.ccv.trim(), postal_code: cardForm.zip.trim() },
          fbp, fbc,
          ...getUtmParams(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || 'Could not complete checkout. Please try again.');
      }
      if (window.fbq) {
        window.fbq('track', 'Purchase', {
          content_name: `${studio.name} Back to School ($299)`,
          value: 299, currency: 'USD',
        });
      }
      setCardForm({ number: '', exp: '', ccv: '' });
      window.location.href = `/trial-success?studio=${studio.slug}&native=1&kind=bts299`;
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

      {/* ── Compact offer statement ── */}
      {/* 2026-09-11 (Justin): page stripped to the offer line + the form.
          Video hero, checkmark row, scroll CTA, offer panel and the $49
          fallback section are gone so checkout is on screen immediately. */}
      <section className="pt-28 pb-6 sm:pt-32 sm:pb-8 text-center text-white">
        <div className="mx-auto w-full max-w-3xl px-4">
          <p className="mb-3 inline-block border border-red-600/60 bg-red-600/15 px-4 py-1.5 text-xs sm:text-sm font-bold uppercase tracking-[0.3em] text-red-500">
            Back to School Special
          </p>
          <h1 style={headline} className="uppercase leading-[0.95]">
            <span className="block text-[clamp(2rem,6vw,3.6rem)]">2 Months Unlimited</span>
            <span style={{ ...headline, ...redText }} className="block text-[clamp(2.6rem,8vw,4.8rem)] drop-shadow-[0_2px_14px_rgba(225,29,42,0.4)]">
              $299
            </span>
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm sm:text-base text-gray-300">
            One payment. No auto-renewal. Your 2 months start at your first class.
          </p>
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
            <div className="mx-auto max-w-xl">
              <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-5 sm:p-6">
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
                {/* card fields — vaulted + charged via Mariana Tek's Stripe */}
                <input
                  type="text" required inputMode="numeric" autoComplete="cc-number" placeholder="Card number"
                  value={cardForm.number}
                  onChange={(e) => setCardForm((f) => ({ ...f, number: e.target.value.replace(/[^\d\s]/g, '') }))}
                  disabled={submitting}
                  className="w-full px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                />
                <div className="grid grid-cols-3 gap-3">
                  <input
                    type="text" required inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" maxLength={7}
                    value={cardForm.exp}
                    onChange={(e) => {
                      // Mobile numeric keypads have no "/" key, so auto-insert it.
                      const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
                      const formatted = digits.length >= 3 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
                      setCardForm((f) => ({ ...f, exp: formatted }));
                    }}
                    disabled={submitting}
                    className="px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                  />
                  <input
                    type="text" required inputMode="numeric" autoComplete="cc-csc" placeholder="CVC"
                    value={cardForm.ccv}
                    onChange={(e) => setCardForm((f) => ({ ...f, ccv: e.target.value.replace(/\D/g, '') }))}
                    disabled={submitting}
                    className="px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                  />
                  <input
                    type="text" required inputMode="numeric" autoComplete="postal-code" placeholder="ZIP"
                    value={cardForm.zip}
                    onChange={(e) => setCardForm((f) => ({ ...f, zip: e.target.value.replace(/[^\d-]/g, '') }))}
                    disabled={submitting}
                    className="px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                  />
                </div>
                {error && <p className="text-xs text-red-400 leading-relaxed">{error}</p>}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-xl bg-red-600 py-4 text-base font-extrabold uppercase tracking-wider text-white transition-colors hover:bg-red-700 disabled:cursor-wait disabled:opacity-60"
                >
                  {submitting ? 'Processing…' : 'Get 2 months for $299 →'}
                </button>
                <p className="text-xs leading-relaxed text-gray-500">
                  By signing up you agree to our{' '}
                  <a href="/privacy" className="underline">Privacy Policy</a> and{' '}
                  <a href="/terms" className="underline">Terms</a>. You pay $299 today, one time.
                  Nothing recurring; your membership is activated automatically.
                </p>
                <div className="flex items-center justify-center gap-2 pt-1 text-xs text-gray-500">
                  <Lock className="h-3.5 w-3.5" />
                  Payment processed securely by Mariana Tek + Stripe
                </div>
              </form>
            </div>
          ) : (
            <p className="text-center text-sm text-gray-500">The checkout appears once you pick a studio.</p>
          )}
        </div>
      </section>
    </div>
  );
}
