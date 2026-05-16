import { useEffect } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { ArrowRight, CheckCircle, Clock, Users, Zap, MapPin, Phone } from 'lucide-react';
import SEOHead from '../components/SEOHead';

// ─── PER-GYM TRIAL CONFIG ───────────────────────────────────────────────────
// Each gym has its own Stripe account and its own $49 trial product.
// To wire a new gym: paste its Stripe Checkout URL into `stripeUrl` below.
//
// Fresh Meadows confirmed live (May 2026).
// Astoria / Bayside / Williamsburg → paste each gym's Stripe Checkout link
// here. Until then, the button shows a friendly "Coming soon — call us" state.
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
  image: string;
  stripeUrl: string | null;
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
    image: '/astoria-final.webp',
    stripeUrl: null, // TODO: paste Astoria Stripe Checkout URL
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
    image: '/bayside-final.webp',
    stripeUrl: null, // TODO: paste Bayside Stripe Checkout URL
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
    image: '/freshmeadows-final.webp',
    stripeUrl: 'https://buy.stripe.com/bJeeVd5fpaH7gbycmD7EQ02',
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
    image: '/williamsburg-final.webp',
    stripeUrl: null, // TODO: paste Williamsburg Stripe Checkout URL
  },
};

export default function LocationTrialSignup() {
  const { location: locationParam } = useParams<{ location: string }>();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [locationParam]);

  const key = (locationParam ?? '').toLowerCase();
  const location = LOCATIONS[key];

  if (!location) {
    return <Navigate to="/trial" replace />;
  }

  const handleClaimClick = () => {
    if (location.stripeUrl) {
      window.location.href = location.stripeUrl;
    }
  };

  return (
    <>
    <SEOHead
      title={`2 Weeks for $49 — ${location.name} | Better Body Bootcamp`}
      description={`Start your 2-week trial at Better Body Bootcamp ${location.name} for just $49. Unlimited classes, expert trainers, real results.`}
      canonical={`/trial/${location.slug}`}
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* HERO ─────────────────────────────────────────────────────────────── */}
      <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-red-800 text-white pt-24 pb-16 sm:pt-32 sm:pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-black/10"></div>
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-10 w-72 h-72 bg-white rounded-full blur-3xl"></div>
          <div className="absolute bottom-10 right-10 w-96 h-96 bg-white rounded-full blur-3xl"></div>
        </div>

        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
          <span className="inline-block px-4 py-1.5 bg-white/15 backdrop-blur-sm rounded-full text-xs font-bold tracking-[0.2em] uppercase border border-white/30 mb-6">
            {location.badge}
          </span>
          <h1 className="text-[clamp(2.5rem,10vw,5.5rem)] font-black mb-6 leading-tight">
            TWO WEEKS FOR $49
          </h1>
          <p className="text-lg sm:text-xl md:text-2xl font-medium leading-relaxed max-w-3xl mx-auto mb-8">
            Unlimited classes at Better Body Bootcamp {location.name}. Real training. Real results.
          </p>

          <div className="flex flex-wrap justify-center gap-4 sm:gap-8 mt-10">
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Clock className="w-5 h-5" />
              <span className="font-semibold">14 Days Unlimited</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Users className="w-5 h-5" />
              <span className="font-semibold">Expert Trainers</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Zap className="w-5 h-5" />
              <span className="font-semibold">High-Energy Workouts</span>
            </div>
          </div>
        </div>
      </div>

      {/* MAIN CARD ────────────────────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 -mt-8 relative z-20">
        <div className="bg-white rounded-3xl shadow-2xl p-6 sm:p-10 lg:p-12 mb-12">

          {/* Why + What's included grid */}
          <div className="grid md:grid-cols-2 gap-8 mb-10">
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold mb-6 text-gray-900">Why Better Body?</h2>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-gray-900 mb-1">Real Strength Training</h3>
                    <p className="text-gray-600">No gimmicks. Just proven methods that deliver lasting results.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-gray-900 mb-1">Dynamic Workouts</h3>
                    <p className="text-gray-600">Never boring, always challenging. Every session pushes you further.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-gray-900 mb-1">Engaged Trainers</h3>
                    <p className="text-gray-600">Coaches who care about your progress and keep you motivated.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-gray-900 mb-1">Community Driven</h3>
                    <p className="text-gray-600">Train alongside people who are serious about their goals.</p>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="bg-gradient-to-br from-red-50 to-white border-2 border-red-100 rounded-2xl p-6 mb-4">
                <h3 className="font-bold text-xl text-gray-900 mb-4">Your 2-Week Trial Includes:</h3>
                <ul className="space-y-3 text-gray-700">
                  <li className="flex items-center gap-2"><span className="text-red-600">•</span> Unlimited access to all classes</li>
                  <li className="flex items-center gap-2"><span className="text-red-600">•</span> Complete fitness assessment</li>
                  <li className="flex items-center gap-2"><span className="text-red-600">•</span> Personalized goal setting session</li>
                  <li className="flex items-center gap-2"><span className="text-red-600">•</span> Full access at our {location.name} studio</li>
                </ul>
                <div className="border-t border-red-100 mt-5 pt-4 flex justify-between items-center">
                  <span className="font-bold text-gray-700 uppercase text-sm tracking-wider">Total</span>
                  <span className="text-3xl font-black text-red-600">$49</span>
                </div>
              </div>

              {/* Studio details card */}
              <div className="bg-gray-50 border border-gray-200 rounded-2xl p-5">
                <h4 className="font-bold text-gray-900 mb-3">Your Studio</h4>
                <div className="space-y-2 text-sm text-gray-700">
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                    <span>{location.address}<br/>{location.city}, {location.state} {location.zip}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4 text-red-600 flex-shrink-0" />
                    <a href={`tel:${location.phone}`} className="hover:text-red-600 transition-colors">{location.phone}</a>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* CTA section ─────────────────────────────────────────────────── */}
          <div className="border-t border-gray-100 pt-8">
            <div className="text-center mb-6">
              <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">
                Claim Your Trial at {location.name}
              </h2>
              <p className="text-gray-600">
                Classes fill up fast. Secure your spot now.
              </p>
            </div>

            {location.stripeUrl ? (
              <button
                onClick={handleClaimClick}
                className="group w-full sm:w-auto sm:mx-auto sm:flex bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-8 py-4 rounded-xl font-black text-lg uppercase tracking-wider transition-all transform hover:scale-[1.02] shadow-lg hover:shadow-red-600/50 flex items-center justify-center gap-3"
              >
                Start My $49 Trial
                <ArrowRight className="w-6 h-6 group-hover:translate-x-1 transition-transform" />
              </button>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-center max-w-2xl mx-auto">
                <p className="text-amber-900 font-semibold mb-1">Online checkout coming soon for {location.name}</p>
                <p className="text-amber-800 text-sm mb-3">
                  Call us to claim your trial today:
                </p>
                <a
                  href={`tel:${location.phone}`}
                  className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-6 py-3 rounded-lg font-bold transition-colors"
                >
                  <Phone className="w-5 h-5" />
                  {location.phone}
                </a>
              </div>
            )}

            <p className="text-center text-xs text-gray-500 mt-6">
              Secure checkout powered by Stripe. Trial valid for 14 days from purchase.
            </p>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
