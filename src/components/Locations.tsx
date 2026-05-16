import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Phone, ArrowRight } from 'lucide-react';
import { supabase, Location } from '../lib/supabase';

const locationImages: Record<string, string> = {
  'Williamsburg': '/williamsburg-final.webp',
  'Astoria': '/astoria-final.webp',
  'Bayside': '/bayside-final.webp',
  'Fresh Meadows': '/freshmeadows-final.webp',
};

export default function Locations() {
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
    <section
      id="locations"
      style={{
        backgroundColor: 'var(--bg-primary)',
        borderTop: '1px solid var(--divider)',
        padding: '96px 0',
      }}
    >
      <div className="max-w-6xl mx-auto px-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6 mb-12">
          <div>
            <p className="eyebrow mb-3" style={{ letterSpacing: '0.2em' }}>NYC STUDIOS</p>
            <h2
              className="font-display font-black uppercase"
              style={{
                fontSize: 'clamp(1.75rem, 4vw, 3.5rem)',
                lineHeight: '0.95',
                letterSpacing: '-0.01em',
                color: 'var(--text-primary)',
              }}
            >
              OUR{' '}
              <span style={{ color: 'var(--brand-red)' }}>LOCATIONS</span>
            </h2>
          </div>
          <Link
            to="/locations"
            className="font-semibold uppercase inline-flex items-center gap-2 flex-shrink-0"
            style={{
              fontSize: '12px',
              letterSpacing: '0.1em',
              color: 'var(--text-secondary)',
              textDecoration: 'none',
              transition: 'color 150ms ease',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
          >
            View all studios
            <ArrowRight style={{ width: '13px', height: '13px' }} />
          </Link>
        </div>

        {/* Cards */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[...Array(4)].map((_, i) => (
              <div
                key={i}
                className="rounded-2xl animate-pulse"
                style={{ height: '380px', backgroundColor: 'var(--bg-elevated)' }}
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
                    height: '380px',
                    border: '1px solid var(--divider)',
                    transition: 'border-color 250ms ease',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--brand-red)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--divider)')}
                >
                  {imgSrc ? (
                    <img
                      src={imgSrc}
                      alt={location.name}
                      className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                    />
                  ) : (
                    <div className="absolute inset-0" style={{ backgroundColor: 'var(--bg-elevated)' }} />
                  )}

                  {/* Base overlay */}
                  <div
                    className="absolute inset-0"
                    style={{ background: 'linear-gradient(to top, rgba(14,15,19,0.95) 0%, rgba(14,15,19,0.45) 50%, rgba(14,15,19,0.1) 100%)' }}
                  />
                  {/* Hover deepen */}
                  <div
                    className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                    style={{ background: 'linear-gradient(to top, rgba(14,15,19,1) 0%, rgba(14,15,19,0.65) 60%, rgba(14,15,19,0.2) 100%)' }}
                  />

                  <div className="absolute inset-0 flex flex-col justify-between p-7">
                    {/* Top tag */}
                    <div
                      className="self-start font-semibold uppercase"
                      style={{
                        fontSize: '10px',
                        letterSpacing: '0.15em',
                        color: 'rgba(255,255,255,0.6)',
                        backgroundColor: 'rgba(14,15,19,0.5)',
                        backdropFilter: 'blur(8px)',
                        padding: '5px 12px',
                        borderRadius: '999px',
                        border: '1px solid rgba(255,255,255,0.15)',
                      }}
                    >
                      {location.city || 'New York'}
                    </div>

                    {/* Bottom */}
                    <div>
                      <h3
                        className="font-display font-black uppercase text-white"
                        style={{
                          fontSize: 'clamp(1.75rem, 3vw, 2.5rem)',
                          lineHeight: '0.95',
                          letterSpacing: '-0.01em',
                          marginBottom: '12px',
                        }}
                      >
                        {location.name}
                      </h3>

                      <div className="space-y-1.5 mb-5">
                        <div className="flex items-start gap-2">
                          <MapPin style={{ width: '13px', height: '13px', color: 'var(--brand-red)', flexShrink: 0, marginTop: '2px' }} />
                          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', lineHeight: '1.4' }}>
                            {location.address}, {location.city}, {location.state} {location.zip}
                          </span>
                        </div>
                        {location.phone && (
                          <div className="flex items-center gap-2">
                            <Phone style={{ width: '13px', height: '13px', color: 'var(--brand-red)', flexShrink: 0 }} />
                            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>{location.phone}</span>
                          </div>
                        )}
                      </div>

                      <div
                        className="inline-flex items-center gap-2 font-display font-bold uppercase"
                        style={{
                          fontSize: '11px',
                          letterSpacing: '0.08em',
                          color: '#fff',
                          backgroundColor: 'var(--brand-red)',
                          padding: '9px 18px',
                          borderRadius: '999px',
                        }}
                      >
                        View Studio
                        <ArrowRight style={{ width: '12px', height: '12px' }} />
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
  );
}
