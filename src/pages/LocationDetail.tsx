import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MapPin, Phone, Calendar, ArrowLeft, Clock, Dumbbell, Users, Award, X } from 'lucide-react';
import { supabase, Location } from '../lib/supabase';
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
  interface Window {
    hcInit?: () => void;
  }
}

interface ClassSchedule {
  id: string;
  name: string;
  time: string;
  instructor: string;
  difficulty: string;
  spotsLeft: number;
}

export default function LocationDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [location, setLocation] = useState<Location | null>(null);
  const [loading, setLoading] = useState(true);
  const [classes, setClasses] = useState<ClassSchedule[]>([]);
  const [mindbodyScriptLoaded, setMindbodyScriptLoaded] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [widgetKey, setWidgetKey] = useState(0);

  const LOCATION_SEO: Record<string, { title: string; description: string; address: string; city: string; state: string; zip: string; phone: string }> = {
    'Astoria': {
      title: 'Astoria Bootcamp & Group Fitness | Better Body Bootcamp',
      description: 'High-intensity bootcamp classes in Astoria, Queens at 31-18 Steinway Street. Start your 2-week trial for $49. All fitness levels welcome.',
      address: '31-18 Steinway Street', city: 'Astoria', state: 'NY', zip: '11103', phone: '+1-718-704-9954',
    },
    'Bayside': {
      title: 'Bayside Bootcamp & Group Fitness | Better Body Bootcamp',
      description: "Bayside's top-rated bootcamp at 3447 Bell Blvd. Expert trainers, high-energy classes, and real results. Start your 2-week trial for $49.",
      address: '3447 Bell Blvd', city: 'Bayside', state: 'NY', zip: '11361', phone: '+1-646-566-8870',
    },
    'Fresh Meadows': {
      title: 'Fresh Meadows Bootcamp & Group Fitness | Better Body Bootcamp',
      description: 'Group training in Fresh Meadows at 76-46 164th Street. Transform your body with high-energy bootcamp classes. Start your 2-week trial for $49.',
      address: '76-46 164th Street', city: 'Fresh Meadows', state: 'NY', zip: '11366', phone: '+1-646-566-8207',
    },
    'Williamsburg': {
      title: 'Williamsburg Bootcamp & Group Fitness | Better Body Bootcamp',
      description: "Brooklyn's Williamsburg bootcamp at 487 Driggs Ave. Science-backed group training that gets real results. Start your 2-week trial for $49.",
      address: '487 Driggs Ave', city: 'Brooklyn', state: 'NY', zip: '11211', phone: '+1-718-683-1864',
    },
  };

  const seoData = location ? LOCATION_SEO[location.name] : null;
  const locationSlug = location ? location.name.toLowerCase().replace(/\s+/g, '-') : slug || '';
  const locationSchema = seoData ? {
    '@context': 'https://schema.org',
    '@type': 'HealthClub',
    '@id': `https://betterbodybootcamp.com/locations/${locationSlug}`,
    name: `Better Body Bootcamp ${location!.name}`,
    description: seoData.description,
    url: `https://betterbodybootcamp.com/locations/${locationSlug}`,
    telephone: seoData.phone,
    priceRange: '$$',
    openingHours: 'Mo-Su 06:00-21:00',
    address: {
      '@type': 'PostalAddress',
      streetAddress: seoData.address,
      addressLocality: seoData.city,
      addressRegion: seoData.state,
      postalCode: seoData.zip,
      addressCountry: 'US',
    },
    parentOrganization: {
      '@type': 'Organization',
      name: 'Better Body Bootcamp',
      url: 'https://betterbodybootcamp.com',
    },
  } : undefined;

  useEffect(() => {
    window.scrollTo(0, 0);
    if (slug) {
      fetchLocation();
      generateClasses();
    }
  }, [slug]);

  useEffect(() => {
    if (!location) return;

    const hasHealcodeWidget = ['Williamsburg', 'Fresh Meadows', 'Bayside', 'Astoria'].includes(location.name);

    if (!hasHealcodeWidget) {
      setMindbodyScriptLoaded(true);
      return;
    }

    const scriptSrc = 'https://widgets.mindbodyonline.com/javascripts/healcode.js';

    const existingScript = document.querySelector(`script[src="${scriptSrc}"]`);

    if (existingScript) {
      console.log('Script already exists, reinitializing widgets');
      setMindbodyScriptLoaded(false);
      setTimeout(() => {
        setWidgetKey(prev => prev + 1);
        setMindbodyScriptLoaded(true);
        setTimeout(() => {
          if (window.hcInit) {
            console.log('Calling hcInit to refresh widgets');
            window.hcInit();
          }
        }, 300);
      }, 100);
      return;
    }

    console.log('Loading MindBody widget script:', scriptSrc);
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = scriptSrc;
    script.async = true;

    script.onload = () => {
      console.log('MindBody widget script loaded successfully');
      setTimeout(() => {
        setWidgetKey(prev => prev + 1);
        setMindbodyScriptLoaded(true);
        setTimeout(() => {
          if (window.hcInit) {
            console.log('Calling hcInit to initialize widgets');
            window.hcInit();
          }
        }, 300);
      }, 1500);
    };

    script.onerror = (error) => {
      console.error('Failed to load MindBody widget script:', error);
      setMindbodyScriptLoaded(true);
    };

    document.head.appendChild(script);

    return () => {
      const scriptToRemove = document.querySelector(`script[src="${scriptSrc}"]`);
      if (scriptToRemove && document.head.contains(scriptToRemove)) {
        document.head.removeChild(scriptToRemove);
      }
    };
  }, [location]);

  useEffect(() => {
    if (!location) return;

    const trackingScripts: Record<string, string> = {
      'Bayside': 'tk_fed55088e2f94df585b6bdf2abb2899e',
      'Fresh Meadows': 'tk_1b3b4b8103a5485db687608b02dba296'
    };

    const trackingId = trackingScripts[location.name];
    if (!trackingId) return;

    const scriptSrc = 'https://link.msgsndr.com/js/external-tracking.js';
    const existingScript = document.querySelector(`script[src="${scriptSrc}"][data-tracking-id="${trackingId}"]`);

    if (existingScript) {
      console.log('Tracking script already exists for', location.name);
      return;
    }

    console.log('Loading tracking script for', location.name);
    const script = document.createElement('script');
    script.src = scriptSrc;
    script.setAttribute('data-tracking-id', trackingId);

    document.body.appendChild(script);

    return () => {
      const scriptToRemove = document.querySelector(`script[src="${scriptSrc}"][data-tracking-id="${trackingId}"]`);
      if (scriptToRemove && document.body.contains(scriptToRemove)) {
        document.body.removeChild(scriptToRemove);
      }
    };
  }, [location]);

  const generateClasses = () => {
    const classTemplates = [
      { name: 'Bootcamp Blast', difficulty: 'All Levels' },
      { name: 'HIIT & Core', difficulty: 'Intermediate' },
      { name: 'Strength & Conditioning', difficulty: 'All Levels' },
      { name: 'Cardio Power', difficulty: 'Beginner Friendly' },
      { name: 'Total Body Burn', difficulty: 'Advanced' },
      { name: 'Morning Warrior', difficulty: 'All Levels' }
    ];

    const instructors = ['Mike Johnson', 'Sarah Chen', 'Alex Rodriguez', 'Emma Davis', 'Chris Martinez'];
    const times = ['6:00 AM', '7:00 AM', '9:00 AM', '12:00 PM', '5:30 PM', '6:30 PM', '7:30 PM'];

    const generatedClasses: ClassSchedule[] = [];

    for (let i = 0; i < 8; i++) {
      const template = classTemplates[i % classTemplates.length];
      generatedClasses.push({
        id: `class-${i}`,
        name: template.name,
        time: times[i % times.length],
        instructor: instructors[i % instructors.length],
        difficulty: template.difficulty,
        spotsLeft: Math.floor(Math.random() * 8) + 3
      });
    }

    setClasses(generatedClasses);
  };

  const fetchLocation = async () => {
    try {
      const locationName = slug?.split('-').map(word =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(' ');

      console.log('Looking for location:', locationName);

      const { data, error } = await supabase
        .from('locations')
        .select('*')
        .ilike('name', locationName)
        .eq('is_active', true)
        .maybeSingle();

      if (error) {
        console.error('Error fetching location:', error);
        throw error;
      }

      console.log('Found location:', data);
      setLocation(data);
    } catch (error) {
      console.error('Error fetching location:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <section className="py-24 bg-white min-h-screen flex items-center justify-center">
        <div className="container mx-auto px-4 text-center">
          <p className="text-xl">Loading location...</p>
        </div>
      </section>
    );
  }

  if (!location) {
    return (
      <section className="py-24 bg-white min-h-screen flex items-center justify-center">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-4xl font-bold mb-4">Location Not Found</h1>
          <Link to="/locations" className="text-red-600 hover:text-red-700 font-bold">
            View All Locations
          </Link>
        </div>
      </section>
    );
  }

  const getLocationImage = (locationName: string) => {
    const imageMap: { [key: string]: string } = {
      'Astoria': '/astoria-final.webp',
      'Bayside': '/bayside-final.webp',
      'Fresh Meadows': '/freshmeadows-final.webp',
      'Williamsburg': '/williamsburg-final.webp'
    };
    return imageMap[locationName] || '';
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

  // Always route to the on-site per-studio trial page. (Previously this
  // returned old thebetterbodybc.com pass URLs — the legacy funnel.)
  const getTrialUrl = (locationName: string) => {
    const slug = locationName.toLowerCase().replace(/ /g, '-');
    return `/trial/${slug}`;
  };

  // Trial URLs are always internal app routes now — never external.
  const isExternalTrialUrl = (_locationName: string) => false;

  const renderWidget = () => {
    const config = getWidgetConfig(location.name);
    if (!config) return null;

    const widgetHtml = `<healcode-widget data-type="schedules" data-widget-partner="object" data-widget-id="${config.id}" data-widget-version="1"></healcode-widget>`;
    return <div dangerouslySetInnerHTML={{ __html: widgetHtml }} />;
  };

  return (
    <>
    <SEOHead
      title={seoData ? seoData.title : (location ? `${location.name} | Better Body Bootcamp NYC` : 'Location | Better Body Bootcamp')}
      description={seoData ? seoData.description : 'Find a Better Body Bootcamp location near you in New York City.'}
      canonical={`/locations/${locationSlug}`}
      schema={locationSchema}
    />
    <div className="min-h-screen bg-black">
      <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-black overflow-hidden h-screen">
        {location.image_url || getLocationImage(location.name) ? (
          <>
            <div className="absolute inset-0">
              <img
                src={location.image_url || getLocationImage(location.name)}
                alt={location.name}
                className="w-full h-full object-cover opacity-30"
              />
            </div>
            <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-red-900/60 to-black/90" />
          </>
        ) : (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.1),transparent_50%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_80%,rgba(0,0,0,0.3),transparent_50%)]" />
          </>
        )}

        <div className="container mx-auto px-4 relative z-10 h-full flex flex-col justify-between py-6">
          <Link
            to="/locations"
            className="inline-flex items-center space-x-2 text-white/90 hover:text-white transition-colors font-semibold group text-sm"
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
            <span>Back to Locations</span>
          </Link>

          <div className="max-w-4xl mx-auto text-center flex-1 flex flex-col justify-center">
            <div className="mb-6">
              <div className="text-red-400 text-sm font-bold tracking-[0.3em] uppercase mb-3" style={{ fontFamily: 'BlackLives, sans-serif' }}>Location</div>
              <h1 className="text-[clamp(3.5rem,10vw,8rem)] font-black text-white tracking-tight mb-6 leading-none" style={{ fontFamily: 'BlackLives, sans-serif' }}>
                {location.name}
              </h1>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4 text-white mb-8">
                <div className="flex items-center space-x-2 md:space-x-3">
                  <MapPin className="w-6 h-6 md:w-5 md:h-5 text-red-400" />
                  <span className="text-lg md:text-lg font-semibold tracking-wide" style={{ fontFamily: 'BlackLives, sans-serif' }}>{location.address}</span>
                </div>
                <div className="hidden sm:block w-1.5 h-1.5 bg-red-400/60 rounded-full"></div>
                <a
                  href={`tel:${location.phone.replace(/[^0-9]/g, '')}`}
                  className="flex items-center space-x-2 md:space-x-3 hover:text-red-400 transition-colors"
                >
                  <Phone className="w-6 h-6 md:w-5 md:h-5 text-red-400" />
                  <span className="text-lg md:text-lg font-semibold tracking-wide" style={{ fontFamily: 'BlackLives, sans-serif' }}>{location.phone}</span>
                </a>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto w-full">
              <a
                href={location.schedule_url || '#'}
                className="group relative bg-white hover:bg-gray-50 rounded-xl p-5 transition-all duration-300 shadow-xl hover:shadow-2xl hover:-translate-y-1"
              >
                <div className="flex items-center justify-center space-x-3">
                  <Calendar className="w-6 h-6 text-red-600 group-hover:scale-110 transition-transform" />
                  <span className="text-base md:text-lg font-black text-black">VIEW SCHEDULE</span>
                </div>
              </a>

              {isExternalTrialUrl(location.name) ? (
                <a
                  href={getTrialUrl(location.name)}
                  className="group relative bg-red-600 hover:bg-red-700 rounded-xl p-5 transition-all duration-300 shadow-xl hover:shadow-2xl hover:-translate-y-1"
                >
                  <div className="flex items-center justify-center">
                    <span className="text-base md:text-lg font-black text-white">2 WEEKS FOR $49</span>
                  </div>
                </a>
              ) : (
                <Link
                  to={getTrialUrl(location.name)}
                  className="group relative bg-red-600 hover:bg-red-700 rounded-xl p-5 transition-all duration-300 shadow-xl hover:shadow-2xl hover:-translate-y-1"
                >
                  <div className="flex items-center justify-center">
                    <span className="text-base md:text-lg font-black text-white">2 WEEKS FOR $49</span>
                  </div>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white py-20">
        <div className="container mx-auto px-4">
          <div className="max-w-5xl mx-auto">
            <div className="mb-20">
              <div className="text-center mb-12">
                <h2 className="text-[clamp(2rem,5vw,5rem)] font-black text-black mb-4 tracking-tight">Upcoming Classes</h2>
                <div className="h-1.5 w-20 bg-red-600 rounded-full mx-auto mb-4" />
                <p className="text-gray-600 text-lg max-w-2xl mx-auto">Join our high-energy bootcamp classes led by expert trainers</p>
              </div>

              {getWidgetConfig(location.name) ? (
                <div className="mb-8">
                  {mindbodyScriptLoaded ? (
                    <div key={widgetKey} className="bg-white rounded-lg shadow-lg p-6">
                      {renderWidget()}
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-red-600"></div>
                      <p className="mt-4 text-gray-600">Loading class schedule...</p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid md:grid-cols-2 gap-6 mb-8">
                    {classes.map((classItem) => (
                      <div
                        key={classItem.id}
                        className="group bg-gradient-to-br from-gray-50 to-white border-2 border-gray-100 hover:border-red-200 rounded-2xl p-6 transition-all duration-300 hover:shadow-xl"
                      >
                        <div className="flex items-start justify-between mb-4">
                          <div>
                            <h3 className="text-2xl font-black text-black mb-2 tracking-tight">{classItem.name}</h3>
                            <div className="flex items-center space-x-2 text-gray-600 mb-1">
                              <Clock className="w-4 h-4" />
                              <span className="font-semibold">{classItem.time}</span>
                            </div>
                            <div className="flex items-center space-x-2 text-gray-600">
                              <Users className="w-4 h-4" />
                              <span className="font-semibold">with {classItem.instructor}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-xs font-bold mb-2">
                              {classItem.difficulty}
                            </div>
                            <div className="text-xs text-gray-500 font-semibold">
                              {classItem.spotsLeft} spots left
                            </div>
                          </div>
                        </div>
                        {isExternalTrialUrl(location.name) ? (
                          <a
                            href={getTrialUrl(location.name)}
                            className="block w-full bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white py-3 rounded-xl font-bold transition-all transform hover:scale-[1.02] shadow-lg text-center"
                          >
                            SIGN UP NOW
                          </a>
                        ) : (
                          <Link
                            to={getTrialUrl(location.name)}
                            className="block w-full bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white py-3 rounded-xl font-bold transition-all transform hover:scale-[1.02] shadow-lg text-center"
                          >
                            SIGN UP NOW
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="text-center">
                    {getWidgetConfig(location.name) ? (
                      <button
                        onClick={() => setShowScheduleModal(true)}
                        className="inline-flex items-center space-x-2 text-red-600 hover:text-red-700 font-bold text-lg transition-colors"
                      >
                        <span>View Full Weekly Schedule</span>
                        <Calendar className="w-5 h-5" />
                      </button>
                    ) : (
                      <a
                        href={location.schedule_url || '#'}
                        className="inline-flex items-center space-x-2 text-red-600 hover:text-red-700 font-bold text-lg transition-colors"
                      >
                        <span>View Full Weekly Schedule</span>
                        <Calendar className="w-5 h-5" />
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="text-center mb-16">
              <h2 className="text-[clamp(2rem,5vw,5rem)] font-black text-black mb-4 tracking-tight">What We Offer</h2>
              <div className="h-1.5 w-20 bg-red-600 rounded-full mx-auto" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
              <div className="group relative bg-gradient-to-br from-gray-50 to-white rounded-3xl p-10 shadow-xl hover:shadow-2xl transition-all duration-300 border-2 border-gray-100 hover:border-red-200 overflow-hidden text-center md:text-left">
                <div className="absolute top-0 right-0 w-32 h-32 bg-red-600/5 rounded-full -mr-16 -mt-16 group-hover:scale-150 transition-transform duration-500" />
                <div className="relative">
                  <div className="bg-gradient-to-br from-red-600 to-red-700 p-4 rounded-2xl inline-block mb-6 shadow-lg">
                    <Dumbbell className="w-8 h-8 text-white" />
                  </div>
                  <h3 className="text-2xl font-black text-black mb-3 tracking-tight">Group Training</h3>
                  <p className="text-gray-600 text-base leading-relaxed">High-intensity bootcamp classes led by expert trainers who push you to achieve your best</p>
                </div>
              </div>

              <div className="group relative bg-gradient-to-br from-gray-50 to-white rounded-3xl p-10 shadow-xl hover:shadow-2xl transition-all duration-300 border-2 border-gray-100 hover:border-red-200 overflow-hidden text-center md:text-left">
                <div className="absolute top-0 right-0 w-32 h-32 bg-red-600/5 rounded-full -mr-16 -mt-16 group-hover:scale-150 transition-transform duration-500" />
                <div className="relative">
                  <div className="bg-gradient-to-br from-red-600 to-red-700 p-4 rounded-2xl inline-block mb-6 shadow-lg">
                    <Clock className="w-8 h-8 text-white" />
                  </div>
                  <h3 className="text-2xl font-black text-black mb-3 tracking-tight">Flexible Schedule</h3>
                  <p className="text-gray-600 text-base leading-relaxed">Multiple class times throughout the week to fit your busy lifestyle and commitments</p>
                </div>
              </div>

              <div className="group relative bg-gradient-to-br from-gray-50 to-white rounded-3xl p-10 shadow-xl hover:shadow-2xl transition-all duration-300 border-2 border-gray-100 hover:border-red-200 overflow-hidden text-center md:text-left">
                <div className="absolute top-0 right-0 w-32 h-32 bg-red-600/5 rounded-full -mr-16 -mt-16 group-hover:scale-150 transition-transform duration-500" />
                <div className="relative">
                  <div className="bg-gradient-to-br from-red-600 to-red-700 p-4 rounded-2xl inline-block mb-6 shadow-lg">
                    <Award className="w-8 h-8 text-white" />
                  </div>
                  <h3 className="text-2xl font-black text-black mb-3 tracking-tight">All Fitness Levels</h3>
                  <p className="text-gray-600 text-base leading-relaxed">Workouts carefully adapted for everyone from beginners to advanced athletes</p>
                </div>
              </div>

              <div className="group relative bg-gradient-to-br from-gray-50 to-white rounded-3xl p-10 shadow-xl hover:shadow-2xl transition-all duration-300 border-2 border-gray-100 hover:border-red-200 overflow-hidden text-center md:text-left">
                <div className="absolute top-0 right-0 w-32 h-32 bg-red-600/5 rounded-full -mr-16 -mt-16 group-hover:scale-150 transition-transform duration-500" />
                <div className="relative">
                  <div className="bg-gradient-to-br from-red-600 to-red-700 p-4 rounded-2xl inline-block mb-6 shadow-lg">
                    <Users className="w-8 h-8 text-white" />
                  </div>
                  <h3 className="text-2xl font-black text-black mb-3 tracking-tight">Community Focus</h3>
                  <p className="text-gray-600 text-base leading-relaxed">Join a supportive community environment where everyone works together to reach their goals</p>
                </div>
              </div>
            </div>

            <div className="bg-gradient-to-br from-black to-gray-900 rounded-3xl p-12 text-center shadow-2xl">
              <h2 className="text-[clamp(2rem,4vw,4rem)] font-black text-white mb-4 tracking-tight">Ready to Get Started?</h2>
              <p className="text-white/80 text-lg mb-8 max-w-2xl mx-auto leading-relaxed">
                Join us at our {location.name} location for high-energy bootcamp classes designed to help you achieve your fitness goals with expert guidance and community support.
              </p>
              {isExternalTrialUrl(location.name) ? (
                <a
                  href={getTrialUrl(location.name)}
                  className="inline-flex items-center justify-center space-x-3 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-10 py-5 rounded-2xl text-lg font-bold transition-all transform hover:scale-105 shadow-xl"
                >
                  <span className="tracking-wide">START YOUR 2-WEEK TRIAL - $49</span>
                </a>
              ) : (
                <Link
                  to={getTrialUrl(location.name)}
                  className="inline-flex items-center justify-center space-x-3 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white px-10 py-5 rounded-2xl text-lg font-bold transition-all transform hover:scale-105 shadow-xl"
                >
                  <span className="tracking-wide">START YOUR 2-WEEK TRIAL - $49</span>
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      {showScheduleModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 flex items-center justify-center p-4">
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
              <h2 className="text-2xl font-black text-black tracking-tight">Full Weekly Schedule</h2>
              <button
                onClick={() => setShowScheduleModal(false)}
                className="p-2 hover:bg-gray-100 rounded-full transition-colors"
              >
                <X className="w-6 h-6 text-gray-600" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 80px)' }}>
              {mindbodyScriptLoaded ? (
                <div key={widgetKey}>{renderWidget()}</div>
              ) : (
                <div className="text-center py-12">
                  <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-red-600"></div>
                  <p className="mt-4 text-gray-600">Loading class schedule...</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
