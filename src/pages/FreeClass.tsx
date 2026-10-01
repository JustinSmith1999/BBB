import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, MapPin } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { captureUtmsFromUrl, getUtmParams } from '../lib/utm';

// ─── /collab/free-class-8x2m — 1 Free Class (collab) landing page (2026-10-01) ─
// QR-code landing page for collaborations: partner shares the QR / link, the
// person picks Astoria or Williamsburg, leaves name/email/phone, and the
// free3-claim edge fn (offer: "free1") grants the $0 "1 Class Free Promo"
// credit in Mariana Tek, drops the lead in Homebase and alerts the studio.
// ?ref=<partner> tags the claim with who sent them (utm_source), so each
// collaboration's results can be read on the board. Short links in
// netlify.toml: /c/ast-8x2m, /c/wb-4q9t, /c/8x2m (+ ?ref=). Unguessable on
// purpose (Chris): only people with the QR / link get the free class. Not in sitemap.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

type Studio = { slug: string; name: string; address: string };
const STUDIOS: Studio[] = [
  { slug: 'astoria',      name: 'Astoria',      address: '31-18 Steinway Street' },
  { slug: 'williamsburg', name: 'Williamsburg', address: '487 Driggs Ave' },
];

export default function FreeClass() {
  const [params] = useSearchParams();
  const paramStudio = params.get('studio') ?? '';
  const ref = (params.get('ref') ?? '').trim().slice(0, 60);
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
          offer: 'free1',
          ref,
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
        title="Your Free Class | Better Body Bootcamp"
        description="One free class at Better Body Bootcamp Astoria or Williamsburg. No card, no commitment."
        noindex
      />

      <section className="bg-gradient-to-br from-black to-gray-900 px-4 pt-28 pb-14 text-center text-white">
        <p className="mb-4 inline-block rounded-full bg-red-600/15 border border-red-600/50 px-4 py-1.5 text-xs sm:text-sm font-bold uppercase tracking-[0.25em] text-red-500">
          {ref ? `${ref} × Better Body` : 'You were invited'}
        </p>
        <h1 className="text-[clamp(2.2rem,5.5vw,3.8rem)] font-bold leading-tight">
          <span className="text-red-600">One Free Class.</span> On Us.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-gray-300">
          No card, no commitment. Claim your class and the studio texts you to get you booked.
        </p>
        <div className="mx-auto mt-6 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-300">
          <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-600" />Coach-led small group training</span>
          <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-600" />All levels welcome</span>
          <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-red-600" />Astoria &amp; Williamsburg</span>
        </div>
      </section>

      <section className="mx-auto max-w-2xl px-4 py-12">
        <div className="rounded-2xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white p-6 sm:p-8 shadow-sm">
          {done ? (
            <div className="py-6 text-center">
              <CheckCircle className="mx-auto h-14 w-14 text-green-600" />
              <h2 className="mt-4 text-2xl font-bold text-gray-900">You're in.</h2>
              <p className="mx-auto mt-3 max-w-md text-gray-600">
                Your free class is on your account. The <span className="font-semibold">{studio?.name}</span> team will text you shortly to book it. Come ready to work.
              </p>
            </div>
          ) : (
            <>
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900">Claim Your Free Class</h2>
              <p className="mt-1 text-sm text-gray-600">Pick your studio and tell us where to text you.</p>

              <div className="mt-5 grid grid-cols-2 gap-3">
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
                  {busy ? 'Claiming…' : 'Claim My Free Class'}
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
