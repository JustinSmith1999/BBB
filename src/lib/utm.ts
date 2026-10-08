// UTM capture + read.
//
// Old behavior (the bug we're fixing): getUtmParams() read utm_* directly from
// window.location.search at form-submit time. If the URL had been mutated by
// the SPA (or the user landed via /ig redirect → trial page → reloaded → no
// query string) we lost attribution and the signup landed as "Direct/untagged".
//
// New behavior: captureUtmsFromUrl() is called once on page mount; it writes
// any utm_* it finds into sessionStorage. getUtmParams() then reads from
// sessionStorage so the attribution survives re-renders, refreshes, and
// internal SPA navigation within the same browser tab.
const SESSION_KEY = 'bbb_utm';
const MAX_LEN = 100;

export interface UtmParams {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
}

type StoredUtm = Partial<Record<keyof UtmParams, string>>;

function readSession(): StoredUtm {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? (parsed as StoredUtm) : {};
  } catch {
    return {};
  }
}

function writeSession(v: StoredUtm): void {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(v)); } catch {}
}

/**
 * Read utm_* off the current URL and persist into sessionStorage. Call this
 * once on mount of every page the trial funnel can land on (LocationTrialSignup,
 * LocationSpecialSignup, LocationResignSignup, TrialSignup).
 *
 * Only overwrites existing session values when the URL actually has fresh
 * utm_* params — so a user who arrived via /ig and then internally clicks
 * a non-UTM link keeps their original Instagram attribution.
 */
export function captureUtmsFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const p = new URLSearchParams(window.location.search);
    const fromUrl: StoredUtm = {};
    const v = (k: string) => {
      const x = (p.get(k) || '').trim().slice(0, MAX_LEN);
      return x || null;
    };
    const src = v('utm_source');
    const med = v('utm_medium');
    const cmp = v('utm_campaign');
    const con = v('utm_content');
    if (src) fromUrl.utmSource   = src;
    if (med) fromUrl.utmMedium   = med;
    if (cmp) fromUrl.utmCampaign = cmp;
    if (con) fromUrl.utmContent  = con;
    if (Object.keys(fromUrl).length === 0) return;
    // Merge over what's already in session (URL wins for any field it sets).
    const merged = { ...readSession(), ...fromUrl };
    writeSession(merged);
  } catch {
    /* ignore */
  }
}

/**
 * Pull UTMs to send to the create-trial-checkout edge function. Prefers the
 * current URL (in case the user clicked a fresh tagged link) and falls back
 * to whatever captureUtmsFromUrl() previously saved.
 */
export function getUtmParams(): UtmParams {
  // 2026-10-08 FIX — THIS IS WHY EVERY PAID TRIAL READ AS "DIRECT".
  //
  // This used to call captureUtmsFromUrl() and then return ONLY what
  // sessionStorage handed back. captureUtmsFromUrl parses the URL and writes
  // to sessionStorage; it returns nothing. Every storage access in this file
  // is wrapped in try/catch that falls back to {}. So whenever sessionStorage
  // was unavailable, the tags were sitting right there in the URL, got parsed,
  // and were then discarded — the function returned four nulls.
  //
  // That is not a rare edge case here: roughly 95% of this traffic is mobile
  // arriving through the Instagram and Facebook in-app browsers, which is
  // exactly where storage gets restricted.
  //
  // The proof is in our own data over 30 days:
  //   page_views  2,832 rows tagged facebook/cpc   <- track.ts reads the URL directly
  //   trial_signups       0 rows with any utm      <- this function, via sessionStorage
  // Same visitors, same pages, same visit. The only difference is that one
  // path trusted storage and the other didn't.
  //
  // Now: read the URL FIRST and use it when present, with sessionStorage only
  // as the fallback for people who landed tagged earlier in the session and
  // are now on an untagged internal page. Never depends on storage working.
  let fromUrl: StoredUtm = {};
  if (typeof window !== 'undefined') {
    try {
      const p = new URLSearchParams(window.location.search);
      const v = (k: string) => {
        const x = (p.get(k) || '').trim().slice(0, MAX_LEN);
        return x || null;
      };
      const src = v('utm_source'), med = v('utm_medium');
      const cmp = v('utm_campaign'), con = v('utm_content');
      if (src) fromUrl.utmSource   = src;
      if (med) fromUrl.utmMedium   = med;
      if (cmp) fromUrl.utmCampaign = cmp;
      if (con) fromUrl.utmContent  = con;
    } catch { /* malformed query string — fall through to storage */ }
  }

  // Keep persisting for later pages in the journey. Best-effort by design:
  // if this throws, the URL values above still get returned.
  captureUtmsFromUrl();
  const stored = readSession();

  return {
    utmSource:   fromUrl.utmSource   ?? stored.utmSource   ?? null,
    utmMedium:   fromUrl.utmMedium   ?? stored.utmMedium   ?? null,
    utmCampaign: fromUrl.utmCampaign ?? stored.utmCampaign ?? null,
    utmContent:  fromUrl.utmContent  ?? stored.utmContent  ?? null,
  };
}
