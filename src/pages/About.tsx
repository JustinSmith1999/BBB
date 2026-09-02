import { useState } from 'react';
import { Play, X, ArrowRight } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import PageHero, { Red } from '../components/PageHero';

const VIDEOS = [
  {
    id: 'QuKwNTK8a18',
    title: 'Better Body BK',
    subtitle: 'Live studio session — April 2026',
  },
  {
    id: 'vUogZ21GlWY',
    title: 'Better Body BK',
    subtitle: 'Live studio session — April 2026',
  },
  {
    id: 'HVI_28mr2XQ',
    title: 'Better Body BK',
    subtitle: 'Live studio session — April 2026',
  },
];

const TESTIMONIALS = [
  { id: 'FZGVv92iLD0', name: 'Tiffany' },
  { id: 'Um6jrZin8qo', name: 'Mirjana' },
  { id: 'ztza4F38KkY', name: 'Lori' },
  { id: '0_CCi5XGHbg', name: 'Robert' },
  { id: 'cYh5O0zRnLk', name: 'Lauren' },
  { id: 'jtYt7Gz7G04', name: 'Debbie' },
];


function thumb(id: string) {
  return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
}

function VideoCard({ id, title, subtitle }: { id: string; title: string; subtitle: string }) {
  const [playing, setPlaying] = useState(false);

  return (
    <div
      className="group relative rounded-2xl overflow-hidden"
      style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)' }}
    >
      {playing ? (
        <div className="relative" style={{ paddingBottom: '56.25%' }}>
          <iframe
            className="absolute inset-0 w-full h-full"
            src={`https://www.youtube.com/embed/${id}?autoplay=1`}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
        <div
          className="relative cursor-pointer"
          style={{ paddingBottom: '56.25%' }}
          onClick={() => setPlaying(true)}
        >
          <img
            src={thumb(id)}
            alt={title}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: 'rgba(14,15,19,0.45)' }}
          >
            <div
              className="flex items-center justify-center rounded-full transition-all duration-200 group-hover:scale-110"
              style={{
                width: '56px', height: '56px',
                backgroundColor: 'var(--brand-red)',
                boxShadow: '0 0 32px rgba(216,59,59,0.5)',
              }}
            >
              <Play style={{ width: '20px', height: '20px', color: '#fff', marginLeft: '3px' }} fill="#fff" />
            </div>
          </div>
        </div>
      )}
      <div style={{ padding: '18px 20px 20px' }}>
        <p style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '3px' }}>{title}</p>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{subtitle}</p>
      </div>
    </div>
  );
}

function TestimonialCard({ id, name }: { id: string; name: string }) {
  const [playing, setPlaying] = useState(false);

  return (
    <div
      className="group relative rounded-xl overflow-hidden cursor-pointer"
      style={{ border: '1px solid var(--divider)' }}
      onClick={() => setPlaying(true)}
    >
      {playing ? (
        <div className="relative" style={{ paddingBottom: '56.25%' }}>
          <iframe
            className="absolute inset-0 w-full h-full"
            src={`https://www.youtube.com/embed/${id}?autoplay=1`}
            title={name}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="relative" style={{ paddingBottom: '56.25%' }}>
          <img
            src={thumb(id)}
            alt={name}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
          <div
            className="absolute inset-0 flex items-end"
            style={{ background: 'linear-gradient(to top, rgba(14,15,19,0.85) 0%, transparent 55%)' }}
          >
            <div className="p-3 flex items-center justify-between w-full">
              <p style={{ fontSize: '13px', fontWeight: 700, color: '#fff' }}>{name}'s Story</p>
              <div
                className="flex items-center justify-center rounded-full flex-shrink-0"
                style={{ width: '30px', height: '30px', backgroundColor: 'var(--brand-red)' }}
              >
                <Play style={{ width: '11px', height: '11px', color: '#fff', marginLeft: '2px' }} fill="#fff" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AboutPage() {
  const [lightboxId, setLightboxId] = useState<string | null>(null);

  return (
    <>
      <SEOHead
        title="About Better Body Bootcamp | NYC's Premier Group Training"
        description="Since 2011, Better Body Bootcamp has helped thousands of New Yorkers transform with science-backed group training across 4 NYC locations."
        canonical="/about"
      />

      <div style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>

        {/* ── Hero (shared PageHero — the reference style, sized up) ── */}
        <PageHero
          eyebrow="SINCE 2011 · NYC"
          lines={["BUILDING NYC'S", <span key="r"><Red>BEST</Red> BODIES</span>]}
        />

        {/* ── Body copy ── */}
        <section style={{ padding: '96px 24px' }}>
          <div className="max-w-content mx-auto grid md:grid-cols-2 gap-16 items-center">
            <div>
              <p className="eyebrow mb-5">WHO WE ARE</p>
              <h2
                className="font-display font-black uppercase mb-6"
                style={{ fontSize: 'clamp(2rem, 4vw, 3.5rem)', lineHeight: '0.92', letterSpacing: '-0.01em' }}
              >
                NOT ANOTHER GYM.<br />
                <span style={{ color: 'var(--brand-red)' }}>YOUR LAUNCHPAD.</span>
              </h2>
              <p style={{ color: 'var(--text-secondary)', lineHeight: '1.75', fontSize: '15px', marginBottom: '18px', maxWidth: '54ch' }}>
                We didn't become one of America's most respected privately owned training programs by following the crowd. We got here by obsessing over your results while everyone else was chasing trends.
              </p>
              <p style={{ color: 'var(--text-secondary)', lineHeight: '1.75', fontSize: '15px', marginBottom: '18px', maxWidth: '54ch' }}>
                And since October 2025, Better Body is under new ownership. New coaches, new programming,
                new standards at every studio. If you trained with us before and it wasn't for you, it's a
                different gym now. Come see for yourself.
              </p>
              <p style={{ color: 'var(--text-secondary)', lineHeight: '1.75', fontSize: '15px', marginBottom: '18px', maxWidth: '54ch' }}>
                World-class trainers who care. Science-backed workouts that actually work. An energy so electric you'll find yourself looking forward to 5 AM alarms. That's Better Body.
              </p>
              <p style={{ color: 'var(--text-secondary)', lineHeight: '1.75', fontSize: '15px', marginBottom: '18px', maxWidth: '54ch' }}>
                The playbook has stayed the same since 2011: coach-led group training in classes small enough that
                nobody disappears in the back row, and programming that blends strength work, HIIT, and
                conditioning so you never plateau on the same routine. No wandering between machines, no guessing
                what to do next. You show up, a coach runs the session, and you leave having done real work.
              </p>
              <p style={{ color: 'var(--text-secondary)', lineHeight: '1.75', fontSize: '15px', maxWidth: '54ch' }}>
                Today that playbook runs at four studios: Astoria, Bayside, and Fresh Meadows in Queens, and
                Williamsburg in Brooklyn, all under one membership. Thousands of New Yorkers have come through
                the doors on the $49 two-week trial and stayed for years, because the thing that keeps people
                training isn't a machine or an app. It's a room full of people who expect to see you tomorrow.
              </p>
              <a
                href="/trial"
                className="inline-flex items-center gap-2 font-display font-bold uppercase mt-8"
                style={{
                  backgroundColor: 'var(--brand-red)',
                  color: '#fff',
                  borderRadius: '999px',
                  padding: '14px 28px',
                  fontSize: '13px',
                  letterSpacing: '0.07em',
                  textDecoration: 'none',
                  transition: 'background-color 150ms, transform 150ms',
                }}
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'var(--brand-red)'; e.currentTarget.style.transform = 'none'; }}
              >
                Try 2 Weeks For $49 <ArrowRight style={{ width: '13px', height: '13px' }} />
              </a>
            </div>

            {/* Feature video */}
            <div
              className="group relative rounded-2xl overflow-hidden cursor-pointer"
              style={{ border: '1px solid var(--divider)' }}
              onClick={() => setLightboxId('QuKwNTK8a18')}
            >
              <div className="relative" style={{ paddingBottom: '56.25%' }}>
                <img
                  src={thumb('QuKwNTK8a18')}
                  alt="Better Body Bootcamp BK — Live Session"
                  className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                />
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ background: 'rgba(14,15,19,0.4)' }}
                >
                  <div
                    className="flex items-center justify-center rounded-full transition-all duration-200 group-hover:scale-110"
                    style={{
                      width: '64px', height: '64px',
                      backgroundColor: 'var(--brand-red)',
                      boxShadow: '0 0 32px rgba(216,59,59,0.5)',
                    }}
                  >
                    <Play style={{ width: '22px', height: '22px', color: '#fff', marginLeft: '3px' }} fill="#fff" />
                  </div>
                </div>
                <div
                  className="absolute bottom-0 left-0 right-0 p-5"
                  style={{ background: 'linear-gradient(to top, rgba(14,15,19,0.9) 0%, transparent 100%)' }}
                >
                  <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '4px' }}>Watch</p>
                  <p style={{ fontSize: '16px', fontWeight: 800, color: '#fff' }}>Live Studio Session — Better Body BK</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Studio Videos ── */}
        <section style={{ borderTop: '1px solid var(--divider)', padding: '96px 24px' }}>
          <div className="max-w-content mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-12">
              <div>
                <p className="eyebrow mb-4">INSIDE THE STUDIOS</p>
                <h2
                  className="font-display font-black uppercase"
                  style={{ fontSize: 'clamp(1.75rem, 4vw, 3rem)', lineHeight: '0.92', letterSpacing: '-0.01em' }}
                >
                  SEE IT FOR <span style={{ color: 'var(--brand-red)' }}>YOURSELF</span>
                </h2>
              </div>
              <a
                href="https://www.youtube.com/@betterbodybootcamp"
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '13px', color: 'var(--text-secondary)', textDecoration: 'none', whiteSpace: 'nowrap', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                YouTube Channel →
              </a>
            </div>
            <div className="grid sm:grid-cols-3 gap-5">
              {VIDEOS.map(v => (
                <VideoCard key={v.id} {...v} />
              ))}
            </div>
          </div>
        </section>

        {/* ── Member Stories ── */}
        <section style={{ borderTop: '1px solid var(--divider)', padding: '96px 24px' }}>
          <div className="max-w-content mx-auto">
            <div className="text-center mb-12">
              <p className="eyebrow mb-4">REAL RESULTS</p>
              <h2
                className="font-display font-black uppercase"
                style={{ fontSize: 'clamp(1.75rem, 4vw, 3rem)', lineHeight: '0.92', letterSpacing: '-0.01em' }}
              >
                HEAR IT FROM <span style={{ color: 'var(--brand-red)' }}>OUR MEMBERS</span>
              </h2>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {TESTIMONIALS.map(t => (
                <TestimonialCard key={t.id} {...t} />
              ))}
            </div>
          </div>
        </section>

        {/* ── Instagram call-out ── */}
        <section style={{ borderTop: '1px solid var(--divider)', padding: '80px 24px' }}>
          <div className="max-w-content mx-auto">
            <div
              className="rounded-2xl p-10 md:p-14 flex flex-col md:flex-row md:items-center justify-between gap-8"
              style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)' }}
            >
              <div>
                <p className="eyebrow mb-4">FOLLOW US</p>
                <h2
                  className="font-display font-black uppercase mb-3"
                  style={{ fontSize: 'clamp(1.5rem, 3vw, 2.5rem)', lineHeight: '0.95', letterSpacing: '-0.01em' }}
                >
                  SEE DAILY CONTENT<br />
                  <span style={{ color: 'var(--brand-red)' }}>FROM EACH STUDIO</span>
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.65', maxWidth: '42ch' }}>
                  Real workouts, real members, real results — posted daily from our four NYC locations.
                </p>
              </div>
              <div className="flex flex-col gap-3 flex-shrink-0">
                {/* 2026-06-30: Added Fresh Meadows handle so all 4 studios surface equally.
                    Justin: confirm @betterbodyfreshmeadows is live before deploy. */}
                {[
                  { handle: '@betterbodyastoria',      url: 'https://www.instagram.com/betterbodyastoria/' },
                  { handle: '@betterbodybayside',      url: 'https://www.instagram.com/betterbodybayside/' },
                  { handle: '@betterbodyfreshmeadows', url: 'https://www.instagram.com/betterbodyfreshmeadows/' },
                  { handle: '@betterbodywilliamsburg', url: 'https://www.instagram.com/betterbodywilliamsburg/' },
                ].map(({ handle, url }) => (
                  <a
                    key={handle}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-3 font-semibold"
                    style={{
                      color: 'var(--text-primary)',
                      textDecoration: 'none',
                      fontSize: '15px',
                      padding: '12px 20px',
                      borderRadius: '12px',
                      border: '1px solid var(--divider)',
                      transition: 'border-color 150ms, background-color 150ms',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--brand-red)'; e.currentTarget.style.backgroundColor = 'rgba(216,59,59,0.06)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--divider)'; e.currentTarget.style.backgroundColor = 'transparent'; }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--brand-red)', flexShrink: 0 }}>
                      <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
                    </svg>
                    {handle}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Bottom CTA ── */}
        <section style={{ borderTop: '1px solid var(--divider)', padding: '96px 24px' }}>
          <div className="max-w-2xl mx-auto text-center">
            <h2
              className="font-display font-black uppercase mb-4"
              style={{ fontSize: 'clamp(1.75rem, 4vw, 3rem)', lineHeight: '0.95', letterSpacing: '-0.01em' }}
            >
              READY TO BECOME<br />
              <span style={{ color: 'var(--brand-red)' }}>YOUR BEST SELF?</span>
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '15px', marginBottom: '32px', lineHeight: '1.65' }}>
              Start with two weeks. No pressure. Just results.
            </p>
            <a
              href="/trial"
              className="inline-flex items-center gap-2 font-display font-bold uppercase"
              style={{
                backgroundColor: 'var(--brand-red)',
                color: '#fff',
                borderRadius: '999px',
                padding: '16px 36px',
                fontSize: '14px',
                letterSpacing: '0.06em',
                textDecoration: 'none',
                transition: 'background-color 150ms, transform 150ms',
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'var(--brand-red)'; e.currentTarget.style.transform = 'none'; }}
            >
              Start 2-Week Trial — $49
              <ArrowRight style={{ width: '14px', height: '14px' }} />
            </a>
          </div>
        </section>

      </div>

      {/* ── Lightbox ── */}
      {lightboxId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.92)' }}
          onClick={() => setLightboxId(null)}
        >
          <button
            className="absolute top-5 right-5 flex items-center justify-center rounded-full"
            style={{ width: '44px', height: '44px', backgroundColor: 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer' }}
            onClick={() => setLightboxId(null)}
          >
            <X style={{ width: '20px', height: '20px', color: '#fff' }} />
          </button>
          <div
            className="w-full"
            style={{ maxWidth: '900px' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ position: 'relative', paddingBottom: '56.25%' }}>
              <iframe
                className="absolute inset-0 w-full h-full rounded-2xl"
                src={`https://www.youtube.com/embed/${lightboxId}?autoplay=1`}
                title="Better Body Bootcamp Video"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
