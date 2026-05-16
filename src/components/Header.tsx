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
            {([['/', 'Home'], ['/about', 'About'], ['/locations', 'Locations'], ['/pricing', 'Pricing'], ['/testimonials', 'Testimonials'], ['/contact', 'Contact']] as [string, string][]).map(([path, label]) => (
              <Link
                key={path}
                to={path}
                className="nav-link"
              >
                {label}
              </Link>
            ))}
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
            {([['/', 'Home'], ['/about', 'About'], ['/locations', 'Locations'], ['/pricing', 'Pricing'], ['/testimonials', 'Testimonials'], ['/contact', 'Contact']] as [string, string][]).map(([path, label]) => (
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
            <div className="pt-2 px-3">
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
