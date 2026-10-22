-- ─────────────────────────────────────────────────────────────────────────────
-- Re-enable trial-signup texts to Devonte and Salim, 2026-10-21.
--
-- THIS REVERSES A DELIBERATE DECISION. Recording that plainly so nobody later
-- reads it as drift and "fixes" it back.
--
--   2026-10-05/07, Justin: "that's what Quo is for, shouldn't be on personal
--   phones." Devonte (Bayside) and Salim (Fresh Meadows) were set
--   notify_signups = false, and 20261005_owner_alerts_devonte_salim.sql plus
--   the CLAUDE.md "Alert routing (settled — don't fix this)" block both say
--   explicitly: do not enable their rows.
--
--   2026-10-21, Justin: "Turn back on texts to Devonte and Salim from Twilio."
--   Confirmed he wants the Quo inbox lines to KEEP receiving as well.
--
-- WHAT THIS MEANS IN PRACTICE, unchanged from the original note:
--   * Each Bayside trial now fires THREE texts: Bayside Quo inbox
--     (+1 917-877-0759), Devonte, Carlos stays off. Same shape for Fresh
--     Meadows (+1 646-887-6483 inbox + Salim).
--   * The two personal texts are NOTIFICATIONS ONLY. A reply sent from a
--     personal phone goes to the customer from an unknown number and does not
--     thread into the Quo conversation. Working the lead still has to happen
--     in the Quo inbox. That is not a bug to report later; it is the known
--     cost of this routing.
--
-- MECHANISM: stripe-webhook, trial-convert-followup and manual-welcome-batch
-- all select location_owners where notify_signups = true and send via Twilio.
-- Flipping the flag is the whole change — no code deploy needed.
--
-- Carlos stays false on both studios (unchanged, correct).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. PREVIEW: who receives alerts today, per studio ───────────────────────
select l.name as studio, o.owner_name, o.phone, o.notify_signups
from public.location_owners o
join public.locations l on l.id = o.location_id
order by l.name, o.notify_signups desc, o.owner_name;


-- ── 2. ENABLE — matched by name, scoped to their own studio ─────────────────
-- Name-matched rather than by a hardcoded uuid so this is readable and cannot
-- silently hit the wrong row if ids were ever reseeded. The studio join keeps
-- Devonte on Bayside only and Salim on Fresh Meadows only, so neither starts
-- getting the other studio's alerts.
update public.location_owners o
set notify_signups = true
from public.locations l
where l.id = o.location_id
  and (
       (o.owner_name ilike '%devonte%' and l.name ilike '%bayside%')
    or (o.owner_name ilike '%salim%'   and l.name ilike '%fresh%')
  )
  and o.notify_signups is distinct from true;


-- ── 3. VERIFY: expect the inbox line AND the named owner true per studio ────
-- Bayside       → Bayside Quo Inbox (true) + Devonte (true), Carlos false
-- Fresh Meadows → FM Quo Inbox (true)      + Salim   (true), Carlos false
select l.name as studio, o.owner_name, o.phone, o.notify_signups
from public.location_owners o
join public.locations l on l.id = o.location_id
where l.name ilike '%bayside%' or l.name ilike '%fresh%'
order by l.name, o.notify_signups desc, o.owner_name;


-- ── 4. Count how many texts each studio's next trial will fire ──────────────
-- Sanity check against the "three texts" expectation above.
select l.name as studio, count(*) filter (where o.notify_signups) as texts_per_trial
from public.location_owners o
join public.locations l on l.id = o.location_id
group by l.name
order by l.name;
