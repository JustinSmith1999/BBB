import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';

// ─── PromoPopup (2026-09-02) ─────────────────────────────────────────────────
// Back to School "2 Months for $299" popup. Flyer green + ink, matching
// PromoTicker. Appears once after a short delay, routes to /backtoschool
// (which handles studio pick + Stripe checkout). Dismiss = snoozed 3 days.
// Never shows on the promo/checkout/success pages, and never interrupts a
// visitor who is already mid-signup on a trial page. Remove with the promo.
// ─────────────────────────────────────────────────────────────────────────────

const FLYER_GREEN = '#C8FF2D';
const INK = '#0D0D0D';
const SNOOZE_KEY = 'bbb_bts299_popup_snooze';
const SNOOZE_DAYS = 3;
const DELAY_MS = 1200; // 2026-09-02: was 5000 — owner wants it right away

// Paths where the popup must never appear.
const BLOCKED = [/^\/backtoschool/, /^\/trial/, /^\/trial-success/, /^\/comeback/, /^\/free-classes/, /^\/staging/, /^\/dashboard/];

export default function PromoPopup() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    if (BLOCKED.some(r => r.test(pathname))) return;
    try {
      const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
      if (Date.now() < until) return;
    } catch { /* private mode: still show once per pageview */ }
    const t = setTimeout(() => setOpen(true), DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // one shot per page load, not per route change

  const snooze = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 864e5)); } catch { /* ignore */ }
    setOpen(false);
  };

  const claim = () => {
    snooze();
    navigate('/backtoschool');
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center px-5"
      role="dialog"
      aria-modal="true"
      aria-label="Back to School special: 2 months for $299"
    >
      {/* Backdrop */}
      <button
        aria-label="Close"
        onClick={snooze}
        className="absolute inset-0 w-full h-full cursor-default"
        style={{ backgroundColor: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(3px)' }}
      />

      {/* Card — 2026-09-02 redesign: the flat all-green flyer card read cheap
          (owner). Now the site's dark editorial language with the flyer green
          as the accent: dark card, hairline dividers, outlined giant price. */}
      <div
        className="relative w-full max-w-md overflow-hidden rounded-2xl shadow-2xl animate-[popIn_.35s_ease-out]"
        style={{ backgroundColor: '#0E0F13', border: '1px solid rgba(245,241,234,0.14)' }}
      >
        <style>{`@keyframes popIn{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}`}</style>

        {/* Green top rule — the campaign's signature */}
        <div style={{ height: '4px', backgroundColor: FLYER_GREEN }} />

        <button
          onClick={snooze}
          aria-label="Close popup"
          className="absolute top-4 right-4 z-10 flex items-center justify-center rounded-full transition-transform hover:scale-110"
          style={{ width: 32, height: 32, backgroundColor: 'rgba(245,241,234,0.08)', border: '1px solid rgba(245,241,234,0.18)', color: '#F5F1EA' }}
        >
          <X style={{ width: 16, height: 16 }} />
        </button>

        <div className="px-8 pt-8 pb-7 text-center">
          <p
            className="font-bold uppercase mb-5"
            style={{ color: FLYER_GREEN, fontSize: '11px', letterSpacing: '0.3em' }}
          >
            Back to School Special
          </p>

          <p
            className="font-display font-black leading-none select-none"
            style={{
              fontSize: 'clamp(4.2rem, 15vw, 5.8rem)',
              letterSpacing: '-0.02em',
              color: 'transparent',
              WebkitTextStroke: `2px ${FLYER_GREEN}`,
            }}
          >
            $299
          </p>
          <p
            className="font-display font-black uppercase mt-2"
            style={{ color: '#F5F1EA', fontSize: 'clamp(1.2rem, 4vw, 1.55rem)', letterSpacing: '0.02em', lineHeight: 1 }}
          >
            2 Months Unlimited
          </p>

          <div className="mx-auto my-5" style={{ height: '1px', width: '64px', backgroundColor: 'rgba(245,241,234,0.18)' }} />

          <p className="mx-auto" style={{ color: 'rgba(245,241,234,0.65)', fontSize: '13.5px', lineHeight: 1.6, maxWidth: '32ch' }}>
            Every coach-led class, all four studios. One payment, no auto-renewal.
          </p>

          <button
            onClick={claim}
            className="font-display font-black uppercase w-full mt-6 rounded-full transition-transform hover:scale-[1.02] active:scale-[0.99]"
            style={{ backgroundColor: FLYER_GREEN, color: INK, padding: '16px 20px', fontSize: '15px', letterSpacing: '0.08em', border: 'none', cursor: 'pointer' }}
          >
            Claim your spot →
          </button>

          <button
            onClick={snooze}
            className="mt-4 font-bold uppercase"
            style={{ background: 'none', border: 'none', color: 'rgba(245,241,234,0.4)', fontSize: '11px', letterSpacing: '0.14em', cursor: 'pointer' }}
          >
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
