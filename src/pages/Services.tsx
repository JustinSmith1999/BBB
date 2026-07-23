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
const PX = '?auto=compress&cs=tinysrgb&w=1600&h=1200&fit=crop';
const MEDIA: Record<string, { type: 'image' | 'video'; src: string }> = {
  'group-training':       { type: 'image', src: `https://images.pexels.com/photos/6339401/pexels-photo-6339401.jpeg${PX}` },
  'small-group-training': { type: 'image', src: `https://images.pexels.com/photos/14623747/pexels-photo-14623747.jpeg${PX}` },
  'personal-training':    { type: 'image', src: `https://images.pexels.com/photos/13451904/pexels-photo-13451904.jpeg${PX}` },
  'inbody':               { type: 'image', src: `https://images.pexels.com/photos/6629204/pexels-photo-6629204.jpeg${PX}` },
  'nutrition':            { type: 'image', src: `https://images.pexels.com/photos/15319047/pexels-photo-15319047/free-photo-of-nutritionist-holding-broccoli-in-office.jpeg${PX}` },
};

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

/* ── Media slot: renders the image/video, or a clean branded panel ── */
function MediaSlot({ slug, name, icon: Icon }: { slug: string; name: string; icon: typeof Users }) {
  const media = MEDIA[slug];
  const [failed, setFailed] = useState(false);
  const showPlaceholder = !media?.src || failed;

  return (
    <div
      className="relative w-full overflow-hidden rounded-2xl"
      style={{
        aspectRatio: '4 / 3',
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--divider)',
      }}
    >
      {!showPlaceholder && media.type === 'image' && (
        <img
          src={media.src}
          alt={`${name} at Better Body Bootcamp`}
          onError={() => setFailed(true)}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
        />
      )}
      {!showPlaceholder && media.type === 'video' && (
        <video
          src={media.src}
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay muted loop playsInline
          onError={() => setFailed(true)}
        />
      )}
      {showPlaceholder && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center px-6"
          style={{ background: 'linear-gradient(135deg, rgba(216,59,59,0.14), rgba(0,0,0,0.06))' }}
        >
          <div
            className="flex items-center justify-center rounded-2xl mb-4"
            style={{
              width: '58px', height: '58px',
              backgroundColor: 'var(--brand-red)',
            }}
          >
            <Icon style={{ width: '26px', height: '26px', color: '#fff' }} />
          </div>
          <p
            className="font-display font-black uppercase"
            style={{ fontSize: '16px', letterSpacing: '-0.01em', color: 'var(--text-primary)', marginBottom: '4px', maxWidth: '20ch' }}
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

  // Scope the studio dropdown to the studios that actually offer this service.
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
    padding: '12px 16px',
    fontSize: '14px',
    fontFamily: 'inherit',
    backgroundColor: 'var(--bg-primary)',
    border: `1px solid ${focused === nm ? 'var(--brand-red)' : 'var(--divider)'}`,
    borderRadius: '10px',
    color: 'var(--text-primary)',
    outline: 'none',
    transition: 'border-color 150ms ease',
  });

  if (success) {
    return (
      <div
        className="rounded-2xl flex flex-col items-center justify-center text-center"
        style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)', padding: '40px 28px' }}
      >
        <CheckCircle style={{ width: '30px', height: '30px', color: '#22c55e', marginBottom: '14px' }} />
        <p style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
          Thanks — we’ll be in touch
        </p>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: '34ch' }}>
          Someone from the studio will reach out about {service.name} shortly.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl"
      style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)', padding: '24px' }}
    >
      <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--brand-red)', marginBottom: '4px' }}>
        Contact us for more information
      </p>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '18px', lineHeight: 1.5 }}>
        Leave your details and we’ll reach out about {service.name}.
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
      <div className="mt-3">
        <input
          type="email" name="email" required placeholder="Email address"
          value={data.email} onChange={e => setData({ ...data, email: e.target.value })}
          style={fieldStyle('email')} onFocus={() => setFocused('email')} onBlur={() => setFocused(null)}
        />
      </div>
      {offered.length > 1 && (
        <div className="mt-3">
          <select
            name="location_id" required
            value={data.location_id} onChange={e => setData({ ...data, location_id: e.target.value })}
            style={{ ...fieldStyle('location'), cursor: 'pointer' }}
            onFocus={() => setFocused('location')} onBlur={() => setFocused(null)}
          >
            <option value="">Which studio?</option>
            {offered.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}
      {offered.length === 1 && (
        <input type="hidden" name="location_id" value={offered[0].id} />
      )}

      {error && (
        <p style={{ fontSize: '12px', color: 'var(--brand-red)', marginTop: '12px' }}>{error}</p>
      )}

      <button
        type="submit" disabled={loading}
        className="w-full font-display font-bold uppercase inline-flex items-center justify-center gap-2 mt-4"
        style={{
          backgroundColor: 'var(--brand-red)', color: '#fff', borderRadius: '999px',
          padding: '14px 28px', fontSize: '13px', letterSpacing: '0.06em', border: 'none',
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

/* ── One full service section ── */
function ServiceSection({ service, locations, flip }: { service: Service; locations: Location[]; flip: boolean }) {
  const Icon = service.icon;
  const studioNames = service.studios === 'all'
    ? (locations.length ? locations.map(l => l.name) : ['Astoria', 'Bayside', 'Fresh Meadows', 'Williamsburg'])
    : (service.studios as string[]);

  return (
    <section
      id={service.slug}
      style={{ padding: '72px 0', borderTop: '1px solid var(--divider)', scrollMarginTop: '90px' }}
    >
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-center">

          {/* Text column */}
          <div className={flip ? 'lg:order-2' : ''}>
            <div className="flex items-center gap-3 mb-4">
              <div
                className="flex items-center justify-center rounded-xl"
                style={{ width: '40px', height: '40px', backgroundColor: 'rgba(216,59,59,0.10)', border: '1px solid rgba(216,59,59,0.22)' }}
              >
                <Icon style={{ width: '18px', height: '18px', color: 'var(--brand-red)' }} />
              </div>
              <span style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.18em', color: 'var(--text-secondary)' }}>
                {service.index}
              </span>
            </div>

            <p className="eyebrow mb-2" style={{ letterSpacing: '0.16em' }}>{service.tagline.toUpperCase()}</p>
            <h2
              className="font-display font-black uppercase"
              style={{ fontSize: 'clamp(1.6rem, 3vw, 2.4rem)', lineHeight: 0.98, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
            >
              {service.name}
            </h2>

            <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.7, margin: '18px 0 0' }}>
              {service.description}
            </p>

            <ul className="mt-5 space-y-2.5">
              {service.bullets.map(b => (
                <li key={b} className="flex items-start gap-2.5">
                  <CheckCircle style={{ width: '17px', height: '17px', color: 'var(--brand-red)', flexShrink: 0, marginTop: '2px' }} />
                  <span style={{ fontSize: '14px', color: 'var(--text-primary)', lineHeight: 1.5 }}>{b}</span>
                </li>
              ))}
            </ul>

            {/* Locations */}
            <div className="mt-6">
              <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                Available at
              </p>
              <div className="flex flex-wrap gap-2">
                {studioNames.map(n => (
                  <span
                    key={n}
                    style={{
                      fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)',
                      padding: '6px 14px', borderRadius: '999px',
                      backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)',
                    }}
                  >
                    {n}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Media + form column */}
          <div className={flip ? 'lg:order-1' : ''}>
            <MediaSlot slug={service.slug} name={service.name} icon={service.icon} />
            <div className="mt-5">
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
        description="Group training, small group training, 1-on-1 personal training, InBody body composition scans, and nutritional consultations across our Astoria, Bayside, Fresh Meadows, and Williamsburg studios."
        canonical="/services"
      />

      <div style={{ minHeight: '100vh', backgroundColor: 'var(--bg-primary)' }}>

        {/* Hero */}
        <div
          className="relative overflow-hidden flex flex-col items-center justify-center text-center"
          style={{ paddingTop: '160px', paddingBottom: '80px' }}
        >
          <div className="absolute inset-0 pointer-events-none opacity-[0.07]">
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[280px] rounded-full"
              style={{ backgroundColor: 'var(--brand-red)', filter: 'blur(120px)' }}
            />
          </div>
          <div className="relative z-10 max-w-3xl mx-auto px-6">
            <p className="eyebrow mb-5" style={{ letterSpacing: '0.2em' }}>WHAT WE OFFER</p>
            <h1
              className="font-display font-black uppercase"
              style={{ fontSize: 'clamp(2.25rem, 4.5vw, 4rem)', lineHeight: 0.92, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
            >
              OUR <span style={{ color: 'var(--brand-red)' }}>SERVICES</span>
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', lineHeight: 1.7, maxWidth: '52ch', margin: '24px auto 0' }}>
              From high-energy group classes to fully private coaching, body composition scans, and nutrition guidance — everything you need to get results, across four NYC studios.
            </p>

            {/* Quick jump chips */}
            <div className="flex flex-wrap justify-center gap-2 mt-8">
              {SERVICES.map(s => (
                <a
                  key={s.slug}
                  href={`#${s.slug}`}
                  style={{
                    fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', textDecoration: 'none',
                    padding: '8px 16px', borderRadius: '999px',
                    backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)',
                    transition: 'border-color 150ms ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--brand-red)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--divider)'; }}
                >
                  {s.name}
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* Service sections */}
        {SERVICES.map((s, i) => (
          <ServiceSection key={s.slug} service={s} locations={locations} flip={i % 2 === 1} />
        ))}

        {/* Bottom CTA */}
        <section style={{ borderTop: '1px solid var(--divider)', padding: '80px 0' }}>
          <div className="max-w-2xl mx-auto px-6 text-center">
            <h2
              className="font-display font-black uppercase mb-4"
              style={{ fontSize: 'clamp(1.5rem, 3vw, 2.5rem)', lineHeight: 0.95, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
            >
              READY TO JUST START?
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '15px', marginBottom: '32px', lineHeight: 1.65 }}>
              Try it all with our 2-week trial and feel the difference for yourself.
            </p>
            <a
              href="/trial"
              className="font-display font-bold uppercase inline-flex items-center gap-2"
              style={{
                backgroundColor: 'var(--brand-red)', color: '#fff', borderRadius: '999px',
                padding: '16px 36px', fontSize: '14px', letterSpacing: '0.06em', textDecoration: 'none',
                transition: 'background-color 150ms ease, transform 150ms ease',
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
    </>
  );
}
