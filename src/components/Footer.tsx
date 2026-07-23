import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export default function Footer() {
  const [email, setEmail] = useState('');
  const [joined, setJoined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  // Hide the newsletter signup on /trial/* — its second email input was
  // competing with the trial form and confusing visitors who landed from ads.
  const location = useLocation();
  const isTrialRoute = location.pathname.startsWith('/trial');

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || submitting) return;

    setSubmitting(true);
    setErrorMsg('');
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/subscribe-newsletter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email: value, source: 'footer-newsletter' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'Could not subscribe. Please try again.');
      }
      setJoined(true);
      setEmail('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not subscribe.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <footer style={{ backgroundColor: 'var(--bg-primary)', borderTop: '1px solid var(--divider)', color: 'var(--text-primary)' }}>
      <div className="max-w-content mx-auto px-6 py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 mb-12">

          {/* Brand + app download + email signup */}
          <div className="col-span-2 md:col-span-1">
            <img
              src="https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png"
              alt="Better Body Bootcamp Logo"
              className="h-10 w-auto object-contain mb-4"
            />
            <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)', lineHeight: '1.6', maxWidth: '28ch' }}>
              New York's premier group fitness bootcamp since 2011.
            </p>

            {/* 2026-06-29: iOS app download CTA. 2026-07-11: Android now live on
                Google Play (id=com.marianatek.betterbodybootcamp) — both badges. */}
            <p className="eyebrow mb-3">GET THE APP</p>
            <a
              href="https://apps.apple.com/us/app/better-body-studios/id6778182425"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Download Better Body Studios on the App Store"
              className="inline-flex items-center gap-3 px-4 py-2.5 rounded-xl transition-transform hover:scale-[1.02] mb-3"
              style={{ backgroundColor: '#000', border: '1px solid #1f2937' }}
            >
              {/* Apple logo */}
              <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                <path d="M17.05 12.04c-.02-3 2.45-4.44 2.56-4.51-1.4-2.04-3.57-2.32-4.34-2.35-1.84-.19-3.6 1.08-4.54 1.08-.94 0-2.39-1.06-3.93-1.03-2.02.03-3.88 1.18-4.92 2.99-2.1 3.65-.54 9.05 1.51 12.01 1 1.45 2.19 3.08 3.74 3.02 1.51-.06 2.08-.97 3.9-.97 1.82 0 2.34.97 3.94.94 1.63-.03 2.66-1.47 3.65-2.93 1.15-1.68 1.62-3.31 1.64-3.39-.04-.02-3.15-1.21-3.21-4.78zM14.09 3.83c.83-1.01 1.39-2.41 1.24-3.83-1.19.05-2.65.79-3.51 1.79-.77.89-1.45 2.32-1.27 3.7 1.33.11 2.69-.67 3.54-1.66z"/>
              </svg>
              <span className="flex flex-col leading-tight">
                <span className="text-[10px] text-white/70 uppercase tracking-wide">Download on the</span>
                <span className="text-base font-bold text-white">App Store</span>
              </span>
            </a>
            <a
              href="https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Get Better Body Bootcamp on Google Play"
              className="inline-flex items-center gap-3 px-4 py-2.5 rounded-xl transition-transform hover:scale-[1.02] mb-6"
              style={{ backgroundColor: '#000', border: '1px solid #1f2937' }}
            >
              {/* Google Play glyph */}
              <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                <path d="M4 2.5v19a1 1 0 0 0 1.53.85l15.5-9.5a1 1 0 0 0 0-1.7L5.53 1.65A1 1 0 0 0 4 2.5z"/>
              </svg>
              <span className="flex flex-col leading-tight">
                <span className="text-[10px] text-white/70 uppercase tracking-wide">Get it on</span>
                <span className="text-base font-bold text-white">Google Play</span>
              </span>
            </a>

            {!isTrialRoute && (
              <>
                <p className="eyebrow mb-3">JOIN THE LIST</p>
                {joined ? (
                  <p className="text-sm" style={{ color: 'var(--brand-red)' }}>You're on the list.</p>
                ) : (
                  <>
                    <form onSubmit={handleJoin} className="flex gap-2">
                      <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="your@email.com"
                        required
                        disabled={submitting}
                        className="flex-1 min-w-0 text-sm px-3 py-2 rounded-lg outline-none disabled:opacity-60"
                        style={{
                          backgroundColor: 'var(--bg-elevated)',
                          border: '1px solid var(--divider)',
                          color: 'var(--text-primary)',
                        }}
                      />
                      <button
                        type="submit"
                        disabled={submitting}
                        className="text-sm font-bold px-4 py-2 rounded-lg transition-colors duration-200 disabled:opacity-60 disabled:cursor-wait"
                        style={{
                          backgroundColor: 'var(--brand-red)',
                          color: 'var(--text-primary)',
                          whiteSpace: 'nowrap',
                        }}
                        onMouseEnter={e => { if (!submitting) e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; }}
                        onMouseLeave={e => { if (!submitting) e.currentTarget.style.backgroundColor = 'var(--brand-red)'; }}
                      >
                        {submitting ? '...' : 'Join'}
                      </button>
                    </form>
                    {errorMsg && (
                      <p className="text-xs mt-2" style={{ color: '#fca5a5' }}>{errorMsg}</p>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {/* Quick Links */}
          <div>
            <p className="eyebrow mb-5">QUICK LINKS</p>
            <ul className="space-y-3 text-sm">
              {[['/','Home'],['/about','About'],['/testimonials','Testimonials'],['/locations','Locations']].map(([path, label]) => (
                <li key={path}>
                  <Link
                    to={path}
                    className="transition-colors duration-200"
                    style={{ color: 'var(--text-secondary)' }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Locations */}
          <div>
            <p className="eyebrow mb-5">LOCATIONS</p>
            <ul className="space-y-3 text-sm">
              {[['astoria','Astoria'],['bayside','Bayside'],['fresh-meadows','Fresh Meadows'],['williamsburg','Williamsburg']].map(([slug, label]) => (
                <li key={slug}>
                  <Link
                    to={`/locations/${slug}`}
                    className="transition-colors duration-200"
                    style={{ color: 'var(--text-secondary)' }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <p className="eyebrow mb-5">LEGAL</p>
            <ul className="space-y-3 text-sm">
              {[['/faq','FAQ'],['/legal','Legal'],['/terms','Terms of Service'],['/privacy','Privacy Policy']].map(([path, label]) => (
                <li key={path}>
                  <Link
                    to={path}
                    className="transition-colors duration-200"
                    style={{ color: 'var(--text-secondary)' }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <p className="eyebrow" style={{ color: 'var(--text-secondary)' }}>NEW YORK'S #1 BOOTCAMP SINCE 2011</p>
          <p className="text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
            © {new Date().getFullYear()} Better Body Bootcamp. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
