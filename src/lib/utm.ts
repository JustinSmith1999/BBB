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
  // Re-capture so the current URL always wins if it has fresh tags.
  captureUtmsFromUrl();
  const stored = readSession();
  return {
    utmSource:   stored.utmSource   ?? null,
    utmMedium:   stored.utmMedium   ?? null,
    utmCampaign: stored.utmCampaign ?? null,
    utmContent:  stored.utmContent  ?? null,
  };
}
