import { Link } from 'react-router-dom';
import Hero from '../components/Hero';
import BrandPillars from '../components/BrandPillars';
import PromoTicker from '../components/PromoTicker';
import TrialForm from '../components/TrialForm';
import SEOHead from '../components/SEOHead';
import { ReviewTicker } from '../components/GoogleReviews';

const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Better Body Bootcamp',
  url: 'https://betterbodybootcamp.com',
  logo: 'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/cropped-0140_bbb_newstrike_logo-design_black_1.png',
  sameAs: [
    'https://www.instagram.com/betterbodybootcamp',
    'https://www.facebook.com/betterbodybootcamp',
  ],
};

const websiteSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Better Body Bootcamp',
  url: 'https://betterbodybootcamp.com',
};

// 2026-08-23 on-page checker: the hero video was invisible to search engines —
// VideoObject markup makes it count as video content on the page.
const videoSchema = {
  '@context': 'https://schema.org',
  '@type': 'VideoObject',
  name: 'Better Body Bootcamp — Training in Our NYC Studios',
  description:
    'Coach-led group fitness classes at Better Body Bootcamp studios in Astoria, Bayside, Fresh Meadows, and Williamsburg. HIIT, strength training, and bootcamp conditioning in coach-led small group classes.',
  contentUrl: 'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/videos/HeroVideo.mp4',
  thumbnailUrl: 'https://betterbodybootcamp.com/bayside-hero-web.jpg',
  uploadDate: '2026-06-01',
};

export default function Home() {
  return (
    <>
      <SEOHead
        title="Best Gyms in Queens & NYC | Better Body Bootcamp · 4 Locations"
        description="The #1 group fitness gyms in Queens and NYC. Three Better Body Bootcamp studios in Queens (Astoria, Bayside, Fresh Meadows) plus Williamsburg, Brooklyn. Real strength training, expert coaches, 2-week trial for $49."
        canonical="/"
        schema={[organizationSchema, websiteSchema, videoSchema]}
      />
      <Hero />
      {/* 2026-08-28: Back to School $299 promo band — remove when promo ends */}
      <PromoTicker />
      <BrandPillars />

      {/* 2026-08-25: restyled from a plain white text wall into the dark
          editorial pattern (eyebrow + display headline + two-column prose +
          CTA row). Copy unchanged — it carries the on-page keyword work. */}
      <section style={{ backgroundColor: 'var(--bg-inverse)', padding: 'clamp(56px, 10vw, 96px) 0' }}>
        <div className="max-w-content mx-auto px-6">
          <div className="grid md:grid-cols-[1fr,2fr] gap-8 md:gap-16">
            <div className="text-center md:text-left">
              <p className="eyebrow mb-4" style={{ letterSpacing: '0.24em' }}>FOUR STUDIOS · QUEENS + BROOKLYN</p>
              <h2
                className="font-display font-black uppercase"
                style={{ fontSize: 'clamp(2rem,3.2vw,2.75rem)', lineHeight: '0.95', color: '#111111' }}
              >
                {/* nbsp-bound word groups — no lone word ever wraps alone */}
                NYC's Boot Camp Gym{' '}
                <span style={{ color: 'var(--brand-red)', whiteSpace: 'nowrap' }}>Since 2011</span>
              </h2>
            </div>
            <div style={{ color: '#3F3F46', fontSize: '15px', lineHeight: '1.8' }}>
              <p style={{ marginBottom: '16px' }}>
                Better Body Bootcamp runs coach-led group fitness classes at four studios: Astoria, Bayside,
                and Fresh Meadows in Queens, plus Williamsburg in Brooklyn.{' '}
                <strong style={{ color: '#111111' }}>Under new ownership since October 2025</strong>, with new
                coaches and new programming across all four studios. Every session blends strength
                training, HIIT training, bootcamp classes, and hybrid training in a high energy, coach-led room, so you get
                the attention of personal training at a fraction of the price. Coaches scale every exercise to
                your fitness level, which is why total beginners and longtime athletes train side by side here.
              </p>
              <p style={{ marginBottom: '28px' }}>
                Whether your goal is weight loss, building strength, or just becoming someone who works out
                consistently, the format does the heavy lifting: show up, follow the coach, repeat. No
                programming to figure out, no wandering between machines. Members who came from a weight loss
                boot camp, a boutique studio, or years of solo gym sessions consistently say the same thing:
                the coached room and the community are what finally made it stick.
              </p>
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-x-7 gap-y-5">
                <Link
                  to="/trial"
                  className="font-display font-bold uppercase inline-flex items-center justify-center w-full sm:w-auto"
                  style={{ backgroundColor: 'var(--brand-red)', color: '#fff', padding: '16px 26px', fontSize: '13px', letterSpacing: '0.12em', textDecoration: 'none' }}
                >
                  Start the $49 Two-Week Trial
                </Link>
                <Link to="/locations" className="uppercase font-bold hover:text-red-600 transition-colors" style={{ fontSize: '12px', letterSpacing: '0.14em', color: '#52525B', textDecoration: 'none' }}>Locations</Link>
                <Link to="/classes" className="uppercase font-bold hover:text-red-600 transition-colors" style={{ fontSize: '12px', letterSpacing: '0.14em', color: '#52525B', textDecoration: 'none' }}>Class Schedule</Link>
                <Link to="/testimonials" className="uppercase font-bold hover:text-red-600 transition-colors" style={{ fontSize: '12px', letterSpacing: '0.14em', color: '#52525B', textDecoration: 'none' }}>Testimonials</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2026-09-02: one quiet rotating Google-review line — inconspicuous,
          links to /testimonials. */}
      <ReviewTicker />

      <TrialForm />
    </>
  );
}
