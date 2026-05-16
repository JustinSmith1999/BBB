import { useState, useEffect } from 'react';
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

  const handleLocationSelect = (locationId: string) => {
    const loc = locations.find(l => l.id === locationId);
    if (loc) {
      navigate(`/locations/${loc.name.toLowerCase().replace(/\s+/g, '-')}`);
    }
    setShowLocations(false);
  };

  return (
    <section
      id="home"
      className="relative overflow-hidden"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        paddingTop: '160px',
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
        className="absolute inset-0 w-full h-full"
        style={{ objectFit: 'cover', zIndex: 0 }}
        poster="/change-your-life.webp"
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
        <p className="eyebrow mb-4" style={{ letterSpacing: '0.2em' }}>NYC · EST. 2011</p>

        {/* Headline */}
        <h1
          className="font-display font-black uppercase"
          style={{
            fontSize: 'clamp(40px, 6vw, 96px)',
            lineHeight: '0.88',
            letterSpacing: '-0.01em',
            color: 'var(--text-primary)',
            maxWidth: '900px',
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
            START YOUR FREE TRIAL
          </a>

          {/* Secondary */}
          <div className="relative">
            <button
              onClick={() => setShowLocations(!showLocations)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#fff',
                fontSize: '13px',
                fontWeight: 500,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
              onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
              onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
            >
              Choose a location →
            </button>

            {showLocations && (
              <div
                className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 w-64 rounded-xl overflow-hidden shadow-2xl"
                style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)', zIndex: 10 }}
              >
                {locations.map(loc => (
                  <button
                    key={loc.id}
                    onClick={() => handleLocationSelect(loc.id)}
                    className="w-full text-left px-5 py-3.5 transition-colors duration-200"
                    style={{ borderBottom: '1px solid var(--divider)', color: 'var(--text-primary)', background: 'none', cursor: 'pointer', display: 'block' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(216,59,59,0.12)')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <div className="font-bold text-sm">{loc.name}</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{loc.address}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
