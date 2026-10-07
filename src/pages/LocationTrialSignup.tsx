import { useState, useEffect, useRef } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { CheckCircle, Lock } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import { getUtmParams, captureUtmsFromUrl } from '../lib/utm';
import { getVariant } from '../lib/abTest';
import { visitorId } from '../lib/visitor';

// ─── PER-GYM CONFIG ─────────────────────────────────────────────────────────
// `locationId` is the Supabase row UUID for the gym. The edge function
// `create-trial-checkout` looks up that row to find the gym's stripe_secret_key
// and stripe_price_id, so each gym charges to its own Stripe account.
// Address/phone/image are hardcoded here to keep first-paint fast (no Supabase
// fetch needed). Verified against the locations table on 2026-05-15.
// ─────────────────────────────────────────────────────────────────────────────
type LocationConfig = {
  slug: string;
  locationId: string;
  name: string;
  badge: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  image: string;
  metaPixelId: string | null; // each gym has its own Meta Pixel for ad attribution
  // 2026-06-29: per-studio Mariana Tek location ID. Used to scope the
  // /intro-offers widget so the customer only sees this studio's $49 trial
  // pass option (not all 4 studios' offers). Verified live in mt-public-classes
  // calls + WidgetLab.tsx.
  mtLocationId: number;
  // 2026-06-19: pre-rendered hero banner. When set, the trial page swaps the
  // gradient hero for this branded banner image (image already contains the
  // "TWO WEEKS FOR $49" headline + studio name baked in). Mobile + desktop
  // variants are crops of the same design tuned for each viewport.
  heroImageWeb?: string;
  heroImageMobile?: string;
};

const LOCATIONS: Record<string, LocationConfig> = {
  'astoria': {
    slug: 'astoria',
    locationId: 'dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45',
    name: 'Astoria',
    badge: 'ASTORIA · QUEENS',
    address: '31-18 Steinway Street',
    city: 'Astoria',
    state: 'NY',
    zip: '11103',
    phone: '(718) 704-9954',
    image: '/astoria-final.webp',
    metaPixelId: '1291566006435758',
    mtLocationId: 48717,
  },
  'bayside': {
    slug: 'bayside',
    locationId: '5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7',
    name: 'Bayside',
    badge: 'BAYSIDE · QUEENS',
    address: '34-47 Bell Blvd',
    city: 'Bayside',
    state: 'NY',
    zip: '11361',
    phone: '(917) 877-0759',
    image: '/bayside-final.webp',
    metaPixelId: '931144729719242',
    mtLocationId: 48718,
    heroImageWeb: '/bayside-hero-web.jpg',
    heroImageMobile: '/bayside-hero-mobile.jpg',
  },
  'fresh-meadows': {
    slug: 'fresh-meadows',
    locationId: '6bbbe077-bcc6-4d9d-a10b-7605c1484752',
    name: 'Fresh Meadows',
    badge: 'FRESH MEADOWS · QUEENS',
    address: '76-46 164th Street',
    city: 'Fresh Meadows',
    state: 'NY',
    zip: '11366',
    phone: '(646) 887-6483',
    image: '/freshmeadows-final.webp',
    metaPixelId: '979328851475276',
    mtLocationId: 48719,
    heroImageWeb: '/fresh-meadows-hero-web.jpg',
    heroImageMobile: '/fresh-meadows-hero-mobile.jpg',
  },
  'williamsburg': {
    slug: 'williamsburg',
    locationId: '80536b45-df0e-42d1-880c-e9301372e1cf',
    name: 'Williamsburg',
    badge: 'WILLIAMSBURG · BROOKLYN',
    address: '487 Driggs Ave',
    city: 'Brooklyn',
    state: 'NY',
    zip: '11211',
    phone: '(718) 683-1864',
    image: '/williamsburg-final.webp',
    metaPixelId: '2160299368182872',
    mtLocationId: 48720,
  },
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Meta Pixel — typed globally so TS doesn't complain when we call window.fbq()
declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    _fbq?: unknown;
    // 2026-06-29: MT Web Integrations runtime — loaded site-wide via
    // index.html. .render(selector) (re-)mounts whichever
    // [data-mariana-integrations] div matches the selector.
    MTIntegrations?: { render: (selector?: string) => void };
  }
}

/**
 * Inject the Meta Pixel <script> for a specific gym, fire PageView once, and
 * return a cleanup function. We re-init the pixel for whichever gym the user
 * lands on so the conversion goes to that gym's Ads Manager.
 */
function loadMetaPixel(pixelId: string): () => void {
  if (typeof window === 'undefined') return () => {};
  const SCRIPT_ID = `meta-pixel-${pixelId}`;
  // Avoid double-injecting if the user re-navigates within SPA
  if (document.getElementById(SCRIPT_ID)) {
    window.fbq?.('init', pixelId);
    window.fbq?.('track', 'PageView');
    return () => {};
  }
  // Standard Meta Pixel snippet, inlined so we can scope it per-gym
  const inline = document.createElement('script');
  inline.id = SCRIPT_ID;
  // 2026-07-02 (QA #8): the MT buy widget rewrites the URL (?_mt=/buy/…),
  // which Meta's pixel auto-catches as a SECOND PageView (ec=1 then ec=2),
  // inflating PageView volume + frequency. `autoConfig=false` disables Meta's
  // automatic SPA/pushState pageview + button auto-tracking for this pixel, so
  // the only PageView that fires is our single explicit one below.
  inline.text = `
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('set', 'autoConfig', false, '${pixelId}');
    fbq('init', '${pixelId}');
    fbq('track', 'PageView');
  `;
  document.head.appendChild(inline);
  // <noscript> fallback for bots / no-JS visitors
  const ns = document.createElement('noscript');
  ns.id = `${SCRIPT_ID}-ns`;
  ns.innerHTML = `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1" />`;
  document.head.appendChild(ns);
  return () => {
    document.getElementById(SCRIPT_ID)?.remove();
    document.getElementById(`${SCRIPT_ID}-ns`)?.remove();
  };
}

// Meta click identifiers for server-side Conversions API matching.
// _fbp is set by the pixel on every visit; _fbc is set when the visitor
// arrived from an ad (fbclid). These are the strongest signals Meta uses to
// tie a server-side Purchase event back to the ad that drove it — without
// them, ad conversions under-report badly. Threaded through checkout ->
// Stripe metadata -> stripe-webhook -> CAPI.
function getMetaClickIds(): { fbp: string; fbc: string } {
  if (typeof document === 'undefined') return { fbp: '', fbc: '' };
  const readCookie = (name: string): string => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  let fbc = readCookie('_fbc');
  if (!fbc) {
    const fbclid = new URLSearchParams(window.location.search).get('fbclid');
    if (fbclid) fbc = `fb.1.${Date.now()}.${fbclid}`;
  }
  return { fbp: readCookie('_fbp'), fbc };
}

export default function LocationTrialSignup() {
  const { location: locationParam } = useParams<{ location: string }>();
  // 2026-06-29: BBB Stripe form replaced by MT widget. The form state
  // (firstName/lastName/email/phone/smsConsent/newsletter), handleChange,
  // handleSubmit, isProcessing/error/submittingRef — all removed. MT now
  // owns the full transaction. Pixel + UTM + soft-conversion remain.
  const pageLoadAtRef = useRef<number>(Date.now());

  // ── 2026-07-01 BAYSIDE-ONLY STRIPE CHECKOUT OVERRIDE ────────────────────
  // 2026-07 RESOLVED: Bayside now uses the Mariana Tek buy widget like every
  // other studio. The earlier Stripe fallback (task #498) assumed the $49 trial
  // contract (memberships-14721) was Astoria-single-location. Verified directly
  // in MT admin (Products → Memberships → Contracts → "$49 Two Weeks Trial",
  // id 14721): it is ACTIVE and sellable at ALL FOUR locations — Astoria (48717),
  // Bayside (48718), Fresh Meadows (48719), Williamsburg (48720). The prior
  // read of "Astoria-only" was a different, inactive product ("Trial Offer Tags"
  // type), not the live trial. With the contract sellable at Bayside, the MT
  // widget routes /buy/48718 correctly — no more checkout rewrite to Astoria —
  // and MT takes the payment into its own Stripe + grants the pass + activates
  // the member automatically. This kills the parallel Stripe checkout that was
  // collecting money without provisioning the member in MT.
  //
  // The Bayside Stripe form + handleBaysideSubmit below are now dead code, kept
  // temporarily behind this flag for a fast rollback. Verify one real Bayside
  // trial end-to-end, then delete the fallback block entirely.
  //
  // ── 2026-08-28: NATIVE CHECKOUT FOR ALL STUDIOS — MT IFRAME KILLED ──────
  // Justin: "get rid of that ugly iframe... for ALL parts on the website."
  // The "Bayside fallback" Stripe form below is now the PRIMARY flow for all
  // four studios: create-trial-checkout is fully multi-location (per-studio
  // Stripe keys in the locations table, task #382 verified), and the missing
  // half — MT provisioning — is solved: stripe-webhook now fires mt-provision,
  // which creates the MT user + cart + $49 contract + alt-payment order via
  // the Admin API. Same outcome as the widget, no iframe, no login wall,
  // and paid-but-not-provisioned is structurally impossible (dead-letter +
  // SMS alert + retry on any MT failure).
  // Instant rollback: set this back to false and redeploy — widget returns.
  const useBaysideFallback = true;
  const [baysideForm,       setBaysideForm]       = useState({
    firstName: '', lastName: '', email: '', phone: '', newsletter: false,
  });
  // ── 2026-09-03: CARD CAPTURE THROUGH MT'S STRIPE (Justin, ~3 months asking).
  // The form now takes the card directly and posts to mt-card-checkout, which
  // stores the card in Mariana Tek (MT tokenizes into ITS Stripe) and charges
  // it there. Our Stripe is out of the money path; the customer gets a real
  // "$49 Two Weeks Trial (Web)" membership + card on file, instantly.
  const [cardForm, setCardForm] = useState({ number: '', exp: '', ccv: '', zip: '' });
  const [baysideSubmitting, setBaysideSubmitting] = useState(false);
  const [baysideError,      setBaysideError]      = useState('');
  const baysideSubmittingRef = useRef(false);

  // ── 2026-10-07: CAPTURE THE LEAD BEFORE THE CARD ───────────────────────
  // Measured week of Sep 27 - Oct 4: 763 people reached a trial page, 34
  // submitted (4.5%), and 29 of those 34 paid (85%). The checkout is fine.
  // The problem was that the form demanded nine fields ending in a credit
  // card before anyone counted as anything, so the 729 who left did so
  // without leaving a name or a number.
  //
  // captureLead() fires once, as soon as name + email + phone are valid and
  // BEFORE the card is touched. Anyone who bails at the card is now a row in
  // Homebase's New Lead column for the desk to ring.
  //
  // Silent: capture-lead stamps abandoned_email_sent_at and withholds the
  // email address, which is what every automated sender keys on. Nothing
  // messages these people. Flip `drip: true` below to put them in the normal
  // abandoned-cart sequence instead.
  // ── A/B: both variants are now two-step, contact first and card second,
  // because capturing the lead before the card is the baseline rather than
  // the experiment. What is being tested is how much typing step 1 demands.
  //
  //   A = step 1 asks first name, last name, email, phone   (4 fields)
  //   B = step 1 asks first name and phone only             (2 fields)
  //       Last name and email move to step 2, beside the card.
  //
  // Why this is the right challenger: 95% of this traffic is on a phone, and
  // an email address is the slowest thing anyone types on a mobile keyboard.
  // We do not need it to ring somebody. One variable changes, so whatever the
  // result is, it is attributable.
  //
  // Assigned once per browser and pinned, so a returning visitor never flips.
  const [variant] = useState(() => getVariant('trial_form_v2'));
  const [step, setStep] = useState<1 | 2>(1);
  // Fields that live in step 1 for this visitor.
  const shortIntake = variant === 'B';

  const leadCapturedRef = useRef(false);
  const captureLead = async () => {
    if (leadCapturedRef.current || !location) return;
    const first = baysideForm.firstName.trim();
    const last  = baysideForm.lastName.trim();
    const mail  = baysideForm.email.trim();
    const tel   = baysideForm.phone.trim();
    // Same bar as the real submit, minus the card. Don't capture half a name.
    if (!first || !last) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return;
    const digits = tel.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) return;

    leadCapturedRef.current = true;   // set first: never double-post
    try {
      const { fbp, fbc } = getMetaClickIds();
      await fetch(`${SUPABASE_URL}/functions/v1/capture-lead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          studio_slug: location.slug,
          location_id: location.locationId,
          first_name: first,
          last_name: last,
          email: mail.toLowerCase(),
          phone: tel,
          fbp, fbc,
          ...getUtmParams(),
          referrer: document.referrer || '',
          page_url: window.location.href,
          time_on_page_ms: Math.max(0, Date.now() - pageLoadAtRef.current),
          ab_variant: variant,
          visitor_id: visitorId(),
          drip: false,
        }),
        keepalive: true,   // survives the tab closing mid-request
      });
    } catch {
      // Never block or surface anything. If this fails the customer still
      // completes checkout normally; we just lose the early capture.
      leadCapturedRef.current = false;
    }
  };

  // ── Soft-conversion: "text me the schedule" mini-form ───────────────────
  // For visitors who won't commit to $49 today. Captures phone, sends the
  // schedule link via Twilio, writes a soft_conversion lead row. 2026-06-11.
  // 2026-07-02 (QA #2): default OPEN. The MT buy widget owns the paid
  // transaction but captures NOTHING pre-payment — anyone who bounces before
  // completing MT checkout was invisible (no abandoned-cart, no comeback
  // audience, no Meta Lead). Surfacing this capture inline under the widget
  // feeds soft_conversions + fires a Meta Lead for every identified visitor,
  // reusing the tested request-schedule-sms path. Collapsible via Cancel.
  const [scheduleOpen,      setScheduleOpen]      = useState(true);
  const [scheduleFirstName, setScheduleFirstName] = useState('');
  const [scheduleLastName,  setScheduleLastName]  = useState('');
  const [scheduleEmail,     setScheduleEmail]     = useState('');
  const [schedulePhone,     setSchedulePhone]     = useState('');
  const [scheduleSending,   setScheduleSending]   = useState(false);
  const [scheduleError,     setScheduleError]     = useState('');
  const [scheduleSent,      setScheduleSent]      = useState(false);

  // 2026-07-01: Bayside-only Stripe Checkout handler. Posts to the same
  // create-trial-checkout edge function the pre-cutover flow used (task #382
  // verified Bayside path works). On success returns { url: Stripe URL } and
  // we redirect. Fires InitiateCheckout pixel for Meta attribution.
  const handleBaysideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (baysideSubmittingRef.current) return;
    setBaysideError('');

    // Variant B, step 1: validate the contact fields only, write the lead,
    // then reveal the card. The card inputs are not mounted yet, so the
    // card validation below must not run.
    if (step === 1) {
      const f = baysideForm.firstName.trim(), t = baysideForm.phone.trim();
      if (!f) { setBaysideError('Please enter your first name.'); return; }
      if (!shortIntake) {
        const l = baysideForm.lastName.trim(), m = baysideForm.email.trim();
        if (!l) { setBaysideError('Please enter your last name.'); return; }
        if (!m || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) {
          setBaysideError('Please enter a valid email address.'); return;
        }
      }
      if (!t || t.replace(/\D/g, '').length < 10) {
        setBaysideError('Please enter a valid phone number.'); return;
      }
      await captureLead();
      setStep(2);
      return;
    }

    const first = baysideForm.firstName.trim();
    const last  = baysideForm.lastName.trim();
    const mail  = baysideForm.email.trim();
    const tel   = baysideForm.phone.trim();
    if (!first) { setBaysideError('Please enter your first name.'); return; }
    if (!last)  { setBaysideError('Please enter your last name.'); return; }
    if (!mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setBaysideError('Please enter a valid email address.'); return;
    }
    if (!tel || tel.replace(/\D/g,'').length < 10) {
      setBaysideError('Please enter a valid phone number.'); return;
    }
    if (!location) return;

    // ── card validation (2026-09-03: in-page card, charged via MT's Stripe) ──
    const cardNumber = cardForm.number.replace(/[\s-]/g, '');
    const expMatch = cardForm.exp.trim().match(/^(0?[1-9]|1[0-2])\s*[\/\s-]?\s*(\d{2}|\d{4})$/);
    if (!/^\d{12,19}$/.test(cardNumber)) { setBaysideError('Please enter a valid card number.'); return; }
    if (!expMatch) { setBaysideError('Expiration should look like MM/YY.'); return; }
    if (!/^\d{3,4}$/.test(cardForm.ccv.trim())) { setBaysideError('Please enter the 3 or 4 digit security code.'); return; }
    if (!/^\d{5}(-\d{4})?$/.test(cardForm.zip.trim())) { setBaysideError('Please enter your billing ZIP code.'); return; }
    const expMonth = expMatch[1].padStart(2, '0');
    const expYear = expMatch[2].length === 2 ? `20${expMatch[2]}` : expMatch[2];

    baysideSubmittingRef.current = true;
    setBaysideSubmitting(true);
    try {
      if (location.metaPixelId && window.fbq) {
        window.fbq('track', 'InitiateCheckout', {
          content_name: `${location.name} 2-Week Trial ($49)`,
          value: 49, currency: 'USD',
        });
      }
      const { fbp, fbc } = getMetaClickIds();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/mt-card-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          first_name: first,
          last_name: last,
          email: mail,
          phone: tel,
          studio_slug: location.slug,
          kind: 'trial',
          newsletter: baysideForm.newsletter,
          card: { number: cardNumber, exp_month: expMonth, exp_year: expYear, ccv: cardForm.ccv.trim(), postal_code: cardForm.zip.trim() },
          fbp, fbc,
          ...getUtmParams(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || 'Could not complete checkout. Please try again.');
      }
      if (location.metaPixelId && window.fbq) {
        window.fbq('track', 'Purchase', {
          content_name: `${location.name} 2-Week Trial ($49)`,
          value: 49, currency: 'USD',
        });
      }
      try { sessionStorage.setItem('bbb_last_trial_studio', location.slug); } catch { /* ignore */ }
      // Card data lives only in component state; clear before navigating.
      setCardForm({ number: '', exp: '', ccv: '' });
      window.location.href = `/trial-success?studio=${location.slug}&native=1`;
    } catch (err) {
      setBaysideError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      baysideSubmittingRef.current = false;
      setBaysideSubmitting(false);
    }
  };

  const handleScheduleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setScheduleError('');
    if (!scheduleFirstName.trim()) {
      setScheduleError('Please enter your first name.');
      return;
    }
    if (!scheduleLastName.trim()) {
      setScheduleError('Please enter your last name.');
      return;
    }
    // Light email validation — server-side normalization happens in the
    // edge function. Basic sanity here so we don't even fire the network call.
    const emailTrim = scheduleEmail.trim();
    if (!emailTrim || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
      setScheduleError('Please enter a valid email address.');
      return;
    }
    const phoneDigits = schedulePhone.replace(/\D/g, '');
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      setScheduleError('Please enter a valid US phone number.');
      return;
    }
    if (!location) return;
    setScheduleSending(true);
    try {
      // Capture every signal Meta gives us so the dashboard can attribute this
      // soft conversion back to the specific ad / campaign / creative.
      const { fbp, fbc } = getMetaClickIds();
      const utms = getUtmParams();
      const timeOnPageMs = pageLoadAtRef.current
        ? Math.max(0, Date.now() - pageLoadAtRef.current)
        : null;

      const res = await fetch(`${SUPABASE_URL}/functions/v1/request-schedule-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey':        SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          studio_slug:  location.slug,
          studio_name:  location.name,
          location_id:  location.locationId,
          phone:        schedulePhone.trim(),
          first_name:   scheduleFirstName.trim(),
          last_name:    scheduleLastName.trim(),
          email:        scheduleEmail.trim().toLowerCase(),
          // Full Meta + journey context for dashboard attribution
          fbp,
          fbc,
          ...utms,                                  // utm_source/medium/campaign/content
          referrer:        document.referrer || '',
          page_url:        window.location.href,
          time_on_page_ms: timeOnPageMs,
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        setScheduleError(data?.error || 'Could not send. Please try again.');
        setScheduleSending(false);
        return;
      }
      // Fire a Meta Pixel Lead event for the soft conversion too — different
      // value (we got contact info but no $) so Meta can score it appropriately.
      if (location.metaPixelId && window.fbq) {
        window.fbq('track', 'Lead', {
          content_name:     `${location.name} Schedule Request (soft)`,
          content_category: 'soft_conversion',
          value: 0,
          currency: 'USD',
        });
      }
      setScheduleSent(true);
      setScheduleSending(false);
    } catch (err) {
      setScheduleError('Network error. Please try again.');
      setScheduleSending(false);
    }
  };

  useEffect(() => {
    window.scrollTo(0, 0);
    // Persist UTM tags from the landing URL into sessionStorage immediately,
    // so attribution survives SPA re-renders / form refreshes. Without this,
    // submissions land as "Direct/untagged" whenever the URL has been mutated
    // between the user arriving via /ig and clicking submit.
    captureUtmsFromUrl();
  }, [locationParam]);

  const key = (locationParam ?? '').toLowerCase();
  const location = LOCATIONS[key];

  // Per-gym Meta Pixel — load that gym's pixel + fire PageView on mount.
  // Cleanup removes the script when navigating away so visiting a different
  // gym's trial page initializes the correct pixel instead of stacking them.
  useEffect(() => {
    if (location?.metaPixelId) {
      return loadMetaPixel(location.metaPixelId);
    }
    return undefined;
  }, [location?.metaPixelId]);

  // ─── MT widget mount (2026-06-29) ──────────────────────────────────────
  // Mariana Tek's Web Integrations runtime is loaded site-wide via
  // index.html. It auto-scans [data-mariana-integrations] divs on initial
  // page load — but React lazy-mounts this route AFTER that scan, so we
  // have to re-invoke MTIntegrations.render() once our div lands in the DOM.
  // (Same pattern as WidgetLab.tsx — see notes there for why we have to
  // call render() per-div with a unique selector.)
  //
  // The widget path `/intro-offers?location=<id>` mounts MT's native
  // new-customer signup + intro pass purchase flow, filtered to this
  // studio's offers. MT owns the entire transaction (account creation,
  // payment, pass issuance, confirmation). Replaces the gutted BBB Stripe
  // form below — kills the silent-failure bridge problem.
  useEffect(() => {
    if (!location?.mtLocationId) return;
    const tryInit = (attempts: number) => {
      if (typeof window.MTIntegrations?.render === 'function') {
        const divs = Array.from(
          document.querySelectorAll('[data-mariana-integrations]'),
        ) as HTMLElement[];
        divs.forEach((div, i) => {
          if (!div.dataset.mtId) div.dataset.mtId = `mt-trial-${i}-${Date.now()}`;
          if (div.children.length > 0) return; // already mounted
          try {
            window.MTIntegrations!.render(`[data-mt-id="${div.dataset.mtId}"]`);
          } catch (e) {
            console.warn('MT trial widget mount failed for', div.dataset.mtId, e);
          }
        });
        return;
      }
      if (attempts > 0) setTimeout(() => tryInit(attempts - 1), 500);
    };
    tryInit(20);
  }, [location?.mtLocationId]);

  // ─── Attribution bridge (2026-07-30, v2) ───────────────────────────────
  // ROOT-CAUSE FIX for "Meta sees 0 purchases": since the MT buy widget took
  // over checkout, NO paid trial carries fbp/fbc — 53/53 trials since 7/1
  // had zero browser signals, so every CAPI purchase goes out unattributable.
  // v1 listened for the email typed into the widget — DEAD CODE: the widget
  // is a sealed CROSS-ORIGIN iframe (betterbodybootcamp.marianaiframes.com),
  // so parent-page listeners never see its inputs. Removed.
  // v2 lives in index.html as window.MT_CONFIG: MT's officially supported
  // parent-page callbacks (onCreateAccountComplete / onLoginComplete /
  // onCheckoutComplete) hand us the customer email, and we store the
  // soft-deleted "attribution-shadow" row from there. See index.html.

  // 2026-06-04: server-side PageView CAPI with hashed email when known.
  // 2026-06-11: REMOVED the email-required gate. Previously this only fired
  // for email-link visitors (?email=X), so Meta ad-driven traffic was
  // invisible to our backend — we couldn't tell if a click actually landed
  // on the page or if 0 form fills meant 0 visits or 0 conversions.
  // Now fires on EVERY page load. Email is optional; fbp/fbc cookies
  // (set by the Meta browser pixel) are enough for CAPI to match. When
  // email IS present, match quality jumps from ~6 to ~9.
  useEffect(() => {
    if (!location) return;
    // 2026-07-02 (QA #1): This event was silently dropping on the single most
    // important ad landing page. Root cause: getMetaClickIds() ran synchronously
    // at mount, BEFORE the Meta pixel script (injected in a separate effect) had
    // written the _fbp cookie. On direct ad clicks with no fbclid in the URL,
    // fbp/fbc were both empty at that instant, the gate bailed, and we fired
    // ZERO server-side PageView / visitor rows — so trial_page_visitors +
    // meta-capi-pageview (the +9 EMQ CAPI mirror, task #182) went dark.
    //
    // Fix: fire on a short deferral so the pixel can set _fbp, re-read the
    // cookies at fire time, and record the visit even if only fbp is present.
    // We also fire an unconditional low-trust fallback (no cookies) after a
    // longer wait so we never lose an ad-driven visit entirely — the function
    // dedupes on event_id and gracefully handles missing identity fields.
    const params = new URLSearchParams(window.location.search);
    const emailFromUrl = params.get('email') || '';
    const eventId = `pv_${location.slug}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let fired = false;

    // ── Client-side enrichment: device + locale + return-visitor count ──
    let connType = '';
    try {
      const c = (navigator as unknown as { connection?: { effectiveType?: string } }).connection;
      connType = c?.effectiveType || '';
    } catch { /* ignore */ }
    const colorScheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    let timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
    const language = navigator.language || '';

    // Returning-visitor counter via localStorage (per studio).
    let visitNumber = 1, daysSinceFirst = 0;
    try {
      const key = `bbb_visit_${location.slug}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        visitNumber = (parsed.count || 0) + 1;
        const firstMs = Number(parsed.first || Date.now());
        daysSinceFirst = Math.floor((Date.now() - firstMs) / 86400000);
        localStorage.setItem(key, JSON.stringify({ count: visitNumber, first: firstMs }));
      } else {
        localStorage.setItem(key, JSON.stringify({ count: 1, first: Date.now() }));
      }
    } catch { /* private mode — fine */ }

    const fireVisit = () => {
      if (fired) return;
      const { fbp, fbc } = getMetaClickIds();
      // Best-effort — never block the page render on this. Fires once per mount.
      fired = true;
      fetch(`${SUPABASE_URL}/functions/v1/meta-capi-pageview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey':        SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          studio_slug:     location.slug,
          email:           emailFromUrl,
          fbp, fbc,
          page_url:        window.location.href,
          referrer:        document.referrer || '',
          event_id:        eventId,
          // Client-side enrichment
          screen_width:    window.screen?.width  ?? null,
          viewport_width:  window.innerWidth     ?? null,
          language,
          timezone,
          connection_type: connType,
          color_scheme:    colorScheme,
          visit_number:    visitNumber,
          days_since_first: daysSinceFirst,
        }),
      }).catch(() => { /* non-blocking */ });
      if (emailFromUrl && window.fbq) {
        window.fbq('init', location.metaPixelId, { em: emailFromUrl });
      }
    };

    // Try immediately if we already have identity (email link / returning
    // visitor with cookies). Otherwise defer to let the pixel set _fbp, then
    // fire regardless so no ad visit is lost.
    const { fbp: fbp0, fbc: fbc0 } = getMetaClickIds();
    if (emailFromUrl || fbp0 || fbc0) {
      fireVisit();
    } else {
      const t = setTimeout(fireVisit, 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [location?.metaPixelId, location?.slug]);

  if (!location) {
    return <Navigate to="/trial" replace />;
  }

  // 2026-06-29: handleChange/handleSubmit removed. MT widget now owns the
  // primary trial transaction (account creation + payment + pass issuance).
  // Browser-side Lead pixel + server-side meta-capi-pageview/create-trial-checkout
  // were tied to the dead BBB form — those signals are now generated MT-side
  // by mt-orders-sync firing CAPI Purchase on new $49 trials.

  return (
    <>
    <SEOHead
      title={`2 Weeks for $49 — ${location.name} | Better Body Bootcamp`}
      description={`Start your 2-week trial at Better Body Bootcamp ${location.name} for just $49. Unlimited classes, expert trainers, real results.`}
      canonical={`/trial/${location.slug}`}
    />
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {/* HERO ─────────────────────────────────────────────────────────────── */}
      {/* 2026-09-11 (Justin): page stripped to "just the form and the menu".
          The banner-image hero, feature chips, benefit columns, reviews and
          FAQ are gone; this compact block is the entire offer statement so
          the form is visible without scrolling on mobile. */}
      <div className="relative bg-gradient-to-br from-red-600 via-red-700 to-red-800 text-white pt-28 pb-8 sm:pt-32 sm:pb-12 overflow-hidden">
        <div className="absolute inset-0 bg-black/10"></div>
        <div className="max-w-3xl mx-auto px-3 sm:px-6 text-center relative z-10">
          <span className="inline-block px-3 py-1 sm:px-4 sm:py-1.5 bg-white/15 backdrop-blur-sm rounded-full text-[10px] sm:text-xs font-bold tracking-[0.2em] uppercase border border-white/30 mb-3 sm:mb-4 whitespace-nowrap">
            {location.badge}
          </span>
          <h1 className="font-black leading-[0.95] tracking-tight text-3xl sm:text-5xl md:text-6xl">
            TWO WEEKS FOR $49
          </h1>
          <p className="text-sm sm:text-lg font-medium leading-snug mt-2 sm:mt-3">
            Unlimited classes at <span className="whitespace-nowrap">Better Body Bootcamp {location.name}</span>.
          </p>
        </div>
      </div>

      {/* MAIN CARD ────────────────────────────────────────────────────────── */}
      {/* No overlap on mobile so the hero subtitle is fully visible. Desktop
          keeps the -mt-8 lift for the existing layered look. */}
      <div className="max-w-2xl mx-auto px-3 sm:px-6 mt-0 sm:-mt-6 relative z-20">
        <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl p-4 sm:p-8 mb-8 sm:mb-12">

            {/* Form ─────────────────────────────────────────────────────── */}
            <div id="trial-form">
              <div className="bg-gradient-to-br from-gray-50 to-white border border-gray-200 rounded-2xl p-4 sm:p-8 scroll-mt-24">
                <div className="mb-5 sm:mb-6 text-center lg:text-left">
                  <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-1">Claim Your Trial</h2>
                  <p className="text-xs sm:text-sm text-gray-600">
                    Two weeks of unlimited classes at <span className="font-semibold">{location.name}</span> for just $49.
                  </p>
                </div>

                {/* ── Mariana Tek native signup widget (Astoria/FM/WB only) ─
                    2026-06-29: replaces the gutted BBB Stripe form. MT's
                    Web Integrations runtime (loaded in index.html) mounts
                    the new-customer signup + intro pass purchase flow in
                    an iframe scoped to this studio's location ID.
                    2026-07-01: BAYSIDE-ONLY OVERRIDE — see useBaysideFallback
                    at top of component. Task #498 (MT pass 14721 Astoria-
                    only) makes the iframe non-convertible for Bayside; we
                    fall back to the pre-cutover Stripe Checkout flow
                    (verified working per task #382) until MT support
                    reconfigures the pass. Ticket in
                    bbb-marketing/mt-support-pass-14721.md.
                    ─────────────────────────────────────────────────────── */}
                {!useBaysideFallback ? (
                  <>
                    {/* MT widget — deep-link straight to the $49 trial pass.
                        2026-07-02 (QA #7 ROLLBACK, verified live post-deploy):
                        the /intro-offers path 404s inside the iframe — MT never
                        flagged pass 14721 as an intro offer, so that route has
                        nothing to render. Reverted to the /buy deep-link (the
                        $49 overlay auto-opens). Sticker-shock-on-close stands
                        until MT reconfigures the pass — folded into the pass-
                        14721 support ticket (task #498): ask MT to (a) split
                        into 4 per-studio passes AND (b) flag them as intro
                        offers so /intro-offers works. */}
                    {/* 2026-08-09: Sticker-shock buffer. The MT /buy widget
                        lists the full membership catalog ($199/mo, $2,199 PIF)
                        around the $49 pass — a $49 shopper who scrolls past the
                        overlay sees those and bolts. Until MT flags pass 14721
                        as an intro offer so /intro-offers works (ticket #498),
                        reframe it: make crystal-clear the ONLY charge today is
                        $49, nothing recurring. Pure copy — no logic touched. */}
                    <div className="mb-4 rounded-xl bg-red-50 border border-red-100 p-3 sm:p-4 text-center">
                      <p className="text-sm sm:text-base font-extrabold text-gray-900">
                        You pay <span className="text-red-600">$49 today</span> — that's the whole price.
                      </p>
                      <p className="text-xs sm:text-sm text-gray-600 mt-1">
                        No membership, no auto-renewal, no commitment. Two weeks of unlimited classes, then it's up to you.
                      </p>
                    </div>
                    <div
                      key={`mt-trial-${location.slug}`}
                      data-mariana-integrations={`/buy/${location.mtLocationId}?activeProduct=memberships-14721&locations=${location.mtLocationId}`}
                      className="w-full bg-white rounded-xl"
                      style={{ height: '720px', overflowY: 'auto' }}
                    />
                    <p className="text-xs text-gray-600 leading-relaxed mt-4">
                      By starting your trial you agree to our{' '}
                      <a href="/privacy" className="underline">Privacy Policy</a> and{' '}
                      <a href="/terms" className="underline">Terms</a>. Payment +
                      account creation handled securely by Mariana Tek.
                    </p>
                    <div className="flex items-center justify-center gap-2 text-xs text-gray-500 pt-2">
                      <Lock className="w-3.5 h-3.5" />
                      Powered by Mariana Tek — secure payments + native booking
                    </div>
                  </>
                ) : (
                  <form onSubmit={handleBaysideSubmit} className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        type="text" required autoComplete="given-name"
                        placeholder="First name"
                        value={baysideForm.firstName}
                        onChange={e => setBaysideForm(f => ({ ...f, firstName: e.target.value }))}
                        disabled={baysideSubmitting}
                        className={(shortIntake && step === 1 ? "col-span-2 " : "") + "px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"}
                      />
                      {!(shortIntake && step === 1) && (
                      <input
                        type="text" required autoComplete="family-name"
                        placeholder="Last name"
                        value={baysideForm.lastName}
                        onChange={e => setBaysideForm(f => ({ ...f, lastName: e.target.value }))}
                        disabled={baysideSubmitting}
                        className="px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                      />)}
                    </div>
                    {!(shortIntake && step === 1) && (
                    <input
                      type="email" required autoComplete="email"
                      placeholder="Email address"
                      value={baysideForm.email}
                      onChange={e => setBaysideForm(f => ({ ...f, email: e.target.value }))}
                      disabled={baysideSubmitting}
                      className="w-full px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                    />)}
                    <input
                      type="tel" required autoComplete="tel"
                      placeholder="Phone number"
                      value={baysideForm.phone}
                      onChange={e => setBaysideForm(f => ({ ...f, phone: e.target.value }))}
                      // Primary capture point: they finished the contact
                      // fields. Everything below this line is the card.
                      onBlur={captureLead}
                      disabled={baysideSubmitting}
                      className="w-full px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                    />
                    {/* 2026-09-03: card fields — charged + stored via Mariana
                        Tek's own Stripe (mt-card-checkout). Never touches our
                        servers' storage; posted once over TLS.
                        2026-10-07: both variants hold these back until the
                        contact details are in and the lead row is written. */}
                    {step === 1 ? null : (<>
                    <input
                      type="text" required inputMode="numeric" autoComplete="cc-number"
                      placeholder="Card number"
                      value={cardForm.number}
                      onChange={e => setCardForm(f => ({ ...f, number: e.target.value.replace(/[^\d\s]/g, '') }))}
                      // Backstop: on mobile people tab or tap straight into
                      // the card without ever blurring the phone field.
                      onFocus={captureLead}
                      disabled={baysideSubmitting}
                      className="w-full px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                    />
                    <div className="grid grid-cols-3 gap-3">
                      <input
                        type="text" required inputMode="numeric" autoComplete="cc-exp"
                        placeholder="MM/YY" maxLength={7}
                        value={cardForm.exp}
                        onChange={e => {
                          // Mobile numeric keypads have no "/" key, so auto-insert it.
                          const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
                          const formatted = digits.length >= 3 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
                          setCardForm(f => ({ ...f, exp: formatted }));
                        }}
                        disabled={baysideSubmitting}
                        className="px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                      />
                      <input
                        type="text" required inputMode="numeric" autoComplete="cc-csc"
                        placeholder="CVC"
                        value={cardForm.ccv}
                        onChange={e => setCardForm(f => ({ ...f, ccv: e.target.value.replace(/\D/g, '') }))}
                        disabled={baysideSubmitting}
                        className="px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                      />
                      <input
                        type="text" required inputMode="numeric" autoComplete="postal-code"
                        placeholder="ZIP"
                        value={cardForm.zip}
                        onChange={e => setCardForm(f => ({ ...f, zip: e.target.value.replace(/[^\d-]/g, '') }))}
                        disabled={baysideSubmitting}
                        className="px-3 py-3 rounded-lg border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60"
                      />
                    </div>
                    </>)}
                    <label className="flex items-start gap-2 text-xs text-gray-600 min-h-[24px] pt-1">
                      <input
                        type="checkbox"
                        checked={baysideForm.newsletter}
                        onChange={e => setBaysideForm(f => ({ ...f, newsletter: e.target.checked }))}
                        className="mt-0.5"
                      />
                      Send me class updates + Better Body {location.name} news
                    </label>
                    {baysideError && (
                      <p className="text-xs text-red-600 leading-relaxed">{baysideError}</p>
                    )}
                    <button
                      type="submit"
                      disabled={baysideSubmitting}
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-4 rounded-xl text-base transition-colors disabled:opacity-60 disabled:cursor-wait"
                    >
                      {baysideSubmitting
                        ? 'Processing…'
                        : (step === 1 ? 'Continue →' : 'Claim my $49 trial →')}
                    </button>
                    {step === 1 && (
                      <p className="text-xs text-gray-500 leading-relaxed">
                        Next: payment details. You will not be charged until you confirm.
                      </p>
                    )}
                    <p className="text-xs text-gray-600 leading-relaxed">
                      By starting your trial you agree to our{' '}
                      <a href="/privacy" className="underline">Privacy Policy</a> and{' '}
                      <a href="/terms" className="underline">Terms</a>. You pay
                      $49 today, one time. Nothing recurring.
                    </p>
                    <div className="flex items-center justify-center gap-2 text-xs text-gray-500 pt-1">
                      <Lock className="w-3.5 h-3.5" />
                      Payment processed securely by Mariana Tek + Stripe
                    </div>
                  </form>
                )}

                {/* ── Soft-conversion: "text me the schedule" ───────────── */}
                <div className="mt-8 pt-6 border-t border-gray-200">
                  {!scheduleSent ? (
                    !scheduleOpen ? (
                      <div className="text-center">
                        <p className="text-sm text-gray-600 mb-3">
                          Not ready to commit to $49 today?
                        </p>
                        <button
                          type="button"
                          onClick={() => setScheduleOpen(true)}
                          className="text-sm font-semibold text-red-700 underline underline-offset-2 hover:text-red-800 transition"
                        >
                          Just text me the class schedule →
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleScheduleSubmit} className="bg-gray-50 border border-gray-200 rounded-xl p-4 sm:p-5" noValidate>
                        <h3 className="text-base font-bold text-gray-900 mb-1">Want us to hold your spot?</h3>
                        <p className="text-xs text-gray-600 mb-4">
                          Not ready to pay right now? Leave your info and we'll text you the class schedule + a link to start your $49 trial whenever you're ready. No card, no commitment.
                        </p>
                        <div className="grid sm:grid-cols-2 gap-3">
                          <input
                            type="text"
                            value={scheduleFirstName}
                            onChange={(e) => setScheduleFirstName(e.target.value)}
                            required
                            placeholder="First name *"
                            autoComplete="given-name"
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900 text-sm"
                          />
                          <input
                            type="text"
                            value={scheduleLastName}
                            onChange={(e) => setScheduleLastName(e.target.value)}
                            required
                            placeholder="Last name *"
                            autoComplete="family-name"
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900 text-sm"
                          />
                          <input
                            type="email"
                            value={scheduleEmail}
                            onChange={(e) => setScheduleEmail(e.target.value)}
                            required
                            inputMode="email"
                            autoComplete="email"
                            placeholder="Email *"
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900 text-sm sm:col-span-2"
                          />
                          <input
                            type="tel"
                            value={schedulePhone}
                            onChange={(e) => setSchedulePhone(e.target.value)}
                            required
                            inputMode="tel"
                            autoComplete="tel"
                            placeholder="Mobile phone *"
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-gray-900 text-sm sm:col-span-2"
                          />
                        </div>
                        {scheduleError && (
                          <div className="mt-3 text-xs text-red-700">{scheduleError}</div>
                        )}
                        <p className="text-[10px] text-gray-500 mt-2">
                          One text with the schedule link. Reply STOP to opt out. Standard rates may apply.
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="submit"
                            disabled={scheduleSending}
                            className="flex-1 bg-gray-900 hover:bg-black text-white font-semibold text-sm py-2.5 px-4 rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {scheduleSending ? 'Sending…' : 'Text me the schedule'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setScheduleOpen(false)}
                            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-2"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )
                  ) : (
                    <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                      <CheckCircle className="w-6 h-6 text-green-600 mx-auto mb-2" />
                      <h3 className="text-base font-bold text-gray-900 mb-1">Schedule sent!</h3>
                      <p className="text-sm text-gray-700">
                        Check your phone — we just texted you the schedule link. See you in class.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
        </div>
      </div>
    </div>
    </>
  );
}
