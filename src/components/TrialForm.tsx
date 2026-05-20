import { useState, useEffect } from 'react';
import { supabase, Location } from '../lib/supabase';

const locationImages: Record<string, string> = {
  'Astoria': '/astoria-final.webp',
  'Bayside': '/bayside-final.webp',
  'Fresh Meadows': '/freshmeadows-final.webp',
  'Williamsburg': '/williamsburg-final.webp',
};

export default function TrialForm() {
  const [locations, setLocations] = useState<Location[]>([]);

  useEffect(() => {
    supabase
      .from('locations')
      .select('*')
      .eq('is_active', true)
      .order('display_order')
      .then(({ data }) => setLocations(data || []));
  }, []);

  const handleLocationClick = (slug: string) => {
    // Always route to the on-site per-studio trial page.
    window.location.href = `/trial/${slug}`;
  };

  return (
    <section
      id="trial"
      className="relative overflow-clip"
      style={{ backgroundColor: 'var(--bg-primary)', padding: '120px 0' }}
    >
      {/* Subtle red glow */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.04]">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] rounded-full" style={{ backgroundColor: 'var(--brand-red)', filter: 'blur(120px)' }} />
      </div>

      <div className="relative z-10 max-w-content mx-auto px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <p className="eyebrow mb-4">LOCATIONS</p>
          <h2
            className="font-display font-black uppercase"
            style={{
              fontSize: 'clamp(2.5rem, 6vw, 5rem)',
              lineHeight: '0.9',
              letterSpacing: '-0.01em',
              color: 'var(--text-primary)',
            }}
          >
            IT'S TIME TO{' '}
            <span style={{ color: 'var(--brand-red)' }}>TRANSFORM</span>
          </h2>
          <p className="mt-6 text-base max-w-lg mx-auto" style={{ color: 'var(--text-secondary)', lineHeight: '1.6', maxWidth: '52ch' }}>
            Experience the program guaranteed to have you stronger, fitter, and leaner. Choose your location to get started.
          </p>
        </div>

        {/* Location cards grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-w-3xl mx-auto">
          {locations.map(location => {
            const slug = location.name.toLowerCase().replace(/ /g, '-');
            const img = locationImages[location.name] || location.image_url || '';

            return (
              <div
                key={location.id}
                className="group relative rounded-2xl overflow-hidden cursor-pointer transition-all duration-200"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--divider)',
                  padding: '24px',
                }}
                onClick={() => handleLocationClick(slug)}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--brand-red)';
                  (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--divider)';
                  (e.currentTarget as HTMLDivElement).style.transform = 'none';
                }}
              >
                {/* Photo */}
                <div className="w-full overflow-hidden rounded-xl mb-5" style={{ height: '140px' }}>
                  <img
                    src={img}
                    alt={location.name}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                </div>

                {/* Info */}
                <h3
                  className="font-display font-black uppercase mb-1"
                  style={{ fontSize: '22px', color: 'var(--text-primary)' }}
                >
                  {location.name}
                </h3>
                <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                  {location.address}
                </p>

                {/* Text CTA */}
                <span
                  className="inline-flex items-center gap-1.5 font-semibold uppercase transition-colors duration-200"
                  style={{
                    fontSize: '12px',
                    letterSpacing: '0.08em',
                    color: 'var(--brand-red)',
                  }}
                >
                  Start Your 2-Week Trial <span className="transition-transform duration-200 group-hover:translate-x-1">→</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
