-- ─────────────────────────────────────────────────────────────────────────────
-- THE UNLOCK: populate meta_accounts.pixel_id for all 4 studios.
--
-- Why this matters: stripe-webhook already has a fully-built server-side
-- Conversions API integration (sendMetaPurchaseEvent in stripe-webhook/index.ts
-- lines 152-221). It runs on every paid trial and silently no-ops with the log:
--   "Meta CAPI skipped for ${studioSlug}: no pixel_id / access_token on file"
-- because the pixel_id column on meta_accounts has never been populated.
-- access_token is set (meta-insights-sync uses it nightly), pixel_id isn't.
--
-- Pixel IDs verified live in Chrome (June 1, 2026) — these are the same IDs
-- that fire PageView on the /trial/{studio} landing pages.
--
-- Effect: starting on the next paid trial after this migration runs,
-- stripe-webhook will POST a server-side Purchase event to Meta's CAPI:
--   • value = $49 (or actual amount_total)
--   • currency = USD
--   • event_id = trial_${stripeSessionId}   ← dedup key with client-side event
--   • user_data = hashed email/phone/name + plain fbp/fbc click identifiers
-- Within 24–48h Meta starts attributing real conversions to the right ads.
-- ─────────────────────────────────────────────────────────────────────────────

-- Defensive: add the column if it doesn't already exist (older schemas might
-- predate the CAPI work). Safe no-op if it's already there.
ALTER TABLE public.meta_accounts
  ADD COLUMN IF NOT EXISTS pixel_id text;

-- ── BEFORE: show every studio's current pixel_id status ─────────────────────
SELECT 'BEFORE' AS phase, studio_slug, ad_account_id,
       pixel_id,
       CASE WHEN access_token IS NULL OR access_token = '' THEN 'MISSING' ELSE 'OK' END AS access_token_status
FROM public.meta_accounts
ORDER BY studio_slug;


-- ── Populate pixel_id per studio (source: src/pages/LocationTrialSignup.tsx) ──
UPDATE public.meta_accounts SET pixel_id = '1291566006435758' WHERE studio_slug = 'astoria';
UPDATE public.meta_accounts SET pixel_id = '931144729719242'  WHERE studio_slug = 'bayside';
UPDATE public.meta_accounts SET pixel_id = '979328851475276'  WHERE studio_slug = 'fresh-meadows';
UPDATE public.meta_accounts SET pixel_id = '2160299368182872' WHERE studio_slug = 'williamsburg';


-- ── AFTER: confirm all 4 rows now have pixel_id populated ───────────────────
SELECT 'AFTER' AS phase, studio_slug, ad_account_id, pixel_id,
       CASE WHEN pixel_id IS NULL OR pixel_id = '' THEN '🔴 STILL EMPTY' ELSE '✓ ready for CAPI' END AS capi_ready
FROM public.meta_accounts
ORDER BY studio_slug;
