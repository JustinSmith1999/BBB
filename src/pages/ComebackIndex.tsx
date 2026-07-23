import { ArrowRight, Clock, Zap, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import SEOHead from '../components/SEOHead';

// 2026-07-02 (QA #3): the bare `/comeback` URL used to 404 — only
// `/comeback/:location` had a route. Real campaign links (comeback-* edge
// functions) are studio-suffixed and unaffected, but any bare-URL hit
// dead-ended. This picker catches those and routes to the correct per-studio
// $29 offer instead of guessing a studio for a lapsed lead.
const STUDIOS = [
  { slug: 'astoria',       name: 'Astoria',       area: 'Astoria, Queens',        address: '31-18 Steinway Street' },
  { slug: 'bayside',       name: 'Bayside',       area: 'Bayside, Queens',        address: '3447 Bell Blvd' },
  { slug: 'fresh-meadows', name: 'Fresh Meadows', area: 'Fresh Meadows, Queens',  address: '76-46 164th Street' },
  { slug: 'williamsburg',  name: 'Williamsburg',  area: 'Williamsburg, Brooklyn', address: '487 Driggs Ave' },
];

export default function ComebackIndex() {
  return (
    <>
    <SEOHead
      title="$29 for 1 Week — Pick Your Studio | Better Body Bootcamp"
      description="Come back to Better Body Bootcamp — one week of unlimited classes for $29. Choose your NYC studio to claim the offer."
      canonical="/comeback"
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-red-800 text-white pt-32 pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-black/10"></div>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
          <h1 className="text-[clamp(2.25rem,5vw,4rem)] font-black mb-5 leading-[1.05]">
            ONE WEEK FOR $29
          </h1>
          <p className="text-lg sm:text-xl md:text-2xl font-medium leading-relaxed max-w-2xl mx-auto mb-8">
            Pick up where you left off. Unlimited classes for 7 days — no auto-renew. Choose your studio to claim it.
          </p>
          <div className="flex flex-wrap justify-center gap-4 sm:gap-6">
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Clock className="w-5 h-5" /><span className="font-semibold">7 Days Unlimited</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Zap className="w-5 h-5" /><span className="font-semibold">No Auto-Renew</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 -mt-10 relative z-20 pb-20">
        <div className="bg-white rounded-3xl shadow-2xl p-6 sm:p-10">
          <div className="text-center mb-8">
            <h2 className="text-2xl sm:text-3xl font-black text-gray-900 mb-2">Choose Your Studio</h2>
            <p className="text-gray-600">Select your location to claim the $29 one-week comeback.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4 sm:gap-5">
            {STUDIOS.map(s => (
              <Link
                key={s.slug}
                to={`/comeback/${s.slug}`}
                className="group flex items-center justify-between gap-4 border-2 border-gray-100 hover:border-red-500 rounded-2xl p-5 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <MapPin className="w-5 h-5 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <div className="font-bold text-gray-900">{s.name}</div>
                    <div className="text-sm text-gray-500">{s.area}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{s.address}</div>
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-gray-300 group-hover:text-red-600 transition-colors flex-shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
