-- 20261007_site_clicks_reporting.sql
-- Two jobs: close a privacy hole the first migration opened, and give the
-- owner dashboard something readable to render.
--
-- ── THE HOLE ────────────────────────────────────────────────────────────────
-- 20261007_site_clicks.sql ended with:
--     grant select on public.click_history, public.link_performance_detail
--       to anon, authenticated;
--
-- site_clicks itself is insert-only to anon, which is correct. But a Postgres
-- view runs with its OWNER's privileges by default (security_invoker is off
-- unless you ask for it), so selecting click_history bypasses that RLS
-- entirely. And click_history exposes person, phone, email and
-- mariana_tek_id by joining trial_signups.
--
-- The anon key is published in the JS bundle on every page of the website.
-- So anyone who viewed source could have dumped the name, phone and email of
-- every identified visitor. Verified live: an anon GET on click_history
-- returned rows. Nothing leaked in practice only because no identified person
-- has clicked yet (person was null on every row) - that is luck, not design,
-- and it would have stopped being true with the first real signup.
--
-- The owner dashboard signs in with a password (sb.auth.signInWithPassword),
-- so it holds the authenticated role, not anon. Revoking anon costs the
-- dashboard nothing.
revoke select on public.click_history           from anon;
revoke select on public.link_performance_detail from anon;
revoke execute on function public.get_person_timeline(text) from anon;

-- Same reasoning: anyone could type a phone number and read that person's
-- entire browsing history. Signed-in staff only.
grant execute on function public.get_person_timeline(text) to authenticated;

comment on view public.click_history is
  'Every click with the person attached where we know them. CONTAINS PII (name, phone, email) - authenticated role only, never anon. The anon key is public in the website bundle.';

-- ── WHAT THE DASHBOARD READS ────────────────────────────────────────────────
-- Shaped to match get_gbp_review_clicks_summary: one row per studio_slug,
-- rolling windows, so the existing card pattern on index.html applies with no
-- new plumbing.
--
-- No PII in or out of this function - it returns counts only. It is
-- security definer because it has to read site_clicks past that table's
-- insert-only RLS, and search_path is pinned so the definer right cannot be
-- turned against us by a hijacked search_path.
create or replace function public.get_site_clicks_summary()
returns table (
  studio_slug     text,
  clicks_today    bigint,
  clicks_week     bigint,
  clicks_prev_week bigint,
  clicks_30d      bigint,
  clicks_total    bigint,
  app_week        bigint,
  app_30d         bigint,
  app_total       bigint,
  tel_week        bigint,
  tel_30d         bigint,
  tel_total       bigint,
  people_30d      bigint,
  identified_30d  bigint,
  last_click_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with scoped as (
    select c.*,
           -- A click with no studio on the path (homepage, /pricing, footer)
           -- belongs to that visitor's studio if we know it from their signup.
           --
           -- public.locations has NO slug column: every other RPC derives it as
           -- lower(replace(name,' ','-')), which turns 'Fresh Meadows' into
           -- 'fresh-meadows' and matches the slugs the website uses in URLs.
           -- Same derivation here so this function agrees with the rest of the
           -- dashboard rather than inventing a second spelling.
           coalesce(c.studio_slug, lower(replace(l.name, ' ', '-'))) as eff_studio,
           t.id as person_id
    from public.site_clicks c
    left join public.trial_signups t
           on t.visitor_id = c.visitor_id
          and t.deleted_at is null
    left join public.locations l on l.id = t.location_id
  )
  select
    eff_studio,
    count(*) filter (where created_at >= date_trunc('day', now() at time zone 'America/New_York')),
    count(*) filter (where created_at >= now() - interval '7 days'),
    count(*) filter (where created_at >= now() - interval '14 days'
                       and created_at <  now() - interval '7 days'),
    count(*) filter (where created_at >= now() - interval '30 days'),
    count(*),
    count(*) filter (where kind = 'app_store' and created_at >= now() - interval '7 days'),
    count(*) filter (where kind = 'app_store' and created_at >= now() - interval '30 days'),
    count(*) filter (where kind = 'app_store'),
    count(*) filter (where kind = 'tel' and created_at >= now() - interval '7 days'),
    count(*) filter (where kind = 'tel' and created_at >= now() - interval '30 days'),
    count(*) filter (where kind = 'tel'),
    count(distinct visitor_id) filter (where created_at >= now() - interval '30 days'),
    count(distinct person_id)  filter (where created_at >= now() - interval '30 days'),
    max(created_at)
  from scoped
  where eff_studio is not null
  group by eff_studio
$$;

comment on function public.get_site_clicks_summary() is
  'Per-studio website click counts over rolling windows. Counts only, no PII. Rows with no studio in the URL are credited to the visitor''s own studio when that visitor has since signed up.';

-- Which links people actually click, per studio. The point of this one is
-- became_customers: comparing two calls to action on raw clicks tells you
-- which is louder, not which one works.
create or replace function public.get_site_clicks_top_links(
  p_studio text default null,
  p_days   int  default 30,
  p_limit  int  default 12
)
returns table (
  kind             text,
  link             text,
  element_id       text,
  clicks           bigint,
  people           bigint,
  identified       bigint,
  became_customers bigint,
  last_click_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.kind,
    coalesce(nullif(c.link_text, ''), c.href, '(unlabelled)') as link,
    c.element_id,
    count(*)                                                  as clicks,
    count(distinct c.visitor_id)                              as people,
    count(distinct t.id)                                      as identified,
    count(distinct t.id) filter (
      where t.payment_status in ('completed', 'paid'))         as became_customers,
    max(c.created_at)                                          as last_click_at
  from public.site_clicks c
  left join public.trial_signups t
         on t.visitor_id = c.visitor_id
        and t.deleted_at is null
  where c.created_at >= now() - make_interval(days => greatest(p_days, 1))
    and (p_studio is null or c.studio_slug = p_studio)
  group by 1, 2, 3
  order by clicks desc
  limit greatest(p_limit, 1)
$$;

comment on function public.get_site_clicks_top_links(text, int, int) is
  'Top clicked links for a studio over the last N days. Counts only, no PII. became_customers is the column that matters when comparing two calls to action.';

grant execute on function public.get_site_clicks_summary()                  to authenticated;
grant execute on function public.get_site_clicks_top_links(text, int, int)  to authenticated;
