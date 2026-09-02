import { Link } from 'react-router-dom';
import { MapPin, Phone, ArrowRight, CheckCircle } from 'lucide-react';
import SEOHead from '../components/SEOHead';

/**
 * /brooklyn — Brooklyn hub page.
 *
 * SEO target: "gym brooklyn williamsburg" (1K/mo, KD 15 — our single best
 * winnable term, currently stuck at ~#17), plus "gyms in williamsburg",
 * "williamsburg gym", "gyms in brooklyn", "bootcamp williamsburg brooklyn".
 *
 * Mirrors the /queens hub strategy: a topically dense borough page that
 * consolidates the Brooklyn footprint (the Williamsburg studio + the
 * neighborhoods it serves) into one authoritative page Google can rank, and
 * funnels internal-link equity DOWN to /locations/williamsburg with the exact
 * "gym in Williamsburg, Brooklyn" anchor the location page needs.
 *
 * Internal-link strategy:
 *   • /locations/williamsburg cross-links UP here ("See all gyms in Brooklyn")
 *   • This page links DOWN to the Williamsburg studio + its trial page
 *   • Sitemap.xml carries /brooklyn at priority 1.0 (same as /queens)
 */

const WILLIAMSBURG = {
  slug: 'williamsburg',
  name: 'Williamsburg',
  neighborhood: 'Williamsburg, Brooklyn',
  address: '487 Driggs Ave',
  zip: '11211',
  phone: '(718) 683-1864',
  image: '/williamsburg-final.webp',
  blurb:
    'A coaching-first gym on Driggs Ave, a few minutes from the Bedford Ave L. Every class is a coached small group with a coach programming the whole session — real coaching in the heart of Williamsburg.',
};

const NEARBY = ['Greenpoint', 'East Williamsburg', 'Bushwick', 'Bedford-Stuyvesant'];

const brooklynSchema = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: 'Better Body Bootcamp — Brooklyn Studio',
  description: 'Coach-led group fitness gym in Williamsburg, Brooklyn.',
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      item: {
        '@type': 'HealthClub',
        '@id': `https://betterbodybootcamp.com/locations/${WILLIAMSBURG.slug}`,
        name: `Better Body Bootcamp ${WILLIAMSBURG.name}`,
        address: {
          '@type': 'PostalAddress',
          streetAddress: WILLIAMSBURG.address,
          addressLocality: 'Brooklyn',
          addressRegion: 'NY',
          postalCode: WILLIAMSBURG.zip,
          addressCountry: 'US',
        },
        telephone: WILLIAMSBURG.phone,
        url: `https://betterbodybootcamp.com/locations/${WILLIAMSBURG.slug}`,
        areaServed: { '@type': 'AdministrativeArea', name: 'Brooklyn, NY' },
        priceRange: '$$',
      },
    },
  ],
};

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the best gym in Williamsburg, Brooklyn?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Better Body Bootcamp is a top-rated coach-led gym in Williamsburg, Brooklyn, on Driggs Ave near the Bedford Ave L. Instead of a floor of machines, every class is a coached small group run by a coach who programs the workout and learns your name. New members start with a 2-week unlimited trial for $49.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is there a bootcamp or group fitness gym in Williamsburg?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Yes. Better Body Bootcamp Williamsburg runs coach-led bootcamp, HIIT, strength, and conditioning classes seven days a week at 487 Driggs Ave, serving Williamsburg, Greenpoint, East Williamsburg, and Bushwick.',
      },
    },
    {
      '@type': 'Question',
      name: 'How much does a gym membership in Williamsburg cost at Better Body Bootcamp?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Start with a $49 two-week unlimited trial. Monthly memberships run from about $189 depending on commitment, with six-month and yearly options that lower the per-month rate. There is no enrollment fee.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is the closest subway to the Williamsburg gym?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'The L train at Bedford Ave is about a 6-minute walk. The G train at Metropolitan Ave or Lorimer St is about a 12-minute walk, and Citi Bike stations are within two blocks.',
      },
    },
  ],
};

export default function Brooklyn() {
  return (
    <>
      <SEOHead
        title="Best Gym in Williamsburg, Brooklyn — Better Body Bootcamp · $49 Trial"
        description="The top coach-led gym in Williamsburg, Brooklyn. Bootcamp, HIIT, strength & group fitness classes on Driggs Ave, all coach-led small groups. Serving Williamsburg, Greenpoint, East Williamsburg & Bushwick. 2-week unlimited trial for $49."
        canonical="/brooklyn"
        schema={[brooklynSchema, faqSchema]}
      />

      <div className="min-h-screen bg-white">
        {/* HERO */}
        <section className="relative bg-gradient-to-br from-gray-900 via-black to-gray-900 text-white pt-32 pb-20 sm:pt-40 sm:pb-28">
          <div className="absolute inset-0 opacity-30 bg-[url('/williamsburg-final.webp')] bg-cover bg-center"></div>
          <div className="relative max-w-6xl mx-auto px-4 sm:px-6 text-center">
            <span className="inline-block px-4 py-1.5 bg-red-600/20 border border-red-500/40 rounded-full text-xs font-bold tracking-[0.2em] uppercase mb-6">
              Williamsburg · Brooklyn, NY
            </span>
            <h1 className="text-5xl sm:text-7xl md:text-8xl font-black leading-[0.95] tracking-tight mb-6">
              The Best Gym
              <br />
              <span className="text-red-500">in Williamsburg</span>
            </h1>
            <p className="text-lg sm:text-2xl max-w-3xl mx-auto mb-10 leading-relaxed text-gray-200">
              Better Body Bootcamp is a coach-led gym in Williamsburg, Brooklyn. Bootcamp, HIIT,
              strength, and conditioning classes on Driggs Ave, in small groups so a coach is on you
              every set.
            </p>
            <Link
              to="/trial/williamsburg"
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
              A Coach-Led Gym in Williamsburg, Brooklyn
            </h2>
            <p className="text-lg leading-relaxed text-gray-700 mb-4">
              Williamsburg has no shortage of places to work out. What it does not have much of is a
              gym where someone actually coaches you. Better Body Bootcamp on Driggs Ave is built the
              other way around. Every class is programmed in advance and run by a coach, so you walk
              in and train instead of wandering a floor of machines trying to figure it out alone.
            </p>
            <p className="text-lg leading-relaxed text-gray-700 mb-4">
              Classes stay small, so you get real coaching cues every set instead of getting
              lost in a room of 60. Whether you have trained for years or you are starting from
              scratch, the coach scales the workout to you. About half the room on any given day
              started as a beginner.
            </p>
            <p className="text-lg leading-relaxed text-gray-700">
              We are a few minutes from the Bedford Ave L, serving Williamsburg and nearby
              Greenpoint, East Williamsburg, and Bushwick. Start with a $49 two-week unlimited trial
              and see what a coached gym in Williamsburg actually feels like.
            </p>
          </div>
        </section>

        {/* LOCATION CARD */}
        <section className="py-16 sm:py-24">
          <div className="max-w-md mx-auto px-4 sm:px-6">
            <div className="bg-white border-2 border-gray-200 rounded-2xl overflow-hidden hover:border-red-500 hover:shadow-xl transition-all">
              <div
                className="h-56 sm:h-64 bg-cover bg-center"
                style={{ backgroundImage: `url(${WILLIAMSBURG.image})` }}
              ></div>
              <div className="p-6 sm:p-8">
                <h3 className="text-2xl font-black mb-1">BBB {WILLIAMSBURG.name}</h3>
                <p className="text-sm font-semibold text-red-600 tracking-wider uppercase mb-4">
                  {WILLIAMSBURG.neighborhood}
                </p>
                <p className="text-gray-700 mb-5 leading-relaxed">{WILLIAMSBURG.blurb}</p>
                <div className="flex items-start gap-2 text-sm text-gray-600 mb-2">
                  <MapPin className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" />
                  <span>
                    {WILLIAMSBURG.address}, Brooklyn, NY {WILLIAMSBURG.zip}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-gray-600 mb-6">
                  <Phone className="w-4 h-4 text-red-600" />
                  <a href={`tel:${WILLIAMSBURG.phone}`} className="hover:text-red-600">{WILLIAMSBURG.phone}</a>
                </div>
                <div className="flex flex-col gap-2">
                  <Link
                    to="/trial/williamsburg"
                    className="text-center bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg transition-colors"
                  >
                    Start $49 Trial in Williamsburg
                  </Link>
                  <Link
                    to="/locations/williamsburg"
                    className="text-center border-2 border-gray-300 hover:border-gray-900 text-gray-900 font-semibold py-2.5 rounded-lg transition-colors"
                  >
                    View the Williamsburg Gym
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* WHY US */}
        <section className="py-16 sm:py-24 bg-black text-white">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <h2 className="text-3xl sm:text-4xl font-black mb-12 text-center">
              What Makes BBB Different from Other Williamsburg Gyms
            </h2>
            <div className="grid sm:grid-cols-2 gap-6">
              {[
                {
                  t: 'Real Group Coaching',
                  d: 'Small coached classes, so you get real coaching cues every set instead of getting lost in a sea of 60.',
                },
                {
                  t: 'Strength + Conditioning',
                  d: 'Proven programming that mixes strength training, conditioning, and metabolic work. Built for results, not just sweat.',
                },
                {
                  t: 'Steps from the Bedford L',
                  d: 'On Driggs Ave, a 6-minute walk from the Bedford Ave L and close to the G. Bike it in and rack up on the block.',
                },
                {
                  t: 'No Long-Term Contract',
                  d: 'Month-to-month plans, no enrollment fee. Start with a $49 two-week trial and decide after you have actually trained here.',
                },
                {
                  t: 'Built for Every Level',
                  d: 'Never done this before? Neither had half the room. The coach scales every movement to where you are today.',
                },
                {
                  t: 'Coaches Who Know Your Name',
                  d: 'Every BBB coach is a full-time staff member, not a side gig. They remember you between classes.',
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
            <p className="text-center text-gray-400 mt-10 text-sm sm:text-[15px] max-w-2xl mx-auto leading-relaxed">
              Proudly serving Williamsburg and nearby {NEARBY.join(', ')} with coach-led bootcamp,
              HIIT, strength, and group fitness classes for every level.
            </p>
          </div>
        </section>

        {/* FAQ (matches schema) */}
        <section className="py-16 sm:py-24 bg-gray-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6">
            <h2 className="text-3xl sm:text-4xl font-black mb-12 text-center">
              Williamsburg Gym FAQs
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
              Your Williamsburg Gym.
              <br />
              Two Weeks for $49.
            </h2>
            <p className="text-lg sm:text-xl mb-10 text-red-100 leading-relaxed">
              Unlimited classes for two weeks on Driggs Ave. Try every coach and every class time,
              then decide. Real coaching, built for Williamsburg.
            </p>
            <Link
              to="/trial/williamsburg"
              className="inline-flex items-center gap-2 bg-white hover:bg-gray-100 text-red-700 font-bold px-10 py-4 rounded-full text-lg transition-colors"
            >
              Start Your $49 Trial <ArrowRight className="w-5 h-5" />
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
