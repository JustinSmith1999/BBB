import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

// 2026-09-01: Homepage "six ways to train" mosaic. Owner loved two things on
// /services — the big outlined index numerals ("05 SEE WHAT THE SCALE CAN'T")
// and the real studio videos/photos — so this brings both to the homepage.
// Each tile links to its band on /services. Media files are the same real
// footage /services uses (public/services/*). Pilates has no footage yet and
// renders the branded dark panel, same fallback pattern as /services.

interface Tile {
  slug: string;
  index: string;
  name: string;
  tagline: string;
  media?: { type: 'video' | 'image'; src: string; poster?: string; fit?: 'contain' };
}

const TILES: Tile[] = [
  {
    slug: 'group-training', index: '01', name: 'Group Training',
    tagline: 'The signature Better Body experience',
    media: { type: 'video', src: '/services/group-training.mp4', poster: '/services/group-training-poster.webp' },
  },
  {
    slug: 'small-group-training', index: '02', name: 'Small Group Training',
    tagline: 'Semi-private, goal-focused',
    media: { type: 'video', src: '/services/small-group-training.mp4', poster: '/services/small-group-training-poster.webp' },
  },
  {
    slug: 'personal-training', index: '03', name: 'Personal Training',
    tagline: 'Your coach, your plan, your pace',
    media: { type: 'video', src: '/services/personal-training.mp4', poster: '/services/personal-training-poster.webp' },
  },
  {
    slug: 'pilates', index: '04', name: 'Pilates',
    tagline: 'Core, control, and mobility',
    // no real footage yet — branded panel fallback
  },
  {
    slug: 'inbody', index: '05', name: 'InBody Scans',
    tagline: 'See what the scale can’t',
    media: { type: 'image', src: '/services/inbody.webp', fit: 'contain' },
  },
  {
    slug: 'nutrition', index: '06', name: 'Nutrition',
    tagline: 'Fuel the results you’re training for',
    media: { type: 'image', src: '/services/nutrition.webp', fit: 'contain' },
  },
];

/* Big outlined numeral — the exact treatment from /services */
function IndexNumeral({ n }: { n: string }) {
  return (
    <span
      className="font-display font-black select-none"
      style={{
        fontSize: 'clamp(3rem, 6vw, 4.6rem)',
        lineHeight: 1,
        color: 'rgba(216,59,59,0.35)',
        WebkitTextStroke: '1px rgba(216,59,59,0.75)',
      }}
      aria-hidden
    >
      {n}
    </span>
  );
}

export default function ServicesShowcase() {
  return (
    <section style={{ backgroundColor: 'var(--bg-primary, #0E0F13)', borderTop: '1px solid var(--divider, rgba(245,241,234,0.12))' }}>
      {/* Section header — same quiet divider-strip voice as /services */}
      <div className="max-w-content mx-auto px-6" style={{ padding: '72px 24px 40px' }}>
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5">
          <div>
            <p className="eyebrow mb-3" style={{ letterSpacing: '0.24em', color: 'var(--brand-red)' }}>
              WHAT WE OFFER · FOUR NYC STUDIOS
            </p>
            <h2
              className="font-display font-black uppercase"
              style={{ fontSize: 'clamp(2rem, 4vw, 3.2rem)', lineHeight: 0.95, letterSpacing: '-0.015em', color: 'var(--text-primary, #F5F1EA)' }}
            >
              Six Ways <span style={{ color: 'var(--brand-red)' }}>to Train</span>
            </h2>
          </div>
          <Link
            to="/services"
            className="uppercase font-bold inline-flex items-center gap-2 transition-colors hover:text-red-500"
            style={{ fontSize: '12px', letterSpacing: '0.16em', color: 'var(--text-secondary, rgba(245,241,234,0.65))', textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            All services <ArrowRight style={{ width: '14px', height: '14px' }} />
          </Link>
        </div>
      </div>

      {/* Mosaic — real footage, outlined numerals, one red accent */}
      <div className="max-w-content mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {TILES.map((t) => (
            <Link
              key={t.slug}
              to={`/services#${t.slug}`}
              className="group relative block overflow-hidden rounded-2xl"
              style={{ aspectRatio: '4 / 5', backgroundColor: 'var(--bg-elevated, #16181E)', textDecoration: 'none' }}
            >
              {/* Media */}
              {t.media?.type === 'video' && (
                <video
                  src={t.media.src}
                  poster={t.media.poster}
                  className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
                  autoPlay muted loop playsInline
                  preload="metadata"
                />
              )}
              {t.media?.type === 'image' && (
                <img
                  src={t.media.src}
                  alt={`${t.name} at Better Body Bootcamp`}
                  loading="lazy"
                  className={`absolute inset-0 w-full h-full transition-transform duration-700 group-hover:scale-[1.04] ${t.media.fit === 'contain' ? 'object-contain p-8' : 'object-cover'}`}
                  style={t.media.fit === 'contain' ? { backgroundColor: '#0E0F13' } : undefined}
                />
              )}
              {!t.media && (
                <div
                  className="absolute inset-0"
                  style={{ background: 'linear-gradient(135deg, rgba(216,59,59,0.18), rgba(14,15,19,0.6))' }}
                />
              )}

              {/* Legibility gradient */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(14,15,19,0.25) 0%, rgba(14,15,19,0.05) 40%, rgba(14,15,19,0.82) 100%)' }}
              />

              {/* Numeral — top left */}
              <div className="absolute top-4 left-5">
                <IndexNumeral n={t.index} />
              </div>

              {/* Name + tagline — bottom */}
              <div className="absolute bottom-0 left-0 right-0 p-5">
                <p
                  className="uppercase font-bold mb-1.5"
                  style={{ fontSize: '10.5px', letterSpacing: '0.18em', color: 'rgba(245,241,234,0.72)' }}
                >
                  {t.tagline}
                </p>
                <div className="flex items-center justify-between gap-3">
                  <h3
                    className="font-display font-black uppercase"
                    style={{ fontSize: 'clamp(1.15rem, 1.8vw, 1.5rem)', lineHeight: 0.98, letterSpacing: '-0.01em', color: '#F5F1EA' }}
                  >
                    {t.name}
                  </h3>
                  <span
                    className="flex items-center justify-center rounded-full flex-none transition-all group-hover:translate-x-0.5"
                    style={{ width: '34px', height: '34px', backgroundColor: 'var(--brand-red)' }}
                  >
                    <ArrowRight style={{ width: '15px', height: '15px', color: '#fff' }} />
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
