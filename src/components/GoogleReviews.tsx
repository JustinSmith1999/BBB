import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';

// 2026-09-02: Real Google reviews, pulled from the testimonials table (rows
// added from each studio's Google profile, all from the new-ownership era).
// Attribution format in `name`: "Anna G. · Google review, Astoria" — the
// studio is parsed off the end so each location page shows ITS OWN reviews.
//
// Two exports:
//   <StudioReviews studio="Astoria" />  — 3 quotes w/ outlined numerals,
//     slotted into the location pages.
//   <ReviewTicker />                     — one quiet rotating quote for the
//     homepage. Inconspicuous by design: a single line, cross-fades.

interface Review {
  name: string;     // display name, e.g. "Anna G."
  studio: string;   // e.g. "Astoria"
  title: string;
  content: string;
}

// Per-studio Yelp listings (2026-09-02) — keyed by display name.
const YELP_URLS: Record<string, string> = {
  'Astoria': 'https://www.yelp.com/biz/better-body-bootcamp-astoria',
  'Bayside': 'https://www.yelp.com/biz/better-body-bootcamp-bayside-bayside-3',
  'Fresh Meadows': 'https://www.yelp.com/biz/better-body-bootcamp-fresh-meadows-fresh-meadows',
  'Williamsburg': 'https://www.yelp.com/biz/better-body-bootcamp-brooklyn',
};

let cache: Review[] | null = null;

async function fetchGoogleReviews(): Promise<Review[]> {
  if (cache) return cache;
  const { data } = await supabase
    .from('testimonials')
    .select('name,title,content,display_order')
    .ilike('name', '%Google review%')
    .order('display_order');
  cache = (data || []).map((r: { name: string; title: string; content: string }) => {
    const m = r.name.match(/^(.*?)\s*·\s*Google review,\s*(.+)$/);
    return {
      name: m ? m[1] : r.name,
      studio: m ? m[2] : '',
      title: r.title,
      content: r.content,
    };
  });
  return cache;
}

const Stars = () => (
  <span className="inline-flex gap-0.5" aria-label="5 star Google review">
    {[0, 1, 2, 3, 4].map(i => (
      <Star key={i} className="w-3.5 h-3.5" style={{ color: '#FBBC04', fill: '#FBBC04' }} />
    ))}
  </span>
);

/* Outlined index numeral — the /services treatment */
const Numeral = ({ n }: { n: number }) => (
  <span
    className="font-display font-black select-none leading-none"
    style={{
      fontSize: 'clamp(2.4rem, 4vw, 3.4rem)',
      color: 'rgba(216,59,59,0.30)',
      WebkitTextStroke: '1px rgba(216,59,59,0.55)',
    }}
    aria-hidden
  >
    {String(n).padStart(2, '0')}
  </span>
);

// ─── Location-page block ──────────────────────────────────────────────────
export function StudioReviews({ studio }: { studio: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  useEffect(() => {
    fetchGoogleReviews().then(all =>
      setReviews(all.filter(r => r.studio.toLowerCase() === studio.toLowerCase()).slice(0, 3)),
    );
  }, [studio]);

  if (reviews.length === 0) return null;

  return (
    <div className="bg-white py-14 sm:py-16 border-t border-gray-100">
      <div className="container mx-auto px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <span className="inline-block text-red-600 text-xs font-black tracking-[0.25em] uppercase mb-3">
              From Google Reviews
            </span>
            <h2 className="text-[clamp(1.875rem,4vw,3.5rem)] font-black text-black tracking-tight">
              {studio} Members Say
            </h2>
            <p className="text-gray-500 text-sm mt-3">
              Real Google reviews, all from the new-ownership era (October 2025 onward).
            </p>
          </div>
          {/* 2026-09-02 owner feedback: show the FULL review verbatim (no
              invented summary titles, no line clamp) and stack with CSS
              columns so a short review never stretches next to a long one. */}
          <div className="columns-1 md:columns-3 gap-8" style={{ columnFill: 'balance' }}>
            {reviews.map((r, i) => (
              <figure key={r.name} className="break-inside-avoid mb-10">
                <div className="flex items-baseline gap-3 mb-3">
                  <Numeral n={i + 1} />
                  <Stars />
                </div>
                <blockquote className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                  {r.content}
                </blockquote>
                <figcaption className="mt-4 text-xs font-bold text-gray-900">
                  {r.name} <span className="text-gray-400 font-semibold">· Google review</span>
                </figcaption>
              </figure>
            ))}
          </div>
          <p className="text-center mt-10 flex items-center justify-center gap-5 flex-wrap">
            <Link to="/testimonials" className="text-red-600 hover:text-red-700 text-sm font-bold">
              Read more member stories →
            </Link>
            {YELP_URLS[studio] && (
              <a
                href={YELP_URLS[studio]}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-red-600 text-sm font-bold"
              >
                Find us on Yelp →
              </a>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Homepage ticker — one quiet rotating quote ───────────────────────────
export function ReviewTicker() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(true);
  // 2026-09-02 (owner): clicking a review opens the FULL review in a modal
  // right there, instead of dumping people at the top of /testimonials.
  const [openReview, setOpenReview] = useState<Review | null>(null);

  useEffect(() => { fetchGoogleReviews().then(setReviews); }, []);
  useEffect(() => {
    if (reviews.length < 2 || openReview) return; // pause rotation while open
    const t = setInterval(() => {
      setVisible(false);
      setTimeout(() => { setIdx(i => (i + 1) % reviews.length); setVisible(true); }, 450);
    }, 7000);
    return () => clearInterval(t);
  }, [reviews.length, openReview]);

  if (reviews.length === 0) return null;
  const r = reviews[idx];
  // 2026-09-02: verbatim excerpt from the review itself (owner: no summaries).
  // First sentence(s), capped ~110 chars, ellipsis only if we cut mid-review.
  const firstSentences = (r.content.match(/[^.!?]+[.!?]+/g) || [r.content]);
  let excerpt = '';
  for (const s of firstSentences) {
    if ((excerpt + s).length > 110 && excerpt) break;
    excerpt += s;
    if (excerpt.length >= 60) break;
  }
  excerpt = excerpt.trim();
  const cut = excerpt.length < r.content.trim().length;
  return (
    <section
      aria-label="Member reviews from Google"
      style={{ backgroundColor: 'var(--bg-inverse, #fff)', borderTop: '1px solid rgba(0,0,0,0.07)' }}
    >
      <button
        onClick={() => setOpenReview(r)}
        className="block w-full"
        style={{ textDecoration: 'none', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        aria-label="Read the full review"
      >
        <div
          className="max-w-content mx-auto px-6 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-center"
          style={{ padding: '22px 24px', minHeight: '72px' }}
        >
          <span className="flex-none inline-flex items-center gap-2">
            <Stars />
            <span className="text-[11px] font-black uppercase tracking-[0.18em] text-gray-400">On Google</span>
          </span>
          <span
            className="text-sm sm:text-[15px] font-semibold text-gray-800 transition-opacity duration-500"
            style={{ opacity: visible ? 1 : 0 }}
          >
            “{excerpt}{cut ? '…' : ''}” <span className="text-gray-400 font-medium">· {r.name}, {r.studio}</span>
          </span>
        </div>
      </button>

      {/* Full-review modal */}
      {openReview && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center px-5"
          role="dialog"
          aria-modal="true"
          aria-label={`Google review by ${openReview.name}`}
        >
          <button
            aria-label="Close"
            onClick={() => setOpenReview(null)}
            className="absolute inset-0 w-full h-full cursor-default"
            style={{ backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', border: 'none' }}
          />
          <div
            className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl overflow-hidden"
            style={{ animation: 'popIn .3s ease-out', maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}
          >
            <style>{`@keyframes popIn{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}`}</style>
            <div className="flex items-center justify-between px-6 pt-5 pb-4" style={{ borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
              <span className="inline-flex items-center gap-2">
                <Stars />
                <span className="text-[11px] font-black uppercase tracking-[0.16em] text-gray-400">Google review</span>
              </span>
              <button
                onClick={() => setOpenReview(null)}
                aria-label="Close review"
                className="flex items-center justify-center rounded-full transition-transform hover:scale-110"
                style={{ width: 30, height: 30, backgroundColor: 'rgba(0,0,0,0.06)', border: 'none', color: '#111', cursor: 'pointer', fontSize: 14 }}
              >
                ✕
              </button>
            </div>
            <blockquote className="px-6 py-5 text-[15px] text-gray-700 whitespace-pre-line overflow-y-auto" style={{ lineHeight: 1.7 }}>
              {openReview.content}
            </blockquote>
            <div className="px-6 pb-5 pt-1 flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-gray-900">
                {openReview.name} <span className="text-gray-400 font-semibold">· {openReview.studio}</span>
              </p>
              <Link
                to="/testimonials"
                onClick={() => setOpenReview(null)}
                className="text-sm font-bold whitespace-nowrap"
                style={{ color: 'var(--brand-red)', textDecoration: 'none' }}
              >
                All reviews →
              </Link>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
