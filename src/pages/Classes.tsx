import { useState, useEffect } from 'react';
import { MapPin } from 'lucide-react';
import { supabase, Location } from '../lib/supabase';
import { Link } from 'react-router-dom';
import SEOHead from '../components/SEOHead';

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
        .select('*')
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

  const getWidgetConfig = (locationName: string) => {
    const configs: { [key: string]: { type: string; id: string } } = {
      'Williamsburg': { type: 'healcode', id: '7d20557070b3' },
      'Fresh Meadows': { type: 'healcode', id: '7d20556770b3' },
      'Bayside': { type: 'healcode', id: '7d20556570b3' },
      'Astoria': { type: 'healcode', id: '7d20556270b3' }
    };
    return configs[locationName];
  };

  const renderWidget = (locationName: string) => {
    const config = getWidgetConfig(locationName);
    if (!config) {
      return (
        <div className="text-center py-12">
          <p className="text-gray-600 mb-4">Class schedule coming soon for this location.</p>
          <Link
            to={`/locations/${locationName.toLowerCase().replace(' ', '-')}`}
            className="inline-block bg-red-600 hover:bg-red-700 text-white px-8 py-3 rounded-full font-bold transition-all"
          >
            View Location Details
          </Link>
        </div>
      );
    }

    // Self-contained iframe — healcode.js loads fresh in the iframe document
    // every visit, immune to SPA navigation / re-render races.
    const srcDoc =
      `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">` +
      `<style>html,body{margin:0;padding:0;background:#fff;` +
      `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}</style>` +
      `</head><body>` +
      `<healcode-widget data-type="schedules" data-widget-partner="object" ` +
      `data-widget-id="${config.id}" data-widget-version="1"></healcode-widget>` +
      `<script src="https://widgets.mindbodyonline.com/javascripts/healcode.js" type="text/javascript"><\/script>` +
      `</body></html>`;
    return (
      <iframe
        key={config.id}
        title={`${locationName} class schedule`}
        srcDoc={srcDoc}
        loading="lazy"
        className="w-full rounded-xl border border-gray-100 bg-white"
        style={{ height: '1400px', minHeight: '600px' }}
      />
    );
  };

  const selectedLocationData = locations.find(loc => loc.id === selectedLocation);

  return (
    <>
    <SEOHead
      title="Class Schedule | Better Body Bootcamp"
      description="Browse and book group fitness classes at Better Body Bootcamp. View the weekly schedule for our Astoria, Bayside, Fresh Meadows, and Williamsburg NYC locations."
      canonical="/classes"
    />
    <div className="min-h-screen bg-white">
      <div className="bg-gradient-to-br from-black to-gray-900 text-white pt-24 pb-20">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-[clamp(2.5rem,7vw,6rem)] font-bold mb-6">
            Class <span className="text-red-600">Schedule</span>
          </h1>
          <p className="text-xl md:text-2xl text-gray-300 max-w-3xl mx-auto">
            Browse and book your fitness classes at any location
          </p>
        </div>
      </div>

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
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-2xl font-bold text-black mb-2">{selectedLocationData.name} Classes</h2>
                    <div className="flex items-center space-x-2 text-gray-600">
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
                  {renderWidget(selectedLocationData.name)}
                </div>
              </div>
            )}
          </>
        )}
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
            href="/#trial"
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
