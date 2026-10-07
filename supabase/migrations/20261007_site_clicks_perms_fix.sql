-- 20261007_site_clicks_perms_fix.sql
--
-- The revokes in 20261007_site_clicks_reporting.sql did nothing, and I only
-- found out by testing them from outside with the public anon key.
--
-- WHY THEY DID NOTHING
-- Postgres grants EXECUTE on every new function to the PUBLIC pseudo-role
-- automatically. anon is a member of PUBLIC, so
--     revoke execute on function f() from anon;
-- removes a grant anon never needed. It keeps the inherited PUBLIC one and
-- carries on executing. Verified live after running that migration:
--
--   get_person_timeline      anon call -> returned [] (executed, just no match)
--   get_site_clicks_summary  anon call -> returned the full row
--
-- Tables and views behave the opposite way (no default PUBLIC grant), which is
-- why the same migration DID successfully lock click_history and
-- link_performance_detail - those now answer 42501 to anon. Only the function
-- half was wrong.
--
-- The right move for a function is to revoke from PUBLIC first, then grant
-- back to exactly the roles that should have it.

-- ── get_person_timeline: the serious one ────────────────────────────────────
-- Takes a phone number and returns that person's entire browsing history.
-- Anyone with the website's anon key could have enumerated phone numbers.
revoke execute on function public.get_person_timeline(text) from public;
revoke execute on function public.get_person_timeline(text) from anon;
grant  execute on function public.get_person_timeline(text) to authenticated;

-- ── the two reporting RPCs ─────────────────────────────────────────────────
-- Counts only, no names or numbers, so this is business data rather than
-- customer data. Still not the public's: it is click volume and member
-- conversion per studio.
revoke execute on function public.get_site_clicks_summary() from public;
revoke execute on function public.get_site_clicks_summary() from anon;
grant  execute on function public.get_site_clicks_summary() to authenticated;

revoke execute on function public.get_site_clicks_top_links(text, int, int) from public;
revoke execute on function public.get_site_clicks_top_links(text, int, int) from anon;
grant  execute on function public.get_site_clicks_top_links(text, int, int) to authenticated;

-- ── verify (run these after; all three must fail or return nothing) ─────────
-- With the anon key:
--   select * from click_history limit 1;                  -> 42501 permission denied
--   select get_person_timeline('+1...');                  -> 42501 permission denied
--   select * from get_site_clicks_summary();              -> 42501 permission denied
--   insert into site_clicks (kind) values ('internal');   -> 201, must still work
--
-- Anything that still returns rows to anon is a hole, not a pass.
