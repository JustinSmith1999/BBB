-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-10 21:35 ET · URGENT
-- Backfill today's lost leads into trial_signups.
--
-- Context: from 12:24-21:17 ET today, 7 form submissions succeeded at the
-- frontend + leads-table stage but FAILED silently at trial_signups insert
-- due to missing `fbp` column. Those customers never reached Stripe Checkout
-- and have no row on /homebase.
--
-- This migration reconstructs trial_signups rows from the `leads` table for
-- those 7 customers so the front desk can chase them. Marks them with a note
-- so it's obvious they were affected by the bug.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.trial_signups (
  name, email, phone, location_id, payment_status, source_category,
  front_desk_stage, front_desk_note, created_at
)
SELECT
  l.full_name,
  l.email,
  l.phone,
  loc.id,
  'pending',
  'trial_form',
  'new_lead',
  'AUTO-BACKFILL: 2026-06-10 fbp column was missing — customer''s form submit silently failed before Stripe redirect. They never got the checkout link. CALL them.',
  l.last_touch_at
FROM public.leads l
JOIN public.locations loc
  ON lower(replace(loc.name, ' ', '-')) = l.studio_slug
WHERE l.last_touch_at >= '2026-06-10T00:00:00-04:00'::timestamptz
  AND l.last_touch_at <  '2026-06-11T00:00:00-04:00'::timestamptz
  AND l.email IS NOT NULL
  AND l.email NOT ILIKE 'justin@%'  -- skip Justin's diagnostic submission
  AND NOT EXISTS (
    SELECT 1 FROM public.trial_signups ts
    WHERE ts.email = l.email
      AND ts.location_id = loc.id
      AND ts.deleted_at IS NULL
      AND ts.created_at >= '2026-06-10T00:00:00-04:00'::timestamptz
  );

SELECT name, email, phone, payment_status, source_category, front_desk_stage
FROM public.trial_signups
WHERE created_at >= '2026-06-10T00:00:00-04:00'::timestamptz
  AND front_desk_note LIKE 'AUTO-BACKFILL%'
ORDER BY created_at;
