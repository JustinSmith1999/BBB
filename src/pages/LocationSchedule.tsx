import { useEffect, useState } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { MapPin, Phone, Calendar, ArrowRight, Clock } from 'lucide-react';
import SEOHead from '../components/SEOHead';

// ─── PER-GYM CONFIG ─────────────────────────────────────────────────────────
// MindBody (Healcode) schedule widget IDs are issued per studio. These match
// the IDs that ship in Classes.tsx / LocationDetail.tsx — change once, change
// everywhere. The page is a single-studio focused schedule view used by
// /schedule/[slug] (e.g. /schedule/fresh-meadows).
// ─────────────────────────────────────────────────────────────────────────────
type LocationConfig = {
  slug: string;
  name: string;
  badge: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  widgetId: string;
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
    widgetId: '7d20556270b3',
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
    widgetId: '7d20556570b3',
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
    widgetId: '7d20556770b3',
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
    widgetId: '7d20557070b3',
  },
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'healcode-widget': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          'data-type'?: string;
          'data-widget-partner'?: string;
          'data-widget-id'?: string;
          'data-widget-version'?: string;
        },
        HTMLElement
      >;
    }
  }
}

const HEALCODE_SRC = 'https://widgets.mindbodyonline.com/javascripts/healcode.js';

export default function LocationSchedule() {
  const { location: slugParam } = useParams<{ location: string }>();
  const slug = (slugParam ?? '').toLowerCase();
  const config = LOCATIONS[slug];

  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [widgetKey, setWidgetKey] = useState(0);

  useEffect(() => {
    if (!config) return;

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${HEALCODE_SRC}"]`);
    if (existing) {
      // If the script is already on the page (e.g. user came from /classes),
      // force a re-render of the widget so MindBody picks up the new widget id.
      setScriptLoaded(false);
      const t = setTimeout(() => {
        setWidgetKey((k) => k + 1);
        setScriptLoaded(true);
      }, 100);
      return () => clearTimeout(t);
    }

    const s = document.createElement('script');
    s.type = 'text/javascript';
    s.src = HEALCODE_SRC;
    s.async = true;
    s.onload = () => {
      // Give Healcode a beat to attach its custom element registry.
      setTimeout(() => {
        setWidgetKey((k) => k + 1);
        setScriptLoaded(true);
      }, 800);
    };
    s.onerror = () => setScriptLoaded(true); // surface the fallback message
    document.head.appendChild(s);

    return () => {
      // Keep the script around — MindBody re-uses it across pages. We just
      // clear our local loaded flag.
    };
  }, [config]);

  if (!config) {
    return <Navigate to="/classes" replace />;
  }

  const trialHref = `/trial/${config.slug}`;
  const locationHref = `/locations/${config.slug}`;
  const widgetHtml = `<healcode-widget data-type="schedules" data-widget-partner="object" data-widget-id="${config.widgetId}" data-widget-version="1"></healcode-widget>`;

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
                Browse this week's classes and reserve your spot. New here? Start with our 2-week trial for $49.
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

        {/* Schedule widget */}
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-5xl mx-auto">
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 sm:p-6 md:p-8">
              <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-red-600/10 flex items-center justify-center">
                    <Calendar className="w-5 h-5 text-red-600" />
                  </div>
                  <div>
                    <h2 className="text-xl sm:text-2xl font-bold text-black leading-tight">This Week's Classes</h2>
                    <p className="text-xs text-gray-500">Powered by MindBody · times update live</p>
                  </div>
                </div>
                <Link
                  to="/classes"
                  className="text-red-600 hover:text-red-700 text-sm font-bold transition-colors"
                >
                  All locations →
                </Link>
              </div>

              {scriptLoaded ? (
                <div key={widgetKey} className="mindbody-schedule-wrap min-h-[400px]">
                  <div dangerouslySetInnerHTML={{ __html: widgetHtml }} />
                </div>
              ) : (
                <div className="text-center py-16">
                  <div className="inline-block animate-spin rounded-full h-10 w-10 border-b-2 border-red-600 mb-4"></div>
                  <p className="text-gray-600 text-sm">Loading {config.name} class schedule…</p>
                </div>
              )}

              {/* Help / fallback */}
              <div className="mt-6 pt-6 border-t border-gray-100 text-xs text-gray-500 flex items-center justify-between flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  Trouble loading? Refresh the page or call {config.phone}.
                </span>
                <a
                  href={`https://clients.mindbodyonline.com/classic/ws?studioid=&stype=-7&sLoc=`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-red-600 hover:text-red-700 font-semibold"
                >
                  Open in MindBody ↗
                </a>
              </div>
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
