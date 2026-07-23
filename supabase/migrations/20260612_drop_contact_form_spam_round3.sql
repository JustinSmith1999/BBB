-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-12 · Round 3 spam cleanup — the 2 borderline cold-pitches.
--
--   1. Emilia Zakoscielny · emiliazakoscielny@gmail.com (6/2)
--      "Hi! My name is Emilia, and I am a group fitness instr[uctor]" —
--      cold pitch from another trainer looking for a teaching gig.
--   2. James Mcnamee · jamesmcn8255@gmail.com (6/2)
--      "I am a student intern here from Ireland for" — student internship
--      cold outreach.
--
-- Neither is paying-customer interest. Justin confirmed: drop both.
-- Pre-May-15 rows untouched (every WHERE has created_at >= 2026-05-15).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Soft-delete from trial_signups ──────────────────────────────────────
UPDATE public.trial_signups
   SET deleted_at = now()
 WHERE source_category = 'contact_form'
   AND deleted_at IS NULL
   AND created_at >= '2026-05-15'::date
   AND LOWER(email) IN (
     'emiliazakoscielny@gmail.com',
     'jamesmcn8255@gmail.com'
   );

-- ── 2. Hard-delete from leads ──────────────────────────────────────────────
DELETE FROM public.leads
 WHERE source = 'contact_form'
   AND created_at >= '2026-05-15'::date
   AND LOWER(email) IN (
     'emiliazakoscielny@gmail.com',
     'jamesmcn8255@gmail.com'
   );

-- ── 3. Hard-delete from contact_submissions ────────────────────────────────
DELETE FROM public.contact_submissions
 WHERE created_at >= '2026-05-15'::date
   AND LOWER(email) IN (
     'emiliazakoscielny@gmail.com',
     'jamesmcn8255@gmail.com'
   );

-- ── 4. Verify · final survivor count + list ────────────────────────────────
SELECT 'trial_signups · contact_form · visible (final)' AS label, COUNT(*) AS n
FROM public.trial_signups
WHERE source_category = 'contact_form' AND deleted_at IS NULL
UNION ALL
SELECT 'contact_submissions · since launch · remaining', COUNT(*)
FROM public.contact_submissions
WHERE created_at >= '2026-05-15'::date;

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
