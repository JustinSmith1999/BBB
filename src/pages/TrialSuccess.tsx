import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle, Calendar, ArrowRight } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import NativeClassList from '../components/NativeClassList';

const APP_STORE_URL = 'https://apps.apple.com/us/app/better-body-studios/id6778182425';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp';

// 2026-06-26: MT Web Integrations class-type id for the daily schedule widget
// (same one the pre-NativeClassList schedule pages used). The booking widget
// path is `/schedule/daily/<classTypeId>?locations=<mtLocationId>`.
const MT_CLASS_TYPE_ID = 48541;

// Per-studio Meta Pixel IDs — mirrors LocationTrialSignup.tsx.
const STUDIO_PIXELS: Record<string, string> = {
  astoria:         '1291566006435758',
  bayside:         '931144729719242',
  'fresh-meadows': '979328851475276',
  williamsburg:    '2160299368182872',
};

// Studio → display name + MT location id (for the booking widget).
const STUDIOS: Record<string, { name: string; mtLocationId: number }> = {
  astoria:         { name: 'Astoria',       mtLocationId: 48717 },
  bayside:         { name: 'Bayside',       mtLocationId: 48718 },
  'fresh-meadows': { name: 'Fresh Meadows', mtLocationId: 48719 },
  williamsburg:    { name: 'Williamsburg',  mtLocationId: 48720 },
};

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    _fbq?: unknown;
    MTIntegrations?: { render: (selector?: string) => void };
  }
}

function ensurePixelLoaded(pixelId: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    const markerId = `meta-pixel-${pixelId}`;
    if (window.fbq && document.getElementById(markerId)) {
      window.fbq('init', pixelId);
      return resolve();
    }
    const tag = document.createElement('script');
    tag.id = markerId;
    tag.text = `
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};
      if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
      n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t,s)}(window, document,'script',
      'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', '${pixelId}');
    `;
    document.head.appendChild(tag);
    const ns = document.createElement('noscript');
    ns.id = `${markerId}-ns`;
    ns.innerHTML = `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${pixelId}&ev=Purchase&noscript=1" />`;
    document.head.appendChild(ns);
    setTimeout(resolve, 250);
  });
}

export default function TrialSuccess() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const sessionId = searchParams.get('session_id');

  // Capture the studio BEFORE the pixel effect clears it from sessionStorage,
  // so we can drop the customer onto the right studio's booking schedule.
  const [studioSlug] = useState<string>(() => {
    try { return sessionStorage.getItem('bbb_last_trial_studio') || ''; } catch { return ''; }
  });
  const studio = STUDIOS[studioSlug];

  // ── Meta Pixel Purchase event (unchanged behavior) ──────────────────────
  // event_id MATCHES stripe-webhook's `trial_${session.id}` so Meta dedupes.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const pixelsToFire = studioSlug && STUDIO_PIXELS[studioSlug]
      ? [STUDIO_PIXELS[studioSlug]]
      : Object.values(STUDIO_PIXELS);
    (async () => {
      for (const pid of pixelsToFire) {
        if (cancelled) return;
        await ensurePixelLoaded(pid);
        window.fbq?.('track', 'Purchase',
          { value: 49, currency: 'USD', content_name: '2-Week Trial' },
          { eventID: `trial_${sessionId}` },
        );
      }
      try { sessionStorage.removeItem('bbb_last_trial_studio'); } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [sessionId, studioSlug]);

  useEffect(() => {
    window.scrollTo(0, 0);
    if (!sessionId) navigate('/locations');
  }, [sessionId, navigate]);

  // 2026-08-31: MT widget mount effect removed — native class list now
  // renders the schedule (MT iframe runtime dropped site-wide, it was
  // crashing iOS Safari).

  if (!sessionId) return null;

  return (
    <>
      <SEOHead
        title="You're in — book your first class"
        description="Your Better Body Bootcamp trial is active. Book your first class now."
        canonical="/trial-success"
        noindex={true}
      />
      <div className="min-h-screen bg-gradient-to-b from-black via-gray-900 to-black py-10 px-4">
        <div className="max-w-2xl w-full mx-auto">
          <div className="bg-gradient-to-br from-gray-900 to-black border-2 border-green-500/50 rounded-3xl p-6 md:p-10 shadow-2xl">

            {/* Confirmation header */}
            <div className="text-center">
              <div className="bg-green-500/20 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-5 border-4 border-green-500">
                <CheckCircle className="w-10 h-10 text-green-400" />
              </div>
              <h1 className="text-3xl md:text-4xl font-display font-black text-white mb-3">
                You&apos;re in!
              </h1>
              <p className="text-lg text-gray-300 mb-2">
                Your 2-week trial{studio ? <> at <span className="font-bold text-white">{studio.name}</span></> : ''} is active.
              </p>
              <p className="text-base text-red-400 font-semibold mb-6 inline-flex items-center gap-2 justify-center">
                <Calendar className="w-5 h-5" /> Now book your first class below 👇
              </p>
            </div>

            {studio ? (
              <>
                {/* 2026-08-31: MT iframe widget replaced with our native class
                    list. MT's widget runtime (marianaiframes.com scripts) was
                    crashing iOS Safari site-wide via a broken date polyfill —
                    removing the widget removed the scripts. Same native list
                    and booking flow as /classes. */}
                <div className="w-full rounded-2xl bg-white overflow-hidden p-5 sm:p-8 text-left">
                  <NativeClassList
                    key={`native-book-${studio.mtLocationId}`}
                    mtLocationId={studio.mtLocationId}
                    studioName={studio.name}
                    studioSlug={studioSlug}
                    days={7}
                  />
                </div>
                <p className="text-gray-400 text-xs mt-3 text-center leading-relaxed">
                  Tap a class, enter the email you used at checkout, and we&apos;ll text you a quick code to confirm your first booking.
                  We also emailed you a link to set your password for the Better Body app.
                </p>
              </>
            ) : (
              // Fallback: studio unknown (cold-loaded URL) — let them pick.
              <div className="bg-black/50 border border-white/10 rounded-2xl p-6">
                <p className="text-gray-300 text-sm mb-4 text-center">Pick your studio to book your first class:</p>
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(STUDIOS).map(([slug, s]) => (
                    <button
                      key={slug}
                      onClick={() => navigate(`/schedule/${slug}`)}
                      className="px-4 py-3 rounded-xl bg-white/5 hover:bg-red-600 border border-white/10 text-white font-bold text-sm transition-colors"
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Secondary — the app, for booking on the go */}
            <div className="mt-7 pt-6 border-t border-white/10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <span className="text-gray-400 text-sm">Prefer your phone?</span>
              <a
                href={APP_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Download Better Body Studios on the App Store"
                className="inline-flex items-center gap-2.5 px-5 py-2.5 rounded-xl font-bold transition-all hover:scale-[1.02]"
                style={{ backgroundColor: '#000', color: '#fff', border: '1px solid #1f2937' }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
                  <path d="M17.05 12.04c-.02-3 2.45-4.44 2.56-4.51-1.4-2.04-3.57-2.32-4.34-2.35-1.84-.19-3.6 1.08-4.54 1.08-.94 0-2.39-1.06-3.93-1.03-2.02.03-3.88 1.18-4.92 2.99-2.1 3.65-.54 9.05 1.51 12.01 1 1.45 2.19 3.08 3.74 3.02 1.51-.06 2.08-.97 3.9-.97 1.82 0 2.34.97 3.94.94 1.63-.03 2.66-1.47 3.65-2.93 1.15-1.68 1.62-3.31 1.64-3.39-.04-.02-3.15-1.21-3.21-4.78zM14.09 3.83c.83-1.01 1.39-2.41 1.24-3.83-1.19.05-2.65.79-3.51 1.79-.77.89-1.45 2.32-1.27 3.7 1.33.11 2.69-.67 3.54-1.66z"/>
                </svg>
                <span className="flex flex-col leading-tight items-start text-left">
                  <span className="text-[10px] text-white/70 uppercase tracking-wide">Download on the</span>
                  <span className="text-base font-black text-white">App Store</span>
                </span>
              </a>
              <a
                href={PLAY_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Get Better Body Bootcamp on Google Play"
                className="inline-flex items-center gap-2.5 px-5 py-2.5 rounded-xl font-bold transition-all hover:scale-[1.02]"
                style={{ backgroundColor: '#000', color: '#fff', border: '1px solid #1f2937' }}
              >
                <svg width="20" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M4 2.5v19a1 1 0 0 0 1.53.85l15.5-9.5a1 1 0 0 0 0-1.7L5.53 1.65A1 1 0 0 0 4 2.5z"/></svg>
                <span className="flex flex-col leading-tight items-start text-left">
                  <span className="text-[10px] text-white/70 uppercase tracking-wide">Get it on</span>
                  <span className="text-base font-black text-white">Google Play</span>
                </span>
              </a>
            </div>
          </div>

          <div className="mt-6 text-center">
            <button
              onClick={() => navigate('/locations')}
              className="inline-flex items-center gap-2 text-gray-400 hover:text-white text-sm font-semibold transition-colors"
            >
              <span>View studio info</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <p className="text-gray-500 text-xs mt-4">
              Questions? <a href="/contact" className="text-red-500 hover:text-red-400 font-semibold">Contact us</a>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
