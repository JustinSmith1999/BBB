// visitor.ts — one stable id per browser, for the life of that browser.
//
// This is the thing that makes "what did this member do before they signed
// up?" answerable. page_views already had bbb_sid, but that lives in
// sessionStorage and dies with the tab, so a person who visited three times
// over two weeks was three strangers.
//
// visitorId() is written once, on first visit, and never changes. It is a
// random UUID: no name, no email, nothing derived from the device. On its own
// it says only "this browser". It becomes a person the moment they fill in the
// trial form, because capture-lead stamps the same id on their trial_signups
// row, and from then on every click they ever made joins back to them.

const KEY = 'bbb_vid';

function uuid(): string {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch { /* older browsers */ }
  return 'v-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Stable per-browser id. Returns '' if storage is unavailable (private mode). */
export function visitorId(): string {
  try {
    let v = localStorage.getItem(KEY);
    if (!v) {
      v = uuid();
      localStorage.setItem(KEY, v);
    }
    return v;
  } catch {
    // Private browsing. We simply can't follow this person across visits;
    // their clicks still record, just without a join key.
    return '';
  }
}
