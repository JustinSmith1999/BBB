// 2026-06-26 v2: Fully local BBB booking modal — no MT widget iframe.
// =====================================================================
// Customer flow:
//   1. Click Reserve on a class tile.
//   2. Modal opens with class details on top.
//   3. If no MT access token in localStorage → email + password form.
//   4. Submit → Supabase edge fn `mt-customer-auth` → returns token.
//   5. We immediately call `mt-customer-reserve` with class_session_id.
//   6. Success → big check + "You're booked!" + close button.
//   7. Token cached in localStorage so the next reserve in the same
//      session is a single click ("Reserve" button straight away).
//
// All MT calls go through Supabase edge fns to keep CORS sane.

import { useEffect, useState } from 'react';
import { X, ExternalLink, Loader2, CheckCircle2, AlertCircle, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { MTClassSession } from '../lib/mtClient';

interface Props {
  session: MTClassSession;
  studioName: string;
  onClose: () => void;
}

const TOKEN_KEY    = 'bbb_mt_customer_token';
const TOKEN_EMAIL  = 'bbb_mt_customer_email';
const TOKEN_EXP    = 'bbb_mt_customer_exp';

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
}
function fmtDayTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
}

function readCachedToken(): { token: string | null; email: string | null } {
  try {
    const tok = localStorage.getItem(TOKEN_KEY);
    const exp = Number(localStorage.getItem(TOKEN_EXP) || '0');
    if (tok && exp > Date.now()) {
      return { token: tok, email: localStorage.getItem(TOKEN_EMAIL) };
    }
  } catch { /* private mode etc. */ }
  return { token: null, email: null };
}
function writeCachedToken(token: string, email: string, expiresIn: number) {
  try {
    localStorage.setItem(TOKEN_KEY,   token);
    localStorage.setItem(TOKEN_EMAIL, email);
    localStorage.setItem(TOKEN_EXP,   String(Date.now() + (expiresIn - 60) * 1000));
  } catch { /* ignore */ }
}
function clearCachedToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EMAIL);
    localStorage.removeItem(TOKEN_EXP);
  } catch { /* ignore */ }
}

type Stage = 'idle' | 'authing' | 'reserving' | 'success' | 'error';

export default function MTBookingModal({ session: s, studioName, onClose }: Props) {
  const cached = readCachedToken();
  const [email,    setEmail]    = useState(cached.email || '');
  const [password, setPassword] = useState('');
  const [token,    setToken]    = useState<string | null>(cached.token);
  const [stage,    setStage]    = useState<Stage>('idle');
  const [error,    setError]    = useState<string | null>(null);
  const [reservation, setReservation] = useState<string | null>(null);

  // Lock body scroll + ESC to close
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const instructor = s.instructor_names[0] || null;

  async function reserveWithToken(accessToken: string) {
    setStage('reserving'); setError(null);
    const { data, error } = await supabase.functions.invoke('mt-customer-reserve', {
      body: { customer_access_token: accessToken, class_session_id: s.id },
    });
    if (error) {
      setError(error.message || 'Reserve failed'); setStage('error'); return;
    }
    if (!data?.ok) {
      // 401 → token expired, force re-login
      if (data?.status === 401) { clearCachedToken(); setToken(null); }
      setError(data?.error || 'Reserve failed');
      setStage('error');
      return;
    }
    setReservation(String(data.reservation_id || s.id));
    setStage('success');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setStage('authing'); setError(null);
    const { data, error } = await supabase.functions.invoke('mt-customer-auth', {
      body: { email, password },
    });
    if (error) {
      setError(error.message || 'Sign-in failed'); setStage('error'); return;
    }
    if (!data?.ok) {
      setError(data?.error || 'Sign-in failed'); setStage('error'); return;
    }
    writeCachedToken(data.access_token, email, Number(data.expires_in || 3600));
    setToken(data.access_token);
    setPassword('');
    await reserveWithToken(data.access_token);
  }

  async function handleOneClickReserve() {
    if (!token) return;
    await reserveWithToken(token);
  }

  function handleSignOut() {
    clearCachedToken();
    setToken(null);
    setEmail('');
  }

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Reserve ${s.class_name}`}
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm overflow-y-auto py-0 sm:py-8"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full sm:max-w-md bg-white sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col" style={{ maxHeight: '94vh' }}>

        {/* Header */}
        <header className="relative px-6 py-6 border-b-2 border-black bg-white">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center text-gray-500 hover:text-black hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-red-600">Reserve</span>
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">· {studioName}</span>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-black leading-tight uppercase">{s.class_name}</h2>
          <p className="text-sm text-gray-600 mt-2">
            <span className="font-bold text-black tabular-nums">{fmtTime(s.start_datetime)}</span>
            {' · '}{fmtDayTime(s.start_datetime)} · {s.duration_min} min
            {instructor && <> · with <span className="font-semibold text-gray-800">{instructor}</span></>}
          </p>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-7 bg-white">

          {/* ── Success ────────────────────────────────────────────────── */}
          {stage === 'success' && (
            <div className="text-center py-4">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 mb-4">
                <CheckCircle2 className="w-9 h-9 text-emerald-600" />
              </div>
              <h3 className="text-2xl font-black uppercase tracking-tight text-black mb-2">You're booked.</h3>
              <p className="text-sm text-gray-600 mb-1">
                See you at <span className="font-bold text-black">{fmtTime(s.start_datetime)}</span> for{' '}
                <span className="font-bold text-black">{s.class_name}</span>.
              </p>
              {reservation && (
                <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mt-2 tabular-nums">
                  Confirmation #{reservation}
                </p>
              )}
              <button
                type="button"
                onClick={onClose}
                className="mt-7 w-full inline-flex items-center justify-center px-5 py-3.5 rounded-xl bg-black text-white text-xs font-black uppercase tracking-[0.18em] hover:bg-red-600 transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {/* ── Login form (no token yet) ──────────────────────────────── */}
          {stage !== 'success' && !token && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                Sign in to your BBB account to reserve.
              </p>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-[0.18em] text-gray-500 mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={stage === 'authing' || stage === 'reserving'}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl text-base font-medium text-black focus:border-black focus:outline-none transition-colors disabled:opacity-50"
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-[0.18em] text-gray-500 mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={stage === 'authing' || stage === 'reserving'}
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl text-base font-medium text-black focus:border-black focus:outline-none transition-colors disabled:opacity-50"
                  placeholder="••••••••"
                />
              </div>

              {error && stage === 'error' && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200">
                  <AlertCircle className="flex-none w-4 h-4 text-red-600 mt-0.5" />
                  <p className="text-xs text-red-700 font-medium leading-relaxed">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={!email || !password || stage === 'authing' || stage === 'reserving'}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-black text-white text-xs font-black uppercase tracking-[0.18em] hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {stage === 'authing' || stage === 'reserving' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> {stage === 'authing' ? 'Signing in…' : 'Reserving…'}</>
                ) : (
                  <><Lock className="w-3.5 h-3.5" /> Sign in &amp; reserve</>
                )}
              </button>

              <p className="text-[11px] text-gray-400 text-center leading-relaxed">
                Don&apos;t have an account? Get the BBB app:{' '}
                <a
                  href="https://apps.apple.com/us/app/better-body-studios/id6778182425"
                  target="_blank"
                  rel="noopener"
                  className="font-bold text-gray-700 hover:text-red-600 underline"
                >
                  iOS
                </a>
                {' · '}
                <a
                  href="https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp"
                  target="_blank"
                  rel="noopener"
                  className="font-bold text-gray-700 hover:text-red-600 underline inline-flex items-center gap-1"
                >
                  Android
                  <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            </form>
          )}

          {/* ── One-click reserve (already signed in) ──────────────────── */}
          {stage !== 'success' && token && (
            <div className="space-y-4">
              {cached.email && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">
                    Signed in as <span className="font-bold text-black">{cached.email}</span>
                  </span>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="font-bold text-gray-400 hover:text-red-600 transition-colors"
                  >
                    Not you?
                  </button>
                </div>
              )}

              {error && stage === 'error' && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200">
                  <AlertCircle className="flex-none w-4 h-4 text-red-600 mt-0.5" />
                  <p className="text-xs text-red-700 font-medium leading-relaxed">{error}</p>
                </div>
              )}

              <button
                type="button"
                onClick={handleOneClickReserve}
                disabled={stage === 'reserving'}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl bg-black text-white text-xs font-black uppercase tracking-[0.18em] hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {stage === 'reserving'
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Reserving…</>
                  : <>Reserve my spot</>
                }
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
