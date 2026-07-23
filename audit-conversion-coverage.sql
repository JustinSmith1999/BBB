-- ─── Per-studio: how many trial customers actually match in MindBody? ───
-- This shows the bridging gap — paid trials whose email doesn't exist in MB.
-- A high "unmatched" count means we're potentially missing conversions
-- (those customers may have bought memberships under a different email).
SELECT
  spm.studio_slug,
  count(DISTINCT lower(spm.customer_email)) AS total_paid_trials,
  count(DISTINCT lower(spm.customer_email)) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM mindbody_clients c
      WHERE lower(c.email) = lower(spm.customer_email)
    )
  ) AS matched_by_email,
  count(DISTINCT lower(spm.customer_email)) FILTER (
    WHERE NOT EXISTS (
      SELECT 1 FROM mindbody_clients c
      WHERE lower(c.email) = lower(spm.customer_email)
    )
  ) AS unmatched_emails
FROM stripe_paid_mirror spm
WHERE spm.paid_at >= '2026-05-15'
GROUP BY spm.studio_slug
ORDER BY spm.studio_slug;

-- ─── What the NEW RPC returns (with direct_link_c included) ────────────
-- Compare these counts to dashboard. Any new rows here are conversions
-- the dashboard was missing before.
SELECT studio_slug, count(*) AS converted_count, sum(total_member_rev_usd) AS total_revenue
FROM public.get_converted_members()
GROUP BY studio_slug
ORDER BY studio_slug;

-- ─── Per-studio unmatched-trial backfill candidates ────────────────────
-- These are the trials our system has no MB link for. If you want to
-- find their real MB accounts (like Hannah Turner), here's the list to
-- search MindBody Business by phone.
SELECT spm.studio_slug, spm.customer_email, spm.customer_name, spm.paid_at,
       t.phone
FROM stripe_paid_mirror spm
LEFT JOIN trial_signups t ON lower(t.email) = lower(spm.customer_email)
WHERE spm.paid_at >= '2026-05-15'
  AND NOT EXISTS (
    SELECT 1 FROM mindbody_clients c
    WHERE lower(c.email) = lower(spm.customer_email)
  )
ORDER BY spm.studio_slug, spm.paid_at DESC
LIMIT 50;
