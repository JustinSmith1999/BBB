import { useState, useEffect } from 'react';
import { ArrowRight, CheckCircle, Users, UserRound, Activity, Apple } from 'lucide-react';
import { supabase, LOCATION_PUBLIC_COLUMNS, Location } from '../lib/supabase';
import { getUtmParams } from '../lib/utm';
import SEOHead from '../components/SEOHead';

/* ────────────────────────────────────────────────────────────────────────
   PHOTOS / VIDEOS
   Each service has a media slot filled with a free, commercially-licensed
   stock photo (Pexels License — free for commercial use, no attribution
   required). These are stand-ins: replace them with real photos of YOUR
   studios and members — authentic photos convert far better than stock.
   To swap one:
     1. Drop your image/video into public/services/ (e.g. group-training.jpg)
     2. Set `src` below to '/services/group-training.jpg' (or any https URL)
     3. Set `type` to 'image' or 'video'.
   If an image ever fails to load, a clean branded panel shows — never
   developer text.
   ──────────────────────────────────────────────────────────────────────── */
// Real BBB studio photos (Williamsburg shared-album footage, frame-grabbed).
// inbody + nutrition are intentionally blank until real photos arrive — a blank
// src shows the clean branded fallback panel (never stock, never dev text).
const MEDIA: Record<string, { type: 'image' | 'video'; src: string }> = {
  'group-training':       { type: 'image', src: '/services/group-training.webp' },
  'small-group-training': { type: 'image', src: '/services/small-group-training.webp' },
  'personal-training':    { type: 'image', src: '/services/personal-training.webp' },
  'inbody':               { type: 'image', src: '' },
  'nutrition':            { type: 'image', src: '' },
};

// Hero background — a real group-training shot, darkened for legibility.
const HERO_IMG = '/services/hero.webp';

// 'all' = every active studio. An array = only those studios (matched by name).
type StudioScope = 'all' | string[];

interface Service {
  slug: string;
  index: string;
  name: string;
  tagline: string;
  description: string;
  bullets: string[];
  studios: StudioScope;
  icon: typeof Users;
}

const SERVICES: Service[] = [
  {
    slug: 'group-training',
    index: '01',
    name: 'Group Training',
    tagline: 'The signature Better Body experience',
    description:
      'Coach-led group workouts that blend high-intensity intervals, strength, and conditioning into one 45-minute session. Every class is programmed by our coaches and scaled to your level, so a first-timer and a veteran can train side by side and both leave wrecked in the best way. It is the energy of a team with the structure of a plan.',
    bullets: [
      'Coach-led, fully programmed classes — no guesswork',
      'Scales to any fitness level, beginner to advanced',
      'HIIT, strength, and conditioning in every session',
    ],
    studios: 'all',
    icon: Users,
  },
  {
    slug: 'small-group-training',
    index: '02',
    name: 'Small Group Training',
    tagline: 'Semi-private, goal-focused',
    description:
      'A small crew of two to six people training together with a coach dialed into each of you. You get far more hands-on attention than a full class — form corrections, tailored progressions, real accountability — while keeping the push and camaraderie that only a group brings. The sweet spot between a class and 1-on-1.',
    bullets: [
      'Small groups of 2–6 for real coach attention',
      'Programming tailored to the group’s goals',
      'More personal than a class, more fun than solo',
    ],
    studios: ['Bayside', 'Fresh Meadows'],
    icon: Users,
  },
  {
    slug: 'personal-training',
    index: '03',
    name: 'Personal Training (1-on-1)',
    tagline: 'Your coach, your plan, your pace',
    description:
      'One coach, one hundred percent focused on you. We build the entire session around your goals, your body, and your schedule — accounting for injuries, experience, and exactly where you want to go. Whether you are training for a specific goal or just want the fastest, safest path to results, this is the most direct way to get there.',
    bullets: [
      'Fully private, undivided coach attention',
      'A plan built entirely around your goals and body',
      'Flexible scheduling that works around your life',
    ],
    studios: ['Bayside', 'Fresh Meadows'],
    icon: UserRound,
  },
  {
    slug: 'inbody',
    index: '04',
    name: 'InBody Body Composition Scans',
    tagline: 'See what the scale can’t',
    description:
      'A 60-second InBody scan breaks your body down into what actually matters — muscle mass, body fat percentage, and a segment-by-segment breakdown of where you carry each. It turns "am I making progress?" into hard numbers you can track over time, so your training and nutrition are guided by real data instead of guesswork.',
    bullets: [
      'Precise body-fat % and muscle-mass readings',
      'Segmental breakdown, arms to legs to core',
      'Re-scan to track real progress over time',
    ],
    studios: 'all',
    icon: Activity,
  },
  {
    slug: 'nutrition',
    index: '05',
    name: 'Nutritional Consultations',
    tagline: 'Fuel the results you’re training for',
    description:
      'Training is only half the equation. Our nutritional consultations give you a clear, sustainable plan for eating toward your goals — no crash diets, no impossible rules, just practical guidance that fits your life. Paired with your training, it is the fastest way to actually see the work pay off.',
    bullets: [
      'Personalized, sustainable nutrition guidance',
      'Built around your goals — not a fad diet',
      'Pairs with training to accelerate results',
    ],
    studios: 'all',
    icon: Apple,
  },
];

/* ── Full-bleed band image; falls back to a clean branded panel ── */
function BandMedia({ slug, name, icon: Icon }: { slug: string; name: string; icon: typeof Users }) {
  const media = MEDIA[slug];
  const [failed, setFailed] = useState(false);
  const show = !media?.src || failed;

  return (
    <div
      className="relative w-full h-72 sm:h-96 lg:h-full overflow-hidden"
      style={{ backgroundColor: 'var(--bg-elevated)' }}
    >
      {!show && media.type === 'image' && (
        <img
          src={media.src}
          alt={`${name} at Better Body Bootcamp`}
          onError={() => setFailed(true)}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
        />
      )}
      {!show && media.type === 'video' && (
        <video
          src={media.src}
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay muted loop playsInline
          onError={() => setFailed(true)}
        />
      )}
      {/* subtle brand tint for cohesion across mixed stock photography */}
      {!show && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'linear-gradient(180deg, rgba(14,15,19,0.05) 0%, rgba(14,15,19,0.35) 100%)' }}
        />
      )}
      {show && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center px-6"
          style={{ background: 'linear-gradient(135deg, rgba(216,59,59,0.18), rgba(14,15,19,0.5))' }}
        >
          <div
            className="flex items-center justify-center rounded-2xl mb-4"
            style={{ width: '64px', height: '64px', backgroundColor: 'var(--brand-red)' }}
          >
            <Icon style={{ width: '28px', height: '28px', color: '#fff' }} />
          </div>
          <p
            className="font-display font-black uppercase"
            style={{ fontSize: '18px', letterSpacing: '-0.01em', color: 'var(--text-primary)', marginBottom: '4px', maxWidth: '20ch' }}
          >
            {name}
          </p>
          <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
            Better Body Bootcamp
          </p>
        </div>
      )}
    </div>
  );
}

/* ── Per-service "Contact us for more info" form ── */
function ServiceContactForm({ service, locations }: { service: Service; locations: Location[] }) {
  const [data, setData] = useState({ name: '', phone: '', email: '', location_id: '' });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState<string | null>(null);

  const offered = service.studios === 'all'
    ? locations
    : locations.filter(l => (service.studios as string[]).some(s => l.name.toLowerCase().includes(s.toLowerCase())));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const studio = offered.find(l => l.id === data.location_id);
      const message =
        `Services page inquiry — interested in ${service.name}` +
        (studio ? ` at ${studio.name}` : '') +
        `. Please reach out with more information.`;

      await supabase.from('contact_submissions').insert([{
        name: data.name,
        email: data.email,
        phone: data.phone,
        location_id: data.location_id || null,
        message,
      }]);

      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-contact-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          name: data.name,
          email: data.email,
          phone: data.phone,
          location: studio?.name || 'Not specified',
          locationEmail: studio?.contact_email,
          message,
          ...(() => { const u = getUtmParams(); return { utm_source: u.utmSource, utm_medium: u.utmMedium, utm_campaign: u.utmCampaign, utm_content: u.utmContent }; })(),
        }),
      });

      setSuccess(true);
      setData({ name: '', phone: '', email: '', location_id: '' });
    } catch {
      setError('Something went wrong. Please try again or call the studio directly.');
    } finally {
      setLoading(false);
    }
  };

  const fieldStyle = (nm: string): React.CSSProperties => ({
    width: '100%',
    padding: '13px 16px',
    fontSize: '14px',
    fontFamily: 'inherit',
    backgroundColor: 'rgba(245,241,234,0.03)',
    border: `1px solid ${focused === nm ? 'var(--brand-red)' : 'var(--divider)'}`,
    borderRadius: '10px',
    color: 'var(--text-primary)',
    outline: 'none',
    transition: 'border-color 150ms ease',
  });

  if (success) {
    return (
      <div
        className="rounded-2xl flex items-center gap-3"
        style={{ backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.28)', padding: '22px 24px' }}
      >
        <CheckCircle style={{ width: '24px', height: '24px', color: '#22c55e', flexShrink: 0 }} />
        <div>
          <p style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>Thanks — we’ll be in touch</p>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Someone from the studio will reach out about {service.name} shortly.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <p style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--brand-red)', marginBottom: '12px' }}>
        Contact us for more information
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          type="text" name="name" required placeholder="Name"
          value={data.name} onChange={e => setData({ ...data, name: e.target.value })}
          style={fieldStyle('name')} onFocus={() => setFocused('name')} onBlur={() => setFocused(null)}
        />
        <input
          type="tel" name="phone" required placeholder="Phone number"
          value={data.phone} onChange={e => setData({ ...data, phone: e.target.value })}
          style={fieldStyle('phone')} onFocus={() => setFocused('phone')} onBlur={() => setFocused(null)}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <input
          type="email" name="email" required placeholder="Email address"
          value={data.email} onChange={e => setData({ ...data, email: e.target.value })}
          style={fieldStyle('email')} onFocus={() => setFocused('email')} onBlur={() => setFocused(null)}
        />
        {offered.length > 1 ? (
          <select
            name="location_id" required
            value={data.location_id} onChange={e => setData({ ...data, location_id: e.target.value })}
            style={{ ...fieldStyle('location'), cursor: 'pointer' }}
            onFocus={() => setFocused('location')} onBlur={() => setFocused(null)}
          >
            <option value="">Which studio?</option>
            {offered.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : offered.length === 1 ? (
          <input type="hidden" name="location_id" value={offered[0].id} />
        ) : null}
      </div>

      {error && <p style={{ fontSize: '12px', color: 'var(--brand-red)', marginTop: '12px' }}>{error}</p>}

      <button
        type="submit" disabled={loading}
        className="font-display font-bold uppercase inline-flex items-center justify-center gap-2 mt-4"
        style={{
          backgroundColor: 'var(--brand-red)', color: '#fff', borderRadius: '999px',
          padding: '14px 34px', fontSize: '13px', letterSpacing: '0.06em', border: 'none',
          cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.75 : 1,
          transition: 'background-color 150ms ease',
        }}
        onMouseEnter={e => { if (!loading) e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; }}
        onMouseLeave={e => { if (!loading) e.currentTarget.style.backgroundColor = 'var(--brand-red)'; }}
      >
        {loading ? 'Sending…' : <>Send <ArrowRight style={{ width: '14px', height: '14px' }} /></>}
      </button>
    </form>
  );
}

/* ── One full-bleed service band (image edge-to-edge, content padded) ── */
function ServiceBand({ service, locations, flip }: { service: Service; locations: Location[]; flip: boolean }) {
  const studioNames = service.studios === 'all'
    ? (locations.length ? locations.map(l => l.name) : ['Astoria', 'Bayside', 'Fresh Meadows', 'Williamsburg'])
    : (service.studios as string[]);

  return (
    <section
      id={service.slug}
      style={{ scrollMarginTop: '80px', borderTop: '1px solid var(--divider)' }}
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 items-stretch">
        {/* Media */}
        <div className={flip ? 'lg:order-2' : 'lg:order-1'}>
          <BandMedia slug={service.slug} name={service.name} icon={service.icon} />
        </div>

        {/* Content */}
        <div
          className={`${flip ? 'lg:order-1' : 'lg:order-2'} flex items-center`}
          style={{ backgroundColor: 'var(--bg-primary)' }}
        >
          <div className="w-full px-6 py-14 sm:px-10 lg:px-16 lg:py-24" style={{ maxWidth: '680px' }}>
            <div className="flex items-baseline gap-4 mb-3">
              <span
                className="font-display font-black"
                style={{ fontSize: 'clamp(2.2rem, 4vw, 3.4rem)', lineHeight: 1, color: 'rgba(216,59,59,0.35)', WebkitTextStroke: '1px rgba(216,59,59,0.55)' }}
              >
                {service.index}
              </span>
              <span className="eyebrow" style={{ letterSpacing: '0.16em' }}>{service.tagline.toUpperCase()}</span>
            </div>

            <h2
              className="font-display font-black uppercase"
              style={{ fontSize: 'clamp(1.9rem, 3.6vw, 3rem)', lineHeight: 0.96, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}
            >
              {service.name}
            </h2>

            <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.75, margin: '20px 0 0' }}>
              {service.description}
            </p>

            <ul className="mt-6 space-y-3">
              {service.bullets.map(b => (
                <li key={b} className="flex items-start gap-3">
                  <CheckCircle style={{ width: '18px', height: '18px', color: 'var(--brand-red)', flexShrink: 0, marginTop: '2px' }} />
                  <span style={{ fontSize: '14.5px', color: 'var(--text-primary)', lineHeight: 1.5 }}>{b}</span>
                </li>
              ))}
            </ul>

            <div className="mt-7 flex flex-wrap items-center gap-2">
              <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginRight: '4px' }}>
                Available at
              </span>
              {studioNames.map(n => (
                <span
                  key={n}
                  style={{
                    fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)',
                    padding: '5px 13px', borderRadius: '999px',
                    backgroundColor: 'rgba(245,241,234,0.05)', border: '1px solid var(--divider)',
                  }}
                >
                  {n}
                </span>
              ))}
            </div>

            <div className="mt-9 pt-8" style={{ borderTop: '1px solid var(--divider)' }}>
              <ServiceContactForm service={service} locations={locations} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function ServicesPage() {
  const [locations, setLocations] = useState<Location[]>([]);

  useEffect(() => {
    supabase
      .from('locations')
      .select(LOCATION_PUBLIC_COLUMNS)
      .eq('is_active', true)
      .order('display_order')
      .then(({ data }) => setLocations((data as unknown as Location[]) || []));
  }, []);

  return (
    <>
      <SEOHead
        title="Services | Better Body Bootcamp NYC"
        description="Group training, small group training, 1-on-1 personal training, InBody body composition scans, and nutritional consultations across our NYC studios."
        canonical="/services"
      />

      <div style={{ backgroundColor: 'var(--bg-primary)' }}>

        {/* ── Full-bleed hero ── */}
        <div className="relative overflow-hidden" style={{ minHeight: '78vh' }}>
          <img
            src={HERO_IMG}
            alt="Better Body Bootcamp training"
            className="absolute inset-0 w-full h-full object-cover"
            style={{ objectPosition: 'center 35%' }}
          />
          <div
            className="absolute inset-0"
            style={{ background: 'linear-gradient(180deg, rgba(14,15,19,0.72) 0%, rgba(14,15,19,0.62) 45%, rgba(14,15,19,0.92) 100%)' }}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6" style={{ paddingTop: '80px' }}>
            <p className="eyebrow mb-5" style={{ letterSpacing: '0.24em' }}>WHAT WE OFFER</p>
            <h1
              className="font-display font-black uppercase"
              style={{ fontSize: 'clamp(2.75rem, 7vw, 6rem)', lineHeight: 0.9, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}
            >
              OUR <span style={{ color: 'var(--brand-red)' }}>SERVICES</span>
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'clamp(1rem, 1.6vw, 1.2rem)', lineHeight: 1.65, maxWidth: '58ch', margin: '26px auto 0' }}>
              From high-energy group classes to fully private coaching, body composition scans, and nutrition guidance — everything you need to get real results, across four NYC studios.
            </p>

            <div className="flex flex-wrap justify-center gap-2.5 mt-10">
              {SERVICES.map(s => (
                <a
                  key={s.slug}
                  href={`#${s.slug}`}
                  className="transition-transform hover:-translate-y-0.5"
                  style={{
                    fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)', textDecoration: 'none',
                    padding: '9px 18px', borderRadius: '999px',
                    backgroundColor: 'rgba(245,241,234,0.08)', border: '1px solid rgba(245,241,234,0.18)',
                    backdropFilter: 'blur(6px)',
                  }}
                >
                  {s.name}
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* ── Service bands (full width, alternating) ── */}
        {SERVICES.map((s, i) => (
          <ServiceBand key={s.slug} service={s} locations={locations} flip={i % 2 === 1} />
        ))}

        {/* ── Full-bleed closing CTA ── */}
        <section className="relative overflow-hidden" style={{ borderTop: '1px solid var(--divider)' }}>
          <div className="absolute inset-0 pointer-events-none opacity-[0.10]">
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ width: '900px', height: '340px', backgroundColor: 'var(--brand-red)', filter: 'blur(140px)' }}
            />
          </div>
          <div className="relative max-w-3xl mx-auto px-6 text-center" style={{ padding: '110px 24px' }}>
            <h2
              className="font-display font-black uppercase mb-5"
              style={{ fontSize: 'clamp(1.9rem, 4vw, 3.2rem)', lineHeight: 0.95, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}
            >
              READY TO JUST START?
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '16px', marginBottom: '34px', lineHeight: 1.65, maxWidth: '46ch', margin: '0 auto 34px' }}>
              Try it all with our 2-week trial and feel the difference for yourself.
            </p>
            <a
              href="/trial"
              className="font-display font-bold uppercase inline-flex items-center gap-2"
              style={{
                backgroundColor: 'var(--brand-red)', color: '#fff', borderRadius: '999px',
                padding: '18px 42px', fontSize: '15px', letterSpacing: '0.06em', textDecoration: 'none',
                transition: 'background-color 150ms ease, transform 150ms ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'var(--brand-red)'; e.currentTarget.style.transform = 'none'; }}
            >
              Start 2-Week Trial — $49
              <ArrowRight style={{ width: '15px', height: '15px' }} />
            </a>
          </div>
        </section>

      </div>
    </>
  );
}
