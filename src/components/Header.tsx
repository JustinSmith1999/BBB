import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Menu, X } from 'lucide-react';

const orgSchema = {
  '@context': 'https://schema.org',
  '@type': 'HealthClub',
  name: 'Better Body Bootcamp',
  url: 'https://betterbodybootcamp.com',
  logo: 'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/cropped-0140_bbb_newstrike_logo-design_black_1.png',
  foundingDate: '2011',
  description: "New York's premier group fitness bootcamp. High-energy HIIT, strength training, and fat-burning workouts across 4 NYC locations.",
  areaServed: {
    '@type': 'City',
    name: 'New York City',
  },
  hasMap: 'https://betterbodybootcamp.com/locations',
  sameAs: [
    'https://www.instagram.com/betterbodybootcamp',
    'https://www.facebook.com/betterbodybootcamp',
  ],
};

export default function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const isHomePage = location.pathname === '/';

  // 2026-09-02 mobile menu rebuild: lock page scroll while the overlay is
  // open (content used to keep scrolling and slide over the menu), and close
  // the menu on any route change.
  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileMenuOpen]);
  useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

  const scrollToSection = (id: string) => {
    if (isHomePage) {
      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
        setMobileMenuOpen(false);
      }
    } else {
      navigate('/');
      setTimeout(() => {
        const element = document.getElementById(id);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth' });
        }
      }, 100);
      setMobileMenuOpen(false);
    }
  };

  return (
    <>
    <Helmet>
      <script type="application/ld+json">{JSON.stringify(orgSchema)}</script>
    </Helmet>
    {/* 2026-09-02 (owner): header no longer sticks — it sits at the top of
        the page and scrolls away with the content. Kills every iOS
        fixed-position glitch for good. */}
    <header className="relative z-50" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <nav className="px-6 py-2" style={{ borderBottom: '1px solid var(--divider)' }}>
        <div className="flex items-center justify-between max-w-content mx-auto">
          <Link to="/" className="flex items-center relative z-[85]">
            <img
              src="https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png"
              alt="Better Body Bootcamp Logo"
              className="h-[3.125rem] w-auto object-contain"
            />
          </Link>

          {/* Desktop nav — visible at >= 900px */}
          <div className="nav-desktop">
            {([['/', 'Home'], ['/locations', 'Book a Class'], ['/about', 'About'], ['/services', 'Services'], ['/pricing', 'Pricing'], ['/testimonials', 'Testimonials'], ['/contact', 'Contact']] as [string, string][]).map(([path, label]) => (
              <Link
                key={path}
                to={path}
                className="nav-link"
              >
                {label}
              </Link>
            ))}
            {/* 2026-06-30: App Store CTA in nav. Black pill with Apple mark +
                "APP" label — minimal footprint, sits next to GET STARTED so
                returning members can grab the booking app from any page. */}
            <a
              href="https://apps.apple.com/us/app/better-body-studios/id6778182425"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Download Better Body Studios on the App Store"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full transition-transform hover:scale-[1.03]"
              style={{ backgroundColor: '#000', color: '#fff' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                <path d="M17.05 12.04c-.02-3 2.45-4.44 2.56-4.51-1.4-2.04-3.57-2.32-4.34-2.35-1.84-.19-3.6 1.08-4.54 1.08-.94 0-2.39-1.06-3.93-1.03-2.02.03-3.88 1.18-4.92 2.99-2.1 3.65-.54 9.05 1.51 12.01 1 1.45 2.19 3.08 3.74 3.02 1.51-.06 2.08-.97 3.9-.97 1.82 0 2.34.97 3.94.94 1.63-.03 2.66-1.47 3.65-2.93 1.15-1.68 1.62-3.31 1.64-3.39-.04-.02-3.15-1.21-3.21-4.78zM14.09 3.83c.83-1.01 1.39-2.41 1.24-3.83-1.19.05-2.65.79-3.51 1.79-.77.89-1.45 2.32-1.27 3.7 1.33.11 2.69-.67 3.54-1.66z"/>
              </svg>
              <span className="font-display font-bold text-[11px] tracking-[0.08em] uppercase">iOS</span>
            </a>
            <a
              href="https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Get Better Body Bootcamp on Google Play"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full transition-transform hover:scale-[1.03]"
              style={{ backgroundColor: '#000', color: '#fff' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                <path d="M4 2.5v19a1 1 0 0 0 1.53.85l15.5-9.5a1 1 0 0 0 0-1.7L5.53 1.65A1 1 0 0 0 4 2.5z"/>
              </svg>
              <span className="font-display font-bold text-[11px] tracking-[0.08em] uppercase">Play</span>
            </a>
            <button
              onClick={() => scrollToSection('trial')}
              className="nav-cta font-display"
            >
              GET STARTED
            </button>
          </div>

          {/* Hamburger — visible below 900px */}
          <button
            className="nav-hamburger relative z-[85]"
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* 2026-09-02 MOBILE MENU REBUILD (owner: "mobile menu kinda sucks" +
            content scrolled OVER the open menu). Now a true full-screen
            overlay: fixed inset-0 at z-[80] (above every page element, below
            the promo popup), body scroll locked while open, big display-type
            links with the outlined index numerals, staggered entrance. */}
        {mobileMenuOpen && (
          <div
            className="nav-mobile-menu fixed inset-0 z-[80] flex flex-col"
            style={{ backgroundColor: 'var(--bg-primary)', paddingTop: '76px' }}
          >
            <style>{`@keyframes navItemIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}`}</style>
            <div className="flex-1 overflow-y-auto px-7 pt-4 pb-8 flex flex-col">
              <nav className="flex-1">
                {([['/', 'Home'], ['/locations', 'Book a Class'], ['/about', 'About'], ['/services', 'Services'], ['/pricing', 'Pricing'], ['/testimonials', 'Testimonials'], ['/contact', 'Contact']] as [string, string][]).map(([path, label], i) => (
                  <Link
                    key={path}
                    to={path}
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex items-baseline gap-4 py-3"
                    style={{
                      textDecoration: 'none',
                      borderBottom: '1px solid var(--divider)',
                      animation: `navItemIn .35s ease-out both`,
                      animationDelay: `${i * 45}ms`,
                    }}
                  >
                    <span
                      className="font-display font-black select-none"
                      style={{
                        fontSize: '1.35rem',
                        lineHeight: 1,
                        color: 'rgba(216,59,59,0.35)',
                        WebkitTextStroke: '1px rgba(216,59,59,0.55)',
                        minWidth: '2.2ch',
                      }}
                      aria-hidden
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      className="font-display font-black uppercase"
                      style={{
                        fontSize: 'clamp(1.5rem, 6vw, 1.9rem)',
                        letterSpacing: '-0.01em',
                        color: location.pathname === path ? 'var(--brand-red)' : 'var(--text-primary)',
                      }}
                    >
                      {label}
                    </span>
                  </Link>
                ))}
              </nav>

              <div className="mt-7 space-y-3" style={{ animation: 'navItemIn .35s ease-out both', animationDelay: '340ms' }}>
                <button
                  onClick={() => scrollToSection('trial')}
                  className="w-full font-display font-black uppercase"
                  style={{
                    backgroundColor: 'var(--brand-red)',
                    color: '#fff',
                    borderRadius: '999px',
                    padding: '16px 22px',
                    fontSize: '15px',
                    letterSpacing: '0.06em',
                    border: 'none',
                  }}
                >
                  Start the $49 Trial
                </button>
                <div className="grid grid-cols-2 gap-3">
                  <a
                    href="https://apps.apple.com/us/app/better-body-studios/id6778182425"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Download Better Body Studios on the App Store"
                    onClick={() => setMobileMenuOpen(false)}
                    className="inline-flex items-center justify-center gap-2"
                    style={{ backgroundColor: '#000', color: '#fff', borderRadius: '999px', padding: '13px 10px', border: '1px solid #1f2937' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                      <path d="M17.05 12.04c-.02-3 2.45-4.44 2.56-4.51-1.4-2.04-3.57-2.32-4.34-2.35-1.84-.19-3.6 1.08-4.54 1.08-.94 0-2.39-1.06-3.93-1.03-2.02.03-3.88 1.18-4.92 2.99-2.1 3.65-.54 9.05 1.51 12.01 1 1.45 2.19 3.08 3.74 3.02 1.51-.06 2.08-.97 3.9-.97 1.82 0 2.34.97 3.94.94 1.63-.03 2.66-1.47 3.65-2.93 1.15-1.68 1.62-3.31 1.64-3.39-.04-.02-3.15-1.21-3.21-4.78zM14.09 3.83c.83-1.01 1.39-2.41 1.24-3.83-1.19.05-2.65.79-3.51 1.79-.77.89-1.45 2.32-1.27 3.7 1.33.11 2.69-.67 3.54-1.66z"/>
                    </svg>
                    <span className="text-xs font-bold">App Store</span>
                  </a>
                  <a
                    href="https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Get Better Body Bootcamp on Google Play"
                    onClick={() => setMobileMenuOpen(false)}
                    className="inline-flex items-center justify-center gap-2"
                    style={{ backgroundColor: '#000', color: '#fff', borderRadius: '999px', padding: '13px 10px', border: '1px solid #1f2937' }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                      <path d="M4 2.5v19a1 1 0 0 0 1.53.85l15.5-9.5a1 1 0 0 0 0-1.7L5.53 1.65A1 1 0 0 0 4 2.5z"/>
                    </svg>
                    <span className="text-xs font-bold">Google Play</span>
                  </a>
                </div>
                <p
                  className="text-center uppercase font-bold pt-1"
                  style={{ fontSize: '10px', letterSpacing: '0.2em', color: 'var(--text-secondary)' }}
                >
                  New ownership · Since October 2025
                </p>
              </div>
            </div>
          </div>
        )}
      </nav>

      {/* Ticker bar */}
      <div
        className="w-full overflow-hidden cursor-pointer"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--divider)',
          height: '28px',
        }}
        onClick={() => scrollToSection('trial')}
      >
        <div className="animate-scroll whitespace-nowrap flex items-center h-full">
          {[0, 1].map(i => (
            <span key={i} className="inline-block font-display font-black" style={{ color: 'var(--brand-red)', fontSize: '11px', letterSpacing: '0.2em' }}>
              {Array.from({ length: 12 }).map((_, j) => (
                <span key={j}>START YOUR TRIAL NOW<span className="mx-3" style={{ opacity: 0.4 }}>•</span></span>
              ))}
            </span>
          ))}
        </div>
      </div>
    </header>
    </>
  );
}
