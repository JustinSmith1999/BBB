-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-05 · Remove email-log-probe's test rows from email_log.
--
-- email-log-probe diagnoses "are email_log writes failing" by INSERTing two
-- real rows every time it is called — one full payload, one minimal — and then
-- leaving them there. It was built for task #319 and has been invoked many
-- times since; I called it again today while auditing, which is what surfaced
-- this. A diagnostic that permanently pollutes the table it diagnoses will
-- quietly inflate every count built on email_log, including the new
-- tracking-audit and the offer-ladder reporting.
--
-- These rows are unambiguous: they address nobody@example.invalid, carry
-- send_path 'email_log_probe', and use event_types that no real sender emits.
-- Deleting them cannot touch a genuine send.
--
-- The probe function itself is left alone — it is still useful. Prefer running
-- it only when email_log writes are actually suspected, and re-run this purge
-- afterwards.
-- ─────────────────────────────────────────────────────────────────────────────

DELETE FROM public.email_log
WHERE send_path = 'email_log_probe'
   OR event_type IN ('probe_minimal', 'sent_inline')
   OR to_addrs = ARRAY['nobody@example.invalid']::text[];

-- What is left should be real traffic only. Sanity-check after running:
--   SELECT event_type, count(*) FROM public.email_log GROUP BY 1 ORDER BY 2 DESC;
-- Expect: email.sent / email.delivered / email.opened / email.clicked /
-- email.bounced / email.complained. Anything else is worth a look.
