export default function About() {
  return (
    <section id="about" className="py-16 sm:py-20 bg-black text-white relative overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-20 left-20 w-96 h-96 bg-red-600 rounded-full mix-blend-screen filter blur-[128px] opacity-10 animate-pulse"></div>
        <div className="absolute bottom-20 right-20 w-96 h-96 bg-red-700 rounded-full mix-blend-screen filter blur-[128px] opacity-10 animate-pulse" style={{ animationDelay: '2s' }}></div>
      </div>

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16 sm:mb-20">
            <div className="inline-block mb-6">
              <span className="px-4 py-2 bg-red-600/20 border border-red-600 rounded-full text-sm font-bold tracking-wider text-red-500 uppercase">
                Since 2011
              </span>
            </div>

            <h2 className="text-[clamp(1.5rem,6vw,7rem)] font-black mb-8 sm:mb-10 tracking-tight leading-[1.1] px-2">
              <span className="inline-block">Building The Nation's</span><br />
              <span className="bg-gradient-to-r from-red-500 via-red-600 to-red-700 bg-clip-text text-transparent inline-block">
                Premier Fitness Community
              </span>
            </h2>

            <div className="max-w-4xl mx-auto space-y-6 text-lg sm:text-xl md:text-2xl leading-relaxed text-gray-300">
              <p>
                We didn't become one of America's most respected privately owned training programs by following the crowd. We got here by <span className="font-bold text-white">obsessing over your results</span> while everyone else was chasing trends.
              </p>

              <p>
                Our formula is simple but powerful: world-class trainers who genuinely care, science-backed workouts that actually work, and an environment so electric you'll find yourself looking forward to 5 AM alarms.
              </p>

              <p className="text-2xl sm:text-3xl font-bold text-white pt-4">
                This isn't just another gym.<br />
                This is your launchpad to <span className="bg-gradient-to-r from-red-500 via-red-600 to-red-700 bg-clip-text text-transparent">becoming unstoppable</span>.
              </p>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-6 sm:gap-8">
            <div className="bg-gradient-to-br from-gray-900 to-black border border-white/10 rounded-2xl p-8 hover:border-red-600/50 transition-all text-center md:text-left">
              <h3 className="text-2xl font-black mb-4 text-white">The Right Training</h3>
              <p className="text-gray-300 leading-relaxed">
                No cookie-cutter programs here. Every workout is engineered to maximize fat burn while sculpting lean, defined muscle. You'll see changes in weeks, not months.
              </p>
            </div>

            <div className="bg-gradient-to-br from-gray-900 to-black border border-white/10 rounded-2xl p-8 hover:border-red-600/50 transition-all text-center md:text-left">
              <h3 className="text-2xl font-black mb-4 text-white">The Right People</h3>
              <p className="text-gray-300 leading-relaxed">
                Our trainers aren't just certified—they're passionate, experienced, and genuinely invested in your success. They'll push you harder than you'd push yourself, and celebrate every win with you.
              </p>
            </div>

            <div className="bg-gradient-to-br from-gray-900 to-black border border-white/10 rounded-2xl p-8 hover:border-red-600/50 transition-all text-center md:text-left">
              <h3 className="text-2xl font-black mb-4 text-white">The Right Energy</h3>
              <p className="text-gray-300 leading-relaxed">
                Walk into any Better Body location and you'll feel it—the energy is contagious. It's the secret ingredient that turns first-timers into lifetime members.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
