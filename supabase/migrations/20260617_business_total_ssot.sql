-- ─────────────────────────────────────────────────────────────────────────
-- 2026-06-17 · REVERTED · was the Unified Business SSOT migration
--
-- Per Justin's request, this work was reverted. All RPCs created here are
-- dropped by 20260617_business_ssot_REVERT.sql which runs later in the
-- migration order. Leaving this file as a no-op so re-running the
-- migrations folder doesn't recreate state we already tore down.
--
-- If you need to see what was in here, check git history.
-- ─────────────────────────────────────────────────────────────────────────

-- intentionally empty
SELECT 1 WHERE FALSE;
