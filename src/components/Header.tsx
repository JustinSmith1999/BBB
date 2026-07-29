import { useState } from 'react';
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
    <header className="fixed top-0 left-0 right-0 z-50" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <nav className="px-6 py-2" style={{ borderBottom: '1px solid var(--divider)' }}>
        <div className="flex items-center justify-between max-w-content mx-auto">
          <Link to="/" className="flex items-center">
            <img
              src="https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png"
              alt="Better Body Bootcamp Logo"
              className="h-[3.125rem] w-auto object-contain"
            />
          </Link>

          {/* Desktop nav — visible at >= 900px */}
          <div className="nav-desktop">
            {([['/', 'Home'], ['/about', 'About'], ['/locations', 'Locations'], ['/services', 'Services'], ['/pricing', 'Pricing'], ['/testimonials', 'Testimonials'], ['/contact', 'Contact']] as [string, string][]).map(([path, label]) => (
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
            className="nav-hamburger"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="nav-mobile-menu mt-2 pb-3 space-y-0.5 max-w-content mx-auto">
            {([['/', 'Home'], ['/about', 'About'], ['/locations', 'Locations'], ['/services', 'Services'], ['/pricing', 'Pricing'], ['/testimonials', 'Testimonials'], ['/contact', 'Contact']] as [string, string][]).map(([path, label]) => (
              <Link
                key={path}
                to={path}
                onClick={() => setMobileMenuOpen(false)}
                className="block py-2.5 px-3 text-sm font-medium transition-colors duration-200"
                style={{ color: 'var(--text-secondary)' }}
              >
                {label}
              </Link>
            ))}
            <div className="pt-2 px-3 space-y-2">
              <button
                onClick={() => scrollToSection('trial')}
                className="w-full font-display font-bold uppercase"
                style={{
                  backgroundColor: 'var(--brand-red)',
                  color: 'var(--text-primary)',
                  borderRadius: '999px',
                  padding: '12px 22px',
                  fontSize: '13px',
                  letterSpacing: '0.04em',
                }}
              >
                GET STARTED
              </button>
              {/* 2026-06-30: App Store CTA in mobile menu. Sits below GET
                  STARTED so first-time visitors hit the trial primary, but
                  returning members can grab the booking app one tap away. */}
              <a
                href="https://apps.apple.com/us/app/better-body-studios/id6778182425"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Download Better Body Studios on the App Store"
                onClick={() => setMobileMenuOpen(false)}
                className="w-full inline-flex items-center justify-center gap-2"
                style={{
                  backgroundColor: '#000',
                  color: '#fff',
                  borderRadius: '999px',
                  padding: '12px 22px',
                  border: '1px solid #1f2937',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                  <path d="M17.05 12.04c-.02-3 2.45-4.44 2.56-4.51-1.4-2.04-3.57-2.32-4.34-2.35-1.84-.19-3.6 1.08-4.54 1.08-.94 0-2.39-1.06-3.93-1.03-2.02.03-3.88 1.18-4.92 2.99-2.1 3.65-.54 9.05 1.51 12.01 1 1.45 2.19 3.08 3.74 3.02 1.51-.06 2.08-.97 3.9-.97 1.82 0 2.34.97 3.94.94 1.63-.03 2.66-1.47 3.65-2.93 1.15-1.68 1.62-3.31 1.64-3.39-.04-.02-3.15-1.21-3.21-4.78zM14.09 3.83c.83-1.01 1.39-2.41 1.24-3.83-1.19.05-2.65.79-3.51 1.79-.77.89-1.45 2.32-1.27 3.7 1.33.11 2.69-.67 3.54-1.66z"/>
                </svg>
                <span className="flex flex-col leading-tight items-start">
                  <span className="text-[9px] text-white/70 uppercase tracking-wide">Download on the</span>
                  <span className="text-sm font-bold text-white">App Store</span>
                </span>
              </a>
              <a
                href="https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Get Better Body Bootcamp on Google Play"
                onClick={() => setMobileMenuOpen(false)}
                className="w-full inline-flex items-center justify-center gap-2"
                style={{
                  backgroundColor: '#000',
                  color: '#fff',
                  borderRadius: '999px',
                  padding: '12px 22px',
                  border: '1px solid #1f2937',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                  <path d="M4 2.5v19a1 1 0 0 0 1.53.85l15.5-9.5a1 1 0 0 0 0-1.7L5.53 1.65A1 1 0 0 0 4 2.5z"/>
                </svg>
                <span className="flex flex-col leading-tight items-start">
                  <span className="text-[9px] text-white/70 uppercase tracking-wide">Get it on</span>
                  <span className="text-sm font-bold text-white">Google Play</span>
                </span>
              </a>
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
