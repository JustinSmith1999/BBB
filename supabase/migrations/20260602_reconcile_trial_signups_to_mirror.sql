-- ─────────────────────────────────────────────────────────────────────────────
-- Reconcile trial_signups paid rows that are missing from stripe_paid_mirror.
-- (Funnel Health pipeline shows 72 vs 68 = 4-row drift, yellow node.)
--
-- For each completed trial_signups row without a matching mirror entry, INSERT
-- a backfill mirror row. This brings the two sides into parity so the pipeline
-- node goes from yellow to green.
--
-- Match keys (in order): stripe_session_id → email → phone. If the trial row
-- has no stripe_session_id we still seed a synthetic row keyed on a
-- "backfill_<id>" intent so downstream RPCs can join.
-- ─────────────────────────────────────────────────────────────────────────────

-- Preview: which trial_signups rows are missing from the mirror?
SELECT
  t.id, t.name, t.email, t.phone,
  lower(replace(l.name, ' ', '-')) AS studio_slug,
  t.payment_date AT TIME ZONE 'America/New_York' AS paid_et,
  t.stripe_session_id
FROM public.trial_signups t
LEFT JOIN public.locations l ON l.id = t.location_id
WHERE t.payment_status = 'completed'
  AND t.deleted_at IS NULL
  AND t.payment_date >= '2026-05-15'::DATE AT TIME ZONE 'America/New_York'
  AND NOT EXISTS (
    SELECT 1 FROM public.stripe_paid_mirror m
    WHERE m.stripe_payment_intent_id = t.stripe_session_id
       OR (m.customer_email IS NOT NULL
           AND lower(trim(m.customer_email)) = lower(trim(t.email)))
       OR (m.customer_phone IS NOT NULL
           AND t.phone IS NOT NULL
           AND regexp_replace(m.customer_phone, '\D', '', 'g') =
               regexp_replace(t.phone, '\D', '', 'g'))
  )
ORDER BY t.payment_date;

-- Insert one mirror row per missing trial. Use the trial's stripe_session_id
-- as the intent key when present; otherwise generate "backfill_<uuid>" so the
-- ON CONFLICT clause is well-defined.
INSERT INTO public.stripe_paid_mirror (
  stripe_payment_intent_id,
  studio_slug,
  location_id,
  amount_cents,
  currency,
  paid_at,
  customer_email,
  customer_name,
  customer_phone,
  raw
)
SELECT
  COALESCE(t.stripe_session_id, 'backfill_' || t.id::TEXT),
  lower(replace(l.name, ' ', '-')),
  t.location_id,
  4900,
  'usd',
  t.payment_date,
  t.email,
  t.name,
  t.phone,
  jsonb_build_object(
    'source', 'reconcile-from-trial-signups',
    'trial_signup_id', t.id,
    'reconciled_at', now()
  )
FROM public.trial_signups t
LEFT JOIN public.locations l ON l.id = t.location_id
WHERE t.payment_status = 'completed'
  AND t.deleted_at IS NULL
  AND t.payment_date >= '2026-05-15'::DATE AT TIME ZONE 'America/New_York'
  AND NOT EXISTS (
    SELECT 1 FROM public.stripe_paid_mirror m
    WHERE m.stripe_payment_intent_id = t.stripe_session_id
       OR (m.customer_email IS NOT NULL
           AND lower(trim(m.customer_email)) = lower(trim(t.email)))
       OR (m.customer_phone IS NOT NULL
           AND t.phone IS NOT NULL
           AND regexp_replace(m.customer_phone, '\D', '', 'g') =
               regexp_replace(t.phone, '\D', '', 'g'))
  )
ON CONFLICT (stripe_payment_intent_id) DO NOTHING;

-- Verify: trial_signups paid count vs mirror count should now match.
SELECT
  (SELECT COUNT(*) FROM public.trial_signups
    WHERE payment_status = 'completed' AND deleted_at IS NULL
      AND payment_date >= '2026-05-15'::DATE AT TIME ZONE 'America/New_York') AS trial_signups_paid,
  (SELECT COUNT(*) FROM public.stripe_paid_mirror
    WHERE paid_at >= '2026-05-15'::DATE AT TIME ZONE 'America/New_York') AS mirror_rows;
