-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Remove B2B / cold-outreach spam from contact-form leads.
--
-- The /contact form is a wide-open inbox so it attracts the usual SaaS /
-- agency / outsourcing pitches ("John M. — Need employees for $10? At OBK
-- we specialize in providing...", "outsource-bookkeeper.com", etc).
-- These pollute /homebase's Abandoned Checkout column and the dashboard's
-- inquiry counts.
--
-- This migration:
--   1. SOFT-DELETES spam trial_signups (source_category='contact_form')
--      so they vanish from /homebase Kanban but stay in the table for
--      forensics. The Kanban filter `deleted_at IS NULL` hides them.
--   2. HARD-DELETES the matching rows from leads (no foreign keys to break).
--   3. PRE-MAY-15 ROWS ARE NEVER TOUCHED — the WHERE clauses include
--      `created_at >= 2026-05-15`. Historical legacy data stays intact.
--
-- Spam matcher — conservative, ANY of:
--   - email domain matches: outsource*, *bookkeep*, *agency.com, *seo*.com
--     *marketing.com, *outsourcing*, *.ru, *.cn
--   - message body contains B2B-tells: "we specialize in", "outsourc",
--     "bookkeep", "marketing services", "seo services", "web design
--     services", "lead generation", "boost your sales", "increase revenue",
--     "save costs", "ai solution", "grow your business", "employees for $",
--     "virtual assistant", "growth hacking", "b2b"
--
-- These are deliberately tight enough that a fitness-customer message
-- ("what are your class times?", "I want to freeze my membership") won't
-- trigger. Safe to re-run: already-deleted rows stay deleted.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Identify spam (audit pass — visible in the migration output) ────────
WITH spam_audit AS (
  SELECT
    ts.id,
    ts.name,
    ts.email,
    ts.created_at,
    ts.front_desk_note,
    'trial_signups' AS source_table
  FROM public.trial_signups ts
  WHERE ts.source_category = 'contact_form'
    AND ts.deleted_at IS NULL
    AND ts.created_at >= '2026-05-15'::date
    AND (
      -- Email-domain matchers
      ts.email ~* '(outsourc|bookkeep|agency\.com|marketing\.com|outsourcing|\.ru$|\.cn$)'
      OR
      -- Body / note matchers
      LOWER(COALESCE(ts.front_desk_note, '')) ~ ('(' ||
        'we specialize in|outsourc|bookkeep|marketing services|seo services|' ||
        'web design services|lead generation|boost your sales|increase revenue|' ||
        'save costs|ai solution|grow your business|employees for \$|' ||
        'virtual assistant|growth hacking|b2b' ||
      ')')
    )
)
SELECT
  '─── SPAM AUDIT — these rows will be removed ───' AS label,
  COUNT(*) AS total_spam_rows
FROM spam_audit;

-- ── 2. Soft-delete spam from trial_signups (post-launch only) ──────────────
UPDATE public.trial_signups
   SET deleted_at = now()
 WHERE source_category = 'contact_form'
   AND deleted_at IS NULL
   AND created_at >= '2026-05-15'::date
   AND (
     email ~* '(outsourc|bookkeep|agency\.com|marketing\.com|outsourcing|\.ru$|\.cn$)'
     OR LOWER(COALESCE(front_desk_note, '')) ~ ('(' ||
        'we specialize in|outsourc|bookkeep|marketing services|seo services|' ||
        'web design services|lead generation|boost your sales|increase revenue|' ||
        'save costs|ai solution|grow your business|employees for \$|' ||
        'virtual assistant|growth hacking|b2b' ||
     ')')
   );

-- ── 3. Hard-delete the matching rows from leads (post-launch only) ─────────
DELETE FROM public.leads
 WHERE source = 'contact_form'
   AND created_at >= '2026-05-15'::date
   AND (
     email ~* '(outsourc|bookkeep|agency\.com|marketing\.com|outsourcing|\.ru$|\.cn$)'
     OR LOWER(COALESCE(notes, '')) ~ ('(' ||
        'we specialize in|outsourc|bookkeep|marketing services|seo services|' ||
        'web design services|lead generation|boost your sales|increase revenue|' ||
        'save costs|ai solution|grow your business|employees for \$|' ||
        'virtual assistant|growth hacking|b2b' ||
     ')')
   );

-- ── 4. Hard-delete the underlying contact_submissions rows (post-launch) ──
-- So if anyone re-runs the backfill / trigger we don't resurrect the same
-- spam. Pre-May-15 contact_submissions are untouched.
DELETE FROM public.contact_submissions
 WHERE created_at >= '2026-05-15'::date
   AND (
     email ~* '(outsourc|bookkeep|agency\.com|marketing\.com|outsourcing|\.ru$|\.cn$)'
     OR LOWER(COALESCE(message, '')) ~ ('(' ||
        'we specialize in|outsourc|bookkeep|marketing services|seo services|' ||
        'web design services|lead generation|boost your sales|increase revenue|' ||
        'save costs|ai solution|grow your business|employees for \$|' ||
        'virtual assistant|growth hacking|b2b' ||
     ')')
   );

-- ── 5. Verify · counts that remain after cleanup ───────────────────────────
SELECT 'trial_signups · contact_form · visible (post-cleanup)' AS label,
       COUNT(*) AS n
FROM public.trial_signups
WHERE source_category = 'contact_form' AND deleted_at IS NULL
UNION ALL
SELECT 'trial_signups · contact_form · soft-deleted total',
       COUNT(*)
FROM public.trial_signups
WHERE source_category = 'contact_form' AND deleted_at IS NOT NULL
UNION ALL
SELECT 'leads · contact_form · remaining (since launch)',
       COUNT(*)
FROM public.leads
WHERE source = 'contact_form' AND created_at >= '2026-05-15'::date
UNION ALL
SELECT 'leads · contact_form · PRE-LAUNCH (untouched)',
       COUNT(*)
FROM public.leads
WHERE source = 'contact_form' AND created_at < '2026-05-15'::date
UNION ALL
SELECT 'contact_submissions · since launch · remaining',
       COUNT(*)
FROM public.contact_submissions
WHERE created_at >= '2026-05-15'::date
UNION ALL
SELECT 'contact_submissions · PRE-LAUNCH (untouched)',
       COUNT(*)
FROM public.contact_submissions
WHERE created_at < '2026-05-15'::date;

-- ── 6. Show what's left so you can eyeball for false positives ─────────────
SELECT
  ts.created_at,
  ts.name,
  ts.email,
  LEFT(ts.front_desk_note, 80) AS note
FROM public.trial_signups ts
WHERE ts.source_category = 'contact_form'
  AND ts.deleted_at IS NULL
  AND ts.created_at >= '2026-05-15'::date
ORDER BY ts.created_at DESC
LIMIT 30;
