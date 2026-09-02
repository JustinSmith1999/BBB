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
      {/* 2026-08-25 redesign: the old footer stacked logo + 2 giant store
          badges + newsletter in one tall left column next to three short link
          lists — huge imbalance, dead space, 5 red labels. Now: newsletter as
          a slim full-width band, then 4 balanced columns, red reserved for
          the Join button only. */}
      {!isTrialRoute && (
        <div style={{ borderBottom: '1px solid var(--divider)' }}>
          <div className="max-w-content mx-auto px-6 py-10 flex flex-col md:flex-row md:items-center gap-6 md:gap-12">
            <div className="md:flex-1">
              <p className="font-display font-black uppercase" style={{ fontSize: 'clamp(1.25rem,2vw,1.75rem)', lineHeight: 1 }}>
                Join the list
              </p>
              <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
                Training tips and member offers. No spam.
              </p>
            </div>
            {joined ? (
              <p className="text-sm font-bold" style={{ color: 'var(--brand-red)' }}>You're on the list.</p>
            ) : (
              <div className="md:flex-1 w-full">
                <form onSubmit={handleJoin} className="flex w-full">
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    required
                    disabled={submitting}
                    className="flex-1 min-w-0 text-sm px-4 outline-none disabled:opacity-60"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--divider)',
                      borderRight: 'none',
                      color: 'var(--text-primary)',
                      height: '48px',
                    }}
                  />
                  <button
                    type="submit"
                    disabled={submitting}
                    className="font-display font-bold uppercase text-sm px-7 transition-colors duration-200 disabled:opacity-60 disabled:cursor-wait"
                    style={{ backgroundColor: 'var(--brand-red)', color: '#fff', letterSpacing: '0.1em', height: '48px', whiteSpace: 'nowrap' }}
                    onMouseEnter={e => { if (!submitting) e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; }}
                    onMouseLeave={e => { if (!submitting) e.currentTarget.style.backgroundColor = 'var(--brand-red)'; }}
                  >
                    {submitting ? '...' : 'Join'}
                  </button>
                </form>
                {errorMsg && (
                  <p className="text-xs mt-2" style={{ color: '#fca5a5' }}>{errorMsg}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="max-w-content mx-auto px-6 py-14">
        {/* 2026-09-02 (owner: "footer is staggered and all over"): brand gets
            its own row; the three link lists sit in ONE aligned 3-col row at
            every width, so nothing dangles or staggers. */}
        <div className="md:flex md:items-start md:gap-16">

          {/* Brand — 2026-09-02 (owner): bigger, and centered on mobile */}
          <div className="mb-12 md:mb-0 md:w-80 md:flex-none flex flex-col items-center text-center md:items-start md:text-left">
            <img
              src="https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png"
              alt="Better Body Bootcamp Logo"
              className="h-12 w-auto object-contain mb-5"
            />
            <p className="mb-6 mx-auto md:mx-0" style={{ color: 'var(--text-secondary)', fontSize: '16px', lineHeight: '1.65', maxWidth: '32ch' }}>
              New York's premier group fitness bootcamp since 2011. Four studios across Queens and Brooklyn.
            </p>
            <div className="flex items-center justify-center md:justify-start gap-5">
              <a
                href="https://apps.apple.com/us/app/better-body-studios/id6778182425"
                target="_blank" rel="noopener noreferrer"
                aria-label="Download Better Body Studios on the App Store"
                className="uppercase font-bold transition-colors"
                style={{ fontSize: '11px', letterSpacing: '0.12em', color: 'var(--text-secondary)', textDecoration: 'none', borderBottom: '1px solid var(--divider)', paddingBottom: '3px' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                App Store
              </a>
              <a
                href="https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp"
                target="_blank" rel="noopener noreferrer"
                aria-label="Get Better Body Bootcamp on Google Play"
                className="uppercase font-bold transition-colors"
                style={{ fontSize: '11px', letterSpacing: '0.12em', color: 'var(--text-secondary)', textDecoration: 'none', borderBottom: '1px solid var(--divider)', paddingBottom: '3px' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                Google Play
              </a>
              <a
                href="https://www.yelp.com/biz/better-body-bootcamp-bayside-bayside-3"
                target="_blank" rel="noopener noreferrer"
                aria-label="Better Body Bootcamp on Yelp"
                className="uppercase font-bold transition-colors"
                style={{ fontSize: '11px', letterSpacing: '0.12em', color: 'var(--text-secondary)', textDecoration: 'none', borderBottom: '1px solid var(--divider)', paddingBottom: '3px' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                Yelp
              </a>
            </div>
          </div>

          {/* Link lists — one balanced 3-col row */}
          <div className="grid grid-cols-3 gap-6 md:gap-10 md:flex-1">

          {/* Explore */}
          <div>
            <p className="uppercase font-bold mb-5" style={{ fontSize: '11px', letterSpacing: '0.18em', color: 'var(--text-secondary)', opacity: 0.7 }}>Explore</p>
            <ul className="space-y-3 text-sm">
              {[['/','Home'],['/about','About'],['/services','Services'],['/pricing','Pricing'],['/testimonials','Testimonials']].map(([path, label]) => (
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

          {/* Studios — 2026-09-02: each name links to the studio page; the small
              Yelp link below routes to that studio's Yelp listing. */}
          <div>
            <p className="uppercase font-bold mb-5" style={{ fontSize: '11px', letterSpacing: '0.18em', color: 'var(--text-secondary)', opacity: 0.7 }}>Studios</p>
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

          {/* Support */}
          <div>
            <p className="uppercase font-bold mb-5" style={{ fontSize: '11px', letterSpacing: '0.18em', color: 'var(--text-secondary)', opacity: 0.7 }}>Support</p>
            <ul className="space-y-3 text-sm">
              {[['/faq','FAQ'],['/contact','Contact'],['/legal','Legal'],['/terms','Terms'],['/privacy','Privacy']].map(([path, label]) => (
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
        </div>

        {/* 2026-09-02 (owner): bottom bar centered, tagline in brand red */}
        <div style={{ borderTop: '1px solid var(--divider)', marginTop: '48px', paddingTop: '28px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '8px' }}>
          <p className="uppercase font-bold" style={{ fontSize: '12px', letterSpacing: '0.18em', color: 'var(--brand-red)' }}>New York's #1 bootcamp since 2011</p>
          <p className="text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>
            © {new Date().getFullYear()} Better Body Bootcamp. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
