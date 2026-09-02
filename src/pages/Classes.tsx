import { useState, useEffect } from 'react';
import { MapPin } from 'lucide-react';
import { supabase, LOCATION_PUBLIC_COLUMNS, Location } from '../lib/supabase';
import { Link } from 'react-router-dom';
import SEOHead from '../components/SEOHead';
import PageHero, { Red } from '../components/PageHero';
import NativeClassList from '../components/NativeClassList';

// 2026-06-26 v2: Iframe gone. NativeClassList hits the mt-public-classes
// Supabase proxy and renders BBB-branded cards. Switches instantly when the
// user picks a different studio tab.

export default function Classes() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLocation, setSelectedLocation] = useState<string>('');

  useEffect(() => {
    fetchLocations();
  }, []);

  const fetchLocations = async () => {
    try {
      const { data } = await supabase
        .from('locations')
        .select(LOCATION_PUBLIC_COLUMNS)
        .eq('is_active', true)
        .order('display_order');

      if (data && data.length > 0) {
        setLocations(data);
        setSelectedLocation(data[0].id);
      }
    } catch (error) {
      console.error('Error fetching locations:', error);
    } finally {
      setLoading(false);
    }
  };

  // 2026-06-26 v2: Native MT booking. Each studio name → its MT location ID
  // inside the betterbodybootcamp tenant. NativeClassList pulls real-time
  // availability via the mt-public-classes Supabase proxy.
  const MT_LOCATION_IDS: Record<string, number> = {
    Astoria: 48717,
    Bayside: 48718,
    'Fresh Meadows': 48719,
    Williamsburg: 48720,
  };

  const renderSchedule = (locationName: string) => {
    const mtLocationId = MT_LOCATION_IDS[locationName];
    const slug = locationName.toLowerCase().replace(' ', '-');
    if (!mtLocationId) {
      return (
        <div className="text-center py-12">
          <p className="text-gray-600 mb-4">Class schedule coming soon for this location.</p>
          <Link
            to={`/locations/${slug}`}
            className="inline-block bg-red-600 hover:bg-red-700 text-white px-8 py-3 rounded-full font-bold transition-all"
          >
            View Location Details
          </Link>
        </div>
      );
    }
    return (
      <NativeClassList
        key={`mt-${mtLocationId}`}
        mtLocationId={mtLocationId}
        studioName={locationName}
        studioSlug={slug}
        days={7}
        trialHref={`/trial/${slug}`}
      />
    );
  };

  const selectedLocationData = locations.find(loc => loc.id === selectedLocation);

  return (
    <>
    <SEOHead
      title="Group Fitness Classes & Schedule | Better Body Bootcamp NYC"
      description="Group fitness classes in Queens & Brooklyn. Browse the live schedule and book at Better Body Bootcamp. View the weekly schedule for our Astoria, Bayside, Fresh Meadows, and Williamsburg NYC locations."
      canonical="/classes"
    />
    <div className="min-h-screen bg-white">
      <PageHero
        eyebrow="GROUP FITNESS · LIVE SCHEDULE"
        lines={["CLASS", <Red key="r">SCHEDULE</Red>]}
        sub="Browse and book group fitness classes at any of our four studios. Times update live."
      />

      <div className="container mx-auto px-4 py-16">
        {loading ? (
          <div className="text-center py-12">
            <p className="text-xl text-gray-600">Loading locations...</p>
          </div>
        ) : (
          <>
            <div className="mb-8">
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Select Location
              </label>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {locations.map((location) => (
                  <button
                    key={location.id}
                    onClick={() => setSelectedLocation(location.id)}
                    className={`p-4 rounded-xl border-2 transition-all text-left ${
                      selectedLocation === location.id
                        ? 'border-red-600 bg-red-50'
                        : 'border-gray-200 hover:border-red-300 bg-white'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <MapPin className={`w-5 h-5 ${selectedLocation === location.id ? 'text-red-600' : 'text-gray-400'}`} />
                      <div>
                        <h3 className={`font-bold ${selectedLocation === location.id ? 'text-red-600' : 'text-black'}`}>
                          {location.name}
                        </h3>
                        <p className="text-xs text-gray-500">{location.address}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {selectedLocationData && (
              <div className="bg-white rounded-xl shadow-lg p-6">
                {/* 2026-08-31: centered on mobile (owner request), row on sm+ */}
                <div className="flex flex-col items-center text-center gap-3 sm:flex-row sm:items-center sm:justify-between sm:text-left sm:gap-0 mb-6">
                  <div>
                    <h2 className="text-2xl font-bold text-black mb-2">{selectedLocationData.name} Classes</h2>
                    <div className="flex items-center justify-center sm:justify-start space-x-2 text-gray-600">
                      <MapPin className="w-4 h-4" />
                      <span>{selectedLocationData.address}</span>
                    </div>
                  </div>
                  <Link
                    to={`/locations/${selectedLocationData.name.toLowerCase().replace(' ', '-')}`}
                    className="text-red-600 hover:text-red-700 font-bold text-sm transition-colors"
                  >
                    View Location Details →
                  </Link>
                </div>

                <div className="mt-6">
                  {renderSchedule(selectedLocationData.name)}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* SEO content block (2026-08-23): the schedule grid alone left this page
          thin in the served HTML. Real program facts, brand voice. */}
      <div className="bg-white py-16 border-t border-gray-100">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-3xl font-bold text-black mb-6">What a Class Here Actually Looks Like</h2>
            <div className="space-y-4 text-gray-700 leading-relaxed">
              <p>
                Every session at Better Body Bootcamp is coach-led from the first minute to the last. You walk in,
                the board tells you nothing you need to figure out alone, and a coach runs the whole room through
                the day's program: a warmup, strength or conditioning blocks, and a finisher. Classes stay small
                enough that the coach sees every rep and fixes form on the spot instead of letting bad habits settle in.
              </p>
              <p>
                The weekly schedule mixes HIIT training, strength training, bootcamp classes, Pilates, and hybrid
                training sessions, so training three or four days a week never means repeating the same
                workout. Early birds catch 5 and 6 AM classes; the evening rush runs past 7 PM. Book through the
                Better Body Studios app or right on this page, and cancel up to 2 hours before class without penalty.
              </p>
              <p>
                All four studios run the same programming: <Link to="/locations/astoria" className="text-red-600 font-semibold hover:underline">Astoria</Link> on
                Steinway Street, <Link to="/locations/bayside" className="text-red-600 font-semibold hover:underline">Bayside</Link> on
                Bell Blvd, <Link to="/locations/fresh-meadows" className="text-red-600 font-semibold hover:underline">Fresh Meadows</Link> on
                164th Street, and <Link to="/locations/williamsburg" className="text-red-600 font-semibold hover:underline">Williamsburg</Link> on
                Driggs Ave. One membership works at all of them, so a Tuesday in Queens and a Thursday in Brooklyn
                is a normal week. New here? The <Link to="/trial" className="text-red-600 font-semibold hover:underline">$49 two-week trial</Link> is
                unlimited classes at your home studio with no auto-renewal.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gray-50 py-16">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-[clamp(1.75rem,4vw,4rem)] font-bold mb-6 text-black">
            Ready to Start Your Journey?
          </h2>
          <p className="text-xl text-gray-700 mb-8 max-w-2xl mx-auto">
            Join thousands of members who have transformed their lives at Better Body Bootcamp
          </p>
          <a
            href="/trial"
            className="inline-block bg-red-600 hover:bg-red-700 text-white px-10 py-4 rounded-full text-lg font-bold transition-all transform hover:scale-105 shadow-lg"
          >
            Start Your Trial
          </a>
        </div>
      </div>
    </div>
    </>
  );
}
