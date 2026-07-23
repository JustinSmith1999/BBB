import { useParams, Navigate, Link } from 'react-router-dom';
import { MapPin, Phone, ArrowRight, Clock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import NativeClassList from '../components/NativeClassList';

// 2026-06-26 v2: Iframe gone. We now hit MT's class_sessions API via the
// mt-public-classes Supabase proxy and render BBB-branded React cards.
// No cross-domain handshake, no auto-scan race, full design control.

// ─── PER-GYM CONFIG ─────────────────────────────────────────────────────────
type LocationConfig = {
  slug: string;
  name: string;
  badge: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  /** Mariana Tek per-studio location ID inside the betterbodybootcamp tenant. */
  mtLocationId: number;
};

const LOCATIONS: Record<string, LocationConfig> = {
  'astoria': {
    slug: 'astoria',
    name: 'Astoria',
    badge: 'ASTORIA · QUEENS',
    address: '31-18 Steinway Street',
    city: 'Astoria',
    state: 'NY',
    zip: '11103',
    phone: '(718) 704-9954',
    mtLocationId: 48717,
  },
  'bayside': {
    slug: 'bayside',
    name: 'Bayside',
    badge: 'BAYSIDE · QUEENS',
    address: '3447 Bell Blvd',
    city: 'Bayside',
    state: 'NY',
    zip: '11361',
    phone: '(646) 566-8870',
    mtLocationId: 48718,
  },
  'fresh-meadows': {
    slug: 'fresh-meadows',
    name: 'Fresh Meadows',
    badge: 'FRESH MEADOWS · QUEENS',
    address: '76-46 164th Street',
    city: 'Fresh Meadows',
    state: 'NY',
    zip: '11366',
    phone: '(646) 566-8207',
    mtLocationId: 48719,
  },
  'williamsburg': {
    slug: 'williamsburg',
    name: 'Williamsburg',
    badge: 'WILLIAMSBURG · BROOKLYN',
    address: '487 Driggs Ave',
    city: 'Brooklyn',
    state: 'NY',
    zip: '11211',
    phone: '(718) 683-1864',
    mtLocationId: 48720,
  },
};

export default function LocationSchedule() {
  const { location: slugParam } = useParams<{ location: string }>();
  const slug = (slugParam ?? '').toLowerCase();
  const config = LOCATIONS[slug];

  if (!config) {
    return <Navigate to="/classes" replace />;
  }

  const trialHref = `/trial/${config.slug}`;
  const locationHref = `/locations/${config.slug}`;

  return (
    <>
      <SEOHead
        title={`Class Schedule — ${config.name} | Better Body Bootcamp`}
        description={`Browse this week's group fitness class schedule at Better Body Bootcamp ${config.name}. View times, reserve your spot, and start your $49 two-week trial.`}
        canonical={`/schedule/${config.slug}`}
      />

      <div className="min-h-screen bg-white">
        {/* Hero */}
        <div className="bg-gradient-to-br from-black via-zinc-900 to-black text-white pt-28 pb-12">
          <div className="container mx-auto px-4">
            <div className="max-w-4xl mx-auto text-center">
              <span className="inline-block bg-red-600/15 text-red-400 text-xs font-bold tracking-widest px-3 py-1 rounded-full mb-4">
                {config.badge}
              </span>
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold leading-[0.95] mb-4">
                {config.name} <span className="text-red-600">Class Schedule</span>
              </h1>
              <p className="text-base sm:text-lg text-gray-300 max-w-2xl mx-auto mb-6">
                Browse this week's classes and reserve your spot below. New here? Start with our 2-week trial for $49.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-300">
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-red-500" />
                  {config.address}, {config.city}, {config.state} {config.zip}
                </span>
                <a
                  href={`tel:${config.phone.replace(/\D+/g, '')}`}
                  className="inline-flex items-center gap-1.5 hover:text-white transition-colors"
                >
                  <Phone className="w-4 h-4 text-red-500" />
                  {config.phone}
                </a>
              </div>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <Link
                  to={trialHref}
                  className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold px-5 py-2.5 rounded-full transition-all shadow-lg shadow-red-900/20"
                >
                  Start 2-Week Trial — $49
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <Link
                  to={locationHref}
                  className="inline-flex items-center gap-2 border border-white/20 hover:border-white/40 text-white font-semibold px-5 py-2.5 rounded-full transition-all"
                >
                  Studio Info
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* 2026-06-26 v2: Native MT class list — no iframe. Real availability,
            BBB design, single-click reserve link. */}
        <div className="container mx-auto px-4 py-10 sm:py-12">
          <div className="max-w-6xl mx-auto">
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 sm:p-6 md:p-8">
              <NativeClassList
                mtLocationId={config.mtLocationId}
                studioName={config.name}
                studioSlug={config.slug}
                days={7}
                trialHref={trialHref}
              />
            </div>

            {/* Help / fallback */}
            <div className="mt-5 text-xs text-gray-500 flex items-center justify-between flex-wrap gap-2 px-1">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Times update live · book directly above.
              </span>
              <a
                href={`tel:${config.phone.replace(/\D+/g, '')}`}
                className="text-red-600 hover:text-red-700 font-semibold inline-flex items-center gap-1"
              >
                <Phone className="w-3.5 h-3.5" />
                Or call {config.phone}
              </a>
            </div>

            {/* Sibling CTA for never-been-here visitors */}
            <div className="mt-6 text-center">
              <Link
                to={trialHref}
                className="inline-flex items-center gap-2 text-red-600 hover:text-red-700 font-bold text-sm transition-colors"
              >
                New here? Start with our 2-week trial — $49
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>

        {/* Conversion footer */}
        <div className="bg-gray-50 border-t border-gray-100 py-14">
          <div className="container mx-auto px-4 text-center">
            <h2 className="text-2xl sm:text-3xl font-bold text-black mb-3">
              First time at {config.name}?
            </h2>
            <p className="text-gray-600 max-w-xl mx-auto mb-6">
              Your first 2 weeks are $49 — unlimited classes, coaching, and a personalized plan to get you started.
            </p>
            <Link
              to={trialHref}
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold px-8 py-3 rounded-full text-base transition-all shadow-lg shadow-red-900/10"
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
