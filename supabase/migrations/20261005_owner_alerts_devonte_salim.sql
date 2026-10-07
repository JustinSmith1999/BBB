-- 20261005_owner_alerts_devonte_salim.sql
-- ===========================================================================
-- Put Devonte and Salim back on the trial TEXT alert for Bayside + Fresh
-- Meadows.
--
-- WHY THIS IS NEEDED
-- manual-welcome-batch texts whoever is listed in location_owners for the
-- studio. Today that table holds exactly one row per Quo studio, and it is the
-- studio's OWN Quo line:
--     Bayside        -> +1 917-877-0759   ("Bayside Quo Inbox")
--     Fresh Meadows  -> +1 646-887-6483   ("Fresh Meadows Quo Inbox")
-- So the alert goes to the shared inbox, not to anyone's phone. Verified by
-- dry-running manual-welcome-batch against a real trial at each studio on
-- 2026-10-05 — those were the only recipients returned.
--
-- The Quo-inbox rows are KEPT on purpose: that copy is what keeps the alert
-- visible in the shared inbox for whoever is on shift. This migration only
-- ADDS the two personal numbers alongside them. If the duplicate turns out to
-- be noisy, delete the "... Quo Inbox" rows — do not delete these.
--
-- PHONE NUMBERS — CHECK THESE BEFORE RUNNING.
-- They are lifted from the BTS_ONLY_PHONES constant in mt-orders-sync, dated
-- 2026-09-16. If either person has changed their number since, fix it here
-- first; a wrong number fails silently as a text into the void.
--     Devonte Smith  +1 214-713-8456
--     Salim Arbaje   +1 917-586-1010
--
-- Idempotent: re-running changes nothing. Safe to run twice.
-- Run in the Supabase SQL editor (this project applies migrations by hand).
-- ===========================================================================

INSERT INTO public.location_owners (location_id, owner_name, phone)
SELECT v.location_id, v.owner_name, v.phone
FROM (VALUES
  -- Bayside
  ('5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7'::uuid, 'Devonte Smith', '+12147138456'),
  ('5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7'::uuid, 'Salim Arbaje',  '+19175861010'),
  -- Fresh Meadows
  ('6bbbe077-bcc6-4d9d-a10b-7605c1484752'::uuid, 'Devonte Smith', '+12147138456'),
  ('6bbbe077-bcc6-4d9d-a10b-7605c1484752'::uuid, 'Salim Arbaje',  '+19175861010')
) AS v(location_id, owner_name, phone)
WHERE NOT EXISTS (
  SELECT 1 FROM public.location_owners lo
  WHERE lo.location_id = v.location_id
    AND regexp_replace(lo.phone, '\D', '', 'g') = regexp_replace(v.phone, '\D', '', 'g')
);

-- ── Verify: this is who will now be texted on every new $49 trial ──────────
SELECT l.name AS studio, lo.owner_name, lo.phone
FROM public.location_owners lo
JOIN public.locations l ON l.id = lo.location_id
WHERE l.name IN ('Bayside', 'Fresh Meadows')
ORDER BY l.name, lo.owner_name;

-- ──────────────────────────────────────────────────────────────────────────
-- 2026-10-07 — DO NOT ENABLE THESE ROWS. Verified against live data today.
--
-- The INSERT above omits notify_signups, so Devonte and Salim landed with the
-- column default (false) and receive no personal texts. That is now the
-- intended state, confirmed by Justin: "that's what Quo is for, shouldn't be
-- on personal phones."
--
-- What actually receives the Bayside / Fresh Meadows trial alert is the Quo
-- inbox line for that studio, which IS notify_signups = true:
--     Bayside Quo Inbox        +1 917-877-0759
--     Fresh Meadows Quo Inbox  +1 646-887-6483
-- The text threads into the shared inbox, so either of them can pick it up
-- and reply FROM the studio line. A reply to a personal phone threads nowhere.
--
-- Flipping notify_signups = true on the Devonte/Salim rows would fire THREE
-- texts per Bayside trial (inbox + 2 personal) and the extra two would be
-- unrepliable. Leave them false. They stay in the table as the roster of who
-- covers which studio, which is what location_owners is also used for.
--
-- Astoria and Williamsburg are not on Quo, so Chris and Steve still take
-- personal texts there. When those two studios move onto Quo, switch them to
-- this same pattern: inbox row true, personal rows false.
-- ──────────────────────────────────────────────────────────────────────────
