import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowRight, Shield, Zap, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Location {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  image_url?: string;
}

export default function LocationTrialSignup() {
  const { location: locationParam } = useParams<{ location: string }>();
  const navigate = useNavigate();
  const [location, setLocation] = useState<Location | null>(null);
  const [loading, setLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: 'US',
    zipCode: '',
    termsAccepted: false,
    newsletter: false
  });

  useEffect(() => {
    window.scrollTo(0, 0);
    const fetchLocation = async () => {
      if (!locationParam) {
        navigate('/locations');
        return;
      }

      const normalizedParam = locationParam.toLowerCase().replace(/-/g, ' ');

      const { data, error } = await supabase
        .from('locations')
        .select('*')
        .eq('is_active', true);

      if (error || !data) {
        navigate('/locations');
        return;
      }

      const foundLocation = data.find(loc =>
        loc.name.toLowerCase() === normalizedParam ||
        loc.city.toLowerCase() === normalizedParam
      );

      if (foundLocation) {
        setLocation(foundLocation);
      } else {
        navigate('/locations');
      }

      setLoading(false);
    };

    fetchLocation();
  }, [locationParam, navigate]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsProcessing(true);

    try {
      const functionUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-trial-checkout`;

      const response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          locationId: location?.id,
          locationName: location?.name,
          customerEmail: formData.email,
          customerName: formData.fullName,
          customerPhone: formData.phone,
          address: formData.address,
          city: formData.city,
          zipCode: formData.zipCode,
          country: formData.country,
          newsletter: formData.newsletter,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create checkout session');
      }

      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No checkout URL received');
      }
    } catch (err) {
      console.error('Payment error:', err);
      setError(err instanceof Error ? err.message : 'Failed to process payment. Please try again.');
      setIsProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-black via-gray-900 to-black flex items-center justify-center">
        <p className="text-xl text-white">Loading...</p>
      </div>
    );
  }

  if (!location) {
    return null;
  }

  return (
    <div className="min-h-screen bg-black">
      <div className="relative text-white pt-32 pb-24 md:pt-40 md:pb-32 overflow-hidden border-b-4 border-red-600 min-h-[60vh] md:min-h-[70vh] flex items-center">
        {location.image_url && (
          <div className="absolute inset-0">
            <img
              src={location.image_url}
              alt={location.name}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/60 to-black"></div>
          </div>
        )}

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
          <span className="inline-block px-3 py-1 bg-red-600 rounded-full text-xs font-bold tracking-wider uppercase mb-3">
            {location.name}
          </span>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-display font-black mb-3 leading-tight">
            2 Weeks. <span className="text-red-500">$49.</span> Unlimited Classes.
          </h1>
          <p className="text-lg md:text-xl text-gray-300 max-w-2xl mx-auto">
            Real training. Real results. No cookie-cutter workouts.
          </p>
        </div>
      </div>

      <section className="py-12 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-8">
            <div className="space-y-6 order-2 lg:order-1">
              <div className="bg-gradient-to-br from-yellow-600/20 to-yellow-700/20 border border-yellow-500/50 rounded-xl p-4">
                <p className="text-sm font-bold text-yellow-300">
                  ⚡ Limited spots available. Act now to secure your trial!
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex gap-4 items-start">
                  <div className="flex-shrink-0 w-10 h-10 bg-red-600/20 border border-red-600 rounded-lg flex items-center justify-center">
                    <Zap className="w-5 h-5 text-red-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black mb-1">Real Training</h3>
                    <p className="text-gray-400 text-sm">
                      Not generic routines. True strength and cardio training designed by top coaches.
                    </p>
                  </div>
                </div>

                <div className="flex gap-4 items-start">
                  <div className="flex-shrink-0 w-10 h-10 bg-red-600/20 border border-red-600 rounded-lg flex items-center justify-center">
                    <Users className="w-5 h-5 text-red-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black mb-1">Strong Community</h3>
                    <p className="text-gray-400 text-sm">
                      Great music, incredible atmosphere, and people serious about results.
                    </p>
                  </div>
                </div>

                <div className="flex gap-4 items-start">
                  <div className="flex-shrink-0 w-10 h-10 bg-red-600/20 border border-red-600 rounded-lg flex items-center justify-center">
                    <Shield className="w-5 h-5 text-red-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-black mb-1">Engaged Trainers</h3>
                    <p className="text-gray-400 text-sm">
                      Dynamic workouts from trainers who care about your progress.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-gray-900/50 to-black/50 border border-white/10 rounded-xl p-5">
                <h3 className="font-black text-xl mb-3">What's Included</h3>
                <ul className="space-y-2 text-sm text-gray-300">
                  <li className="flex items-center gap-2">
                    <span className="text-red-500">✓</span> 2 weeks unlimited access
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-red-500">✓</span> All bootcamp classes
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-red-500">✓</span> Expert coaching
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-red-500">✓</span> Community support
                  </li>
                </ul>
              </div>

              <div className="bg-black/50 border border-white/10 rounded-xl p-5">
                <h3 className="font-black text-lg mb-2">Location Details</h3>
                <p className="text-gray-400 text-sm mb-1">{location.address}</p>
                <p className="text-gray-400 text-sm mb-3">{location.city}, {location.state} {location.zip}</p>
                <a href={`tel:${location.phone}`} className="text-red-500 hover:text-red-400 font-semibold text-sm">
                  {location.phone}
                </a>
              </div>
            </div>

            <div className="lg:sticky lg:top-24 lg:h-fit order-1 lg:order-2">
              <form onSubmit={handleSubmit} className="bg-gradient-to-br from-gray-900 to-black rounded-2xl shadow-2xl p-6 border-2 border-white/10">
                <div className="bg-red-600/10 border border-red-600 rounded-xl p-4 mb-6 text-center">
                  <div className="text-3xl font-display font-black text-white mb-1">$49</div>
                  <div className="text-xs text-gray-400 uppercase">2-Week Trial</div>
                </div>

                <div className="space-y-3 mb-6">
                  <input
                    type="text"
                    name="fullName"
                    value={formData.fullName}
                    onChange={handleChange}
                    placeholder="Full Name"
                    required
                    className="w-full px-4 py-2.5 bg-black/50 border border-white/10 rounded-lg text-white text-sm placeholder-gray-500 focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  />
                  <input
                    type="email"
                    name="email"
                    value={formData.email}
                    onChange={handleChange}
                    placeholder="Email"
                    required
                    className="w-full px-4 py-2.5 bg-black/50 border border-white/10 rounded-lg text-white text-sm placeholder-gray-500 focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  />
                  <input
                    type="tel"
                    name="phone"
                    value={formData.phone}
                    onChange={handleChange}
                    placeholder="Phone"
                    required
                    className="w-full px-4 py-2.5 bg-black/50 border border-white/10 rounded-lg text-white text-sm placeholder-gray-500 focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  />
                  <input
                    type="text"
                    name="address"
                    value={formData.address}
                    onChange={handleChange}
                    placeholder="Address"
                    required
                    className="w-full px-4 py-2.5 bg-black/50 border border-white/10 rounded-lg text-white text-sm placeholder-gray-500 focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      name="city"
                      value={formData.city}
                      onChange={handleChange}
                      placeholder="City"
                      required
                      className="w-full px-4 py-2.5 bg-black/50 border border-white/10 rounded-lg text-white text-sm placeholder-gray-500 focus:ring-2 focus:ring-red-500 focus:border-red-500"
                    />
                    <input
                      type="text"
                      name="zipCode"
                      value={formData.zipCode}
                      onChange={handleChange}
                      placeholder="Zip"
                      required
                      className="w-full px-4 py-2.5 bg-black/50 border border-white/10 rounded-lg text-white text-sm placeholder-gray-500 focus:ring-2 focus:ring-red-500 focus:border-red-500"
                    />
                  </div>
                  <select
                    name="country"
                    value={formData.country}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-2.5 bg-black/50 border border-white/10 rounded-lg text-white text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
                  >
                    <option value="US">United States</option>
                    <option value="CA">Canada</option>
                  </select>
                </div>

                <div className="bg-black/30 border border-white/10 rounded-lg p-4 mb-6">
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <rect x="2" y="5" width="20" height="14" rx="2" strokeWidth="2"/>
                      <path d="M2 10h20" strokeWidth="2"/>
                    </svg>
                    <span className="text-sm font-bold text-white">Secure Payment</span>
                  </div>
                  <p className="text-xs text-gray-400 text-center">Payment processed securely via Stripe</p>
                </div>

                <div className="space-y-3 mb-6">
                  <label className="flex items-start gap-2 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      name="termsAccepted"
                      checked={formData.termsAccepted}
                      onChange={handleChange}
                      required
                      className="mt-0.5 w-4 h-4 text-red-600 bg-black border-white/20 rounded focus:ring-red-500"
                    />
                    <span className="text-gray-400">
                      I agree to the terms. Trial expires 2 weeks from purchase.
                    </span>
                  </label>

                  <label className="flex items-start gap-2 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      name="newsletter"
                      checked={formData.newsletter}
                      onChange={handleChange}
                      className="mt-0.5 w-4 h-4 text-red-600 bg-black border-white/20 rounded focus:ring-red-500"
                    />
                    <span className="text-gray-400">
                      Send me updates and class schedules
                    </span>
                  </label>
                </div>

                {error && (
                  <div className="bg-red-500/20 border border-red-500 rounded-lg p-3">
                    <p className="text-red-200 text-sm font-medium">{error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isProcessing}
                  className="w-full group relative bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-6 py-3.5 rounded-lg font-display font-black transition-all transform hover:scale-[1.02] shadow-lg hover:shadow-red-600/50 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
                >
                  <span className="uppercase tracking-wider text-sm">
                    {isProcessing ? 'Processing...' : 'Claim Your Trial - $49'}
                  </span>
                  {!isProcessing && <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />}
                </button>

                <p className="text-center text-xs text-gray-500 mt-4">
                  Questions? <a href={`tel:${location.phone}`} className="text-red-500 hover:text-red-400">Call us</a>
                </p>
              </form>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
