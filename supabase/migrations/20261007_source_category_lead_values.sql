-- 20261007_source_category_lead_values.sql
--
-- trial_signups.source_category is a CHECK-constrained vocabulary. Two values
-- the lead-capture work depends on were never added to it:
--
--   trial_partial  - someone gave name + phone on a trial page and stopped at
--                    the card. Written by capture-lead. Must be its own value:
--                    folding it into 'trial_form' would inflate every real
--                    signup count on the dashboard and in the funnel RPCs,
--                    because a partial is a lead, not a trial.
--
--   meta_lead      - came in through a Meta instant form rather than the
--                    website. Written by meta-lead-ads (both the `poll` action,
--                    which has carried this value since 2026-09-01, and the new
--                    `import_leads`). Distinct from 'ad' because 'ad' means
--                    "an ad sent them to our site"; these people never reached
--                    the site at all, which is the entire point of the channel
--                    and the thing we want to measure separately.
--
-- Found the hard way: capture-lead returned
--   'violates check constraint "trial_signups_source_category_check"'
-- on a live call. Before that it was failing on a column that does not exist
-- (page_url), so this constraint was never even reached. Net effect: the
-- two-step trial form has captured ZERO leads since it went live, and the Meta
-- poller would have failed the same way had its permissions ever worked.
--
-- Every other value is preserved exactly as-is; this only appends.

alter table public.trial_signups
  drop constraint if exists trial_signups_source_category_check;

alter table public.trial_signups
  add constraint trial_signups_source_category_check
  check (
    source_category is null or source_category = any (array[
      -- existing vocabulary, unchanged
      'trial_form', 'special_form', 'resign_form', 'comeback_form',
      'contact_form', 'schedule_request', 'mb_direct', 'in_person',
      'direct_membership', 'manual', 'sheet', 'sheet_backfill', 'walk_in',
      'member_referral', 'groupon', 'external_paid', 'reactivation', 'ad',
      'web_organic', 'stripe_checkout', 'legacy_archived', 'mt_app',
      -- added 2026-10-07
      'trial_partial', 'meta_lead'
    ])
  );

comment on column public.trial_signups.source_category is
  'How this person entered the funnel. trial_partial = gave name/phone on a trial page but never reached the card (a lead, NOT a signup - exclude from signup counts). meta_lead = submitted a Meta instant form and never touched the website.';
