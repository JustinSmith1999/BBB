-- 20261007_ab_variant.sql
-- A/B testing the trial page intake form.
--
-- WHY
-- Week of Sep 27 - Oct 4: 763 people reached a trial page, 34 filled the form
-- (4.5%), 29 of those 34 paid (85%). The checkout converts. The intake form is
-- where the business leaks, and nobody has ever tested an alternative to it.
--
-- ab_variant records which version of the form a person was shown, so the
-- comparison is measured rather than argued about.
--
-- Two-step intake (contact details first, card second) is now the BASELINE for
-- everyone, not the experiment. Capturing the lead before asking for a card is
-- simply how the form works from 2026-10-07 on.
--
-- What is under test is how much typing step 1 demands:
--   'A' = step 1 asks first name, last name, email, phone     (4 fields)
--   'B' = step 1 asks first name and phone only               (2 fields)
--         Last name and email move to step 2, next to the card.
--
-- 95% of this traffic is on a phone and an email address is the slowest thing
-- anyone types on a mobile keyboard. We do not need it to ring someone. One
-- variable changes, so the result is attributable.
--
-- Assignment happens in the browser on first visit and is pinned in
-- localStorage, so a person sees the same form if they come back. It is
-- written onto trial_signups by capture-lead and mt-card-checkout.
--
-- Run in the Supabase SQL editor.

alter table public.trial_signups
  add column if not exists ab_variant text;

comment on column public.trial_signups.ab_variant is
  'Which step-1 intake this person was shown. Both variants are two-step. A = 4 fields (first, last, email, phone). B = 2 fields (first, phone). Null for rows created before 2026-10-07 or outside the trial page.';

-- Reading the test. Variant is only meaningful on rows the trial page created,
-- so this excludes desk sales, the MT app, and backfills.
create or replace view public.ab_trial_form_results as
select
  ab_variant                                                       as variant,
  l.name                                                           as studio,
  count(*)                                                         as leads_captured,
  count(*) filter (where payment_status = 'completed')             as paid,
  round(
    100.0 * count(*) filter (where payment_status = 'completed')
    / nullif(count(*), 0)
  , 1)                                                             as paid_pct,
  min(t.created_at)                                                as first_seen,
  max(t.created_at)                                                as last_seen
from public.trial_signups t
left join public.locations l on l.id = t.location_id
where t.ab_variant is not null
  and t.deleted_at is null
group by 1, 2
order by 2, 1;

comment on view public.ab_trial_form_results is
  'A/B results for trial-page step 1. A = 4 fields, B = 2 fields. leads_captured counts everyone step 1 captured; paid counts those who finished the $49. Expect B to capture more leads at a lower paid percentage, since a shorter step 1 lets through people who were never going to buy today. Judge on paid COUNT and on total leads captured, never on paid percentage alone.';

grant select on public.ab_trial_form_results to anon, authenticated;
