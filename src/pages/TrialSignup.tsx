import { ArrowRight, Clock, Users, Zap, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import SEOHead from '../components/SEOHead';

// /trial is the studio picker. Each card routes to the per-studio page
// (/trial/[slug]) which has the real validated form + per-gym Stripe checkout.
const STUDIOS = [
  { slug: 'astoria',       name: 'Astoria',       area: 'Astoria, Queens',        address: '31-18 Steinway Street' },
  { slug: 'bayside',       name: 'Bayside',       area: 'Bayside, Queens',        address: '3447 Bell Blvd' },
  { slug: 'fresh-meadows', name: 'Fresh Meadows', area: 'Fresh Meadows, Queens',  address: '76-46 164th Street' },
  { slug: 'williamsburg',  name: 'Williamsburg',  area: 'Williamsburg, Brooklyn', address: '487 Driggs Ave' },
];

export default function TrialSignup() {
  return (
    <>
    <SEOHead
      title="2 Weeks for $49 — Pick Your Studio | Better Body Bootcamp"
      description="Start your 2-week trial at Better Body Bootcamp for $49. Choose your NYC studio — Astoria, Bayside, Fresh Meadows, or Williamsburg — and claim your spot."
      canonical="/trial"
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* HERO */}
      <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-red-800 text-white pt-32 pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-black/10"></div>
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-10 w-72 h-72 bg-white rounded-full blur-3xl"></div>
          <div className="absolute bottom-10 right-10 w-96 h-96 bg-white rounded-full blur-3xl"></div>
        </div>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
          <h1 className="text-[clamp(2.25rem,5vw,4rem)] font-black mb-5 leading-[1.05]">
            TWO WEEKS FOR $49
          </h1>
          <p className="text-lg sm:text-xl md:text-2xl font-medium leading-relaxed max-w-2xl mx-auto mb-8">
            Unlimited classes, expert coaching, real results. Pick your studio to get started.
          </p>
          <div className="flex flex-wrap justify-center gap-4 sm:gap-6">
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Clock className="w-5 h-5" /><span className="font-semibold">14 Days Unlimited</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Users className="w-5 h-5" /><span className="font-semibold">Expert Trainers</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Zap className="w-5 h-5" /><span className="font-semibold">High-Energy Workouts</span>
            </div>
          </div>
        </div>
      </div>

      {/* STUDIO PICKER */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 -mt-10 relative z-20 pb-20">
        <div className="bg-white rounded-3xl shadow-2xl p-6 sm:p-10">
          <div className="text-center mb-8">
            <h2 className="text-2xl sm:text-3xl font-black text-gray-900 mb-2">Choose Your Studio</h2>
            <p className="text-gray-600">Select the location closest to you to claim your 2-week trial.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4 sm:gap-5">
            {STUDIOS.map(s => (
              <Link
                key={s.slug}
                to={`/trial/${s.slug}`}
                className="group flex items-center justify-between gap-4 border-2 border-gray-200 hover:border-red-500 rounded-2xl p-5 sm:p-6 transition-all hover:shadow-lg hover:-translate-y-0.5"
              >
                <div>
                  <div className="text-lg sm:text-xl font-black text-gray-900">{s.name}</div>
                  <div className="flex items-center gap-1.5 text-sm text-gray-500 mt-1">
                    <MapPin className="w-4 h-4 text-red-600 flex-shrink-0" />
                    <span>{s.address} · {s.area}</span>
                  </div>
                </div>
                <span className="flex items-center gap-1.5 text-sm font-bold text-red-600 whitespace-nowrap">
                  Start <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </span>
              </Link>
            ))}
          </div>
          <p className="text-center text-xs text-gray-500 mt-6 italic">
            You have 60 days to claim and start your trial.
          </p>
          <p className="text-center text-sm text-red-600 font-bold mt-2">
            Two-week trial available only to New York City residents.
          </p>
          <p className="text-center text-sm text-gray-500 mt-3">
            Questions? <a href="/contact" className="text-red-600 hover:text-red-700 font-semibold">Contact us</a> anytime.
          </p>
          <p className="text-center text-[10px] text-gray-400 mt-4 leading-tight">
            All trials non-refundable.
          </p>
        </div>
      </div>
    </div>
    </>
  );
}
