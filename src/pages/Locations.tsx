import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Phone, ArrowRight } from 'lucide-react';
import { supabase, Location } from '../lib/supabase';
import SEOHead from '../components/SEOHead';

const locationImages: Record<string, string> = {
  'Williamsburg': '/williamsburg-final.webp',
  'Astoria': '/astoria-final.webp',
  'Bayside': '/bayside-final.webp',
  'Fresh Meadows': '/freshmeadows-final.webp',
};

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('locations')
      .select('*')
      .eq('is_active', true)
      .order('display_order')
      .then(({ data }) => {
        setLocations(data || []);
        setLoading(false);
      });
  }, []);

  return (
    <>
      <SEOHead
        title="Our Locations | Better Body Bootcamp NYC"
        description="Four premium Better Body Bootcamp studios across New York: Astoria, Bayside, Fresh Meadows, and Williamsburg. Find your nearest location and start your 2-week trial."
        canonical="/locations"
      />

      <div style={{ minHeight: '100vh', backgroundColor: 'var(--bg-primary)' }}>

        {/* Hero */}
        <div
          className="relative flex flex-col items-center justify-center text-center overflow-hidden"
          style={{
            paddingTop: '160px',
            paddingBottom: '96px',
            borderBottom: '1px solid var(--divider)',
          }}
        >
          <div className="absolute inset-0 pointer-events-none opacity-[0.06]">
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] rounded-full"
              style={{ backgroundColor: 'var(--brand-red)', filter: 'blur(100px)' }}
            />
          </div>
          <div className="relative z-10 max-w-3xl mx-auto px-6">
            <p className="eyebrow mb-5" style={{ letterSpacing: '0.2em' }}>NYC STUDIOS</p>
            <h1
              className="font-display font-black uppercase"
              style={{
                fontSize: 'clamp(2.5rem, 6vw, 5.5rem)',
                lineHeight: '0.92',
                letterSpacing: '-0.01em',
                color: 'var(--text-primary)',
              }}
            >
              FIND YOUR{' '}
              <span style={{ color: 'var(--brand-red)' }}>LOCATION</span>
            </h1>
            <p
              className="mt-6 text-lg"
              style={{ color: 'var(--text-secondary)', lineHeight: '1.6', maxWidth: '48ch', margin: '24px auto 0' }}
            >
              Four studios across New York City. Same elite coaching, same proven program — wherever you are.
            </p>
          </div>
        </div>

        {/* Grid */}
        <section style={{ padding: '96px 0' }}>
          <div className="max-w-6xl mx-auto px-6">
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="rounded-2xl animate-pulse"
                    style={{ height: '420px', backgroundColor: 'var(--bg-elevated)' }}
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {locations.map((location) => {
                  const imgSrc = location.image_url || locationImages[location.name];
                  const slug = location.name.toLowerCase().replace(/\s+/g, '-');
                  return (
                    <Link
                      key={location.id}
                      to={`/locations/${slug}`}
                      className="group relative rounded-2xl overflow-hidden block"
                      style={{
                        height: '420px',
                        border: '1px solid var(--divider)',
                        transition: 'border-color 250ms ease',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--brand-red)')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--divider)')}
                    >
                      {/* Photo */}
                      {imgSrc ? (
                        <img
                          src={imgSrc}
                          alt={location.name}
                          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                        />
                      ) : (
                        <div className="absolute inset-0" style={{ backgroundColor: 'var(--bg-elevated)' }} />
                      )}

                      {/* Overlay — always dark at bottom, deepens on hover */}
                      <div
                        className="absolute inset-0 transition-opacity duration-300"
                        style={{ background: 'linear-gradient(to top, rgba(14,15,19,0.95) 0%, rgba(14,15,19,0.5) 50%, rgba(14,15,19,0.15) 100%)' }}
                      />
                      <div
                        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                        style={{ background: 'linear-gradient(to top, rgba(14,15,19,1) 0%, rgba(14,15,19,0.6) 60%, rgba(14,15,19,0.2) 100%)' }}
                      />

                      {/* Content */}
                      <div className="absolute inset-0 flex flex-col justify-between p-8">
                        {/* Top — neighborhood tag */}
                        <div
                          className="self-start font-semibold uppercase"
                          style={{
                            fontSize: '11px',
                            letterSpacing: '0.15em',
                            color: 'rgba(255,255,255,0.6)',
                            backgroundColor: 'rgba(14,15,19,0.5)',
                            backdropFilter: 'blur(8px)',
                            padding: '6px 14px',
                            borderRadius: '999px',
                            border: '1px solid rgba(255,255,255,0.15)',
                          }}
                        >
                          {location.city || 'New York'}
                        </div>

                        {/* Bottom — name, details, cta */}
                        <div>
                          <h2
                            className="font-display font-black uppercase text-white"
                            style={{
                              fontSize: 'clamp(2rem, 3.5vw, 2.75rem)',
                              lineHeight: '0.95',
                              letterSpacing: '-0.01em',
                              marginBottom: '16px',
                            }}
                          >
                            {location.name}
                          </h2>

                          <div className="space-y-2 mb-6">
                            <div className="flex items-start gap-2.5">
                              <MapPin style={{ width: '14px', height: '14px', color: 'var(--brand-red)', flexShrink: 0, marginTop: '2px' }} />
                              <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', lineHeight: '1.4' }}>
                                {location.address}, {location.city}, {location.state} {location.zip}
                              </span>
                            </div>
                            {location.phone && (
                              <div className="flex items-center gap-2.5">
                                <Phone style={{ width: '14px', height: '14px', color: 'var(--brand-red)', flexShrink: 0 }} />
                                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)' }}>{location.phone}</span>
                              </div>
                            )}
                          </div>

                          <div
                            className="inline-flex items-center gap-2 font-display font-bold uppercase"
                            style={{
                              fontSize: '12px',
                              letterSpacing: '0.08em',
                              color: '#fff',
                              backgroundColor: 'var(--brand-red)',
                              padding: '10px 20px',
                              borderRadius: '999px',
                              transition: 'background-color 150ms ease',
                            }}
                          >
                            View Studio
                            <ArrowRight style={{ width: '13px', height: '13px' }} />
                          </div>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Bottom CTA strip */}
        <section
          style={{ borderTop: '1px solid var(--divider)', padding: '80px 0' }}
        >
          <div className="max-w-2xl mx-auto px-6 text-center">
            <h2
              className="font-display font-black uppercase mb-4"
              style={{
                fontSize: 'clamp(1.5rem, 3vw, 2.5rem)',
                lineHeight: '0.95',
                letterSpacing: '-0.01em',
                color: 'var(--text-primary)',
              }}
            >
              NOT SURE WHICH LOCATION?
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '15px', marginBottom: '32px', lineHeight: '1.6' }}>
              Start your 2-week trial at any studio — same class, same coaches, same results.
            </p>
            <a
              href="/trial"
              className="font-display font-bold uppercase inline-flex items-center gap-2"
              style={{
                backgroundColor: 'var(--brand-red)',
                color: '#fff',
                borderRadius: '999px',
                padding: '16px 36px',
                fontSize: '14px',
                letterSpacing: '0.06em',
                textDecoration: 'none',
                transition: 'background-color 150ms ease, transform 150ms ease',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.backgroundColor = 'var(--brand-red)';
                e.currentTarget.style.transform = 'none';
              }}
            >
              Start 2-Week Trial — $49
              <ArrowRight style={{ width: '14px', height: '14px' }} />
            </a>
          </div>
        </section>

      </div>
    </>
  );
}
