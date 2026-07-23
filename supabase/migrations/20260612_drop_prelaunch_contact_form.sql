-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Drop pre-launch contact-form rows from /homebase Kanban.
--
-- The contact_submissions → trial_signups backfill (20260612_contact_form_into_kanban.sql)
-- pulled every contact_submission ever made, including pre-launch (< May 15, 2026)
-- inquiries from the previous-ownership era — e.g. Lisa Condon (2025-12-10)
-- asking to freeze her membership. These rows pollute /homebase and are not
-- actionable by current staff.
--
-- Cleanup:
--   1. Soft-delete pre-May-15 contact_form rows in trial_signups (deleted_at).
--      /homebase already filters `deleted_at IS NULL` so they vanish from the
--      Kanban but stay in the table for forensics.
--   2. Hard-delete the matching pre-May-15 contact_form rows in leads. They
--      don't drive any UI we want them in, and they were a backfill artifact.
--
-- Safe to re-run: idempotent (already-deleted rows stay deleted; the leads
-- DELETE just removes the now-orphaned rows again as a no-op).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Soft-delete pre-launch contact_form rows in trial_signups ──────────
UPDATE public.trial_signups
   SET deleted_at = now()
 WHERE source_category = 'contact_form'
   AND created_at < '2026-05-15'::date
   AND deleted_at IS NULL;

-- ── 2. Hard-delete pre-launch contact_form rows in leads ──────────────────
DELETE FROM public.leads
 WHERE source = 'contact_form'
   AND created_at < '2026-05-15'::date;

-- ── 3. Verify what's left vs what got dropped ─────────────────────────────
SELECT
  'trial_signups · contact_form · still visible' AS label,
  COUNT(*) AS n
FROM public.trial_signups
WHERE source_category = 'contact_form'
  AND deleted_at IS NULL
UNION ALL
SELECT
  'trial_signups · contact_form · soft-deleted (pre-launch)',
  COUNT(*)
FROM public.trial_signups
WHERE source_category = 'contact_form'
  AND deleted_at IS NOT NULL
UNION ALL
SELECT
  'leads · contact_form · remaining',
  COUNT(*)
FROM public.leads
WHERE source = 'contact_form';
