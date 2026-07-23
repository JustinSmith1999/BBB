-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-04: SUPERSEDED — DO NOT RUN.
--
-- This migration would have snapped stripe_paid_mirror.paid_at back to the
-- true Stripe charge time, which is the OPPOSITE of what Justin decided.
-- Per his call we keep the drifted customers showing as "paid today" on the
-- Daily Pulse tiles. The relabel-as-today migration handles that.
--
-- Use 20260604_relabel_drift_as_today.sql instead.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT 'This migration is superseded — see 20260604_relabel_drift_as_today.sql' AS warning;
