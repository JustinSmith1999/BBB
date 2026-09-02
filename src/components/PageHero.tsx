import { ReactNode } from 'react';

// ─── PageHero (2026-08-29) ───────────────────────────────────────────────────
// THE one hero. Justin: "Heros on different pages vary in size and background
// again. I want them all in this style: SINCE 2011 · NYC / BUILDING NYC'S /
// BEST BODIES — but bigger."
// Style contract (About-page hero, scaled up):
//   • dark real-footage background (photo or silent video), brightness ~0.45
//   • identical gradient into the page bg so every page lands the same
//   • bottom-left anchored content: red eyebrow, stacked display headline
//   • one size everywhere: clamp(3.25rem, 8vw, 8rem), line-height 0.9
// Pages pass copy + media only. Do not restyle heroes per-page again — change
// it here or nowhere.
// ─────────────────────────────────────────────────────────────────────────────

interface PageHeroProps {
  eyebrow: string;
  lines: ReactNode[];      // stacked headline lines; wrap accent words in <Red>
  sub?: string;
  children?: ReactNode;    // optional extras under the headline (chips, etc.)
}

export function Red({ children }: { children: ReactNode }) {
  return <span style={{ color: 'var(--brand-red)' }}>{children}</span>;
}

// 2026-08-29 (Justin): NO backgrounds — pure type on the page background,
// CENTERED on every page. Identical everywhere.
export default function PageHero({ eyebrow, lines, sub, children }: PageHeroProps) {
  return (
    <div
      className="relative overflow-hidden flex items-center justify-center text-center"
      // 2026-09-02 (owner: "why so much empty space") — was 54vh/600px min.
      // Content-driven height with a modest floor; same look, less dead air.
      style={{ minHeight: 'clamp(300px, 36vh, 420px)', paddingTop: '56px', paddingBottom: '64px', borderBottom: '1px solid var(--divider)', backgroundColor: 'var(--bg-primary)' }}
    >

      <div className="relative z-10 w-full max-w-content mx-auto px-6 flex flex-col items-center">
        <p className="eyebrow mb-4" style={{ letterSpacing: '0.26em', fontSize: 'clamp(12px, 1vw, 16px)' }}>
          {eyebrow}
        </p>
        <h1
          className="font-display font-black uppercase"
          style={{ fontSize: 'clamp(3.25rem, 8vw, 8rem)', lineHeight: '0.9', letterSpacing: '-0.015em', color: 'var(--text-primary)' }}
        >
          {lines.map((l, i) => (
            <span key={i} className="block">{l}</span>
          ))}
        </h1>
        {sub && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 'clamp(15px, 1.2vw, 19px)', lineHeight: '1.65', maxWidth: '54ch', marginTop: '24px' }}>
            {sub}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
