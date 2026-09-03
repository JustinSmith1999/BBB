import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

interface Location {
  id: string;
  name: string;
  address: string;
}

const HERO_VIDEO = 'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/videos/HeroVideo.mp4';

export default function Hero() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [showLocations, setShowLocations] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    supabase
      .from('locations')
      .select('id, name, address')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => { if (data) setLocations(data); });
  }, []);

  // Lock page scroll while the full-screen studio picker is open.
  useEffect(() => {
    document.body.style.overflow = showLocations ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [showLocations]);

  const handleLocationSelect = (locationId: string) => {
    const loc = locations.find(l => l.id === locationId);
    // Fallback ids ARE the slugs (used before the DB fetch resolves).
    navigate(`/locations/${loc ? loc.name.toLowerCase().replace(/\s+/g, '-') : locationId}`);
  };

  return (
    <section
      id="home"
      className="relative overflow-hidden"
      style={{
        minHeight: 'calc(100vh - 96px)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        paddingTop: '64px',
        paddingBottom: '120px',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      {/* Background video */}
      <video
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        className="absolute inset-0 w-full h-full"
        // 2026-06-12: removed poster image (was /change-your-life.webp).
        // Background is dark so the brief moment before the video starts
        // playing now just shows the page bg instead of the placeholder.
        style={{ objectFit: 'cover', zIndex: 0, backgroundColor: 'var(--bg-primary)' }}
        onError={e => console.error('Hero video failed to load:', e, HERO_VIDEO)}
      >
        <source src={HERO_VIDEO} type="video/mp4" />
      </video>

      {/* Dark overlay */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(rgba(14,15,19,0.70), rgba(14,15,19,0.85))',
          zIndex: 1,
        }}
      />

      {/* Content */}
      <div
        className="relative w-full max-w-content mx-auto px-6 flex flex-col items-center text-center"
        style={{ zIndex: 2 }}
      >
        {/* Eyebrow */}
        <p className="eyebrow mb-5" style={{ letterSpacing: '0.28em', fontSize: 'clamp(13px, 1.1vw, 17px)', color: '#fff', fontWeight: 700 }}>NYC <span style={{ color: 'var(--brand-red)' }}>·</span> EST. 2011</p>

        {/* Headline */}
        <h1
          className="font-display font-black uppercase"
          style={{
            fontSize: 'clamp(40px, 9.5vw, 150px)',
            lineHeight: '0.88',
            letterSpacing: '-0.01em',
            color: 'var(--text-primary)',
            maxWidth: '1240px',
          }}
        >
          <span
            style={{
              WebkitTextStroke: '2px var(--text-primary)',
              WebkitTextFillColor: 'transparent',
              display: 'block',
            }}
          >
            TRANSFORM
          </span>
          <span style={{ color: 'var(--brand-red)', display: 'block' }}>
            YOUR BODY
          </span>
          <span
            style={{
              WebkitTextStroke: '2px var(--text-primary)',
              WebkitTextFillColor: 'transparent',
              display: 'block',
            }}
          >
            TRANSFORM
          </span>
          <span style={{ color: 'var(--brand-red)', display: 'block' }}>
            YOUR LIFE
          </span>
        </h1>

        {/* CTAs */}
        <div className="flex flex-col items-center gap-4" style={{ marginTop: '48px' }}>
          {/* Primary */}
          <a
            href="/trial"
            className="font-display font-bold uppercase"
            style={{
              backgroundColor: 'var(--brand-red)',
              color: '#fff',
              borderRadius: '999px',
              padding: '16px 32px',
              fontSize: '14px',
              letterSpacing: '0.06em',
              textDecoration: 'none',
              display: 'inline-block',
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
            START YOUR 2-WEEK TRIAL
          </a>

          {/* Secondary — 2026-09-02 v2: owner wants a DROPDOWN. Proper ghost
              pill trigger (not a bare text link) + the studio list above it. */}
          <div className="relative">
            <button
              onClick={() => setShowLocations(!showLocations)}
              className="font-display font-bold uppercase transition-all hover:-translate-y-0.5"
              style={{
                background: 'rgba(245,241,234,0.07)',
                border: `1px solid ${showLocations ? 'var(--brand-red)' : 'rgba(245,241,234,0.28)'}`,
                backdropFilter: 'blur(6px)',
                borderRadius: '999px',
                padding: '13px 26px',
                fontSize: '13px',
                letterSpacing: '0.08em',
                color: '#fff',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              Choose a location
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  transition: 'transform 180ms ease',
                  transform: showLocations ? 'rotate(180deg)' : 'none',
                  fontSize: '10px',
                }}
              >
                ▼
              </span>
            </button>

            {/* 2026-09-02 v3: full-screen STUDIO CARD PICKER (owner: "would a
                locations card picker page be nicer?"). Real studio photos,
                2x2 on desktop, scrollable single column on mobile. */}
            {/* 2026-09-03 FIX (Justin): the picker used position:fixed inside the
                hero, but an ancestor's isolation/backdrop-filter creates a new
                containing block, so "fixed" pinned it INSIDE the section and the
                cards jammed to the top-middle of the page. Portal to <body> so
                the overlay truly covers the viewport on every browser. */}
            {showLocations && createPortal(
              <div
                className="fixed inset-0 z-[90] flex flex-col"
                style={{ backgroundColor: 'rgba(10,11,14,0.96)', backdropFilter: 'blur(10px)', animation: 'pickIn 220ms ease-out' }}
                role="dialog"
                aria-modal="true"
                aria-label="Pick your studio"
              >
                <style>{`@keyframes pickIn{from{opacity:0}to{opacity:1}}@keyframes cardIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}`}</style>

                <div className="flex items-center justify-between px-6 pt-6 pb-2 max-w-6xl mx-auto w-full">
                  <p className="font-display font-black uppercase" style={{ color: '#F5F1EA', fontSize: 'clamp(1.3rem, 3vw, 1.8rem)', letterSpacing: '-0.01em' }}>
                    Pick your <span style={{ color: 'var(--brand-red)' }}>studio</span>
                  </p>
                  <button
                    onClick={() => setShowLocations(false)}
                    aria-label="Close"
                    className="flex items-center justify-center rounded-full transition-transform hover:scale-110"
                    style={{ width: 38, height: 38, backgroundColor: 'rgba(245,241,234,0.08)', border: '1px solid rgba(245,241,234,0.2)', color: '#F5F1EA', fontSize: 18, cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                </div>

                {/* 2026-09-03 (Justin): on big desktops the 2x2 grid sat top-middle
                    with a huge dead zone below. Center the grid vertically and let
                    the cards grow wider so the picker fills the screen. */}
                <div className="flex-1 overflow-y-auto px-6 pb-8 pt-3 flex flex-col justify-center">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 lg:gap-6 max-w-6xl mx-auto w-full">
                    {(locations.length ? locations : [
                      { id: 'astoria', name: 'Astoria', address: '31-18 Steinway Street' },
                      { id: 'bayside', name: 'Bayside', address: '3447 Bell Blvd' },
                      { id: 'fresh-meadows', name: 'Fresh Meadows', address: '76-46 164th Street' },
                      { id: 'williamsburg', name: 'Williamsburg', address: '487 Driggs Ave' },
                    ]).map((loc, i) => {
                      const slug = loc.name.toLowerCase().replace(/\s+/g, '-');
                      const img = `/${slug.replace('fresh-meadows', 'freshmeadows')}-final.webp`;
                      return (
                        <button
                          key={loc.id}
                          onClick={() => handleLocationSelect(loc.id)}
                          className="group/card relative overflow-hidden rounded-2xl text-left"
                          style={{ aspectRatio: '16 / 9', border: '1px solid rgba(245,241,234,0.12)', cursor: 'pointer', background: '#16181E', padding: 0, animation: `cardIn .3s ease-out both`, animationDelay: `${i * 60}ms` }}
                        >
                          <img
                            src={img}
                            alt={`Better Body Bootcamp ${loc.name}`}
                            className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover/card:scale-[1.05]"
                            loading="lazy"
                          />
                          <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(10,11,14,0.05) 30%, rgba(10,11,14,0.85) 100%)' }} aria-hidden />
                          <span className="absolute bottom-0 left-0 right-0 p-5 flex items-end justify-between gap-3">
                            <span>
                              <span className="font-display font-black uppercase block" style={{ color: '#F5F1EA', fontSize: 'clamp(1.3rem, 2.6vw, 1.7rem)', letterSpacing: '-0.01em', lineHeight: 1 }}>
                                {loc.name}
                              </span>
                              <span className="block text-xs mt-1.5" style={{ color: 'rgba(245,241,234,0.7)' }}>{loc.address}</span>
                            </span>
                            <span
                              className="flex-none flex items-center justify-center rounded-full transition-transform group-hover/card:translate-x-0.5"
                              style={{ width: 36, height: 36, backgroundColor: 'var(--brand-red)', color: '#fff', fontWeight: 800 }}
                              aria-hidden
                            >
                              →
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>,
              document.body
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
