// ─── Per-studio FAQ data + neighborhood entity facts ──────────────────────
//
// What this is for:
//   1. FAQPage schema on every /locations/[slug] page so Google AI Overviews
//      can directly cite the answer when someone asks the question.
//   2. Visible Q&A content block on the same page (AI extracts from both the
//      schema AND the in-text content — having them match doubles surface).
//   3. Service catalog (hasOfferCatalog) so Google connects "bootcamp class
//      near me" / "personal training in Williamsburg" to this studio.
//
// Questions are written to match real searches — neighborhood, subway, parking,
// price, beginner-friendliness, what to bring. Answers are studio-specific
// where useful (subway, parking, landmarks) and shared where the answer is the
// same network-wide (membership terms, cancellation, what to bring).
//
// Update guidance:
// - Keep answers under ~75 words. AI Overviews chunk by paragraph.
// - Include the exact branded phrase "Better Body Bootcamp <Studio>" in
//   ~50% of answers so the entity-to-answer association is strong.
// - Don't repeat the same phrase verbatim 12 times; vary the language so
//   the page reads naturally to a human, not just a crawler.
// ────────────────────────────────────────────────────────────────────────────

export type StudioFaqEntry = { q: string; a: string };

export type StudioSeoExtras = {
  // Programs offered at this studio — feeds hasOfferCatalog as Service entities.
  programs: Array<{ name: string; description: string; price?: string }>;
  // Surrounding neighborhoods this studio realistically serves. Baked into
  // areaServed schema + a visible "Areas we serve" block so the page ranks for
  // "gym/bootcamp/group fitness in <nearby area>" — the reach expansion the
  // keyword research flagged (most searchers use the neighborhood, not the exact
  // one the studio sits in).
  nearbyAreas: string[];
  // Neighborhood entity facts — power the local Q&A answers AND optionally
  // surface as visible "About the neighborhood" blocks if we want them later.
  neighborhood: {
    nearestSubway: string;
    parking: string;
    landmarks: string;
  };
  faq: StudioFaqEntry[];
};

// Shared answers used across all 4 studios. Defined once and folded into each
// studio's faq array so updates land in one place.
const SHARED = {
  trial: 'The two-week trial is $49 for new members and unlocks unlimited classes for 14 days. Sign up online and your first class is bookable as soon as you finish payment.',
  beginners: 'Yes. Every class is coached and every movement is scaled to your level. About half of new members start as beginners and ramp up over their first month. You will not be the only first-timer in the room.',
  whatToBring: 'Bring athletic shoes, comfortable workout clothes, a water bottle, and a sweat towel. We provide every piece of equipment you need. Arrive 10–15 minutes before your first class so the coach can show you around.',
  cancellation: 'Classes can be cancelled up to 2 hours before start time at no charge through the Better Body Studios app. Late cancellations may carry a small fee. Membership terms vary by package — check your agreement or call your home studio.',
  schedule: 'Most studios run morning blocks (typically 6am–10am), a midday window, and an evening block (typically 5pm–8pm). The live schedule on each studio page shows exact class times for the next two weeks.',
  membership: 'Monthly memberships start around $189/mo for unlimited classes. Six-month and yearly options bring the per-month rate down. Personal training packages and pay-per-class drop-ins are also available — ask the studio for the current price sheet.',
  personalTraining: 'Yes. One-on-one and small-group personal training is available at every studio with the same coaches who run the group classes. Sessions are booked through the Better Body Studios app or in-studio at the front desk.',
  showers: 'Amenities vary by studio. Every location has changing rooms, lockers, and water refill stations. Call your home studio for specifics on showers and additional amenities.',
  difference: 'Better Body Bootcamp is a coached group-strength program, not a self-serve gym floor. Every workout is programmed in advance, every class has a coach in the room, and the focus is real strength and conditioning — not just sweat.',
};

const PROGRAMS_DEFAULT: StudioSeoExtras['programs'] = [
  { name: 'Bootcamp Classes',     description: 'Coached group-strength + conditioning classes blending HIIT intervals with progressive strength training.', price: '$49 two-week trial' },
  { name: 'Personal Training',    description: 'One-on-one and small-group personal training sessions with the same expert coaches who run the group classes.' },
  { name: 'Group Strength',       description: 'Programmed strength workouts in a small-group setting — barbell, dumbbell, and bodyweight progressions.' },
  { name: 'HIIT & Conditioning',  description: 'High-intensity interval training built into every class for cardiovascular conditioning and fat loss.' },
];

// ────────────────────────────────────────────────────────────────────────────
// Per-studio data.
//
// Key = exact location.name (matches LOCATION_SEO map in LocationDetail.tsx).
// ────────────────────────────────────────────────────────────────────────────

export const STUDIO_SEO_EXTRAS: Record<string, StudioSeoExtras> = {

  'Astoria': {
    programs: PROGRAMS_DEFAULT,
    nearbyAreas: ['Long Island City', 'Sunnyside', 'Woodside', 'Ditmars', 'Astoria Heights'],
    neighborhood: {
      nearestSubway: 'The N and W trains at Astoria Blvd are about a 5-minute walk; the R/W at Steinway St is a 10-minute walk.',
      parking: 'Street parking along Steinway Street and the surrounding side streets is generally easy mid-morning and evening. Metered weekday parking applies on the main commercial strip.',
      landmarks: 'We are on the Steinway Street commercial strip, near the Museum of the Moving Image and the Kaufman Astoria Studios district.',
    },
    faq: [
      { q: 'Where is Better Body Bootcamp Astoria located?',
        a: 'Better Body Bootcamp Astoria is at 31-18 Steinway Street, Astoria, NY 11103, in the heart of the Steinway Street shopping corridor.' },
      { q: 'Where can I find a bootcamp, HIIT, or group fitness class near me in Astoria?',
        a: 'Better Body Bootcamp Astoria runs coach-led bootcamp, HIIT, strength, and group fitness classes every day on Steinway Street — serving Astoria, Long Island City, Sunnyside, Woodside, and Ditmars. It is a gym built around real coaching, not a self-serve floor. New members get two weeks of unlimited classes for $49.' },
      { q: 'Is Better Body Bootcamp a good gym in Astoria, Queens?',
        a: 'We are a coach-led gym on Steinway Street in Astoria, Queens, and one of the higher-rated gyms in this part of NYC. A coach runs the full hour of every class, so you get real cueing instead of wandering a machine floor alone. Easy to reach from the N and W trains at Astoria Blvd. Your first two weeks are $49.' },
      { q: 'What is the closest subway to Better Body Bootcamp Astoria?',
        a: 'The N and W trains at Astoria Blvd are about a 5-minute walk. The R and W trains at Steinway St are about a 10-minute walk. Several bus lines stop directly on Steinway.' },
      { q: 'Is there parking near Better Body Bootcamp Astoria?',
        a: 'Street parking along Steinway Street and the side streets is generally easy mid-morning and evening. Metered weekday parking applies on the main commercial strip.' },
      { q: 'How much does Better Body Bootcamp Astoria cost?',         a: SHARED.membership },
      { q: 'Does Better Body Bootcamp Astoria have a free trial?',     a: SHARED.trial },
      { q: 'What time do classes start at Better Body Bootcamp Astoria?', a: SHARED.schedule },
      { q: 'Can complete beginners join Better Body Bootcamp Astoria?',  a: SHARED.beginners },
      { q: 'What should I bring to my first class at Better Body Bootcamp Astoria?', a: SHARED.whatToBring },
      { q: 'Does Better Body Bootcamp Astoria offer personal training?', a: SHARED.personalTraining },
      { q: 'Does Better Body Bootcamp Astoria have showers?',           a: SHARED.showers },
      { q: 'What is the cancellation policy?',                          a: SHARED.cancellation },
      { q: 'What makes Better Body Bootcamp different from a regular Astoria gym?', a: SHARED.difference },
      { q: 'How does Better Body Bootcamp compare to Blink Fitness, Planet Fitness, or Club Fitness in Astoria?',
        a: 'Big-box gyms in Astoria like Blink Fitness, Planet Fitness, and Club Fitness give you equipment and space, and they are a good fit if you already know your way around a training program. Better Body Bootcamp is the opposite model: every class is a coached small group where a coach programs and runs every session, and you are corrected and pushed every set. If you want a floor of machines, they do that well. If you want coaching, that is us. The $49 two-week trial exists so you can compare for yourself.' },
      { q: 'Is Better Body Bootcamp Astoria under new ownership?',
        a: 'Yes. The Astoria studio came under new ownership in October 2025. The original Better Body Bootcamp program and coaching staff remain in place; ownership change brought updated facilities and a refreshed schedule.' },
    ],
  },

  'Bayside': {
    programs: PROGRAMS_DEFAULT,
    nearbyAreas: ['Bay Terrace', 'Whitestone', 'Auburndale', 'Douglaston', 'Little Neck', 'Oakland Gardens'],
    neighborhood: {
      nearestSubway: 'The LIRR Bayside station is about a 3-minute walk on Bell Blvd. The Q12, Q13, Q31, and Q88 buses all stop within two blocks.',
      parking: 'Free street parking is generally available on Bell Blvd and the side streets. Municipal lots near 41st Ave provide additional metered parking.',
      landmarks: 'We are on Bell Blvd in the heart of the Bayside shopping district, walking distance from Bell Park, the Bay Terrace shopping center, and the LIRR station.',
    },
    faq: [
      { q: 'Where is Better Body Bootcamp Bayside located?',
        a: 'Better Body Bootcamp Bayside is at 34-47 Bell Blvd, Bayside, NY 11361, on the main Bell Blvd shopping strip a few blocks from the LIRR station.' },
      { q: 'Where can I find a bootcamp, HIIT, or group fitness class near me in Bayside?',
        a: 'Better Body Bootcamp Bayside offers coach-led bootcamp, HIIT, strength, and group fitness classes daily on Bell Blvd — serving Bayside, Bay Terrace, Whitestone, Auburndale, Douglaston, and Little Neck. It is a coaching-first gym, not a self-serve floor. New members get two weeks of unlimited classes for $49.' },
      { q: 'Looking for a gym in Bayside, Queens?',
        a: 'Better Body Bootcamp is a coach-led gym on Bell Blvd in Bayside, Queens, a few minutes from the LIRR. Every class is a coached small group with a coach programming every session, so it is real coaching, not a self-serve floor. Free street parking is usually easy nearby. Your first two weeks are $49.' },
      { q: 'What is the closest train to Better Body Bootcamp Bayside?',
        a: 'The LIRR Bayside station is about a 3-minute walk on Bell Blvd. The Q12, Q13, Q31, and Q88 buses also serve the area within two blocks.' },
      { q: 'Is there parking at Better Body Bootcamp Bayside?',
        a: 'Yes. Free street parking is generally available on Bell Blvd and surrounding side streets. Municipal lots near 41st Ave provide additional metered parking for longer visits.' },
      { q: 'How much does Better Body Bootcamp Bayside cost?',         a: SHARED.membership },
      { q: 'Does Better Body Bootcamp Bayside offer a free trial?',    a: SHARED.trial },
      { q: 'What time do classes start at Better Body Bootcamp Bayside?', a: SHARED.schedule },
      { q: 'Can complete beginners join Better Body Bootcamp Bayside?',   a: SHARED.beginners },
      { q: 'What should I bring to my first class at Better Body Bootcamp Bayside?', a: SHARED.whatToBring },
      { q: 'Does Better Body Bootcamp Bayside offer personal training?', a: SHARED.personalTraining },
      { q: 'Does Better Body Bootcamp Bayside have showers?',           a: SHARED.showers },
      { q: 'What is the class cancellation policy?',                    a: SHARED.cancellation },
      { q: 'What makes Better Body Bootcamp different from other Bayside gyms?', a: SHARED.difference },
      { q: 'Is Better Body Bootcamp Bayside under new ownership?',
        a: 'Yes. The Bayside studio came under new ownership in October 2025. The original Better Body Bootcamp program and most coaching staff remain. The new ownership team is investing in equipment and member experience.' },
    ],
  },

  'Fresh Meadows': {
    programs: PROGRAMS_DEFAULT,
    nearbyAreas: ['Utopia', 'Hillcrest', 'Jamaica Estates', 'Flushing', 'Kew Gardens Hills', 'Briarwood'],
    neighborhood: {
      nearestSubway: 'Fresh Meadows is primarily served by buses — the Q30, Q31, Q75, Q88, and Q17 all stop within a few blocks. The nearest subway is the F train at 169th St, about a 12-minute drive.',
      parking: 'Easy street parking on 164th Street and the surrounding residential blocks. The neighborhood is largely drive-up — most members park within a block.',
      landmarks: 'We are minutes from Cunningham Park, the Long Island Expressway, and the Fresh Meadows Shopping Center on Horace Harding Expressway.',
    },
    faq: [
      { q: 'Where is Better Body Bootcamp Fresh Meadows located?',
        a: 'Better Body Bootcamp Fresh Meadows is at 76-46 164th Street, Fresh Meadows, NY 11366, minutes from Cunningham Park and the Long Island Expressway.' },
      { q: 'Where can I find a bootcamp, HIIT, or group fitness class near me in Fresh Meadows?',
        a: 'Better Body Bootcamp Fresh Meadows runs coach-led bootcamp, HIIT, strength, and group fitness classes daily on 164th Street — serving Fresh Meadows, Utopia, Hillcrest, Jamaica Estates, Flushing, and Kew Gardens Hills. It is a coaching-first gym, not a self-serve floor. New members get two weeks of unlimited classes for $49.' },
      { q: 'Is there a good gym in Fresh Meadows, Queens?',
        a: 'Better Body Bootcamp is a coach-led gym on 164th Street in Fresh Meadows, Queens, with the easy street parking most members use. Every class is a coached small group and a coach runs the full session, so you get real coaching over a machine floor. Your first two weeks are $49.' },
      { q: 'How do I get to Better Body Bootcamp Fresh Meadows by transit?',
        a: 'Fresh Meadows is primarily served by buses — the Q30, Q31, Q75, Q88, and Q17 all stop within a few blocks. The nearest subway is the F train at 169th St, about a 12-minute drive.' },
      { q: 'Is parking easy at Better Body Bootcamp Fresh Meadows?',
        a: 'Yes. Street parking on 164th Street and the surrounding residential blocks is consistently easy. Most members park within a block of the door.' },
      { q: 'How much does Better Body Bootcamp Fresh Meadows cost?',  a: SHARED.membership },
      { q: 'Does Better Body Bootcamp Fresh Meadows offer a free trial?', a: SHARED.trial },
      { q: 'What time are classes at Better Body Bootcamp Fresh Meadows?', a: SHARED.schedule },
      { q: 'Can beginners join Better Body Bootcamp Fresh Meadows?',     a: SHARED.beginners },
      { q: 'What should I bring to my first class at Better Body Bootcamp Fresh Meadows?', a: SHARED.whatToBring },
      { q: 'Does Better Body Bootcamp Fresh Meadows offer personal training?', a: SHARED.personalTraining },
      { q: 'Does Better Body Bootcamp Fresh Meadows have showers?',     a: SHARED.showers },
      { q: 'What is the cancellation policy?',                           a: SHARED.cancellation },
      { q: 'What makes Better Body Bootcamp different from other Fresh Meadows gyms?', a: SHARED.difference },
      { q: 'Is Better Body Bootcamp Fresh Meadows under new ownership?',
        a: 'Yes. The Fresh Meadows studio came under new ownership in October 2025. The original program and coaches are still in place, with the new ownership investing in equipment and the member experience.' },
    ],
  },

  'Williamsburg': {
    programs: PROGRAMS_DEFAULT,
    nearbyAreas: ['Greenpoint', 'East Williamsburg', 'Bushwick', 'Bedford-Stuyvesant'],
    neighborhood: {
      nearestSubway: 'The L train at Bedford Ave is about a 6-minute walk. The G train at Metropolitan Ave / Lorimer St is about a 12-minute walk.',
      parking: 'Street parking in Williamsburg is limited and metered weekdays. Most members take the L train or bike. Citi Bike stations are within two blocks.',
      landmarks: 'We are on Driggs Ave near McCarren Park, walking distance from the Williamsburg Bridge waterfront and the Bedford Ave commercial strip.',
    },
    faq: [
      { q: 'Where is Better Body Bootcamp Williamsburg located?',
        a: 'Better Body Bootcamp Williamsburg is at 487 Driggs Ave, Brooklyn, NY 11211, walking distance from McCarren Park and the Williamsburg Bridge waterfront.' },
      { q: 'Where can I find a bootcamp, HIIT, or group fitness class near me in Williamsburg?',
        a: 'Better Body Bootcamp Williamsburg offers coach-led bootcamp, HIIT, strength, and group fitness classes daily on Driggs Ave — serving Williamsburg, Greenpoint, East Williamsburg, and Bushwick. It is a coaching-first gym, not a self-serve floor. New members get two weeks of unlimited classes for $49.' },
      { q: 'Is Better Body Bootcamp a real gym in Williamsburg, Brooklyn?',
        a: 'Yes. We are a coaching-first gym on Driggs Ave in Williamsburg, Brooklyn, a few minutes from the Bedford Ave L. It is not a floor of machines you figure out alone. Every class is a coached small group run by a coach who programs the workout and learns your name. Your first two weeks are $49.' },
      { q: 'What is the closest subway to Better Body Bootcamp Williamsburg?',
        a: 'The L train at Bedford Ave is about a 6-minute walk. The G train at Metropolitan Ave or Lorimer St is about a 12-minute walk. Multiple bus lines also serve the area.' },
      { q: 'Is there parking near Better Body Bootcamp Williamsburg?',
        a: 'Street parking in Williamsburg is limited and metered on weekdays. Most members take the L train or bike — Citi Bike stations are within two blocks of the door.' },
      { q: 'How much does Better Body Bootcamp Williamsburg cost?',    a: SHARED.membership },
      { q: 'Does Better Body Bootcamp Williamsburg have a free trial?', a: SHARED.trial },
      { q: 'What time are classes at Better Body Bootcamp Williamsburg?', a: SHARED.schedule },
      { q: 'Can complete beginners join Better Body Bootcamp Williamsburg?', a: SHARED.beginners },
      { q: 'What should I bring to my first class at Better Body Bootcamp Williamsburg?', a: SHARED.whatToBring },
      { q: 'Does Better Body Bootcamp Williamsburg offer personal training?', a: SHARED.personalTraining },
      { q: 'Does Better Body Bootcamp Williamsburg have showers?',     a: SHARED.showers },
      { q: 'What is the cancellation policy?',                          a: SHARED.cancellation },
      { q: 'What makes Better Body Bootcamp different from other Williamsburg gyms?', a: SHARED.difference },
      { q: 'Is Better Body Bootcamp Williamsburg under new ownership?',
        a: 'Yes. The Williamsburg studio came under new ownership in October 2025. The original Better Body Bootcamp program and coaching staff remain in place; ownership change brought updated facilities.' },
    ],
  },

};
