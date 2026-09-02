import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, MapPin } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { captureUtmsFromUrl, getUtmParams } from '../lib/utm';

// ─── /freeclasses — 3 Free Classes claim page (2026-08-21) ──────────────────
// Landing page for the abandoned-checkout winback. No payment: name/email/
// phone form -> free3-claim edge fn -> lead lands in Homebase + studio gets
// notified to book them in. Short links: /free3/<studio> (netlify.toml).
// Styled to match the site (dark hero + red accents + white form card, same
// language as the /trial pages). Not in the sitemap.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

type Studio = { slug: string; name: string; address: string };
const STUDIOS: Studio[] = [
  { slug: 'astoria',       name: 'Astoria',       address: '31-18 Steinway Street' },
  { slug: 'bayside',       name: 'Bayside',       address: '34-47 Bell Blvd' },
  { slug: 'fresh-meadows', name: 'Fresh Meadows', address: '76-46 164th Street' },
  { slug: 'williamsburg',  name: 'Williamsburg',  address: '487 Driggs Ave' },
];

export default function FreeClasses() {
  const [params] = useSearchParams();
  const paramStudio = params.get('studio') ?? '';
  const [slug, setSlug] = useState<string>(STUDIOS.some((s) => s.slug === paramStudio) ? paramStudio : '');
  const studio = STUDIOS.find((s) => s.slug === slug) ?? null;
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => { captureUtmsFromUrl(); }, []);

  const submit = async () => {
    setError('');
    if (!studio) { setError('Pick your studio first.'); return; }
    const first = form.firstName.trim(), last = form.lastName.trim(), mail = form.email.trim(), tel = form.phone.trim();
    if (first.length < 2) { setError('Please enter your first name.'); return; }
    if (last.length < 2) { setError('Please enter your last name.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { setError('Please enter a valid email address.'); return; }
    const digits = tel.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) { setError('Please enter a valid US phone number.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/free3-claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({
          studioSlug: studio.slug,
          firstName: first, lastName: last, email: mail, phone: tel,
          ...getUtmParams(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'Something went wrong. Please try again.');
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-red-600 focus:outline-none focus:ring-1 focus:ring-red-600';

  return (
    <div className="min-h-screen bg-white">
      <SEOHead
        title="3 Free Classes | Better Body Bootcamp"
        description="Come see for yourself: 3 free classes at any Better Body Bootcamp studio. No commitment."
        noindex
      />

      {/* Hero — same language as the trial pages */}
      <section className="bg-gradient-to-br from-black to-gray-900 px-4 pt-28 pb-14 text-center text-white">
        <p className="mb-4 inline-block rounded-full bg-red-600/15 border border-red-600/50 px-4 py-1.5 text-xs sm:text-sm font-bold uppercase tracking-[0.25em] text-red-500">
          Come see for yourself
        </p>
        <h1 className="text-[clamp(2.2rem,5.5vw,3.8rem)] font-bold leading-tight">
          <span className="text-red-600">3 Free Classes.</span> On Us.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-gray-300">
          No commitment, no card. Claim your classes and your studio texts you to get you booked.
        </p>
        <div className="mx-auto mt-6 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-300">
          <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-600" />Coach-led small group classes</span>
          <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-600" />All levels welcome</span>
          <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-600" />Offer ends Sep 21</span>
        </div>
      </section>

      {/* Claim card */}
      <section className="mx-auto max-w-2xl px-4 py-12">
        <div className="rounded-2xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white p-6 sm:p-8 shadow-sm">
          {done ? (
            <div className="py-6 text-center">
              <CheckCircle className="mx-auto h-14 w-14 text-green-600" />
              <h2 className="mt-4 text-2xl font-bold text-gray-900">You're in.</h2>
              <p className="mx-auto mt-3 max-w-md text-gray-600">
                The <span className="font-semibold">{studio?.name}</span> team will text you shortly to book your 3 classes. Come ready to work.
              </p>
            </div>
          ) : (
            <>
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900">Claim Your 3 Free Classes</h2>
              <p className="mt-1 text-sm text-gray-600">Pick your studio and tell us where to text you.</p>

              <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {STUDIOS.map((s) => (
                  <button
                    key={s.slug}
                    onClick={() => setSlug(s.slug)}
                    className={`rounded-xl border p-3 text-center transition-all ${
                      slug === s.slug
                        ? 'border-red-600 bg-red-50 text-red-700'
                        : 'border-gray-200 bg-white text-gray-800 hover:border-gray-400'
                    }`}
                  >
                    <span className="block text-sm font-bold">{s.name}</span>
                    <span className="mt-1 flex items-center justify-center gap-1 text-[11px] text-gray-500">
                      <MapPin className="h-3 w-3" />{s.address}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-5 grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <input className={input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
                  <input className={input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
                </div>
                <input className={input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                <input className={input} type="tel" placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
                <button
                  onClick={submit}
                  disabled={busy}
                  className="mt-1 rounded-lg bg-red-600 py-4 text-lg font-extrabold uppercase tracking-wider text-white transition-all hover:bg-red-700 hover:scale-[1.01] disabled:opacity-60"
                >
                  {busy ? 'Claiming…' : 'Claim My 3 Classes'}
                </button>
                <p className="text-center text-xs text-gray-500">
                  The studio will reach out to schedule. No purchase required.
                </p>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
