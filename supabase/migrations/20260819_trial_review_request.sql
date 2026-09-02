-- 2026-08-19: Auto-review engine support.
-- Adds the per-studio Google review link + a one-time "already asked" marker so
-- trial-review-request can ask each active trial member for a Google review
-- exactly once, per studio, on autopilot. Review velocity is the #1 Map Pack
-- ranking factor and we currently collect it from nobody.

-- Per-studio Google review deep link. Populate from each Business Profile:
--   Business Profile → "Ask for reviews" / "Get more reviews" → copy the link
--   (looks like https://g.page/r/XXXX/review). The engine SKIPS any studio
--   whose review_link is NULL, so it's safe to fill these in one at a time.
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS review_link text;

-- One-time marker so a member is asked for a review at most once, ever.
ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS review_request_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_trial_signups_review_request
  ON public.trial_signups (payment_status, review_request_sent_at, payment_date)
  WHERE review_request_sent_at IS NULL;

-- Example (fill in the real links once you've copied them from each profile):
-- UPDATE public.locations SET review_link = 'https://g.page/r/XXXX/review' WHERE name = 'Bayside';
-- UPDATE public.locations SET review_link = 'https://g.page/r/YYYY/review' WHERE name = 'Astoria';
-- UPDATE public.locations SET review_link = 'https://g.page/r/ZZZZ/review' WHERE name = 'Williamsburg';
-- UPDATE public.locations SET review_link = 'https://g.page/r/WWWW/review' WHERE name = 'Fresh Meadows';

SELECT 'trial_review_request columns ready' AS status;
