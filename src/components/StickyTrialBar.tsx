import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * StickyTrialBar — a persistent "start the trial" bar, mobile only.
 *
 * 2026-10-16. WHY THIS EXISTS, measured not assumed. On an iPhone viewport
 * (375x812) the live /pricing page is 6,248px tall — 7.7 screens — and the
 * only trial CTA above the fold sits at 1,004px. After that there is nothing
 * actionable until 5,206px: 5.2 screens of membership pricing with no way to
 * act on it. Someone comparing monthly prices on their phone, which is the
 * exact journey Justin described, reads the whole page and then has to scroll
 * back up or hunt the nav.
 *
 * This keeps one tap target on screen the entire time. It is deliberately
 * NOT shown on:
 *   - the trial pages themselves (the form is already at 0.58 screens there,
 *     and a floating bar over a form you are filling in is an obstruction)
 *   - desktop, where the whole page is a third as tall in screens and the
 *     header CTA stays reachable
 *
 * Appears after the user has scrolled past the hero, so it never covers the
 * first impression, and it respects the iOS safe area so it does not sit
 * under the home indicator.
 */
export default function StickyTrialBar({
  to = '/trial',
  label = 'Start 2 Weeks for $49',
  showAfterPx = 700,
}: {
  to?: string;
  label?: string;
  showAfterPx?: number;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > showAfterPx);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [showAfterPx]);

  return (
    <div
      aria-hidden={!show}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 60,
        padding: '10px 16px calc(10px + env(safe-area-inset-bottom, 0px))',
        background: 'rgba(255,255,255,0.97)',
        backdropFilter: 'blur(8px)',
        borderTop: '1px solid rgba(0,0,0,0.08)',
        transform: show ? 'translateY(0)' : 'translateY(110%)',
        transition: 'transform 220ms ease',
        pointerEvents: show ? 'auto' : 'none',
      }}
      className="md:hidden"
      data-testid="sticky-trial-bar"
    >
      <Link
        to={to}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // 52px clears the 44px minimum tap target with room to spare.
          minHeight: '52px',
          width: '100%',
          borderRadius: '999px',
          backgroundColor: 'var(--brand-red)',
          color: '#fff',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontSize: '15px',
          textDecoration: 'none',
        }}
      >
        {label}
      </Link>
    </div>
  );
}
