// 2026-09-03: HIDDEN $1 live-fire test page for the MT card checkout.
// Not linked anywhere, not in the sitemap, noindex. Charges $1 to contract
// 14946 "Web Checkout Test $1 (do not sell)" through mt-card-checkout —
// the exact same function and code path the live $49/$299 pages use.
// DELETE this page (and the "webtest" PRODUCT entry + contract 14946)
// once the test passes.
import { useState } from 'react';
import { Helmet } from 'react-helmet-async';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export default function CheckoutTest() {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [card, setCard] = useState({ number: '', exp: '', ccv: '', zip: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    const cardNumber = card.number.replace(/[\s-]/g, '');
    const expMatch = card.exp.trim().match(/^(0?[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/);
    if (!/^\d{12,19}$/.test(cardNumber)) { setMsg('Bad card number'); return; }
    if (!expMatch) { setMsg('Exp should be MM/YY'); return; }
    if (!/^\d{3,4}$/.test(card.ccv.trim())) { setMsg('Bad CVC'); return; }
    if (!/^\d{5}(-\d{4})?$/.test(card.zip.trim())) { setMsg('Bad billing ZIP'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/mt-card-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          first_name: form.firstName.trim(),
          last_name: form.lastName.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          studio_slug: 'bayside',
          kind: 'webtest',
          card: {
            number: cardNumber,
            exp_month: expMatch[1].padStart(2, '0'),
            exp_year: expMatch[2].length === 2 ? `20${expMatch[2]}` : expMatch[2],
            ccv: card.ccv.trim(),
            postal_code: card.zip.trim(),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.message || data?.error || 'failed');
      setOk(true);
      setCard({ number: '', exp: '', ccv: '' });
      setMsg(`SUCCESS — order ${data.order_id}. $1 charged via MT Stripe, card on file, membership attached.`);
    } catch (err) {
      setMsg(`FAILED: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const cls = 'w-full px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400';
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-6">
      <Helmet><meta name="robots" content="noindex,nofollow,noarchive,nosnippet" /><title>Internal test</title></Helmet>
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 bg-white rounded-2xl p-6 shadow">
        <h1 className="font-bold text-lg text-gray-900">$1 checkout test (internal)</h1>
        <p className="text-xs text-gray-500">Charges $1 through MT&apos;s Stripe on the Bayside test contract. Refund in MT admin afterward.</p>
        <div className="grid grid-cols-2 gap-3">
          <input className={cls} required placeholder="First" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
          <input className={cls} required placeholder="Last" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
        </div>
        <input className={cls} required type="email" placeholder="Email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
        <input className={cls} required type="tel" placeholder="Phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
        <input className={cls} required inputMode="numeric" autoComplete="cc-number" placeholder="Card number" value={card.number} onChange={e => setCard(c => ({ ...c, number: e.target.value.replace(/[^\d\s]/g, '') }))} />
        <div className="grid grid-cols-3 gap-3">
          <input className={cls} required inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" value={card.exp} onChange={e => setCard(c => ({ ...c, exp: e.target.value }))} />
          <input className={cls} required inputMode="numeric" autoComplete="cc-csc" placeholder="CVC" value={card.ccv} onChange={e => setCard(c => ({ ...c, ccv: e.target.value.replace(/\D/g, '') }))} />
          <input className={cls} required inputMode="numeric" autoComplete="postal-code" placeholder="ZIP" value={card.zip} onChange={e => setCard(c => ({ ...c, zip: e.target.value.replace(/[^\d-]/g, '') }))} />
        </div>
        {msg && <p className={`text-sm leading-relaxed ${ok ? 'text-green-700' : 'text-red-600'}`}>{msg}</p>}
        <button type="submit" disabled={busy} className="w-full bg-gray-900 text-white font-bold py-3 rounded-xl disabled:opacity-60">
          {busy ? 'Processing…' : 'Run $1 test'}
        </button>
      </form>
    </div>
  );
}
