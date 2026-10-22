-- ─────────────────────────────────────────────────────────────────────────────
-- Repair two long-standing attribution holes, 2026-10-21.
--
-- Justin: "What else have you not fixed that I've asked you to for months".
-- Both of these were found by tracking-audit and both had been sitting there.
--
--   A. trial_signups rows with no location_id  → invisible to every per-studio
--      report, every owner digest, and the Homebase board.
--   B. email_log rows with no send_path        → attribute to nothing, so the
--      campaign reporting RPC under-counts every send.
--
-- SAFE BY CONSTRUCTION
--   * Every section runs a SELECT preview FIRST. Run the previews, read them,
--     and only then run the UPDATE beneath. Nothing here deletes.
--   * Every UPDATE is narrowed by `where <col> is null`, so re-running it is a
--     no-op and it can never overwrite a value that is already correct.
--   * Wrap in a transaction if you want a safety net:
--       begin;  <run the updates>  <re-run the previews>  commit;  -- or rollback;
--
-- SCOPE, measured not guessed (tracking-audit, 2026-10-21):
--   A → 29 rows total, but 0 paid / 15 already soft-deleted / 14 live and
--       unpaid. So the real blast radius is FOURTEEN pending leads. No money
--       is affected; nobody paid and got lost.
--   B → 135 of 561 email_log rows (24.1%).
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- A-PRE. SCHEMA CHECK — run this first, it answers every guess below.
--
-- Four statements in this file have now failed on columns that were assumed
-- rather than read: mariana_tek_sales.email (it is customer_email), and
-- locations.slug (it does not exist). This dump makes the real shape visible
-- so the queries underneath can be trusted. It reads nothing but metadata.
-- ═════════════════════════════════════════════════════════════════════════════
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('locations','trial_signups','mariana_tek_sales',
                     'mariana_tek_clients','capi_events','email_log')
order by table_name, ordinal_position;


-- ═════════════════════════════════════════════════════════════════════════════
-- A. trial_signups with no location_id
-- ═════════════════════════════════════════════════════════════════════════════

-- ── A0. PREVIEW: who are they, and is there anything to recover them from? ───
--
-- 2026-10-21: the first version of this hardcoded `s.email` on
-- mariana_tek_sales and failed — that table's column is `customer_email`.
-- Rather than swap one guess for another, every cross-table field below is
-- read through to_jsonb(row)->>'key'. A key that does not exist yields NULL
-- instead of raising, so coalescing over the plausible names works whatever
-- the real column is called, and this cannot break again on a schema I have
-- not personally read.
--
-- Run this first. `recoverable_from` null means nothing in our data knows
-- which studio that person wanted, and no query can invent it.
select
  ts.id,
  ts.created_at::date       as created,
  ts.name,
  ts.email,
  ts.phone,
  ts.payment_status,
  ts.lead_source,
  ts.deleted_at is not null as already_deleted,
  case
    when mts.slug is not null then 'mariana_tek_sales.'   || mts.slug
    when mtc.slug is not null then 'mariana_tek_clients.' || mtc.slug
    when ce.slug  is not null then 'capi_events.'         || ce.slug
    else null
  end                       as recoverable_from
from public.trial_signups ts
left join lateral (
  select to_jsonb(s)->>'studio_slug' as slug
  from public.mariana_tek_sales s
  where ts.email is not null
    and lower(coalesce(to_jsonb(s)->>'customer_email', to_jsonb(s)->>'email','')) = lower(ts.email)
  order by (to_jsonb(s)->>'sale_date_time') desc nulls last
  limit 1
) mts on true
left join lateral (
  select to_jsonb(c)->>'studio_slug' as slug
  from public.mariana_tek_clients c
  where ts.email is not null
    and lower(coalesce(to_jsonb(c)->>'email', to_jsonb(c)->>'customer_email','')) = lower(ts.email)
  limit 1
) mtc on true
left join lateral (
  -- fbp is one browser, so this is a strong match. See lead-journey for why.
  select e.studio_slug as slug
  from public.capi_events e
  where ts.fbp is not null
    and e.visitor_meta->>'fbp' = ts.fbp
    and e.studio_slug is not null
  order by e.attempted_at asc
  limit 1
) ce on true
where ts.location_id is null
order by ts.created_at desc;


-- ── A1. REPAIR — now collision-aware ────────────────────────────────────────
--
-- 2026-10-21, third correction, and this one is a FINDING not just a bug.
-- The first collision-blind version hit:
--   duplicate key violates "trial_signups_email_per_studio_uidx"
--   (location_id, lower(email)) = (5c0e8383…, boeyhe0224@hotmail.com)
--
-- There is a unique index on (location_id, lower(email)). The update failed
-- because that orphan row's person ALREADY EXISTS on that studio, properly
-- attributed. So the row is not a lost lead — it is a stray duplicate of
-- someone already on the board, and attaching a studio to it would create a
-- second card for one human.
--
-- That splits the orphans into two populations that need opposite treatment:
--   DUPLICATE — the studio already has this email. Do NOT attach. Report it.
--   GENUINE   — nothing matches. Attach, and it appears on the board.
--
-- Only the genuine ones are written here. Duplicates are listed by A1-DUP
-- below for a human to close out, because merging two records is a judgement
-- call about which name, phone and stage survive — not something to automate
-- on fourteen rows.

-- A1-A. The resolution, shared by both steps.
create temporary table _orphan_fix as
with resolved as (
  select
    ts.id,
    ts.email,
    coalesce(
      (select to_jsonb(s)->>'studio_slug'
         from public.mariana_tek_sales s
        where ts.email is not null
          and lower(coalesce(to_jsonb(s)->>'customer_email', to_jsonb(s)->>'email','')) = lower(ts.email)
        order by (to_jsonb(s)->>'sale_date_time') desc nulls last
        limit 1),
      (select to_jsonb(c)->>'studio_slug'
         from public.mariana_tek_clients c
        where ts.email is not null
          and lower(coalesce(to_jsonb(c)->>'email', to_jsonb(c)->>'customer_email','')) = lower(ts.email)
        limit 1),
      (select e.studio_slug
         from public.capi_events e
        where ts.fbp is not null
          and e.visitor_meta->>'fbp' = ts.fbp
          and e.studio_slug is not null
        order by e.attempted_at asc
        limit 1)
    ) as slug
  from public.trial_signups ts
  where ts.location_id is null
    and ts.deleted_at is null
)
select
  r.id,
  r.email,
  r.slug,
  l.id as target_location_id,
  exists (
    select 1 from public.trial_signups x
     where x.location_id = l.id
       and lower(x.email) = lower(r.email)
       and x.id <> r.id
  ) as is_duplicate
from resolved r
join public.locations l
  on coalesce(
       to_jsonb(l)->>'slug',
       lower(regexp_replace(trim(l.name), '\s+', '-', 'g'))
     ) = r.slug
where r.slug is not null;


-- A1-DUP. REPORT ONLY — orphans that are duplicates of an existing lead.
-- Nothing is written. Decide per row whether to close the stray out.
select f.id as stray_row_id, f.email, f.slug as studio,
       t.id as existing_row_id, t.created_at::date as existing_created,
       t.payment_status as existing_status, t.front_desk_stage as existing_stage
from _orphan_fix f
join public.trial_signups t
  on t.location_id = f.target_location_id
 and lower(t.email) = lower(f.email)
 and t.id <> f.id
where f.is_duplicate
order by f.email;


-- A1-B. WRITE — only the genuine ones. Cannot collide, by construction.
update public.trial_signups t
set location_id = f.target_location_id
from _orphan_fix f
where t.id = f.id
  and not f.is_duplicate;


-- A1-C. What just happened.
select
  count(*) filter (where is_duplicate)     as duplicates_left_alone,
  count(*) filter (where not is_duplicate) as rows_attached
from _orphan_fix;


-- ── A2. VERIFY: re-run A0. Anything still listed is genuinely unknowable. ────
-- Those rows should be worked by hand or closed out; do NOT guess a studio for
-- them, because a wrong studio is worse than a null (it corrupts that studio's
-- conversion rate and routes the alert to an owner who cannot help).
select count(*) as still_null_and_live
from public.trial_signups
where location_id is null and deleted_at is null;


-- ═════════════════════════════════════════════════════════════════════════════
-- B. email_log rows with no send_path
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B0. PREVIEW: what are the 135, and what would each be labelled? ──────────
-- from_addr is set by the sending function, so it is the reliable signal.
-- Subject matching is the fallback and is deliberately conservative.
select
  coalesce(from_addr,'(none)')                       as from_addr,
  left(coalesce(subject,'(none)'), 60)               as subject_sample,
  count(*)                                           as rows,
  min(created_at)::date                              as first_seen,
  max(created_at)::date                              as last_seen,
  case
    when from_addr = 'free3-claim'                   then 'free3_claim'
    when from_addr ilike '%winback%'                 then 'winback_blast'
    when from_addr ilike '%abandoned%'               then 'abandoned_cart_email'
    when from_addr ilike '%welcome%'                 then 'manual_welcome_batch'
    when from_addr ilike '%digest%'
      or subject   ilike '%leads from yesterday%'    then 'daily_lead_digest'
    when subject ilike '%weekly recap%'
      or subject ilike '%weekly report%'             then 'owner_weekly_report'
    when subject ilike '%trial%'                     then 'trial_onboarding'
    else null
  end                                                as would_set
from public.email_log
where send_path is null
group by 1,2,6
order by rows desc;


-- ── B1. REPAIR: label what can be labelled ──────────────────────────────────
update public.email_log
set send_path = case
  when from_addr = 'free3-claim'                   then 'free3_claim'
  when from_addr ilike '%winback%'                 then 'winback_blast'
  when from_addr ilike '%abandoned%'               then 'abandoned_cart_email'
  when from_addr ilike '%welcome%'                 then 'manual_welcome_batch'
  when from_addr ilike '%digest%'
    or subject   ilike '%leads from yesterday%'    then 'daily_lead_digest'
  when subject ilike '%weekly recap%'
    or subject ilike '%weekly report%'             then 'owner_weekly_report'
  when subject ilike '%trial%'                     then 'trial_onboarding'
  else null
end
where send_path is null;


-- ── B2. The leftovers get an explicit label, not another null ───────────────
-- A null means "we forgot to record this". 'unclassified_legacy' means "we
-- looked and could not tell". The difference matters: the first keeps showing
-- up as a bug to re-investigate forever, the second is a closed question.
update public.email_log
set send_path = 'unclassified_legacy'
where send_path is null
  and created_at < '2026-10-21';


-- ── B3. STOP THE BLEEDING: no new row may arrive unlabelled ─────────────────
-- Every sending function already passes send_path. This default means that if
-- a future one forgets, the row is still attributable to "someone forgot"
-- rather than vanishing into the 24% orphan bucket.
alter table public.email_log
  alter column send_path set default 'unset_check_caller';


-- ── B4. VERIFY ──────────────────────────────────────────────────────────────
select send_path, count(*) as rows
from public.email_log
group by 1
order by rows desc;


-- ═════════════════════════════════════════════════════════════════════════════
-- B5. Sweep the 14 stragglers (run AFTER deploying the resend-webhook fix)
--
-- After B1/B2 ran, 14 rows were still null. They are all from TODAY, which is
-- why B2 skipped them — its cutoff was `created_at < '2026-10-21'`, chosen so
-- it could not touch rows a live sender was mid-flight on.
--
-- Their cause is now known: resend-webhook inserts delivered/bounced events,
-- and Resend does not always echo the tags on those. The function now falls
-- back to the original `email.sent` row with the same resend_id, so this stops
-- producing new nulls. These 14 predate that fix.
--
-- Same trick, applied retroactively: adopt the label from the sibling row that
-- shares a resend_id. Anything with no sibling stays null for a human.
-- ═════════════════════════════════════════════════════════════════════════════

-- B5a. PREVIEW — what each straggler would inherit.
select e.id, e.event_type, e.subject, e.resend_id,
       (select x.send_path from public.email_log x
         where x.resend_id = e.resend_id and x.send_path is not null
         order by x.created_at asc limit 1) as would_inherit
from public.email_log e
where e.send_path is null
order by e.created_at desc;

-- B5b. ADOPT.
-- Correlated scalar subqueries in SET, NOT a LATERAL in the FROM clause —
-- `update ... from lateral` cannot see the update target, which is what broke
-- A1 earlier. Same mistake, caught before it reached the editor this time.
update public.email_log e
set send_path = (
      select x.send_path from public.email_log x
       where x.resend_id = e.resend_id and x.send_path is not null
       order by x.created_at asc limit 1),
    trial_signup_id = coalesce(e.trial_signup_id, (
      select x.trial_signup_id from public.email_log x
       where x.resend_id = e.resend_id and x.send_path is not null
       order by x.created_at asc limit 1))
where e.send_path is null
  and e.resend_id is not null
  and exists (
      select 1 from public.email_log x
       where x.resend_id = e.resend_id and x.send_path is not null);

-- B5c. VERIFY — expect 0, or a handful with no sibling to learn from.
select count(*) as still_null from public.email_log where send_path is null;


-- ═════════════════════════════════════════════════════════════════════════════
-- B6. The last 14 — identified, not guessed
--
-- The B5a diagnostic named them exactly. All 14 are resend-webhook rows
-- (raw.type = email.sent / email.delivered) from two senders that never set
-- Resend `tags`, so the webhook had nothing to label them with and B5 found no
-- sibling to inherit from:
--
--   12 × "N leads to call — <studio>, <weekday>, <month> <day>"
--        → daily-lead-digest, built 2026-10-19 WITHOUT tags. My omission.
--    2 × "New Contact Form Submission from <name>"
--        → send-contact-email, same omission.
--
-- Both functions now pass tags: daily_lead_digest / contact_form_notify, so
-- this stops at the source. These 14 predate that and are labelled by subject,
-- which is safe here because both subject lines are machine-generated and
-- unmistakable — not a loose keyword guess.
--
-- Deploy FIRST, so no new untagged rows arrive between the backfill and the fix:
--   bbb deploy-fn daily-lead-digest
--   bbb deploy-fn send-contact-email
-- ═════════════════════════════════════════════════════════════════════════════

-- B6a. PREVIEW.
select
  case
    when e.subject ~ '^\d+ leads? to call — '        then 'daily_lead_digest'
    when e.subject like 'New Contact Form Submission%' then 'contact_form_notify'
    else null
  end                                   as would_set,
  count(*)                              as rows
from public.email_log e
where e.send_path is null
group by 1
order by rows desc;

-- B6b. LABEL.
update public.email_log e
set send_path = case
      when e.subject ~ '^\d+ leads? to call — '          then 'daily_lead_digest'
      when e.subject like 'New Contact Form Submission%' then 'contact_form_notify'
    end
where e.send_path is null
  and (e.subject ~ '^\d+ leads? to call — '
       or e.subject like 'New Contact Form Submission%');

-- B6c. VERIFY — expect 0.
select count(*) as still_null from public.email_log where send_path is null;

-- B6d. Final tally by path.
select send_path, count(*) as rows
from public.email_log
group by 1
order by rows desc;
