// Reads utm_* tags off the current URL so a trial signup can be attributed to
// the marketing link it came from — e.g. /ig/bayside redirects to
// /trial/bayside?utm_source=instagram, and this pulls "instagram" out.
export interface UtmParams {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
}

export function getUtmParams(): UtmParams {
  try {
    const p = new URLSearchParams(window.location.search);
    const v = (k: string) => {
      const x = (p.get(k) || '').trim().slice(0, 100);
      return x || null;
    };
    return {
      utmSource: v('utm_source'),
      utmMedium: v('utm_medium'),
      utmCampaign: v('utm_campaign'),
      utmContent: v('utm_content'),
    };
  } catch {
    return { utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null };
  }
}
