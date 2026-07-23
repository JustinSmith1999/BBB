// 2026-06-26: Native BBB booking page. Replaces /schedule/[slug]'s MT iframe
// with React components rendering the same data from MT's Customer API.
// Phase 1 = read-only schedule rendered natively. Phase 2 = reserve in-page
// (needs OAuth client from MT dev portal).

import { useEffect } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { MapPin, Phone, ArrowRight, Clock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import NativeClassList from '../components/NativeClassList';

type LocationConfig = {
  slug: string;
  name: string;
  badge: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  mtLocationId: number;
};

const LOCATIONS: Record<string, LocationConfig> = {
  'astoria':       { slug: 'astoria',       name: 'Astoria',       badge: 'ASTORIA · QUEENS',       address: '31-18 Steinway Street', city: 'Astoria',       state: 'NY', zip: '11103', phone: '(718) 704-9954', mtLocationId: 48717 },
  'bayside':       { slug: 'bayside',       name: 'Bayside',       badge: 'BAYSIDE · QUEENS',       address: '3447 Bell Blvd',        city: 'Bayside',       state: 'NY', zip: '11361', phone: '(646) 566-8870', mtLocationId: 48718 },
  'fresh-meadows': { slug: 'fresh-meadows', name: 'Fresh Meadows', badge: 'FRESH MEADOWS · QUEENS', address: '76-46 164th Street',   city: 'Fresh Meadows', state: 'NY', zip: '11366', phone: '(646) 566-8207', mtLocationId: 48719 },
  'williamsburg':  { slug: 'williamsburg',  name: 'Williamsburg',  badge: 'WILLIAMSBURG · BROOKLYN', address: '487 Driggs Ave',      city: 'Brooklyn',      state: 'NY', zip: '11211', phone: '(718) 683-1864', mtLocationId: 48720 },
};

export default function Book() {
  const { location: slugParam } = useParams<{ location: string }>();
  const slug = (slugParam ?? '').toLowerCase();
  const cfg  = LOCATIONS[slug];

  useEffect(() => { window.scrollTo(0, 0); }, [slug]);

  if (!cfg) return <Navigate to="/classes" replace />;

  const trialHref = `/trial/${cfg.slug}`;

  return (
    <>
      <SEOHead
        title={`Book a Class — ${cfg.name} | Better Body Bootcamp`}
        description={`Reserve your spot in this week's group fitness classes at Better Body Bootcamp ${cfg.name}. New here? Start with our 2-week trial for $49.`}
        canonical={`/book/${cfg.slug}`}
      />

      <div className="min-h-screen bg-white">
        {/* HERO — tight, content-driven height (no h-screen). */}
        <div className="bg-gradient-to-br from-black via-zinc-900 to-black text-white pt-24 pb-10">
          <div className="container mx-auto px-4">
            <div className="max-w-4xl mx-auto text-center">
              <span className="inline-block bg-red-600/15 text-red-400 text-[10px] font-black tracking-[0.25em] uppercase px-3 py-1 rounded-full mb-4">
                {cfg.badge}
              </span>
              <h1 className="text-[clamp(2rem,4vw,3rem)] font-bold leading-[0.95] mb-3 tracking-tight">
                Book a Class at <span className="text-red-500">{cfg.name}</span>
              </h1>
              <p className="text-sm sm:text-base text-gray-300 max-w-xl mx-auto mb-5">
                Reserve your spot in this week's classes. New here? Start with our 2-week trial — $49.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-gray-300">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-red-500" />
                  {cfg.address}, {cfg.city}, {cfg.state} {cfg.zip}
                </span>
                <a
                  href={`tel:${cfg.phone.replace(/\D+/g, '')}`}
                  className="inline-flex items-center gap-1.5 hover:text-white transition-colors"
                >
                  <Phone className="w-4 h-4 text-red-500" />
                  {cfg.phone}
                </a>
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <Link
                  to={trialHref}
                  className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold px-5 py-2 rounded-full transition-all shadow-lg shadow-red-900/20 text-sm"
                >
                  Start 2-Week Trial — $49
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <Link
                  to={`/locations/${cfg.slug}`}
                  className="inline-flex items-center gap-2 border border-white/20 hover:border-white/40 text-white font-semibold px-5 py-2 rounded-full transition-all text-sm"
                >
                  Studio Info
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* NATIVE CLASS LIST — no iframe. */}
        <div className="container mx-auto px-4 py-10 sm:py-14">
          <div className="max-w-5xl mx-auto">
            <NativeClassList
              mtLocationId={cfg.mtLocationId}
              studioName={cfg.name}
              studioSlug={cfg.slug}
              days={7}
              trialHref={trialHref}
            />

            <div className="mt-8 pt-6 border-t border-gray-100 flex items-center justify-between flex-wrap gap-3 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Times update live · book any spot above.
              </span>
              <a
                href={`tel:${cfg.phone.replace(/\D+/g, '')}`}
                className="text-red-600 hover:text-red-700 font-semibold inline-flex items-center gap-1"
              >
                <Phone className="w-3.5 h-3.5" />
                Or call {cfg.phone}
              </a>
            </div>
          </div>
        </div>

        {/* CONVERSION FOOTER */}
        <div className="bg-gray-50 border-t border-gray-100 py-12">
          <div className="container mx-auto px-4 text-center">
            <h2 className="text-2xl sm:text-3xl font-bold text-black mb-3">First time at {cfg.name}?</h2>
            <p className="text-gray-600 max-w-xl mx-auto mb-5">
              Your first 2 weeks are $49 — unlimited classes, coaching, and a personalized plan.
            </p>
            <Link
              to={trialHref}
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold px-7 py-3 rounded-full text-base transition-all shadow-lg shadow-red-900/10"
            >
              Claim My Trial
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
