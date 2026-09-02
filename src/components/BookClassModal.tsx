import { useEffect, useRef, useState } from 'react';
import { X, CheckCircle, ArrowRight } from 'lucide-react';
import type { MTClassSession } from '../lib/mtClient';

// ─────────────────────────────────────────────────────────────────────────────
// BookClassModal (2026-08-28) — native 1-tap booking via the book-class edge
// function (MT Admin API). Replaces the MT-widget login wall as the primary
// path; the widget remains reachable via a fallback link at the bottom.
//
// Flow:
//   • email prefilled from localStorage(bbb_book_email)
//   • device token in localStorage(bbb_book_token) → books instantly
//   • otherwise: send 6-digit code (SMS to the phone on their MT account,
//     email fallback) → enter code → booked + device remembered.
// ─────────────────────────────────────────────────────────────────────────────

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/book-class`;

type Step = 'email' | 'code' | 'booking' | 'done' | 'no_account' | 'no_credits';

interface Props {
  session: MTClassSession;
  studioName: string;
  studioSlug: string;
  onClose: () => void;
}

async function call(body: Record<string, unknown>) {
  const r = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

export default function BookClassModal({ session: s, studioName, studioSlug, onClose }: Props) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState(() => localStorage.getItem('bbb_book_email') || '');
  const [code, setCode] = useState('');
  const [first, setFirst] = useState('');
  const [phoneHint, setPhoneHint] = useState<string | null>(null);
  const [sentVia, setSentVia] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const when = new Date(s.start_datetime).toLocaleString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);

  const finishBooking = (data: { device_token?: string; first?: string }) => {
    if (data.device_token) localStorage.setItem('bbb_book_token', data.device_token);
    localStorage.setItem('bbb_book_email', email);
    if (data.first) setFirst(data.first);
    setStep('done');
  };

  const tryBook = async (withCode?: string) => {
    setBusy(true); setError('');
    const deviceToken = localStorage.getItem('bbb_book_token');
    const res = await call({
      action: 'book', email, class_session_id: s.id,
      ...(withCode ? { code: withCode } : {}),
      ...(deviceToken && !withCode ? { device_token: deviceToken } : {}),
    });
    setBusy(false);
    if (res.ok && res.booked) { finishBooking(res); return true; }
    if (res.error === 'verification_required') return false;
    if (res.error === 'no_account') { setStep('no_account'); return true; }
    if (res.error === 'no_payment_option') { setStep('no_credits'); return true; }
    setError(res.error || 'Something went wrong. Try again.');
    return true; // handled (error shown)
  };

  const sendCode = async () => {
    setBusy(true); setError('');
    const res = await call({ action: 'send_code', email });
    setBusy(false);
    if (res.ok) {
      setSentVia(res.sent);
      setPhoneHint(res.phone_hint || null);
      if (res.first) setFirst(res.first);
      setStep('code');
    } else if (res.error === 'no_account') {
      setStep('no_account');
    } else {
      setError(res.error || 'Could not send a code. Try again.');
    }
  };

  const onEmailContinue = async () => {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { setError('Enter a valid email.'); return; }
    setEmail(e);
    // If we have a remembered device, try booking straight away.
    if (localStorage.getItem('bbb_book_token')) {
      setStep('booking');
      const handled = await tryBook();
      if (!handled) { localStorage.removeItem('bbb_book_token'); await sendCode(); }
      else if (!localStorage.getItem('bbb_book_token')) setStep('email');
      return;
    }
    await sendCode();
  };

  const onCodeSubmit = async () => {
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code.'); return; }
    setStep('booking');
    const handled = await tryBook(code);
    if (!handled) { setError('That code didn’t work. Check it and try again.'); setStep('code'); }
    else if (step !== 'done' && error) setStep('code');
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white sm:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 p-2 text-gray-400 hover:text-black transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Class summary header */}
        <div className="bg-black text-white px-6 py-5">
          <div className="text-[10px] font-black uppercase tracking-[0.25em] text-red-500 mb-1">{studioName}</div>
          <div className="text-xl font-black uppercase leading-tight">{s.class_name}</div>
          <div className="text-sm text-white/70 mt-1">
            {when}{s.instructor_names[0] ? ` · ${s.instructor_names[0]}` : ''}
          </div>
        </div>

        <div className="px-6 py-6">
          {step === 'email' && (
            <>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">
                Your email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onEmailContinue()}
                placeholder="you@email.com"
                autoFocus
                className="w-full border-2 border-gray-200 focus:border-black rounded-xl px-4 py-3 text-base outline-none transition-colors"
              />
              {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
              <button
                onClick={onEmailContinue}
                disabled={busy}
                className="mt-4 w-full bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-black uppercase tracking-wider py-4 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {busy ? 'One sec…' : 'Book this class'} {!busy && <ArrowRight className="w-4 h-4" />}
              </button>
              <p className="text-xs text-gray-400 mt-3 text-center">
                First time? We&rsquo;ll text a quick code to the number on your account.
              </p>
            </>
          )}

          {step === 'code' && (
            <>
              <p className="text-sm text-gray-700 mb-3">
                {sentVia === 'sms'
                  ? <>We texted a 6-digit code to <b>{phoneHint || 'your phone'}</b>.</>
                  : <>We emailed a 6-digit code to <b>{email}</b>.</>}
              </p>
              <input
                ref={codeRef}
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && onCodeSubmit()}
                placeholder="••••••"
                className="w-full border-2 border-gray-200 focus:border-black rounded-xl px-4 py-3 text-2xl tracking-[0.5em] text-center outline-none transition-colors"
              />
              {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
              <button
                onClick={onCodeSubmit}
                disabled={busy}
                className="mt-4 w-full bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-black uppercase tracking-wider py-4 rounded-xl transition-colors"
              >
                {busy ? 'Booking…' : 'Confirm & book'}
              </button>
              <button onClick={sendCode} disabled={busy} className="mt-3 w-full text-xs text-gray-500 underline">
                Resend code
              </button>
            </>
          )}

          {step === 'booking' && (
            <div className="py-8 text-center text-gray-600">Booking your spot…</div>
          )}

          {step === 'done' && (
            <div className="text-center py-4">
              <CheckCircle className="w-14 h-14 text-green-600 mx-auto mb-3" />
              <div className="text-xl font-black uppercase">You&rsquo;re booked{first ? `, ${first}` : ''}!</div>
              <p className="text-sm text-gray-600 mt-2">
                {s.class_name} · {when} at {studioName}. See you there — arrive 10 minutes early.
              </p>
              <button
                onClick={onClose}
                className="mt-5 w-full bg-black text-white font-black uppercase tracking-wider py-3.5 rounded-xl"
              >
                Done
              </button>
            </div>
          )}

          {step === 'no_credits' && (
            <div className="text-center py-2">
              <div className="text-lg font-black uppercase mb-2">No classes left on your account</div>
              <p className="text-sm text-gray-600 mb-4">
                We found your account, but there's no active membership or class credits to book with.
              </p>
              <a
                href="/pricing"
                className="block w-full bg-red-600 hover:bg-red-700 text-white font-black uppercase tracking-wider py-4 rounded-xl transition-colors"
              >
                See memberships
              </a>
              <a href={`/trial/${studioSlug}`} className="block mt-3 text-xs text-gray-500 underline">
                New here? 2 weeks unlimited for $49
              </a>
            </div>
          )}

          {step === 'no_account' && (
            <div className="text-center py-2">
              <div className="text-lg font-black uppercase mb-2">We couldn&rsquo;t find that email</div>
              <p className="text-sm text-gray-600 mb-4">
                No Better Body account matches <b>{email}</b>. New here? Start with 2 weeks unlimited for $49.
              </p>
              <a
                href={`/trial/${studioSlug}`}
                className="block w-full bg-red-600 hover:bg-red-700 text-white font-black uppercase tracking-wider py-4 rounded-xl transition-colors"
              >
                Start the $49 trial
              </a>
              <button onClick={() => { setStep('email'); setError(''); }} className="mt-3 text-xs text-gray-500 underline">
                Try a different email
              </button>
            </div>
          )}

          {step !== 'done' && (
            <p className="text-[11px] text-gray-400 mt-5 text-center">
              Trouble booking? Call the studio or book in the Better Body app.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
