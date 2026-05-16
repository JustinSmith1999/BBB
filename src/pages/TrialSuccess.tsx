import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle, ArrowRight, Calendar } from 'lucide-react';
import SEOHead from '../components/SEOHead';

export default function TrialSuccess() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [countdown, setCountdown] = useState(5);
  const sessionId = searchParams.get('session_id');

  useEffect(() => {
    window.scrollTo(0, 0);

    if (!sessionId) {
      navigate('/locations');
      return;
    }

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          navigate('/locations');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [sessionId, navigate]);

  if (!sessionId) {
    return null;
  }

  return (
    <>
    <SEOHead
      title="Welcome to Better Body Bootcamp!"
      description="Your trial signup was successful. Welcome to Better Body Bootcamp!"
      canonical="/trial-success"
      noindex={true}
    />
    <div className="min-h-screen bg-gradient-to-b from-black via-gray-900 to-black flex items-center justify-center px-4">
      <div className="max-w-2xl w-full">
        <div className="bg-gradient-to-br from-gray-900 to-black border-2 border-green-500/50 rounded-3xl p-8 md:p-12 text-center shadow-2xl">
          <div className="bg-green-500/20 w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4 border-green-500">
            <CheckCircle className="w-12 h-12 text-green-400" />
          </div>

          <h1 className="text-3xl md:text-4xl lg:text-5xl font-display font-black text-white mb-4">
            Payment Successful!
          </h1>

          <p className="text-lg md:text-xl text-gray-300 mb-8">
            Welcome to Better Body Bootcamp! Your 2-week trial is ready.
          </p>

          <div className="bg-black/50 border border-white/10 rounded-2xl p-6 mb-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center justify-center gap-2">
              <Calendar className="w-6 h-6 text-red-500" />
              What's Next?
            </h2>
            <div className="space-y-3 text-left text-gray-300">
              <div className="flex items-start gap-3">
                <span className="text-red-500 font-bold">1.</span>
                <p className="text-sm md:text-base">
                  Check your email for confirmation and location details
                </p>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-red-500 font-bold">2.</span>
                <p className="text-sm md:text-base">
                  Your location will contact you to schedule your first class
                </p>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-red-500 font-bold">3.</span>
                <p className="text-sm md:text-base">
                  Show up ready to work and experience real training
                </p>
              </div>
            </div>
          </div>

          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-6">
            <p className="text-yellow-200 text-sm font-semibold">
              Your trial expires 3 months from today. Make sure to use it!
            </p>
          </div>

          <button
            onClick={() => navigate('/locations')}
            className="group inline-flex items-center gap-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-8 py-4 rounded-xl font-bold transition-all transform hover:scale-[1.02] shadow-lg"
          >
            <span>View All Locations</span>
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </button>

          <p className="text-gray-500 text-sm mt-6">
            Redirecting in {countdown} seconds...
          </p>
        </div>

        <div className="mt-8 text-center">
          <p className="text-gray-400 text-sm mb-2">
            Questions about your trial?
          </p>
          <a
            href="/contact"
            className="text-red-500 hover:text-red-400 font-semibold text-sm"
          >
            Contact Us
          </a>
        </div>
      </div>
    </div>
    </>
  );
}
