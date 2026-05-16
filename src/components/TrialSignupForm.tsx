import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface TrialSignupFormProps {
  locationId: string;
  locationName: string;
}

export default function TrialSignupForm({ locationId, locationName }: TrialSignupFormProps) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: 'United States',
    zip: '',
    agreeTerms: false,
    agreeNewsletter: false
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!formData.agreeTerms) {
      setError('Please agree to the terms of service');
      return;
    }

    setIsSubmitting(true);

    try {
      const { error: dbError } = await supabase
        .from('trial_signups')
        .insert([
          {
            name: formData.name,
            email: formData.email,
            phone: formData.phone,
            location_id: locationId
          }
        ]);

      if (dbError) throw dbError;

      setShowSuccess(true);
      setFormData({
        name: '',
        email: '',
        phone: '',
        address: '',
        city: '',
        country: 'United States',
        zip: '',
        agreeTerms: false,
        agreeNewsletter: false
      });

      setTimeout(() => setShowSuccess(false), 5000);
    } catch (err) {
      console.error('Error submitting trial signup:', err);
      setError('Failed to submit signup. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;

    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  if (showSuccess) {
    return (
      <div className="bg-gradient-to-br from-green-50 to-white rounded-2xl md:rounded-3xl p-8 md:p-12 text-center shadow-2xl border-2 border-green-200">
        <div className="bg-green-100 w-20 h-20 md:w-24 md:h-24 rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 className="w-10 h-10 md:w-12 md:h-12 text-green-600" />
        </div>
        <h3 className="text-2xl md:text-3xl font-black text-black mb-4">Welcome to Better Body!</h3>
        <p className="text-gray-700 text-base md:text-lg mb-2">
          Your trial signup has been received.
        </p>
        <p className="text-gray-600 text-sm md:text-base">
          We'll contact you shortly at {locationName} to confirm your first class.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-gray-900 to-black rounded-2xl md:rounded-3xl p-6 md:p-10 lg:p-12 shadow-2xl">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-6 md:mb-10">
          <h2 className="text-[clamp(1.75rem,5vw,5rem)] font-black text-white mb-3 md:mb-4 tracking-tight">
            Two Weeks for $49
          </h2>
          <p className="text-white/80 text-sm sm:text-base md:text-lg mb-4 md:mb-6 leading-relaxed px-2">
            Tired of cookie-cutter workouts? Discover the difference with training that actually works
          </p>
          <div className="bg-red-600 text-white px-4 md:px-6 py-2 md:py-3 rounded-xl md:rounded-2xl inline-block font-bold text-sm md:text-base lg:text-lg shadow-lg">
            2-Week Trial • Unlimited Access • $49.00
          </div>
        </div>

        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl md:rounded-2xl p-4 md:p-6 lg:p-8 mb-6 md:mb-8">
          <p className="text-white/90 leading-relaxed text-sm md:text-base mb-3 md:mb-4">
            If you're over the repetitive, uninspired workouts from big-box studios, it's time for something better.
            At Better Body, we don't do generic routines like Orange Theory or F45. Our program is built on real
            strength and cardio training, designed by top coaches to deliver real, lasting results.
          </p>
          <p className="text-white/90 leading-relaxed text-sm md:text-base mb-3 md:mb-4">
            We keep it intense, effective, and never boring—with high-energy workouts, great music, and a community
            of driven people who are serious about progress. Our trainers are engaged, our workouts are dynamic, and
            our approach is everything the others aren't.
          </p>
          <p className="text-white font-bold text-base md:text-lg">
            Stop wasting time on ineffective programs. Get two weeks of Better Body training for just $49 and feel the difference.
          </p>
        </div>

        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl md:rounded-2xl p-4 md:p-6 mb-6 md:mb-8">
          <p className="text-yellow-200 text-xs md:text-sm font-bold text-center leading-relaxed">
            This is a limited-time free trial offer. Classes fill up fast, and once capacities are reached,
            this offer may be removed without prior notice. Take action now to secure your spot—don't wait!
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 md:space-y-6">
          <div>
            <label className="block text-white font-bold mb-2 text-xs md:text-sm tracking-wide">YOUR INFORMATION</label>
            <div className="space-y-3 md:space-y-4">
              <input
                type="text"
                name="name"
                value={formData.name}
                onChange={handleChange}
                placeholder="Full Name..."
                required
                className="w-full px-4 md:px-6 py-3 md:py-4 rounded-lg md:rounded-xl border-2 border-white/20 bg-white/5 text-white placeholder-white/40 focus:outline-none focus:border-red-500 focus:bg-white/10 transition-all text-sm md:text-base"
              />
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                placeholder="Email Address..."
                required
                className="w-full px-4 md:px-6 py-3 md:py-4 rounded-lg md:rounded-xl border-2 border-white/20 bg-white/5 text-white placeholder-white/40 focus:outline-none focus:border-red-500 focus:bg-white/10 transition-all text-sm md:text-base"
              />
              <input
                type="tel"
                name="phone"
                value={formData.phone}
                onChange={handleChange}
                placeholder="Phone Number..."
                required
                className="w-full px-4 md:px-6 py-3 md:py-4 rounded-lg md:rounded-xl border-2 border-white/20 bg-white/5 text-white placeholder-white/40 focus:outline-none focus:border-red-500 focus:bg-white/10 transition-all text-sm md:text-base"
              />
            </div>
          </div>

          <div>
            <label className="block text-white font-bold mb-2 text-xs md:text-sm tracking-wide">BILLING ADDRESS</label>
            <div className="space-y-3 md:space-y-4">
              <input
                type="text"
                name="address"
                value={formData.address}
                onChange={handleChange}
                placeholder="Full Address..."
                required
                className="w-full px-4 md:px-6 py-3 md:py-4 rounded-lg md:rounded-xl border-2 border-white/20 bg-white/5 text-white placeholder-white/40 focus:outline-none focus:border-red-500 focus:bg-white/10 transition-all text-sm md:text-base"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4">
                <input
                  type="text"
                  name="city"
                  value={formData.city}
                  onChange={handleChange}
                  placeholder="City Name..."
                  required
                  className="px-4 md:px-6 py-3 md:py-4 rounded-lg md:rounded-xl border-2 border-white/20 bg-white/5 text-white placeholder-white/40 focus:outline-none focus:border-red-500 focus:bg-white/10 transition-all text-sm md:text-base"
                />
                <input
                  type="text"
                  name="zip"
                  value={formData.zip}
                  onChange={handleChange}
                  placeholder="Zip Code..."
                  required
                  className="px-4 md:px-6 py-3 md:py-4 rounded-lg md:rounded-xl border-2 border-white/20 bg-white/5 text-white placeholder-white/40 focus:outline-none focus:border-red-500 focus:bg-white/10 transition-all text-sm md:text-base"
                />
              </div>
              <select
                name="country"
                value={formData.country}
                onChange={handleChange}
                className="w-full px-4 md:px-6 py-3 md:py-4 rounded-lg md:rounded-xl border-2 border-white/20 bg-white/5 text-white focus:outline-none focus:border-red-500 focus:bg-white/10 transition-all text-sm md:text-base"
              >
                <option value="United States" style={{ color: '#000000', backgroundColor: '#FFFFFF' }}>United States</option>
                <option value="Canada" style={{ color: '#000000', backgroundColor: '#FFFFFF' }}>Canada</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-white font-bold mb-2 text-xs md:text-sm tracking-wide">PAYMENT INFORMATION</label>
            <div className="bg-white/5 border-2 border-white/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <input
                type="text"
                placeholder="Enter Payment Details"
                className="w-full px-4 md:px-6 py-3 md:py-4 rounded-lg md:rounded-xl border-2 border-white/20 bg-white/10 text-white placeholder-white/40 focus:outline-none focus:border-red-500 transition-all text-sm md:text-base"
                disabled
              />
              <p className="text-white/50 text-xs mt-3 text-center">
                We Respect Your Privacy & Information.
              </p>
            </div>
          </div>

          <div className="space-y-3 md:space-y-4">
            <label className="flex items-start space-x-3 cursor-pointer group">
              <input
                type="checkbox"
                name="agreeTerms"
                checked={formData.agreeTerms}
                onChange={handleChange}
                className="mt-0.5 md:mt-1 w-5 h-5 flex-shrink-0 rounded border-2 border-white/30 bg-white/5 checked:bg-red-600 checked:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-gray-900 transition-all cursor-pointer"
              />
              <span className="text-white/80 text-xs md:text-sm leading-relaxed group-hover:text-white transition-colors">
                <span className="text-red-400">*</span> I agree to the Terms of Service. Our $49 for 2-Week Trial offer expires in 3 months from date of purchase.
              </span>
            </label>

            <label className="flex items-start space-x-3 cursor-pointer group">
              <input
                type="checkbox"
                name="agreeNewsletter"
                checked={formData.agreeNewsletter}
                onChange={handleChange}
                className="mt-0.5 md:mt-1 w-5 h-5 flex-shrink-0 rounded border-2 border-white/30 bg-white/5 checked:bg-red-600 checked:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-gray-900 transition-all cursor-pointer"
              />
              <span className="text-white/80 text-xs md:text-sm leading-relaxed group-hover:text-white transition-colors">
                Subscribe to our newsletter. By signing up you agree to receive important information like class schedules, closures, contests/giveaways, and other announcements. You are always free to unsubscribe.
              </span>
            </label>
          </div>

          {error && (
            <div className="bg-red-500/20 border border-red-500 rounded-xl p-3 md:p-4">
              <p className="text-red-200 text-xs md:text-sm font-medium">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-6 md:px-8 py-4 md:py-5 rounded-xl md:rounded-2xl text-base md:text-lg font-black tracking-wide transition-all transform hover:scale-[1.02] shadow-xl disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
          >
            {isSubmitting ? 'Processing...' : 'Start Real Training for $49'}
          </button>

          <p className="text-white/60 text-xs text-center leading-relaxed">
            We will not share or trade online information that you provide us (including e-mail addresses).
            View our full Privacy Policy for more information.
          </p>
        </form>
      </div>
    </div>
  );
}
