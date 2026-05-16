export const BASE_URL = 'https://betterbodybootcamp.com';
export const DEFAULT_OG_IMAGE = 'https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png';
export const SITE_NAME = 'Better Body Bootcamp';

export function buildTitle(title: string): string {
  return title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
}

export function buildCanonical(path?: string): string {
  return path ? `${BASE_URL}${path}` : BASE_URL;
}
