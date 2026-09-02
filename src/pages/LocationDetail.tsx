import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MapPin, Phone, ArrowLeft, ArrowRight, Clock, Dumbbell, Users, User, Flame } from 'lucide-react';
import { StudioReviews } from '../components/GoogleReviews';

// 2026-06-25: Mariana Tek per-studio location IDs (pulled from
// betterbodybootcamp.marianatools.com/developer). Same tenant for all 4
// studios. Used now by NativeClassList (the iframe class-type-id is gone).
const MT_LOCATION_IDS: Record<string, number> = {
  Astoria: 48717,
  Bayside: 48718,
  'Fresh Meadows': 48719,
  Williamsburg: 48720,
};

// 2026-06-25: Program icons — index-aligned with PROGRAMS_DEFAULT in
// /lib/studioFaq.ts. If we reorder programs, reorder this too.
const PROGRAM_ICONS = [Dumbbell, User, Users, Flame] as const;

// 2026-07-08: Sibling-studio cross-links. Serves two goals at once:
//  • Visitor flow — someone on the Astoria page can jump straight to the
//    other 3 studios (or the Queens hub) without hunting through the nav.
//  • SEO internal linking — completes the /queens hub strategy documented in
//    Queens.tsx: each studio page now links laterally to its siblings AND up
//    to the Queens hub, so link equity flows through the local cluster and
//    Google can crawl all 4 studios from any one of them.
const ALL_STUDIOS: { name: string; slug: string; address: string; borough: string }[] = [
  { name: 'Astoria',       slug: 'astoria',       address: '31-18 Steinway Street', borough: 'Queens' },
  { name: 'Bayside',       slug: 'bayside',       address: '34-47 Bell Blvd',        borough: 'Queens' },
  { name: 'Fresh Meadows', slug: 'fresh-meadows', address: '76-46 164th Street',    borough: 'Queens' },
  { name: 'Williamsburg',  slug: 'williamsburg',  address: '487 Driggs Ave',        borough: 'Brooklyn' },
];

// 2026-08-23 on-page checker: one natural positioning sentence per studio.
// Adds the "fitness goals" semantic term + honest comparison framing against
// the boutique/big-box options people actually cross-shop in each neighborhood.
// 2026-08-25: short per-studio hero sublines — the hero used to show the same
// generic sentence at all four studios. One line each, no capacity numbers.
const HERO_BOROUGH: Record<string, string> = {
  'astoria': 'Queens',
  'bayside': 'Queens',
  'fresh-meadows': 'Queens',
  'williamsburg': 'Brooklyn',
};


const STUDIO_POSITIONING: Record<string, string> = {
  'astoria':
    "Whatever your fitness goals are, from first pull-up to marathon prep, our coaches build the path. Plenty of members arrive after trying big-box gyms and boutique studios around Steinway and 30th Ave, and stay because a coached room beats training alone.",
  'bayside':
    "Whatever your fitness goals are, our coaches meet you where you're at. If you're comparing us to Powerhouse or the big-box gyms along Bell Blvd, the difference is simple: every session here is coach-led, small group, and programmed for you.",
  'fresh-meadows':
    "Looking for a boot camp gym near you in Fresh Meadows? This is it: coach-led small group classes built around your fitness goals whether that's fat loss, strength, or just showing up consistently again.",
  'williamsburg':
    "Comparing us to Barry's or the other boutique studios in Williamsburg? Our classes are coach-led and small group like theirs, at a fraction of the per-class price, and programmed around your fitness goals instead of a franchise formula.",
};
import { supabase, LOCATION_PUBLIC_COLUMNS, Location } from '../lib/supabase';
import SEOHead from '../components/SEOHead';
import { STUDIO_SEO_EXTRAS } from '../lib/studioFaq';
// 2026-06-26: Native (no-iframe) class list — same data as the old MT widget
// but rendered as React components with full BBB styling.
import NativeClassList from '../components/NativeClassList';

// 2026-06-25: healcode-widget JSX global declarations removed — we no longer
// embed MindBody widgets on this page. The MT widget mounts via a regular
// <div data-mariana-integrations="..."> element handled by the MT runtime.

// 2026-06-26 (REAL FIX): MT auto-scans [data-mariana-integrations] ONCE on
// script load — before React lazy-mounts this route. The previous helper called
// `__initMTIntegrations()` which doesn't exist as a global (silent no-op). The
// real exposed API is `window.MTIntegrations.render(selector)`. We poll for it
// then mount.
declare global {
  interface Window {
    MTIntegrations?: { render: (selector?: string) => void };
  }
}

// 2026-06-26: reInitMTWidgets() removed — page no longer embeds the MT iframe.
// NativeClassList renders the schedule via the mt-public-classes proxy.

export default function LocationDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [location, setLocation] = useState<Location | null>(null);
  const [loading, setLoading] = useState(true);

  // Per-location SEO + structured data. Titles target the actual searches
  // people type into Google ("gyms in fresh meadows" beats "fresh meadows
  // bootcamp"). Lat/lng coords are the studio addresses geocoded to ~10m,
  // which lets Google place us on the Map Pack confidently.
  // Each row also carries the "under new ownership" tagline so it shows in
  // both the meta description and the rendered page content.
  const NEW_OWNERSHIP_TAG = 'Under new ownership since October 2025.';
  const LOCATION_SEO: Record<string, {
    title: string;
    description: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    phone: string;
    lat: number;
    lng: number;
    instagram?: string;
    facebook?: string;
  }> = {
    'Astoria': {
      title: 'Gyms in Astoria, Queens · Group Fitness Classes · $49 Trial',
      description: 'Group fitness classes, bootcamp & HIIT gym in Astoria, Queens on Steinway St — also serving Long Island City, Sunnyside & Woodside. 2 weeks unlimited classes for $49.',
      address: '31-18 Steinway Street', city: 'Astoria', state: 'NY', zip: '11103', phone: '+1-718-704-9954',
      lat: 40.7634, lng: -73.9148,
      instagram: 'https://www.instagram.com/betterbodybootcampastoria',
      facebook:  'https://www.facebook.com/betterbodybootcampastoria',
    },
    'Bayside': {
      title: 'Gyms in Bayside, Queens · Group Fitness Classes · $49 Trial',
      description: 'Group fitness classes, bootcamp & HIIT gym in Bayside, Queens on Bell Blvd — also serving Bay Terrace, Whitestone, Douglaston & Little Neck. 2 weeks unlimited for $49.',
      address: '34-47 Bell Blvd', city: 'Bayside', state: 'NY', zip: '11361', phone: '+1-646-566-8870',
      lat: 40.7666, lng: -73.7732,
      instagram: 'https://www.instagram.com/betterbodybootcampbayside',
      facebook:  'https://www.facebook.com/betterbodybootcampbayside',
    },
    'Fresh Meadows': {
      title: 'Gyms in Fresh Meadows, Queens · Group Fitness Classes · $49 Trial',
      description: 'Group fitness classes, bootcamp & HIIT gym in Fresh Meadows, Queens — also serving Flushing, Hillcrest, Utopia & Jamaica Estates. 2 weeks unlimited classes for $49.',
      address: '76-46 164th Street', city: 'Fresh Meadows', state: 'NY', zip: '11366', phone: '+1-646-566-8207',
      lat: 40.7345, lng: -73.7906,
      instagram: 'https://www.instagram.com/betterbodyfreshmeadows',
      facebook:  'https://www.facebook.com/betterbodybootcampfreshmeadows',
    },
    'Williamsburg': {
      title: 'Gyms in Williamsburg, Brooklyn · Group Fitness Classes · $49 Trial',
      description: "Group fitness classes, bootcamp & HIIT gym in Williamsburg, Brooklyn on Driggs Ave — also serving Greenpoint, East Williamsburg & Bushwick. 2 weeks unlimited for $49.",
      address: '487 Driggs Ave', city: 'Brooklyn', state: 'NY', zip: '11211', phone: '+1-718-683-1864',
      lat: 40.7146, lng: -73.9602,
      instagram: 'https://www.instagram.com/betterbodybootcampwilliamsburg',
      facebook:  'https://www.facebook.com/betterbodybootcampwilliamsburg',
    },
  };
  // Suppress unused-variable lint if not referenced elsewhere — the tag is
  // intended for display embedded in description copy above plus future use.
  void NEW_OWNERSHIP_TAG;

  const seoData = location ? LOCATION_SEO[location.name] : null;
  // Surrounding neighborhoods this studio serves — drives the enriched
  // areaServed schema below + the visible "Areas we serve" block. Sourced from
  // the keyword research so we rank for "gym/bootcamp in <nearby area>", not
  // just the exact neighborhood the studio sits in.
  const nearbyAreas = location ? (STUDIO_SEO_EXTRAS[location.name]?.nearbyAreas ?? []) : [];
  const locationSlug = location ? location.name.toLowerCase().replace(/\s+/g, '-') : slug || '';
  // ── LocalBusiness schema ───────────────────────────────────────────────
  // Beefed up beyond the bare HealthClub: geo coords help us appear in the
  // Map Pack; OpeningHoursSpecification renders the open/closed badge in
  // search results; sameAs feeds Google's entity graph (links our Instagram
  // and Facebook to this physical business); paymentAccepted + areaServed
  // are minor but help Google answer voice queries like "gyms near me that
  // take Apple Pay."
  // We deliberately ship multi-type schema: HealthClub + GymCenter so we
  // match both "gym" and "fitness center" queries.
  const locationSchema = seoData ? {
    '@context': 'https://schema.org',
    '@type': ['HealthClub', 'GymCenter', 'LocalBusiness'],
    '@id': `https://betterbodybootcamp.com/locations/${locationSlug}`,
    name: `Better Body Bootcamp ${location!.name}`,
    description: seoData.description,
    url: `https://betterbodybootcamp.com/locations/${locationSlug}`,
    telephone: seoData.phone,
    priceRange: '$$',
    image: 'https://betterbodybootcamp.com/og-image.jpg',
    currenciesAccepted: 'USD',
    paymentAccepted: ['Cash', 'Credit Card', 'Apple Pay', 'Google Pay'],
    address: {
      '@type': 'PostalAddress',
      streetAddress: seoData.address,
      addressLocality: seoData.city,
      addressRegion: seoData.state,
      postalCode: seoData.zip,
      addressCountry: 'US',
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude:  seoData.lat,
      longitude: seoData.lng,
    },
    hasMap: `https://www.google.com/maps/search/?api=1&query=${seoData.lat},${seoData.lng}`,
    // Mon-Sun 06:00 to 21:00 — adjust per studio when we have real hours.
    openingHoursSpecification: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(day => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: day,
      opens: '06:00',
      closes: '21:00',
    })),
    // areaServed lists the studio's own city PLUS the surrounding
    // neighborhoods it draws from. This is a direct relevance signal for
    // "gym / bootcamp / group fitness in <nearby area>" queries — the reach
    // expansion the keyword research identified.
    areaServed: [
      {
        '@type': 'City',
        name: seoData.city,
        containedInPlace: { '@type': 'AdministrativeArea', name: 'New York' },
      },
      ...nearbyAreas.map((area) => ({
        '@type': 'Place',
        name: area,
        containedInPlace: { '@type': 'AdministrativeArea', name: 'New York' },
      })),
    ],
    // sameAs links to the studio's social profiles. Google uses these to
    // confirm the entity is the same business across the web.
    sameAs: [
      ...(seoData.instagram ? [seoData.instagram] : []),
      ...(seoData.facebook  ? [seoData.facebook ] : []),
    ],
    parentOrganization: {
      '@type': 'Organization',
      name: 'Better Body Bootcamp',
      url: 'https://betterbodybootcamp.com',
      sameAs: [
        'https://www.instagram.com/betterbodybootcamp',
        'https://www.facebook.com/betterbodybootcamp',
      ],
    },
    // Business founded 2011 (operating since 2011; ownership changed Oct 2025
    // — that's noted in the FAQ content, but foundingDate = business age,
    // and 15 years of history is a local-trust signal worth claiming).
    foundingDate: '2011',
    knowsAbout: ['Bootcamp Classes', 'Group Fitness', 'Personal Training', 'Strength Training', 'HIIT', 'Cardio'],
  } : undefined;

  // ── FAQ + Service catalog + Speakable schema ───────────────────────────
  // Google AI Overviews / SGE pull citations from FAQPage schema heavily —
  // when someone asks Google "what subway is closest to Better Body Bootcamp
  // Williamsburg" we want the answer + URL to come from us, not a Reddit
  // thread. Same for "how much does bootcamp cost in Astoria" etc.
  //
  // We ship THREE separate JSON-LD blocks per location (in addition to
  // LocalBusiness above):
  //   1. FAQPage — every Q&A pair shows up below as visible content too.
  //   2. ItemList of Service entities (hasOfferCatalog on Org) — connects
  //      "personal training near me" / "group fitness classes Bayside" etc
  //      to this specific studio as the provider.
  //   3. SpeakableSpecification on the FAQ section — voice assistants pick
  //      this up for "Hey Google, what time does Better Body Bootcamp open?"
  // 2026-09-02: surface the new-ownership story everywhere it matters —
  // first FAQ on every studio page (also lands in the FAQPage schema, so
  // Google and AI assistants answer "is BBB under new management" correctly).
  const baseExtras = location ? STUDIO_SEO_EXTRAS[location.name] : undefined;
  const studioExtras = (baseExtras && location) ? {
    ...baseExtras,
    faq: [
      {
        q: `Is Better Body Bootcamp ${location.name} under new ownership?`,
        a: `Yes. Better Body Bootcamp has been under new ownership since October 2025, with new coaches and new programming across all four studios. The ${location.name} community you know is the same; the training, coaching staff, and member experience have been rebuilt from the ground up.`,
      },
      ...baseExtras.faq,
    ],
  } : undefined;
  const pageUrl = `https://betterbodybootcamp.com/locations/${locationSlug}`;

  const faqSchema = (studioExtras && location) ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${pageUrl}#faq`,
    mainEntity: studioExtras.faq.map((entry, idx) => ({
      '@type': 'Question',
      '@id': `${pageUrl}#faq-q${idx + 1}`,
      name: entry.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: entry.a,
      },
    })),
    // Speakable narrows the section a voice assistant reads — point it at
    // the answer paragraphs we render below. css-selector form per schema.org.
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['[data-speakable="faq-answer"]'],
    },
  } : undefined;

  const serviceCatalogSchema = (studioExtras && location && seoData) ? {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${pageUrl}#programs`,
    name: `Programs at Better Body Bootcamp ${location.name}`,
    itemListElement: studioExtras.programs.map((p, idx) => ({
      '@type': 'Service',
      position: idx + 1,
      name: p.name,
      description: p.description,
      areaServed: { '@type': 'City', name: seoData.city },
      provider: {
        '@type': 'HealthClub',
        '@id': pageUrl,
        name: `Better Body Bootcamp ${location.name}`,
      },
      ...(p.price ? {
        offers: {
          '@type': 'Offer',
          price: '49',
          priceCurrency: 'USD',
          description: p.price,
          availability: 'https://schema.org/InStock',
          url: `${pageUrl}#trial`,
        },
      } : {}),
    })),
  } : undefined;

  const allSchemas = [
    locationSchema,
    faqSchema,
    serviceCatalogSchema,
  ].filter(Boolean) as object[];

  useEffect(() => {
    window.scrollTo(0, 0);
    if (slug) {
      fetchLocation();
    }
  }, [slug]);

  // 2026-06-26: reInitMTWidgets useEffect removed — we no longer embed the MT
  // iframe on this page. Native React class list renders via mt-public-classes
  // proxy and handles its own load lifecycle.

  // 2026-06-25: MindBody healcode script-load removed. The MT runtime in
  // index.html scans for [data-mariana-integrations] and mounts iframes —
  // no per-page script injection needed.

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

  const fetchLocation = async () => {
    try {
      const locationName = slug?.split('-').map(word =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(' ');

      console.log('Looking for location:', locationName);

      const { data, error } = await supabase
        .from('locations')
        .select(LOCATION_PUBLIC_COLUMNS)
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

  // 2026-06-25: getLocationImage() removed — hero no longer renders studio
  // photos because the source *-final.webp files are too low-resolution to
  // display at fullscreen without pixelating (Bayside was only 25KB!).
  // The hero now uses a pure CSS gradient treatment. When real BBB studio
  // photography is available, wire it back in here with proper srcset.

  // Always route to the on-site per-studio trial page.
  const getTrialUrl = (locationName: string) => {
    const slug = locationName.toLowerCase().replace(/ /g, '-');
    return `/trial/${slug}`;
  };

  // Trial URLs are always internal app routes now — never external.
  const isExternalTrialUrl = () => false;

  return (
    <>
    <SEOHead
      title={seoData ? seoData.title : (location ? `${location.name} | Better Body Bootcamp NYC` : 'Location | Better Body Bootcamp')}
      description={seoData ? seoData.description : 'Find a Better Body Bootcamp location near you in New York City.'}
      canonical={`/locations/${locationSlug}`}
      schema={allSchemas.length > 0 ? allSchemas : undefined}
    />
    <div className="min-h-screen bg-black">
      {/* 2026-08-25 CLEAN HERO (reference: 1bodytraining.com — Justin: "we
          want it clean"). Still photo, left-aligned editorial layout, solid +
          outlined two-line headline, one quiet subline, rectangular buttons.
          No video, no glow orbs, no dot grid, no icon rows, no scroll cue.
          Content-driven height. */}
      <div className="relative bg-black overflow-hidden">
        {/* 2026-08-25: video background (poster keeps the identical still on
            screen until the clip loads, so there is never a flash or void).
            Same quiet grade as the still — dimmed + partly desaturated — so it
            reads as texture, not noise. */}
        <video
          src="/services/hero.mp4"
          poster="/services/hero-poster.webp"
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover opacity-60"
          style={{ objectPosition: 'center 30%', filter: 'grayscale(35%)' }}
          autoPlay
          muted
          loop
          playsInline
        />
        <div className="absolute inset-0 bg-black/60" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/30" />

        <div className="container mx-auto px-4 sm:px-8 relative z-10 pt-10 pb-14 sm:pt-12 sm:pb-16 lg:pt-16 lg:pb-20">
          <Link
            to="/locations"
            className="inline-flex items-center gap-2 text-white/60 hover:text-white transition-colors text-xs font-bold tracking-[0.2em] uppercase mb-12"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>All Locations</span>
          </Link>

          <div className="max-w-4xl mx-auto text-center">
            <div className="flex items-center justify-center gap-4 mb-6">
              <span className="block w-10 h-px bg-white/50" />
              <span className="text-white/80 text-xs font-bold tracking-[0.35em] uppercase">
                {(seoData?.city || location.name)}, {HERO_BOROUGH[locationSlug ?? ''] ?? 'NY'} &middot; Est. 2011
              </span>
            </div>

            <h1
              className="font-black text-white uppercase leading-[0.88] tracking-tight mb-8"
              style={{ fontFamily: 'BlackLives, sans-serif', fontSize: 'clamp(3rem,8vw,6.5rem)' }}
            >
              {location.name}
              <span
                aria-hidden="true"
                className="block text-transparent"
                style={{ WebkitTextStroke: '2px rgba(255,255,255,0.85)' }}
              >
                {HERO_BOROUGH[locationSlug ?? ''] ?? 'New York'}.
              </span>
            </h1>

<p className="text-white/50 text-sm tracking-wide mb-10">
              {seoData?.address ?? location.address}
              {' '}&middot;{' '}
              <a
                href={`tel:${location.phone.replace(/[^0-9]/g, '')}`}
                className="hover:text-white transition-colors"
              >
                {location.phone}
              </a>
            </p>

            <div className="flex flex-col sm:flex-row justify-center gap-3 sm:gap-4">
              <Link
                to={getTrialUrl(location.name)}
                className="inline-flex items-center justify-center bg-red-600 hover:bg-red-700 text-white text-sm font-bold tracking-[0.15em] uppercase px-8 py-4 transition-colors"
              >
                2 Weeks for $49
              </Link>
              <Link
                to={`/schedule/${locationSlug}`}
                className="inline-flex items-center justify-center border border-white/40 hover:border-white hover:bg-white hover:text-black text-white text-sm font-bold tracking-[0.15em] uppercase px-8 py-4 transition-colors"
              >
                Book a Class
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* 2026-06-26: Native MT booking — no more iframe. NativeClassList hits
          the mt-public-classes Supabase proxy and renders BBB-branded cards
          with real availability + reserve links. Same data, our design. */}
      <div className="bg-white py-12 sm:py-14">
        <div className="container mx-auto px-4">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8">
              <span className="inline-block text-red-600 text-xs font-black tracking-[0.25em] uppercase mb-3">
                This Week
              </span>
              <h2 className="text-[clamp(1.875rem,4vw,3.5rem)] font-black text-black mb-3 tracking-tight">
                Book a Class at {location.name}
              </h2>
              <p className="text-gray-600 text-base sm:text-lg max-w-xl mx-auto">
                Pick a class, reserve your spot — or call the studio to book by phone.
              </p>
            </div>

            {/* 2026-06-26: Native BBB-branded class list. Same data as the MT
                iframe but rendered as React components — full design control,
                no cross-domain handshake. Powered by mt-public-classes proxy. */}
            {MT_LOCATION_IDS[location.name] ? (
              <NativeClassList
                mtLocationId={MT_LOCATION_IDS[location.name]}
                studioName={location.name}
                studioSlug={locationSlug}
                days={7}
                trialHref={`/trial/${locationSlug}`}
              />
            ) : (
              <div className="text-center py-12 text-gray-500 text-sm">
                Schedule loading is temporarily unavailable. Please{' '}
                <a href={`tel:${location.phone.replace(/[^0-9]/g, '')}`} className="text-red-600 font-bold hover:text-red-700">
                  call the studio
                </a>{' '}
                to book.
              </div>
            )}

            <div className="mt-5 text-xs text-gray-500 flex items-center justify-between flex-wrap gap-2 px-1">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Times update live · book directly above.
              </span>
              <a
                href={`tel:${location.phone.replace(/[^0-9]/g, '')}`}
                className="text-red-600 hover:text-red-700 font-semibold inline-flex items-center gap-1"
              >
                <Phone className="w-3.5 h-3.5" />
                Or call {location.phone}
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* ── Programs (dark, full-width — section rhythm break) ── */}
      {studioExtras && (
        <div className="bg-gradient-to-b from-black via-zinc-900 to-black py-14 sm:py-16">
          <div className="container mx-auto px-4">
            <div className="max-w-5xl mx-auto">
              <div className="text-center mb-10">
                <span className="inline-block text-red-500 text-xs font-black tracking-[0.25em] uppercase mb-3">What We Train</span>
                <h2 className="text-[clamp(1.875rem,4vw,3.5rem)] font-black text-white mb-3 tracking-tight">
                  Group Fitness Classes at {location.name}
                </h2>
                <p className="text-gray-400 text-base sm:text-lg max-w-xl mx-auto leading-relaxed">
                  Strength training, HIIT training, bootcamp classes, hybrid training, small group training, and 1-on-1 personal training. Every session is programmed.
                </p>
                <p className="mt-4 inline-flex items-center gap-2 text-xs font-black tracking-[0.2em] uppercase text-red-500 border border-red-500/40 rounded-full px-4 py-2">
                  New ownership · New coaches · Since October 2025
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
                {studioExtras.programs.map((p, i) => {
                  const Icon = PROGRAM_ICONS[i] || Dumbbell;
                  return (
                    <div
                      key={p.name}
                      className="group relative bg-zinc-900/70 border border-white/10 hover:border-red-500/60 rounded-2xl p-6 transition-all duration-300 hover:-translate-y-1 hover:bg-zinc-900"
                    >
                      <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-red-600/15 group-hover:bg-red-600 transition-colors mb-4">
                        <Icon className="w-5 h-5 text-red-400 group-hover:text-white transition-colors" />
                      </div>
                      <h3 className="text-base sm:text-lg font-black text-white mb-2 tracking-tight">{p.name}</h3>
                      <p className="text-sm text-gray-400 leading-relaxed">{p.description}</p>
                    </div>
                  );
                })}
              </div>

              {/* Areas we serve — visible on-page content that mirrors the
                  areaServed schema. Targets "gym / bootcamp / group fitness in
                  <nearby neighborhood>" so the page ranks beyond the exact
                  block the studio sits on. */}
              {nearbyAreas.length > 0 && (
                <p className="mt-9 text-center text-gray-400 text-sm sm:text-[15px] leading-relaxed max-w-3xl mx-auto">
                  Better Body Bootcamp is a coach-led <span className="text-gray-200 font-semibold">gym in {location.name}</span>, also serving nearby{' '}
                  {nearbyAreas.join(', ')} with bootcamp, HIIT, strength &amp; group fitness classes for every level.
                </p>
              )}

              {/* 2026-08-23 on-page checker: per-studio positioning line — natural
                  comparison framing + "fitness goals" semantic term. */}
              {STUDIO_POSITIONING[location.slug] && (
                <p className="mt-4 text-center text-gray-400 text-sm sm:text-[15px] leading-relaxed max-w-3xl mx-auto">
                  {STUDIO_POSITIONING[location.slug]}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Real Google reviews for THIS studio (2026-09-02) ── */}
      <StudioReviews studio={location.name} />

      {/* ── FAQ (light gray, full-width, top 5 visible by default) ── */}
      {studioExtras && (
        <div id="faq" className="bg-gray-50 py-14 sm:py-16 border-t border-gray-100">
          <div className="container mx-auto px-4">
            <div className="max-w-5xl mx-auto">
              <div className="text-center mb-8">
                <span className="inline-block text-red-600 text-xs font-black tracking-[0.25em] uppercase mb-3">Common Questions</span>
                <h2 className="text-[clamp(1.875rem,4vw,3.5rem)] font-black text-black mb-3 tracking-tight">
                  Frequently Asked
                </h2>
                <p className="text-gray-600 text-base sm:text-lg max-w-md mx-auto leading-relaxed">
                  Everything you need to know about training at {location.name}.
                </p>
              </div>
              <div className="space-y-3">
                {studioExtras.faq.slice(0, 5).map((entry, idx) => (
                  <details
                    key={idx}
                    className="group bg-white border border-gray-200 hover:border-red-300 open:border-red-400 open:shadow-md rounded-2xl px-5 sm:px-6 py-4 transition-all"
                    {...(idx === 0 ? { open: true } : {})}
                  >
                    <summary className="cursor-pointer font-bold text-black text-[15px] sm:text-base tracking-tight list-none flex items-start justify-between gap-4">
                      <span className="flex-1 pr-2 leading-snug">{entry.q}</span>
                      <span className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-red-50 group-open:bg-red-600 text-red-600 group-open:text-white transition-colors">
                        <span className="text-lg leading-none inline-block group-open:rotate-45 transition-transform">+</span>
                      </span>
                    </summary>
                    <p
                      className="mt-4 pt-4 border-t border-gray-100 text-gray-700 text-[15px] leading-relaxed"
                      data-speakable="faq-answer"
                    >
                      {entry.a}
                    </p>
                  </details>
                ))}
                {studioExtras.faq.length > 5 && (
                  <details className="group bg-white border border-gray-200 hover:border-red-300 open:border-red-400 open:shadow-md rounded-2xl px-5 sm:px-6 py-4 transition-all">
                    <summary className="cursor-pointer font-bold text-red-600 text-[15px] sm:text-base tracking-tight list-none flex items-center justify-between gap-4">
                      <span>Show {studioExtras.faq.length - 5} more questions</span>
                      <span className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-red-50 group-open:bg-red-600 text-red-600 group-open:text-white transition-colors">
                        <span className="text-lg leading-none inline-block group-open:rotate-45 transition-transform">+</span>
                      </span>
                    </summary>
                    <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                      {studioExtras.faq.slice(5).map((entry, idx) => (
                        <details
                          key={idx}
                          className="group/inner bg-gray-50 border border-gray-200 hover:border-red-300 open:border-red-400 rounded-xl px-4 sm:px-5 py-3 transition-all"
                        >
                          <summary className="cursor-pointer font-bold text-black text-[14px] sm:text-[15px] tracking-tight list-none flex items-start justify-between gap-4">
                            <span className="flex-1 pr-2 leading-snug">{entry.q}</span>
                            <span className="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-50 group-open/inner:bg-red-600 text-red-600 group-open/inner:text-white transition-colors">
                              <span className="text-base leading-none inline-block group-open/inner:rotate-45 transition-transform">+</span>
                            </span>
                          </summary>
                          <p
                            className="mt-3 pt-3 border-t border-gray-200 text-gray-700 text-[14px] leading-relaxed"
                            data-speakable="faq-answer"
                          >
                            {entry.a}
                          </p>
                        </details>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Other studios (cross-links: visitor flow + SEO internal linking) ── */}
      <div className="bg-zinc-950 py-14 sm:py-16 border-t border-white/5">
        <div className="container mx-auto px-4">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-9">
              <span className="inline-block text-red-500 text-xs font-black tracking-[0.25em] uppercase mb-3">The BBB Network</span>
              <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-black text-white mb-3 tracking-tight">
                Other Studios Near You
              </h2>
              <p className="text-gray-400 text-base max-w-lg mx-auto leading-relaxed">
                Your $49 trial works at any Better Body Bootcamp. Explore the rest of the network.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {ALL_STUDIOS.filter((s) => s.name !== location.name).map((s) => (
                <Link
                  key={s.slug}
                  to={`/locations/${s.slug}`}
                  className="group bg-zinc-900/70 border border-white/10 hover:border-red-500/60 rounded-2xl p-6 transition-all duration-300 hover:-translate-y-1 hover:bg-zinc-900"
                >
                  <div className="flex items-center gap-2 text-red-400 mb-2">
                    <MapPin className="w-4 h-4" />
                    <span className="text-[11px] font-black tracking-[0.2em] uppercase">{s.borough}</span>
                  </div>
                  <h3 className="text-lg font-black text-white mb-1 tracking-tight group-hover:text-red-400 transition-colors">
                    {s.name}
                  </h3>
                  <p className="text-sm text-gray-400 mb-4">{s.address}</p>
                  <span className="inline-flex items-center gap-1 text-sm font-bold text-white/80 group-hover:text-white transition-colors">
                    View studio
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                  </span>
                </Link>
              ))}
            </div>
            {['Astoria', 'Bayside', 'Fresh Meadows'].includes(location.name) && (
              <div className="text-center mt-8">
                <Link
                  to="/queens"
                  className="inline-flex items-center gap-2 text-red-400 hover:text-red-300 font-bold text-sm tracking-wide"
                >
                  See all gyms in Queens
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            )}
            {location.name === 'Williamsburg' && (
              <div className="text-center mt-8">
                <Link
                  to="/brooklyn"
                  className="inline-flex items-center gap-2 text-red-400 hover:text-red-300 font-bold text-sm tracking-wide"
                >
                  See all gyms in Brooklyn
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── CTA strip (black) ── */}
      <div className="bg-black py-14 sm:py-16">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto">
            <div className="bg-gradient-to-br from-zinc-900 to-black border border-red-900/30 rounded-3xl p-10 sm:p-12 text-center shadow-2xl">
              <h2 className="text-[clamp(2rem,4vw,4rem)] font-black text-white mb-4 tracking-tight">Ready to Get Started?</h2>
              <p className="text-white/80 text-lg mb-8 max-w-2xl mx-auto leading-relaxed">
                Two weeks of unlimited classes at {location.name} for $49. Come see what coached training actually feels like.
              </p>
              {isExternalTrialUrl() ? (
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

    </div>
    </>
  );
}
