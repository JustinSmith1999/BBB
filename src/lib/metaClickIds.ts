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
export function captureMetaClickIds(): void {
  if (typeof window === "undefined") return;
  try {
    const fbclid = new URLSearchParams(window.location.search).get("fbclid");
    // Only write if we don't already have an _fbc (don't clobber the pixel's,
    // and keep the FIRST touch that actually carried the click id).
    if (fbclid && !readCookie("_fbc")) {
      writeCookie("_fbc", `fb.1.${Date.now()}.${fbclid}`, FBC_TTL_DAYS);
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
