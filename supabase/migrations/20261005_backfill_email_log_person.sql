-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-05 · Backfill email_log.trial_signup_id from the recipient address.
--
-- The tracking audit found 2,854 of 2,887 rows (98.9%) with no person
-- attached. Almost all of it is one sender: winback_bts299, 2,826 rows, 100%
-- orphaned. That blast wrote email_log directly with no trial_signup_id and
-- sent through Resend with no tags, so nothing about it could ever be tied to
-- a name — you could count sends and nothing else.
--
-- winback-blast is fixed going forward (it now resolves the person before
-- sending and tags the message). This recovers the history, which is worth
-- doing because those 2,826 sends are the single biggest campaign on record
-- and they are currently invisible to every per-person view.
--
-- SAFETY
--   • Only touches rows where trial_signup_id IS NULL. Never overwrites an
--     attribution that already exists.
--   • Matches on lower(trim()) of the first recipient against
--     trial_signups.email. Exact match only — no fuzzy name matching, which is
--     what makes get_converted_members fragile.
--   • Where one email maps to several trial_signups rows (the same person
--     signing up at two studios), takes the most recent non-deleted row. That
--     is the same tie-break the fixed winback-blast uses, so history and new
--     sends agree.
--   • Rows whose recipient has no trial_signups row at all stay NULL. Those
--     are genuinely unattributable — mostly staff and owner notifications.
--
-- Re-runnable: running it twice changes nothing the second time.
-- ─────────────────────────────────────────────────────────────────────────────

WITH best_match AS (
  SELECT DISTINCT ON (lower(trim(t.email)))
         lower(trim(t.email)) AS email,
         t.id
  FROM public.trial_signups t
  WHERE t.email IS NOT NULL
    AND t.email <> ''
    AND t.deleted_at IS NULL
  ORDER BY lower(trim(t.email)), t.created_at DESC
)
UPDATE public.email_log el
   SET trial_signup_id = bm.id
  FROM best_match bm
 WHERE el.trial_signup_id IS NULL
   AND el.to_addrs IS NOT NULL
   AND array_length(el.to_addrs, 1) >= 1
   AND lower(trim(el.to_addrs[1])) = bm.email;

-- Check the result:
--   SELECT send_path,
--          count(*)                                           AS rows,
--          count(*) FILTER (WHERE trial_signup_id IS NULL)     AS still_orphan
--     FROM public.email_log
--    GROUP BY send_path
--    ORDER BY still_orphan DESC;
-- winback_bts299 should drop from 100% orphaned to near zero. Whatever remains
-- is a recipient who never had a trial_signups row — staff alerts and owner
-- notifications, which is correct.
