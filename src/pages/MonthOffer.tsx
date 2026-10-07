import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { MapPin, Lock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { captureUtmsFromUrl, getUtmParams } from '../lib/utm';
import { getMetaClickIds } from '../lib/metaClickIds';

// ─── /month/:studio — $99 One Month Unlimited ───────────────────────────────
// 2026-10-05. Built for the offer-ladder drip (ladder-send step "99"), which
// is the rung between $299 two months and the $49 two weeks.
//
// BAYSIDE + FRESH MEADOWS ONLY. This is enforced in THREE places on purpose:
//   1. STUDIOS below (the picker only offers two),
//   2. the slug guard in this component (a hand-typed /month/astoria shows a
//      "not sold here" panel rather than a broken checkout),
//   3. PRODUCT_STUDIOS in mt-card-checkout (the server refuses with a 400).
// Belt and braces: the only one that protects the money is (3), but a customer
// should never reach it.
//
// Checkout is the same native path the $49 trial and the $299 promo use:
// mt-card-checkout stores the card in Mariana Tek (MT tokenizes into ITS
// Stripe), charges it there, and attaches the contract. Our Stripe is out of
// the money path entirely.
//
// MT CONTRACT: "$99 One Month Unlimited (Web)", id 15109, created 2026-10-05.
// mt-card-checkout resolves it from the MT_CONTRACT_MONTH_99 secret rather
// than a literal, so if that secret is unset the server refuses the sale
// outright (409) instead of taking money with nowhere to put it.
//
// NOINDEX + not in the sitemap. This is an email destination, not a page we
// want ranking against /trial — the ladder is a private concession, and a
// public $99 month would undercut the $239 membership for everyone.
// ─────────────────────────────────────────────────────────────────────────────

type Studio = { slug: string; name: string; address: string };

const STUDIOS: Studio[] = [
  { slug: 'bayside',       name: 'Bayside',       address: '34-47 Bell Blvd' },
  { slug: 'fresh-meadows', name: 'Fresh Meadows', address: '76-46 164th Street' },
];

const redText: React.CSSProperties = { color: '#E11D2A' };
// NOTE: the BlackLives font renders "·" as garbage glyphs — never put a
// middot in headline text. (Carried over from BackToSchool.tsx.)
const headline: React.CSSProperties = { fontFamily: "'BlackLives', Impact, sans-serif", letterSpacing: '0.02em' };

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const inputCls =
  'px-3 py-3 rounded-lg bg-black/40 border border-white/20 text-white placeholder-gray-500 ' +
  'focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60';

export default function MonthOffer() {
  // Accept BOTH /month/bayside and /month?studio=bayside. The ladder emails
  // use the path form; anything hand-shared may use the query form.
  const { studio: pathStudio } = useParams<{ studio?: string }>();
  const [params] = useSearchParams();
  const requested = (pathStudio || params.get('studio') || '').toLowerCase();

  const [slug, setSlug] = useState<string>(
    STUDIOS.some((s) => s.slug === requested) ? requested : '',
  );
  const studio = STUDIOS.find((s) => s.slug === slug) ?? null;

  // Someone asked for a studio by name and it is not one of the two. Say so
  // plainly and point at the $49, which IS sold everywhere — do not silently
  // drop them into a picker as though they mistyped.
  const wrongStudio = requested.length > 0 && !STUDIOS.some((s) => s.slug === requested);

  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [cardForm, setCardForm] = useState({ number: '', exp: '', ccv: '', zip: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);

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

    const cardNumber = cardForm.number.replace(/[\s-]/g, '');
    const expMatch = cardForm.exp.trim().match(/^(0?[1-9]|1[0-2])\s*[/\s-]?\s*(\d{2}|\d{4})$/);
    if (!/^\d{12,19}$/.test(cardNumber)) { setError('Please enter a valid card number.'); return; }
    if (!expMatch) { setError('Expiration should look like MM/YY.'); return; }
    if (!/^\d{3,4}$/.test(cardForm.ccv.trim())) { setError('Please enter the 3 or 4 digit security code.'); return; }
    if (!/^\d{5}(-\d{4})?$/.test(cardForm.zip.trim())) { setError('Please enter your billing ZIP code.'); return; }
    const expMonth = expMatch[1].padStart(2, '0');
    const expYear = expMatch[2].length === 2 ? `20${expMatch[2]}` : expMatch[2];

    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (window.fbq) {
        window.fbq('track', 'InitiateCheckout', {
          content_name: `${studio.name} One Month ($99)`,
          value: 99, currency: 'USD',
        });
      }
      const { fbp, fbc } = getMetaClickIds();
      const utm = getUtmParams();
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
          kind: 'month',
          card: { number: cardNumber, exp_month: expMonth, exp_year: expYear, ccv: cardForm.ccv.trim(), postal_code: cardForm.zip.trim() },
          fbp, fbc,
          // 2026-10-05: send SNAKE_CASE explicitly. mt-card-checkout reads
          // body.utm_source, but getUtmParams() returns camelCase — the
          // `...getUtmParams()` spread used by LocationTrialSignup and
          // BackToSchool therefore lands as NULL on every native sale. The
          // function now accepts both shapes, and this page never relied on
          // that leniency in the first place.
          utm_source: utm.utmSource,
          utm_medium: utm.utmMedium,
          utm_campaign: utm.utmCampaign,
          utm_content: utm.utmContent,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || 'Could not complete checkout. Please try again.');
      }
      if (window.fbq) {
        window.fbq('track', 'Purchase', {
          content_name: `${studio.name} One Month ($99)`,
          value: 99, currency: 'USD',
        });
      }
      // Card data lives only in component state; clear before navigating.
      setCardForm({ number: '', exp: '', ccv: '', zip: '' });
      window.location.href = `/trial-success?studio=${studio.slug}&native=1&kind=month`;
    } catch (err) {
      setError((err as Error).message || 'Something went wrong. Please try again.');
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-black">
      <SEOHead
        title="One Month Unlimited for $99 | Better Body Bootcamp"
        description="One month of unlimited coach-led classes for $99 at Better Body Bootcamp Bayside and Fresh Meadows. One payment, nothing recurring."
        noindex
      />

      <section className="pt-28 pb-6 sm:pt-32 sm:pb-8 text-center text-white">
        <div className="mx-auto w-full max-w-3xl px-4">
          <p className="mb-3 inline-block border border-red-600/60 bg-red-600/15 px-4 py-1.5 text-xs sm:text-sm font-bold uppercase tracking-[0.3em] text-red-500">
            Bayside &amp; Fresh Meadows
          </p>
          <h1 style={headline} className="uppercase leading-[0.95]">
            <span className="block text-[clamp(2rem,6vw,3.6rem)]">One Month Unlimited</span>
            <span style={{ ...headline, ...redText }} className="block text-[clamp(2.6rem,8vw,4.8rem)] drop-shadow-[0_2px_14px_rgba(225,29,42,0.4)]">
              $99
            </span>
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm sm:text-base text-gray-300">
            One payment. No auto-renewal. Every class, every time slot, for a full month.
          </p>
        </div>
      </section>

      <section className="bg-gradient-to-b from-black via-gray-950 to-black px-4 sm:px-8 py-10 sm:py-14">
        <div className="mx-auto max-w-4xl">
          {wrongStudio ? (
            <div className="mx-auto max-w-xl rounded-xl border border-white/10 bg-white/5 p-6 text-center">
              <h2 style={headline} className="mb-3 text-2xl uppercase text-white">Not at that studio</h2>
              <p className="text-sm leading-relaxed text-gray-300">
                The $99 month runs at Bayside and Fresh Meadows only. Our two-week
                trial for $49 is available at all four studios.
              </p>
              <a
                href="/trial"
                className="mt-5 inline-block rounded-xl bg-red-600 px-6 py-3 text-sm font-extrabold uppercase tracking-wider text-white hover:bg-red-700"
              >
                See the $49 two weeks →
              </a>
            </div>
          ) : (
            <>
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

              <div className="mx-auto mb-8 grid max-w-xl grid-cols-2 gap-3 sm:gap-4">
                {STUDIOS.map((s) => (
                  <button
                    key={s.slug}
                    type="button"
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
                        disabled={submitting} className={inputCls}
                      />
                      <input
                        type="text" required autoComplete="family-name" placeholder="Last name"
                        value={form.lastName}
                        onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                        disabled={submitting} className={inputCls}
                      />
                    </div>
                    <input
                      type="email" required autoComplete="email" placeholder="Email address"
                      value={form.email}
                      onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                      disabled={submitting} className={`w-full ${inputCls}`}
                    />
                    <input
                      type="tel" required autoComplete="tel" placeholder="Phone number"
                      value={form.phone}
                      onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                      disabled={submitting} className={`w-full ${inputCls}`}
                    />
                    <input
                      type="text" required inputMode="numeric" autoComplete="cc-number" placeholder="Card number"
                      value={cardForm.number}
                      onChange={(e) => setCardForm((f) => ({ ...f, number: e.target.value.replace(/[^\d\s]/g, '') }))}
                      disabled={submitting} className={`w-full ${inputCls}`}
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
                        disabled={submitting} className={inputCls}
                      />
                      <input
                        type="text" required inputMode="numeric" autoComplete="cc-csc" placeholder="CVC"
                        value={cardForm.ccv}
                        onChange={(e) => setCardForm((f) => ({ ...f, ccv: e.target.value.replace(/\D/g, '') }))}
                        disabled={submitting} className={inputCls}
                      />
                      <input
                        type="text" required inputMode="numeric" autoComplete="postal-code" placeholder="ZIP"
                        value={cardForm.zip}
                        onChange={(e) => setCardForm((f) => ({ ...f, zip: e.target.value.replace(/[^\d-]/g, '') }))}
                        disabled={submitting} className={inputCls}
                      />
                    </div>
                    {error && <p className="text-xs leading-relaxed text-red-400">{error}</p>}
                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full rounded-xl bg-red-600 py-4 text-base font-extrabold uppercase tracking-wider text-white transition-colors hover:bg-red-700 disabled:cursor-wait disabled:opacity-60"
                    >
                      {submitting ? 'Processing…' : 'Start my month — $99 →'}
                    </button>
                    <p className="text-xs leading-relaxed text-gray-500">
                      By signing up you agree to our{' '}
                      <a href="/privacy" className="underline">Privacy Policy</a> and{' '}
                      <a href="/terms" className="underline">Terms</a>. You pay $99 today, one time.
                      Nothing recurring; your month starts at your first class.
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
            </>
          )}
        </div>
      </section>
    </div>
  );
}
