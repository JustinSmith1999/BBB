import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, ArrowRight } from 'lucide-react';
import { supabase, LOCATION_PUBLIC_COLUMNS, Location } from '../lib/supabase';
import SEOHead from '../components/SEOHead';
import PageHero, { Red } from '../components/PageHero';

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
      .select(LOCATION_PUBLIC_COLUMNS)
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

        {/* Hero (shared PageHero — one style everywhere) */}
        <PageHero
          eyebrow="NYC STUDIOS · QUEENS + BROOKLYN"
          lines={["A BETTER BODY", <Red key="r">NEAR YOU</Red>]}
        />

        {/* Grid */}
        <section style={{ padding: '48px 0 96px' }}>
          <div className="max-w-[1440px] mx-auto px-6">
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="rounded-2xl animate-pulse"
                    style={{ height: '600px', backgroundColor: 'var(--bg-elevated)' }}
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
                        height: '600px',
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
                          className="absolute inset-0 w-full h-full object-cover grayscale-[45%] group-hover:grayscale-0 transition-all duration-700 group-hover:scale-105"
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
                          </div>

                          <div
                            className="inline-flex items-center gap-2 font-display font-bold uppercase group-hover:gap-3"
                            style={{
                              fontSize: '13px',
                              letterSpacing: '0.18em',
                              color: '#fff',
                              borderBottom: '2px solid var(--brand-red)',
                              paddingBottom: '6px',
                              transition: 'gap 150ms ease',
                            }}
                          >
                            View Studio
                            <ArrowRight style={{ width: '14px', height: '14px', color: 'var(--brand-red)' }} />
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

        {/* 2026-08-25: "Four Studios, One Membership" — restyled from a flat
            text wall into stats + two-column editorial prose. Same copy, same
            SEO value, actual life. */}
        <section style={{ borderTop: '1px solid var(--divider)', padding: '80px 0' }}>
          <div className="max-w-[1440px] mx-auto px-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-16">
              {[
                { n: '4', l: 'Studios across NYC' },
                { n: '1', l: 'Membership, every studio' },
                { n: '2011', l: 'Training New Yorkers since' },
                { n: '7', l: 'Days a week, 5 AM to night' },
              ].map((x) => (
                <div key={x.l} style={{ borderLeft: '2px solid var(--brand-red)', paddingLeft: '18px' }}>
                  <div className="font-display font-black" style={{ fontSize: 'clamp(2.25rem,4vw,3.5rem)', lineHeight: 1, color: 'var(--text-primary)' }}>{x.n}</div>
                  <div className="uppercase" style={{ fontSize: '11px', letterSpacing: '0.14em', color: 'var(--text-secondary)', marginTop: '8px' }}>{x.l}</div>
                </div>
              ))}
            </div>
            <div className="grid md:grid-cols-[1fr,2fr] gap-10 md:gap-16">
              <h2
                className="font-display font-black uppercase"
                style={{ fontSize: 'clamp(1.5rem,3vw,2.5rem)', lineHeight: '0.95', color: 'var(--text-primary)' }}
              >
                Four Studios,<br />
                <span style={{ color: 'var(--brand-red)' }}>One Membership</span>
              </h2>
              <div style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: '1.8' }}>
                <p style={{ marginBottom: '16px' }}>
                  Better Body Bootcamp has been training New Yorkers since 2011, and today runs four studios: three
                  across Queens and one in Brooklyn. Astoria sits on Steinway Street minutes from the Broadway N/W stop,
                  Bayside is on Bell Blvd near the LIRR, Fresh Meadows is on 164th Street off the Q65, and Williamsburg
                  is on Driggs Ave a few blocks from the Bedford L. Every studio runs the same coach-led programming
                  in small group classes, so which one you call home comes down to your commute, not the quality of
                  the workout.
                </p>
                <p>
                  One membership works at all four, and plenty of members split their week between studios: mornings
                  near home, evenings near work. If you're new, pick whichever studio is easiest to get to and start
                  with the $49 two-week unlimited trial there. Members drive in from Whitestone, Flushing, Douglaston,
                  Forest Hills, Long Island City, and Greenpoint, and the studios' class times are built around real
                  NYC schedules, from 5 AM sessions before the commute to evening classes that let you train after work.
                </p>
              </div>
            </div>
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
