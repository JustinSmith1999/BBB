import { useState } from 'react';
import { Link } from 'react-router-dom';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export default function Footer() {
  const [email, setEmail] = useState('');
  const [joined, setJoined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

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

          {/* Brand + email signup */}
          <div className="col-span-2 md:col-span-1">
            <img
              src="https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png"
              alt="Better Body Bootcamp Logo"
              className="h-10 w-auto object-contain mb-4"
            />
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)', lineHeight: '1.6', maxWidth: '28ch' }}>
              New York's premier group fitness bootcamp since 2011.
            </p>
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
