// abTest.ts — the smallest honest A/B test.
//
// No third-party tool, no extra script, no cookie banner. A coin flip on first
// visit, pinned in localStorage so the same person always sees the same form,
// and the variant rides along on the rows we already write. Results come out
// of the ab_trial_form_results view.
//
// Rules that make a test trustworthy, all enforced here:
//   1. Assign ONCE per browser, per test. Re-rolling on every page view mixes
//      the groups and makes the result meaningless.
//   2. Assign on arrival, before the person sees anything, so the split isn't
//      biased by who scrolled far enough to reach the form.
//   3. Never change the split mid-test. Changing it re-balances the groups
//      against each other and invalidates everything collected so far.
//   4. An override in the URL (?ab=A) is for OUR testing. It is not persisted,
//      so a shared link can't silently poison the sample.

export type Variant = 'A' | 'B';

const KEY_PREFIX = 'bbb_ab_';

/**
 * Returns the variant for `test`, assigning one on first visit.
 * `?ab=A` / `?ab=B` forces a variant for this page view only (not stored).
 */
export function getVariant(test: string, split = 0.5): Variant {
  // Manual override for QA. Deliberately not persisted.
  try {
    const forced = new URLSearchParams(window.location.search).get('ab');
    if (forced === 'A' || forced === 'B') return forced;
  } catch { /* SSR / prerender */ }

  const key = KEY_PREFIX + test;
  try {
    const stored = localStorage.getItem(key);
    if (stored === 'A' || stored === 'B') return stored;
    const assigned: Variant = Math.random() < split ? 'A' : 'B';
    localStorage.setItem(key, assigned);
    return assigned;
  } catch {
    // Private browsing or storage disabled. Fall back to control so a
    // storage-less visitor can never be counted as a B that we can't pin.
    return 'A';
  }
}
