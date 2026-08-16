import { Link } from 'react-router-dom';
import { MapPin, Phone, ArrowRight, CheckCircle } from 'lucide-react';
import SEOHead from '../components/SEOHead';

/**
 * /queens — Queens hub page.
 *
 * SEO target: "gyms in queens", "best gym queens", "gym in queens ny",
 * "queens gym", "fitness queens".
 *
 * Currently BBB's homepage owns "gyms in BAYSIDE queens" at #1 but there's
 * no authoritative page for the generic "gyms in queens" query — Google has
 * been grabbing /locations/fresh-meadows and ranking it at #66. This page
 * consolidates the 3 Queens locations (Astoria, Bayside, Fresh Meadows) into
 * one topically dense hub Google can confidently rank.
 *
 * Internal-link strategy:
 *   • Homepage links here in a "Queens locations" footer block
 *   • Each /locations/[queens-slug] cross-links here in a "More Queens BBB"
 *     section
 *   • This page links DOWN to each individual studio page
 *   • Sitemap.xml gets /queens at priority 1.0
 */

const QUEENS_LOCATIONS = [
  {
    slug: 'astoria',
    name: 'Astoria',
    neighborhood: 'Astoria, Queens',
    address: '31-18 Steinway Street',
    zip: '11103',
    phone: '(718) 704-9954',
    image: '/astoria-final.webp',
    blurb:
      'Steinway Street\'s premier group fitness studio. Walk-distance from the Steinway N/W stops. Real strength training in the heart of Astoria.',
  },
  {
    slug: 'bayside',
    name: 'Bayside',
    neighborhood: 'Bayside, Queens',
    address: '34-47 Bell Blvd',
    zip: '11361',
    phone: '(646) 566-8870',
    image: '/bayside-final.webp',
    blurb:
      'Bell Boulevard\'s strength + conditioning destination. Free parking, 6am–8pm classes, real coaching for Bayside locals.',
  },
  {
    slug: 'fresh-meadows',
    name: 'Fresh Meadows',
    neighborhood: 'Fresh Meadows, Queens',
    address: '76-46 164th Street',
    zip: '11366',
    phone: '(646) 566-8207',
    image: '/freshmeadows-final.webp',
    blurb:
      '164th Street\'s flagship Queens location. Largest training floor in the BBB network. Most class times in the borough.',
  },
];

const queensSchema = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'Best Body Bootcamp — Queens Studios',
  description: '3 group fitness studios across Queens, NY — Astoria, Bayside, Fresh Meadows.',
  itemListElement: QUEENS_LOCATIONS.map((loc, idx) => ({
    '@type': 'ListItem',
    position: idx + 1,
    item: {
      '@type': 'HealthClub',
      '@id': `https://betterbodybootcamp.com/locations/${loc.slug}`,
      name: `Better Body Bootcamp ${loc.name}`,
      address: {
        '@type': 'PostalAddress',
        streetAddress: loc.address,
        addressLocality: loc.neighborhood.split(',')[0],
        addressRegion: 'NY',
        postalCode: loc.zip,
        addressCountry: 'US',
      },
      telephone: loc.phone,
      url: `https://betterbodybootcamp.com/locations/${loc.slug}`,
      areaServed: { '@type': 'AdministrativeArea', name: 'Queens, NY' },
      priceRange: '$$',
    },
  })),
};

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the best gym in Queens?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Better Body Bootcamp is the #1-rated group fitness studio in Queens with three locations: Astoria, Bayside, and Fresh Meadows. We focus on real strength training, expert coaching, and high-energy classes — not vending-machine treadmill gyms.',
      },
    },
    {
      '@type': 'Question',
      name: 'How many Better Body Bootcamp locations are in Queens?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'There are three BBB studios in Queens: Astoria (31-18 Steinway Street), Bayside (34-47 Bell Blvd), and Fresh Meadows (76-46 164th Street). All three are within a 30-minute drive of each other.',
      },
    },
    {
      '@type': 'Question',
      name: 'How much does a gym in Queens cost at Better Body Bootcamp?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Start with our $49 two-week unlimited trial at any of the three Queens BBB locations. Monthly memberships range from $179–$249 depending on commitment. There is no enrollment fee.',
      },
    },
    {
      '@type': 'Question',
      name: 'Are there gyms in Queens with class schedules?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Yes. All three Queens BBB studios run group classes from 6am to 8pm on weekdays and morning blocks on weekends. View the live schedule for each location: Astoria, Bayside, or Fresh Meadows.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is the closest BBB gym to me in Queens?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Astoria covers western Queens (LIC, Sunnyside, Woodside). Bayside covers eastern Queens (Bayside Hills, Whitestone, Auburndale). Fresh Meadows covers central Queens (Forest Hills, Jamaica Estates, Hillcrest). All three are accessible by car or by Q-line bus.',
      },
    },
  ],
};

export default function Queens() {
  return (
    <>
      <SEOHead
        title="Best Gyms in Queens, NY — Better Body Bootcamp · 3 Studios"
        description="The #1 group fitness gyms in Queens, NY. Three Better Body Bootcamp locations — Astoria, Bayside, Fresh Meadows. Real strength training, expert coaches, 2-week unlimited trial for $49."
        canonical="/queens"
        schema={[queensSchema, faqSchema]}
      />

      <div className="min-h-screen bg-white">
        {/* HERO */}
        <section className="relative bg-gradient-to-br from-gray-900 via-black to-gray-900 text-white pt-32 pb-20 sm:pt-40 sm:pb-28">
          <div className="absolute inset-0 opacity-30 bg-[url('/change-your-life.webp')] bg-cover bg-center"></div>
          <div className="relative max-w-6xl mx-auto px-4 sm:px-6 text-center">
            <span className="inline-block px-4 py-1.5 bg-red-600/20 border border-red-500/40 rounded-full text-xs font-bold tracking-[0.2em] uppercase mb-6">
              3 Locations · Queens, NY
            </span>
            <h1 className="text-5xl sm:text-7xl md:text-8xl font-black leading-[0.95] tracking-tight mb-6">
              The #1 Gym
              <br />
              <span className="text-red-500">in Queens</span>
            </h1>
            <p className="text-lg sm:text-2xl max-w-3xl mx-auto mb-10 leading-relaxed text-gray-200">
              Three Better Body Bootcamp studios across Queens — Astoria, Bayside, and Fresh
              Meadows. Real strength training, expert coaches, and high-energy classes.
            </p>
            <Link
              to="/trial"
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold px-8 py-4 rounded-full text-lg transition-colors"
            >
              Start Your $49 Trial <ArrowRight className="w-5 h-5" />
            </Link>
          </div>
        </section>

        {/* INTRO COPY */}
        <section className="py-16 sm:py-24 bg-gray-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6">
            <h2 className="text-3xl sm:text-4xl font-black mb-6 text-center">
              Why Better Body Bootcamp is the Best Gym in Queens
            </h2>
            <p className="text-lg leading-relaxed text-gray-700 mb-4">
              Queens deserves better than a treadmill-and-vending-machine gym. Better Body Bootcamp
              has built three group fitness studios across Queens — one in Astoria, one in Bayside,
              and one in Fresh Meadows — purpose-built for people who want real results, not
              monthly billing on a membership they never use.
            </p>
            <p className="text-lg leading-relaxed text-gray-700 mb-4">
              Every BBB Queens location runs the same proven program: high-energy strength,
              conditioning, and metabolic training led by expert coaches. Classes max out at 20
              members so you get real coaching cues every set — not lost in a sea of 60.
            </p>
            <p className="text-lg leading-relaxed text-gray-700">
              If you live anywhere in Queens — from LIC to Bayside Hills, from Sunnyside to Jamaica
              Estates — there is a BBB studio within a short drive. Start with our $49 two-week
              unlimited trial and train at any of the three Queens locations.
            </p>
          </div>
        </section>

        {/* LOCATION CARDS */}
        <section className="py-16 sm:py-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <h2 className="text-3xl sm:text-4xl font-black mb-12 text-center">
              Better Body Bootcamp Queens Locations
            </h2>
            <div className="grid md:grid-cols-3 gap-6 sm:gap-8">
              {QUEENS_LOCATIONS.map((loc) => (
                <div
                  key={loc.slug}
                  className="bg-white border-2 border-gray-200 rounded-2xl overflow-hidden hover:border-red-500 hover:shadow-xl transition-all"
                >
                  <div
                    className="h-48 sm:h-56 bg-cover bg-center"
                    style={{ backgroundImage: `url(${loc.image})` }}
                  ></div>
                  <div className="p-6 sm:p-8">
                    <h3 className="text-2xl font-black mb-1">BBB {loc.name}</h3>
                    <p className="text-sm font-semibold text-red-600 tracking-wider uppercase mb-4">
                      {loc.neighborhood}
                    </p>
                    <p className="text-gray-700 mb-5 leading-relaxed">{loc.blurb}</p>
                    <div className="flex items-start gap-2 text-sm text-gray-600 mb-2">
                      <MapPin className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" />
                      <span>
                        {loc.address}, {loc.neighborhood.split(',')[0]}, NY {loc.zip}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-600 mb-6">
                      <Phone className="w-4 h-4 text-red-600" />
                      <a href={`tel:${loc.phone}`} className="hover:text-red-600">{loc.phone}</a>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Link
                        to={`/trial/${loc.slug}`}
                        className="text-center bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg transition-colors"
                      >
                        Start $49 Trial in {loc.name}
                      </Link>
                      <Link
                        to={`/locations/${loc.slug}`}
                        className="text-center border-2 border-gray-300 hover:border-gray-900 text-gray-900 font-semibold py-2.5 rounded-lg transition-colors"
                      >
                        View {loc.name} Studio Details
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* WHY US */}
        <section className="py-16 sm:py-24 bg-black text-white">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <h2 className="text-3xl sm:text-4xl font-black mb-12 text-center">
              What Makes BBB Different from Other Gyms in Queens
            </h2>
            <div className="grid sm:grid-cols-2 gap-6">
              {[
                {
                  t: 'Real Group Coaching',
                  d:
                    'Capped at 20 members per class. Real coaching cues every set — not lost in a sea of 60.',
                },
                {
                  t: 'Strength + Conditioning',
                  d:
                    'Proven programming that mixes strength training, conditioning, and metabolic work. Built for results.',
                },
                {
                  t: '3 Queens Locations',
                  d:
                    'Train at Astoria, Bayside, or Fresh Meadows — one membership, three studios across Queens.',
                },
                {
                  t: 'No Long-Term Contract',
                  d:
                    'Month-to-month plans available. No enrollment fee. Start with a $49 two-week trial — no strings attached.',
                },
                {
                  t: 'Class Times That Fit Queens Life',
                  d:
                    '6am to 8pm weekdays, morning blocks on weekends. Built around your commute, not ours.',
                },
                {
                  t: 'Coaches Who Know Your Name',
                  d:
                    'Every BBB coach is a full-time staff member, not a side gig. They remember you between classes.',
                },
              ].map((f) => (
                <div key={f.t} className="flex gap-4">
                  <CheckCircle className="w-6 h-6 text-red-500 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="font-bold text-lg mb-1">{f.t}</h3>
                    <p className="text-gray-300 leading-relaxed">{f.d}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ (matches schema) */}
        <section className="py-16 sm:py-24 bg-gray-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6">
            <h2 className="text-3xl sm:text-4xl font-black mb-12 text-center">
              Queens Gym FAQs
            </h2>
            <div className="space-y-6">
              {(faqSchema.mainEntity as any[]).map((q: any) => (
                <div key={q.name} className="bg-white border border-gray-200 rounded-xl p-6 sm:p-8">
                  <h3 className="font-bold text-lg mb-3">{q.name}</h3>
                  <p className="text-gray-700 leading-relaxed">{q.acceptedAnswer.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="py-20 sm:py-28 bg-gradient-to-br from-red-700 to-red-900 text-white">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center">
            <h2 className="text-4xl sm:text-6xl font-black mb-6 leading-tight">
              Find Your Queens Studio.
              <br />
              Start Your $49 Trial.
            </h2>
            <p className="text-lg sm:text-xl mb-10 text-red-100 leading-relaxed">
              Two weeks of unlimited classes at any of our three Queens locations. Try every coach,
              every class time, every studio. Real fitness — built for Queens.
            </p>
            <Link
              to="/trial"
              className="inline-flex items-center gap-2 bg-white hover:bg-gray-100 text-red-700 font-bold px-10 py-4 rounded-full text-lg transition-colors"
            >
              Pick Your Queens Studio <ArrowRight className="w-5 h-5" />
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
