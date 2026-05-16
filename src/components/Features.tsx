import { Flame, Dumbbell, Heart, Zap } from 'lucide-react';

export default function Features() {
  const scrollToTrial = () => {
    const element = document.getElementById('trial');
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const features = [
    {
      icon: <Zap className="w-16 h-16 text-red-600" />,
      title: 'Better Body Bootcamp Is The Solution',
      description:
        "We know that your reasons for getting into shape are deep and meaningful. That's why we treat your results like a matter of life and death. We achieve this through the best trainers in the business, running the most effective workouts, in the most fun and caring environment in all of fitness.",
    },
    {
      icon: <Flame className="w-16 h-16 text-red-600" />,
      title: 'Fat-Burning Intervals At Their Finest',
      description:
        "You've heard of interval training right? Yes, but everyone's doing that these days. At Better Body, you'll find a higher level. We pick interval moves that sculpt and tone you, to make sure you're changing your shape while you're burning fat. There's more to results than endless burpees; that's what you'll discover with us.",
    },
    {
      icon: <Dumbbell className="w-16 h-16 text-red-600" />,
      title: 'Body Sculpting With Weights',
      description:
        "Did you know that if you do the wrong strength moves, you can actually look worse? The wrong routine can give you a stockier, chunkier, blockier appearance, bigger clothing sizes, and a larger waist. We pick moves that will sculpt, tone, and define you, and put them in a combination to give you your best possible appearance.",
    },
    {
      icon: <Heart className="w-16 h-16 text-red-600" />,
      title: 'When Fitness Is Fun, It\'s Effortless',
      description:
        "Our greatest discovery at Better Body is a training style that pumps tons of energy, motivation, and fun into every single day. You'll look forward to every workout as a way to let loose and unwind from your day, or kick-start it with strength and power. It's this unique approach that's helped us turn more newbies into fitness junkies than any other program ever invented.",
    },
  ];

  return (
    <section id="features" className="py-16 sm:py-20 bg-black relative overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-20 left-20 w-72 h-72 bg-red-600 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob"></div>
        <div className="absolute bottom-20 right-20 w-72 h-72 bg-red-800 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-4000"></div>
      </div>

      <div className="container mx-auto px-4 relative z-10">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 max-w-7xl mx-auto mb-12 sm:mb-16">
          {features.map((feature, index) => (
            <div
              key={index}
              className="group bg-gradient-to-br from-gray-900 to-black border-2 border-red-600 p-6 sm:p-10 rounded-2xl shadow-2xl hover:shadow-red-600/50 transition-all transform hover:scale-105 hover:border-red-500"
            >
              <div className="flex justify-center mb-4 sm:mb-6 transform group-hover:scale-110 transition-transform">{feature.icon}</div>
              <h3 className="text-[clamp(1.25rem,4vw,3rem)] font-black mb-4 sm:mb-6 text-white text-center tracking-tight">
                {feature.title}
              </h3>
              <p className="text-sm sm:text-base md:text-lg text-gray-300 leading-relaxed text-center">
                {feature.description}
              </p>
            </div>
          ))}
        </div>

        <div className="max-w-5xl mx-auto text-center bg-black text-white py-8 sm:py-12 px-6 sm:px-8 rounded-2xl shadow-2xl mb-12 sm:mb-16">
          <h2 className="text-[clamp(1.5rem,4vw,4rem)] font-bold mb-4 sm:mb-6">
            Real People. Real Transformations. Real Results.
          </h2>
          <p className="text-base sm:text-lg md:text-xl mb-6 sm:mb-8 leading-relaxed text-gray-300">
            Our members don't just lose weight—they <span className="font-bold text-white">transform their entire lives</span>. They discover strength they never knew they had. They build the body they've always wanted. And they prove that with the right program, anything is possible. Your transformation story starts here.
          </p>
          <button
            onClick={() => {
              const element = document.getElementById('testimonials');
              if (element) {
                element.scrollIntoView({ behavior: 'smooth' });
              }
            }}
            className="bg-red-600 hover:bg-red-700 text-white px-8 sm:px-10 py-3 sm:py-4 rounded-full text-base sm:text-lg font-bold transition-all transform hover:scale-105 shadow-lg"
          >
            VIEW TESTIMONIALS
          </button>
        </div>

        <div className="max-w-5xl mx-auto text-center bg-gradient-to-br from-gray-100 to-gray-50 py-8 sm:py-12 px-6 sm:px-8 rounded-2xl shadow-lg">
          <h2 className="text-[clamp(1.5rem,4vw,4rem)] font-bold mb-4 sm:mb-6 text-black">
            Your Future Self Is Waiting
          </h2>
          <p className="text-base sm:text-lg md:text-xl text-gray-700 mb-6 sm:mb-8 leading-relaxed">
            Three months from now, you'll wish you had started today. The only thing standing between you and the body you want is a decision. <span className="font-bold text-black">Your decision</span>. Making excuses is easy—but excuses won't change your reflection in the mirror. You deserve to feel strong, confident, and unstoppable. The time is now.
          </p>
          <button
            onClick={scrollToTrial}
            className="bg-red-600 hover:bg-red-700 text-white px-8 sm:px-10 py-3 sm:py-4 rounded-full text-base sm:text-lg font-bold transition-all transform hover:scale-105 shadow-lg"
          >
            START YOUR TRIAL
          </button>
        </div>
      </div>
    </section>
  );
}
