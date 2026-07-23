-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Round 2 spam cleanup — catches the 5 obvious ones the first
-- regex pass missed (different B2B / community-pitch vectors).
--
-- Identified by eyeballing the survivors list:
--   1. Amy Basem · welcomeamy@faimbd.com (×3 rows · 6/5)
--      "Town Hall is now preparing Welcome Kits for…" — community welcome-
--      kit B2B pitch
--   2. Chris Grayson · chris@animateddexplainers.com (×1 · 6/3)
--      "If your audience doesn't understand your…" — animated explainer
--      agency cold outreach
--   3. Dawn Chimento · info@dcpelvictherapy.com (×1 · 5/22)
--      "My name is Dawn Chimento and I am…" — B2B cross-promotion from a
--      pelvic therapy practice. info@ + business domain = vendor pitch.
--
-- Also extending the body matcher with the patterns that didn't trigger
-- last time so any future spam in this lane gets caught:
--   - "welcome kits"
--   - "your audience doesn't understand"
--   - "town hall is now preparing"
--
-- Pre-May-15 rows are untouched — every WHERE has created_at >= 2026-05-15.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Drop the 3 known-spam email addresses ──────────────────────────────
WITH known_spam_emails AS (
  SELECT unnest(ARRAY[
    'welcomeamy@faimbd.com',
    'chris@animateddexplainers.com',
    'info@dcpelvictherapy.com'
  ]) AS email
)
UPDATE public.trial_signups
   SET deleted_at = now()
 WHERE source_category = 'contact_form'
   AND deleted_at IS NULL
   AND created_at >= '2026-05-15'::date
   AND LOWER(email) IN (SELECT email FROM known_spam_emails);

DELETE FROM public.leads
 WHERE source = 'contact_form'
   AND created_at >= '2026-05-15'::date
   AND LOWER(email) IN (
     'welcomeamy@faimbd.com',
     'chris@animateddexplainers.com',
     'info@dcpelvictherapy.com'
   );

DELETE FROM public.contact_submissions
 WHERE created_at >= '2026-05-15'::date
   AND LOWER(email) IN (
     'welcomeamy@faimbd.com',
     'chris@animateddexplainers.com',
     'info@dcpelvictherapy.com'
   );

-- ── 2. Extended body matcher · catches the same B2B patterns going forward
UPDATE public.trial_signups
   SET deleted_at = now()
 WHERE source_category = 'contact_form'
   AND deleted_at IS NULL
   AND created_at >= '2026-05-15'::date
   AND LOWER(COALESCE(front_desk_note, '')) ~ (
     'welcome kits|your audience doesn''t understand|town hall is now preparing|' ||
     'animated explainer|explainer video|pelvic therap'
   );

DELETE FROM public.leads
 WHERE source = 'contact_form'
   AND created_at >= '2026-05-15'::date
   AND LOWER(COALESCE(notes, '')) ~ (
     'welcome kits|your audience doesn''t understand|town hall is now preparing|' ||
     'animated explainer|explainer video|pelvic therap'
   );

DELETE FROM public.contact_submissions
 WHERE created_at >= '2026-05-15'::date
   AND LOWER(COALESCE(message, '')) ~ (
     'welcome kits|your audience doesn''t understand|town hall is now preparing|' ||
     'animated explainer|explainer video|pelvic therap'
   );

-- ── 3. Verify — what's left after round 2 ─────────────────────────────────
SELECT
  ts.created_at,
  ts.name,
  ts.email,
  LEFT(ts.front_desk_note, 90) AS note
FROM public.trial_signups ts
WHERE ts.source_category = 'contact_form'
  AND ts.deleted_at IS NULL
  AND ts.created_at >= '2026-05-15'::date
ORDER BY ts.created_at DESC;
