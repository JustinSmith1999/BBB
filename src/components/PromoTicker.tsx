import { Link } from 'react-router-dom';

// ─── PromoTicker (2026-08-28) ────────────────────────────────────────────────
// Flyer-styled scrolling promo band for the Back to School $299 offer.
// Sits between the Hero and BrandPillars on the homepage. Uses the ORIGINAL
// flyer green (#C8FF2D) with black type, matching the printed back-to-school
// flyers. Whole band clickable → /backtoschool. Remove when the promo ends.
// Reuses the scroll keyframes from index.css (slow variant, 60s loop).
// ─────────────────────────────────────────────────────────────────────────────

const FLYER_GREEN = '#C8FF2D';
const INK = '#0D0D0D';

export default function PromoTicker() {
  const chunk = (
    <>
      <span style={{ color: INK }}>BACK TO SCHOOL SPECIAL</span>
      <span className="mx-4" style={{ color: INK, opacity: 0.35 }}>★</span>
      <span style={{ color: INK }}>2 MONTHS FOR $299</span>
      <span className="mx-4" style={{ color: INK, opacity: 0.35 }}>★</span>
      <span style={{ color: INK }}>ALL FOUR STUDIOS</span>
      <span className="mx-4" style={{ color: INK, opacity: 0.35 }}>★</span>
      <span style={{ color: INK }}>CLAIM YOUR SPOT</span>
      <span className="mx-4" style={{ color: INK, opacity: 0.35 }}>★</span>
    </>
  );

  return (
    <Link
      to="/backtoschool"
      aria-label="Back to School special: 2 months for $299"
      className="block w-full overflow-hidden"
      style={{
        backgroundColor: FLYER_GREEN,
        borderTop: `1px solid ${INK}`,
        borderBottom: `1px solid ${INK}`,
      }}
    >
      <div className="animate-scroll-slow whitespace-nowrap flex items-center" style={{ height: '52px' }}>
        {[0, 1].map((i) => (
          <span
            key={i}
            className="inline-block font-display font-black uppercase"
            style={{ fontSize: 'clamp(15px, 2vw, 20px)', letterSpacing: '0.08em' }}
          >
            {Array.from({ length: 6 }).map((_, j) => (
              <span key={j}>{chunk}</span>
            ))}
          </span>
        ))}
      </div>
    </Link>
  );
}
