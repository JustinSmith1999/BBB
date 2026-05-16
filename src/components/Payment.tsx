import { CreditCard, Check } from 'lucide-react';

export default function Payment() {
  return (
    <section className="py-12 sm:py-16 bg-gradient-to-br from-gray-900 to-black text-white">
      <div className="container mx-auto px-4">
        <div className="text-center mb-8 sm:mb-12">
          <h2 className="text-[clamp(1.75rem,5vw,5rem)] font-bold mb-3 sm:mb-4">
            Membership Options
          </h2>
          <p className="text-lg sm:text-xl text-gray-400">
            Choose the plan that works best for you
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8 max-w-6xl mx-auto">
          <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-6 sm:p-8 border border-gray-700 hover:border-red-600 transition-all transform hover:scale-105">
            <h3 className="text-[clamp(1.25rem,3vw,2rem)] font-bold mb-3 sm:mb-4">Trial Pass</h3>
            <div className="text-3xl sm:text-4xl font-bold mb-4 sm:mb-6">
              <span className="text-red-600">Contact</span>
              <span className="text-base sm:text-lg font-normal text-gray-400"> / for pricing</span>
            </div>
            <ul className="space-y-3 sm:space-y-4 mb-6 sm:mb-8">
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Experience our training</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Meet our trainers</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">See the results</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Limited time offer</span>
              </li>
            </ul>
            <button
              onClick={() => {
                const element = document.getElementById('trial');
                if (element) element.scrollIntoView({ behavior: 'smooth' });
              }}
              className="w-full bg-red-600 hover:bg-red-700 text-white px-5 sm:px-6 py-2.5 sm:py-3 rounded-full text-sm sm:text-base font-bold transition-all"
            >
              Start Trial
            </button>
          </div>

          <div className="bg-gradient-to-br from-red-600 to-red-800 rounded-2xl p-6 sm:p-8 border-2 border-red-400 md:transform md:scale-105 shadow-2xl">
            <div className="bg-white text-black text-xs font-bold px-3 py-1 rounded-full inline-block mb-3 sm:mb-4">
              MOST POPULAR
            </div>
            <h3 className="text-[clamp(1.25rem,3vw,2rem)] font-bold mb-3 sm:mb-4">Monthly Membership</h3>
            <div className="text-3xl sm:text-4xl font-bold mb-4 sm:mb-6">
              <span className="text-white">Contact</span>
              <span className="text-base sm:text-lg font-normal text-red-200"> / for pricing</span>
            </div>
            <ul className="space-y-3 sm:space-y-4 mb-6 sm:mb-8">
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-white flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Unlimited classes</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-white flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">All locations access</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-white flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Nutrition guidance</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-white flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Community support</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-white flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Recurring via Mind Body</span>
              </li>
            </ul>
            <button
              onClick={() => {
                const element = document.getElementById('contact');
                if (element) element.scrollIntoView({ behavior: 'smooth' });
              }}
              className="w-full bg-white text-red-600 hover:bg-gray-100 px-5 sm:px-6 py-2.5 sm:py-3 rounded-full text-sm sm:text-base font-bold transition-all"
            >
              Get Started
            </button>
          </div>

          <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-6 sm:p-8 border border-gray-700 hover:border-red-600 transition-all transform hover:scale-105">
            <h3 className="text-[clamp(1.25rem,3vw,2rem)] font-bold mb-3 sm:mb-4">Annual Membership</h3>
            <div className="text-3xl sm:text-4xl font-bold mb-4 sm:mb-6">
              <span className="text-red-600">Contact</span>
              <span className="text-base sm:text-lg font-normal text-gray-400"> / for pricing</span>
            </div>
            <ul className="space-y-3 sm:space-y-4 mb-6 sm:mb-8">
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Everything in Monthly</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Best value pricing</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Priority booking</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Exclusive events</span>
              </li>
              <li className="flex items-start space-x-3">
                <Check className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm sm:text-base">Managed via Mind Body</span>
              </li>
            </ul>
            <button
              onClick={() => {
                const element = document.getElementById('contact');
                if (element) element.scrollIntoView({ behavior: 'smooth' });
              }}
              className="w-full bg-red-600 hover:bg-red-700 text-white px-5 sm:px-6 py-2.5 sm:py-3 rounded-full text-sm sm:text-base font-bold transition-all"
            >
              Contact Us
            </button>
          </div>
        </div>

        <div className="mt-8 sm:mt-12 max-w-3xl mx-auto text-center">
          <div className="bg-gray-800 rounded-xl p-6 sm:p-8">
            <CreditCard className="w-10 h-10 sm:w-12 sm:h-12 text-red-600 mx-auto mb-3 sm:mb-4" />
            <h3 className="text-[clamp(1.25rem,3vw,2rem)] font-bold mb-3 sm:mb-4">Mind Body Integration</h3>
            <p className="text-sm sm:text-base text-gray-400 mb-3 sm:mb-4">
              All recurring payments are securely processed through Mind Body, our trusted payment partner.
              You'll have access to your membership dashboard, class scheduling, and payment management
              all in one place.
            </p>
            <p className="text-xs sm:text-sm text-gray-500">
              Contact us to set up your membership and connect with Mind Body for seamless payment processing.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
