import { TrendingUp, Users, Award, DollarSign, BookOpen, Handshake } from 'lucide-react';
import SEOHead from '../components/SEOHead';

export default function Franchising() {
  const benefits = [
    {
      icon: <Award className="w-12 h-12 text-red-600" />,
      title: 'Proven Success',
      description: '13+ years of industry leadership with a track record of successful locations',
    },
    {
      icon: <Users className="w-12 h-12 text-red-600" />,
      title: 'Loyal Community',
      description: 'Members stay with us for years because our program delivers real results',
    },
    {
      icon: <BookOpen className="w-12 h-12 text-red-600" />,
      title: 'Complete Training',
      description: 'Comprehensive training program covering operations, marketing, and coaching',
    },
    {
      icon: <DollarSign className="w-12 h-12 text-red-600" />,
      title: 'Strong ROI',
      description: 'Multiple revenue streams and proven business model for profitability',
    },
    {
      icon: <TrendingUp className="w-12 h-12 text-red-600" />,
      title: 'Marketing Support',
      description: 'National brand recognition with local marketing guidance and materials',
    },
    {
      icon: <Handshake className="w-12 h-12 text-red-600" />,
      title: 'Ongoing Support',
      description: 'Dedicated franchise support team to help you succeed every step of the way',
    },
  ];

  const requirements = [
    'Passion for fitness and helping others achieve their goals',
    'Business management experience or entrepreneurial background',
    'Minimum liquid capital of $150,000',
    'Total investment range: $200,000 - $400,000',
    'Ability to follow proven systems and processes',
    'Commitment to the Better Body brand and culture',
  ];

  const steps = [
    {
      number: '01',
      title: 'Initial Inquiry',
      description: 'Complete our franchise inquiry form and schedule a discovery call',
    },
    {
      number: '02',
      title: 'Review Process',
      description: 'Receive and review our Franchise Disclosure Document (FDD)',
    },
    {
      number: '03',
      title: 'Meet the Team',
      description: 'Visit our corporate office and existing locations to see our operation',
    },
    {
      number: '04',
      title: 'Application & Approval',
      description: 'Complete franchise application and receive approval',
    },
    {
      number: '05',
      title: 'Training & Launch',
      description: 'Complete comprehensive training and launch your location',
    },
  ];

  return (
    <>
    <SEOHead
      title="Franchise Opportunities | Better Body Bootcamp"
      description="Own a Better Body Bootcamp franchise. Join the fastest growing bootcamp franchise in America with 13+ years of proven success. Investment from $200K-$400K."
      canonical="/franchising"
    />
    <div className="min-h-screen bg-white">
      <div className="bg-gradient-to-br from-black to-gray-900 text-white pt-24 pb-20">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-[clamp(2rem,4.5vw,4rem)] font-bold mb-6">
            Franchise <span className="text-red-600">Opportunities</span>
          </h1>
          <p className="text-xl md:text-2xl text-gray-300 max-w-3xl mx-auto">
            Join the fastest growing bootcamp franchise in America
          </p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto text-center mb-16">
          <h2 className="text-[clamp(2rem,4vw,4rem)] font-bold mb-6 text-black">
            Build Your Business With A Proven Brand
          </h2>
          <p className="text-xl text-gray-700 leading-relaxed">
            Better Body Bootcamp has been transforming lives since 2011. Now we're looking for
            passionate entrepreneurs to bring our proven program to new communities across the
            country. With our comprehensive support system, you'll have everything you need to build
            a thriving fitness business.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 mb-20">
          {benefits.map((benefit, index) => (
            <div
              key={index}
              className="text-center p-6 bg-white rounded-xl shadow-lg hover:shadow-2xl transition-all transform hover:-translate-y-2"
            >
              <div className="flex justify-center mb-4">{benefit.icon}</div>
              <h3 className="text-xl font-bold mb-3 text-black">{benefit.title}</h3>
              <p className="text-gray-700">{benefit.description}</p>
            </div>
          ))}
        </div>

        <div className="bg-gradient-to-br from-gray-50 to-white rounded-2xl p-8 md:p-12 mb-20">
          <h2 className="text-[clamp(2rem,4vw,4rem)] font-bold mb-8 text-center text-black">
            Franchise Requirements
          </h2>
          <div className="max-w-3xl mx-auto">
            <ul className="space-y-4">
              {requirements.map((requirement, index) => (
                <li key={index} className="flex items-start space-x-3">
                  <div className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
                    <svg
                      className="w-4 h-4 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <span className="text-lg text-gray-700">{requirement}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mb-20">
          <h2 className="text-[clamp(2rem,4vw,4rem)] font-bold mb-12 text-center text-black">
            Your Path to Ownership
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
            {steps.map((step, index) => (
              <div key={index} className="text-center">
                <div className="bg-red-600 text-white text-3xl font-bold w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                  {step.number}
                </div>
                <h3 className="text-lg font-bold mb-2 text-black">{step.title}</h3>
                <p className="text-sm text-gray-600">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-br from-red-600 to-red-800 text-white py-16">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="text-[clamp(1.75rem,4vw,4rem)] font-bold mb-6">Ready to Get Started?</h2>
            <p className="text-xl mb-8">
              Take the first step toward owning your own Better Body Bootcamp franchise. Fill out
              our inquiry form and one of our franchise development specialists will be in touch.
            </p>
            <a
              href="/contact"
              className="inline-block bg-white text-red-600 hover:bg-gray-100 px-10 py-4 rounded-full text-lg font-bold transition-all transform hover:scale-105 shadow-lg"
            >
              Request Information
            </a>
            <p className="mt-6 text-sm text-red-100">
              This information is not intended as an offer to sell, or the solicitation of an offer
              to buy, a franchise. It is for informational purposes only.
            </p>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
