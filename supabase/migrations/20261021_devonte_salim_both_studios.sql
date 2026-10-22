-- ─────────────────────────────────────────────────────────────────────────────
-- Devonte AND Salim both get BOTH studios, 2026-10-21.
--
-- Follows on from 20261021_reenable_devonte_salim_alerts.sql, which turned each
-- of them on for his own studio only (Devonte → Bayside, Salim → Fresh Meadows).
-- Justin, same day: "Both should get devonte and salim."
--
-- So each of the two studios alerts: its Quo inbox + Devonte + Salim.
-- That is THREE texts per Bayside trial and three per Fresh Meadows trial.
-- Carlos stays off on both (unchanged, still correct).
--
-- NOTE ON COVERAGE: location_owners doubles as the roster of who covers which
-- studio. Both men already have a row at both studios, so nothing is being
-- created here — only the notify_signups flag flips. If either row were
-- missing this would silently do nothing, which is why step 1 previews and
-- step 3 verifies the count rather than trusting the update.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. PREVIEW: do both men actually have a row at both studios? ────────────
-- Expect FOUR rows: Devonte+Salim × Bayside+Fresh Meadows.
select l.name as studio, o.owner_name, o.phone, o.notify_signups
from public.location_owners o
join public.locations l on l.id = o.location_id
where (o.owner_name ilike '%devonte%' or o.owner_name ilike '%salim%')
  and (l.name ilike '%bayside%' or l.name ilike '%fresh%')
order by l.name, o.owner_name;


-- ── 2. ENABLE both men at both studios ──────────────────────────────────────
update public.location_owners o
set notify_signups = true
from public.locations l
where l.id = o.location_id
  and (o.owner_name ilike '%devonte%' or o.owner_name ilike '%salim%')
  and (l.name ilike '%bayside%' or l.name ilike '%fresh%')
  and o.notify_signups is distinct from true;


-- ── 3. VERIFY: who is on, per studio ────────────────────────────────────────
-- Bayside       → Bayside Quo Inbox, Devonte, Salim   (Carlos off)
-- Fresh Meadows → FM Quo Inbox,      Devonte, Salim   (Carlos off)
select l.name as studio,
       string_agg(o.owner_name, ', ' order by o.owner_name)
         filter (where o.notify_signups)     as receiving,
       string_agg(o.owner_name, ', ' order by o.owner_name)
         filter (where not o.notify_signups) as not_receiving
from public.location_owners o
join public.locations l on l.id = o.location_id
group by l.name
order by l.name;


-- ── 4. Texts per trial. Expect Bayside 3, Fresh Meadows 3, the others 2. ────
select l.name as studio, count(*) filter (where o.notify_signups) as texts_per_trial
from public.location_owners o
join public.locations l on l.id = o.location_id
group by l.name
order by l.name;
