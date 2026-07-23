// 404 page — caught by the SPA's catch-all <Route path="*" /> in App.tsx.
// Returns HTTP 200 (because it's the React app shell, not a static 404), but
// we tell crawlers + AI bots not to index it via Helmet. Sets a clear, helpful
// landing instead of a blank screen when someone hits a bad URL or old marketing
// link. Includes brand-consistent visuals + the most useful jump-off points.

import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Home, MapPin, Calendar, Phone } from 'lucide-react';

export default function NotFound() {
  return (
    <>
      <Helmet>
        <title>Page not found · Better Body Bootcamp</title>
        {/* Don't index 404s — Google docs explicitly says don't let soft-404s
            pollute the index. nofollow keeps crawlers from chasing whatever
            broken links got them here. */}
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="relative min-h-screen bg-black overflow-hidden flex items-center">
        {/* Brand glow background — matches the /locations/[slug] hero treatment */}
        <div className="absolute inset-0 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black" />
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-red-600/25 blur-[120px]" />
        <div className="absolute -bottom-40 -right-40 w-[700px] h-[700px] rounded-full bg-red-700/20 blur-[140px]" />
        <div
          className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />

        <div className="container mx-auto px-4 relative z-10 py-20">
          <div className="max-w-3xl mx-auto text-center text-white">
            {/* Big 404 with brand-red dot */}
            <div className="inline-flex items-baseline gap-2 mb-6">
              <span
                className="text-[clamp(6rem,18vw,12rem)] font-black leading-none tracking-tighter"
                style={{ fontFamily: 'BlackLives, sans-serif' }}
              >
                404
              </span>
              <span className="w-3 h-3 sm:w-4 sm:h-4 rounded-full bg-red-500 -translate-y-2 sm:-translate-y-3" />
            </div>

            <h1 className="text-2xl sm:text-4xl font-black mb-4 tracking-tight">
              We can't find that page.
            </h1>

            <p className="text-base sm:text-lg text-gray-300 max-w-xl mx-auto mb-10 leading-relaxed">
              The page you're looking for may have moved or no longer exists. Try one of these instead:
            </p>

            {/* 3 jump-off tiles */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 max-w-2xl mx-auto mb-8">
              <Link
                to="/"
                className="group bg-white/5 hover:bg-white/10 border border-white/10 hover:border-red-400/40 rounded-2xl p-5 transition-all"
              >
                <Home className="w-5 h-5 text-red-400 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                <div className="text-sm font-black tracking-wide">HOME</div>
                <div className="text-xs text-gray-400 mt-1">Start here</div>
              </Link>
              <Link
                to="/locations"
                className="group bg-white/5 hover:bg-white/10 border border-white/10 hover:border-red-400/40 rounded-2xl p-5 transition-all"
              >
                <MapPin className="w-5 h-5 text-red-400 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                <div className="text-sm font-black tracking-wide">LOCATIONS</div>
                <div className="text-xs text-gray-400 mt-1">All 4 NYC studios</div>
              </Link>
              <Link
                to="/trial"
                className="group bg-red-600 hover:bg-red-700 border border-red-500 rounded-2xl p-5 transition-all shadow-lg shadow-red-900/30"
              >
                <Calendar className="w-5 h-5 text-white mx-auto mb-2 group-hover:scale-110 transition-transform" />
                <div className="text-sm font-black tracking-wide text-white">START TRIAL</div>
                <div className="text-xs text-white/80 mt-1">2 weeks · $49</div>
              </Link>
            </div>

            {/* Call fallback */}
            <a
              href="tel:+16465668870"
              className="inline-flex items-center gap-2 text-sm font-bold text-gray-400 hover:text-white transition-colors"
            >
              <Phone className="w-4 h-4 text-red-500" />
              Or call us: (646) 566-8870
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
