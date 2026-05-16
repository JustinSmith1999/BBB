import { useState, useEffect } from 'react';
import { ArrowRight, CheckCircle, Clock, Users, Zap } from 'lucide-react';
import { supabase } from '../lib/supabase';
import SEOHead from '../components/SEOHead';

interface Location {
  id: string;
  name: string;
  neighborhood: string;
}

export default function TrialSignup() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: '',
    zipCode: '',
    preferredLocation: '',
    termsAccepted: false,
    newsletter: false
  });

  useEffect(() => {
    const fetchLocations = async () => {
      const { data } = await supabase
        .from('locations')
        .select('id, name, neighborhood')
        .order('name');
      if (data) setLocations(data);
    };
    fetchLocations();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  return (
    <>
    <SEOHead
      title="2 Weeks for $49 Trial | Better Body Bootcamp"
      description="Start your fitness journey with Better Body Bootcamp's 2-week trial for just $49. Unlimited classes, expert trainers, and a supportive community at NYC locations."
      canonical="/trial"
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-red-800 text-white pt-24 pb-16 sm:pt-32 sm:pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-black/10"></div>
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-10 w-72 h-72 bg-white rounded-full blur-3xl"></div>
          <div className="absolute bottom-10 right-10 w-96 h-96 bg-white rounded-full blur-3xl"></div>
        </div>

        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
          <h1 className="text-[clamp(2.5rem,10vw,5.5rem)] font-black mb-6 leading-tight">
            TWO WEEKS FOR $49
          </h1>
          <p className="text-lg sm:text-xl md:text-2xl font-medium leading-relaxed max-w-3xl mx-auto mb-8">
            Tired of cookie-cutter workouts? Discover the difference with training that actually works
          </p>

          <div className="flex flex-wrap justify-center gap-4 sm:gap-8 mt-10">
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Clock className="w-5 h-5" />
              <span className="font-semibold">14 Days Unlimited</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Users className="w-5 h-5" />
              <span className="font-semibold">Expert Trainers</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/20">
              <Zap className="w-5 h-5" />
              <span className="font-semibold">High-Energy Workouts</span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 -mt-8 relative z-20">
        <div className="bg-white rounded-3xl shadow-2xl p-6 sm:p-10 lg:p-12 mb-12">
          <div className="grid md:grid-cols-2 gap-8 mb-10">
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold mb-6 text-gray-900">Why Better Body?</h2>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-gray-900 mb-1">Real Strength Training</h3>
                    <p className="text-gray-600">No gimmicks. Just proven methods that deliver lasting results.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-gray-900 mb-1">Dynamic Workouts</h3>
                    <p className="text-gray-600">Never boring, always challenging. Every session is designed to push you further.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-gray-900 mb-1">Engaged Trainers</h3>
                    <p className="text-gray-600">Coaches who care about your progress and keep you motivated.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <CheckCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-gray-900 mb-1">Community Driven</h3>
                    <p className="text-gray-600">Train alongside people who are serious about their fitness goals.</p>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="bg-gradient-to-br from-red-50 to-red-100 rounded-2xl p-6 mb-6 border-2 border-red-200">
                <h3 className="text-xl font-bold mb-3 text-gray-900">Your 2-Week Trial Includes:</h3>
                <ul className="space-y-2 text-gray-700">
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
                    Unlimited access to all classes
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
                    Complete fitness assessment
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
                    Personalized goal setting session
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-red-600 rounded-full"></div>
                    Access to all locations
                  </li>
                </ul>
                <div className="mt-6 pt-6 border-t-2 border-red-200 flex justify-between items-center">
                  <span className="text-lg font-bold text-gray-900">TOTAL</span>
                  <span className="text-4xl font-black text-red-600">$49</span>
                </div>
              </div>

              <div className="bg-yellow-50 border-2 border-yellow-300 rounded-xl p-4">
                <p className="text-sm font-semibold text-yellow-900 flex items-start gap-2">
                  <span className="text-xl">⚠️</span>
                  <span>Classes fill up fast! This limited-time offer may be removed without notice. Secure your spot now.</span>
                </p>
              </div>
            </div>
          </div>

          <div className="border-t-2 border-gray-100 pt-10 mt-10">
            <h2 className="text-2xl sm:text-3xl font-bold mb-8 text-center text-gray-900">Complete Your Registration</h2>

            <form onSubmit={handleSubmit} className="space-y-8">
              <div>
                <h3 className="text-lg font-bold mb-4 text-gray-900 flex items-center gap-2">
                  <div className="w-8 h-8 bg-red-600 text-white rounded-full flex items-center justify-center text-sm font-bold">1</div>
                  Your Information
                </h3>
                <div className="space-y-5">
                  <input
                    type="text"
                    name="fullName"
                    value={formData.fullName}
                    onChange={handleChange}
                    placeholder="Full Name"
                    required
                    className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                  />
                  <input
                    type="email"
                    name="email"
                    value={formData.email}
                    onChange={handleChange}
                    placeholder="Email Address"
                    required
                    className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                  />
                  <input
                    type="tel"
                    name="phone"
                    value={formData.phone}
                    onChange={handleChange}
                    placeholder="Phone Number"
                    required
                    className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                  />
                  <select
                    name="preferredLocation"
                    value={formData.preferredLocation}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                    style={{ color: '#000000', backgroundColor: '#FFFFFF' }}
                  >
                    <option value="" style={{ color: '#6B7280', backgroundColor: '#FFFFFF' }}>Select Preferred Location</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id} style={{ color: '#000000', backgroundColor: '#FFFFFF' }}>
                        {location.name} - {location.neighborhood}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-bold mb-4 text-gray-900 flex items-center gap-2">
                  <div className="w-8 h-8 bg-red-600 text-white rounded-full flex items-center justify-center text-sm font-bold">2</div>
                  Billing Address
                </h3>
                <div className="space-y-4">
                  <input
                    type="text"
                    name="address"
                    value={formData.address}
                    onChange={handleChange}
                    placeholder="Street Address"
                    required
                    className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                  />
                  <div className="grid sm:grid-cols-3 gap-4">
                    <input
                      type="text"
                      name="city"
                      value={formData.city}
                      onChange={handleChange}
                      placeholder="City"
                      required
                      className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                    />
                    <select
                      name="country"
                      value={formData.country}
                      onChange={handleChange}
                      required
                      className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                      style={{ color: '#000000', backgroundColor: '#FFFFFF' }}
                    >
                      <option value="" style={{ color: '#000000', backgroundColor: '#FFFFFF' }}>Country</option>
                      <option value="US" style={{ color: '#000000', backgroundColor: '#FFFFFF' }}>United States</option>
                      <option value="CA" style={{ color: '#000000', backgroundColor: '#FFFFFF' }}>Canada</option>
                    </select>
                    <input
                      type="text"
                      name="zipCode"
                      value={formData.zipCode}
                      onChange={handleChange}
                      placeholder="Zip Code"
                      required
                      className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all"
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-bold mb-4 text-gray-900 flex items-center gap-2">
                  <div className="w-8 h-8 bg-red-600 text-white rounded-full flex items-center justify-center text-sm font-bold">3</div>
                  Payment Information
                </h3>
                <div className="bg-gradient-to-br from-gray-50 to-gray-100 border-2 border-gray-200 rounded-xl p-8 text-center">
                  <div className="inline-flex items-center justify-center w-16 h-16 bg-white rounded-full mb-4 shadow-md">
                    <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <rect x="2" y="5" width="20" height="14" rx="2" strokeWidth="2"/>
                      <path d="M2 10h20" strokeWidth="2"/>
                    </svg>
                  </div>
                  <p className="text-gray-600 font-medium mb-2">Secure Payment Processing</p>
                  <p className="text-sm text-gray-500">Payment details will be collected on the next step</p>
                </div>
                <div className="flex items-center justify-center gap-2 mt-4 text-sm text-gray-500">
                  <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                  </svg>
                  <span>Secured with 256-bit SSL encryption</span>
                </div>
              </div>

              <div className="space-y-4 bg-gray-50 rounded-2xl p-6 border-2 border-gray-200">
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    name="termsAccepted"
                    checked={formData.termsAccepted}
                    onChange={handleChange}
                    required
                    className="mt-0.5 w-5 h-5 text-red-600 border-gray-300 rounded focus:ring-red-500 cursor-pointer"
                  />
                  <span className="text-sm text-gray-700 leading-relaxed">
                    <strong className="text-gray-900">Terms of Service*</strong> - Our $49 for 2-Week Trial offer expires in 3 months from date of purchase.
                  </span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    name="newsletter"
                    checked={formData.newsletter}
                    onChange={handleChange}
                    className="mt-0.5 w-5 h-5 text-red-600 border-gray-300 rounded focus:ring-red-500 cursor-pointer"
                  />
                  <span className="text-sm text-gray-700 leading-relaxed">
                    <strong className="text-gray-900">Newsletter</strong> - Stay updated with class schedules, closures, contests, and announcements.
                  </span>
                </label>

                <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-4 mt-4">
                  <div className="flex items-start gap-2">
                    <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
                    </svg>
                    <p className="text-sm text-blue-900 leading-relaxed">
                      <strong>Privacy Guarantee:</strong> We will never share or sell your information. Your data is secure with us.
                    </p>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                className="w-full group bg-gradient-to-r from-red-600 via-red-700 to-red-800 hover:from-red-700 hover:via-red-800 hover:to-red-900 text-white px-8 py-6 rounded-2xl text-lg sm:text-xl font-bold transition-all transform hover:scale-[1.02] shadow-xl hover:shadow-2xl flex items-center justify-center gap-3 mt-6"
              >
                <span>Start Real Training for $49</span>
                <ArrowRight className="w-6 h-6 group-hover:translate-x-1 transition-transform" />
              </button>

              <p className="text-center text-sm text-gray-500 mt-4">
                Questions? <a href="/contact" className="text-red-600 hover:text-red-700 font-semibold">Contact us</a> anytime.
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
