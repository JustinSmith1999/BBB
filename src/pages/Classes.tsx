import { useState, useEffect } from 'react';
import { MapPin, Calendar } from 'lucide-react';
import { supabase, Location } from '../lib/supabase';
import { Link } from 'react-router-dom';
import SEOHead from '../components/SEOHead';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'healcode-widget': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & {
        'data-type'?: string;
        'data-widget-partner'?: string;
        'data-widget-id'?: string;
        'data-widget-version'?: string;
      }, HTMLElement>;
    }
  }
}

export default function Classes() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [mindbodyScriptLoaded, setMindbodyScriptLoaded] = useState(false);
  const [widgetKey, setWidgetKey] = useState(0);

  useEffect(() => {
    fetchLocations();
  }, []);

  useEffect(() => {
    if (!selectedLocation) return;

    const location = locations.find(loc => loc.id === selectedLocation);
    if (!location) return;

    const hasHealcodeWidget = ['Williamsburg', 'Fresh Meadows', 'Bayside', 'Astoria'].includes(location.name);

    if (!hasHealcodeWidget) {
      setMindbodyScriptLoaded(true);
      return;
    }

    const scriptSrc = 'https://widgets.mindbodyonline.com/javascripts/healcode.js';

    const existingScript = document.querySelector(`script[src="${scriptSrc}"]`);

    if (existingScript) {
      setMindbodyScriptLoaded(false);
      setTimeout(() => {
        setWidgetKey(prev => prev + 1);
        setMindbodyScriptLoaded(true);
      }, 100);
      return;
    }

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = scriptSrc;
    script.async = true;

    script.onload = () => {
      setTimeout(() => {
        setWidgetKey(prev => prev + 1);
        setMindbodyScriptLoaded(true);
      }, 1000);
    };

    script.onerror = () => {
      setMindbodyScriptLoaded(true);
    };

    document.head.appendChild(script);

    return () => {
      const scriptToRemove = document.querySelector(`script[src="${scriptSrc}"]`);
      if (scriptToRemove && document.head.contains(scriptToRemove)) {
        document.head.removeChild(scriptToRemove);
      }
    };
  }, [selectedLocation, locations]);

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

    const widgetHtml = `<healcode-widget data-type="schedules" data-widget-partner="object" data-widget-id="${config.id}" data-widget-version="1"></healcode-widget>`;
    return <div dangerouslySetInnerHTML={{ __html: widgetHtml }} />;
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

                {mindbodyScriptLoaded ? (
                  <div key={widgetKey} className="mt-6">
                    {renderWidget(selectedLocationData.name)}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-red-600 mb-4"></div>
                    <p className="text-gray-600">Loading class schedule...</p>
                  </div>
                )}
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
