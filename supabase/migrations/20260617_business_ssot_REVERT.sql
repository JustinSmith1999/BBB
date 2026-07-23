-- ─────────────────────────────────────────────────────────────────────────
-- 2026-06-17 · REVERT · Business SSOT work
--
-- Per Justin's request, drop all RPCs + helpers added today for the
-- "Full Business Activity" dashboard work. Migrations stay on disk as a
-- record but the DB returns to its prior state (no full-business RPCs).
--
-- After running this, the bbb-marketing dashboard tile that called
-- get_business_combined_summary will just show "Data unavailable" until
-- the HTML/JS for that card is also removed (next step).
-- ─────────────────────────────────────────────────────────────────────────

-- Combined summary (called by the dashboard tile)
DROP FUNCTION IF EXISTS public.get_business_combined_summary(INTEGER);

-- Underlying per-domain RPCs
DROP FUNCTION IF EXISTS public.get_business_revenue_total(TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.get_business_members_total(TEXT);
DROP FUNCTION IF EXISTS public.get_business_trials_total(TEXT, INTEGER);

-- Predicate helpers
DROP FUNCTION IF EXISTS public._is_membership_item(TEXT);
DROP FUNCTION IF EXISTS public._is_trial_item(TEXT);

-- Verify · all five names should error with "function does not exist"
-- after this runs. (Pasting these into the editor will fail safely.)
-- SELECT * FROM public.get_business_combined_summary(7);
-- SELECT * FROM public.get_business_revenue_total(NULL, 7);
-- SELECT * FROM public.get_business_members_total(NULL);
-- SELECT * FROM public.get_business_trials_total(NULL, 7);
