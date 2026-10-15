// Persist Meta click identifiers at FIRST TOUCH so they survive to checkout.
//
// The bug this fixes (fbc captured on only ~9% of web trials while fbp was at
// 74%): fbc — the Facebook click-ID that ties a purchase to a specific ad
// click — was only ever built from ?fbclid in the URL *at the moment of
// checkout*, or from the pixel's own _fbc cookie. A visitor who clicks an ad,
// lands with ?fbclid=..., then navigates to the checkout page no longer has
// fbclid in the URL, and the pixel does not reliably write _fbc — so fbc came
// up empty and Meta could not attribute the purchase to the ad that drove it.
//
// Fix: on the very first page load, if ?fbclid is present, write our OWN
// durable _fbc cookie (Meta's `fb.1.<ts>.<fbclid>` format, 90-day life,
// root-path so it is shared across every page). The existing checkout code
// already reads the _fbc cookie first, so once this runs at boot it flows
// through unchanged: checkout -> trial_signups.fbc -> CAPI Purchase event.
//
// Deliberately defensive: attribution must NEVER break the app, so every
// access is wrapped and no-ops safely on SSR / no-cookie environments.

const FBC_TTL_DAYS = 90;

function readCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

function writeCookie(name: string, value: string, days: number): void {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

// Run once, as early as possible in app boot (see main.tsx). Captures the
// ad-click id from the landing URL into a durable cookie so it is still around
// when the visitor reaches checkout later in the session.
// 2026-10-15 — in-memory copy of the landing fbc, the one store that cannot
// be taken away.
//
// Both persistence layers this module relied on can silently fail in exactly
// the traffic we care about. ~95% of ad traffic arrives in the Instagram and
// Facebook in-app browsers, where cookie writes are restricted the same way
// sessionStorage is (see the matching note in lib/utm.ts, where the identical
// problem had zero utm_* on trial_signups against 2,832 tagged page_views).
// When the cookie write below is dropped, getMetaClickIds falls through to
// reading ?fbclid from the live URL — but by the time someone has typed their
// phone number, this SPA has usually mutated the URL and the parameter is
// gone. Cookie blocked plus URL rewritten equals no fbc, which is how the
// Astoria trial page took 36 ad-tagged landings on 2026-10-14 and produced a
// paid trial recorded as "no ad signal".
//
// A module-level variable survives SPA navigation within the page session and
// needs no permission from anyone. Cookie first (survives a full reload and
// multi-session journeys), then this, then the URL.
let fbcFromLanding = "";

export function captureMetaClickIds(): void {
  if (typeof window === "undefined") return;
  try {
    const fbclid = new URLSearchParams(window.location.search).get("fbclid");
    if (!fbclid) return;
    const value = `fb.1.${Date.now()}.${fbclid}`;
    // Hold it in memory regardless of whether the cookie write survives.
    if (!fbcFromLanding) fbcFromLanding = value;
    // Only write if we don't already have an _fbc (don't clobber the pixel's,
    // and keep the FIRST touch that actually carried the click id).
    if (!readCookie("_fbc")) {
      writeCookie("_fbc", value, FBC_TTL_DAYS);
    }
  } catch {
    /* never break the app over attribution */
  }
}

// Shared reader for checkout/lead calls. Durable _fbc/_fbp cookies first, then
// a live-URL fbclid fallback for the same-page (no-navigation) case.
export function getMetaClickIds(): { fbp: string; fbc: string } {
  if (typeof document === "undefined") return { fbp: "", fbc: "" };
  let fbc = readCookie("_fbc");
  if (!fbc) fbc = fbcFromLanding;          // captured at boot, cannot be blocked
  if (!fbc) {
    try {
      const fbclid = new URLSearchParams(window.location.search).get("fbclid");
      if (fbclid) fbc = `fb.1.${Date.now()}.${fbclid}`;
    } catch {
      /* ignore */
    }
  }
  return { fbp: readCookie("_fbp"), fbc };
}
