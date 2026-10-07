-- 20261007_site_clicks.sql
-- Track every click on the WEBSITE, and make it answerable to
-- "what did THIS person do?"
--
-- Named site_clicks, NOT link_clicks. A link_clicks table already exists and
-- belongs to email link tracking (get_link_performance reads it). Creating
-- this one with `if not exists` under that name silently did nothing and left
-- every view broken, which is how this naming collision was found.
--
-- THE PROBLEM THIS SOLVES
-- page_views already records traffic, but the only identifier on it is
-- bbb_sid, which lives in sessionStorage and dies when the tab closes. So a
-- person who visits on Monday, comes back Thursday and signs up on Sunday is
-- three unrelated rows. Nothing could ever be attributed to a human.
--
-- THE IDENTITY CHAIN
--   1. visitor_id  — a random UUID in localStorage, written on first visit and
--                    never changed. Every page view and every click carries it.
--                    Anonymous: it is not a name, it is "this browser".
--   2. The moment that person fills in step 1 of the trial form, capture-lead
--      writes their trial_signups row AND stamps the same visitor_id on it.
--   3. From that moment the join is retroactive. Every click that visitor ever
--      made, including months before they told us who they were, belongs to a
--      named person.
--   4. trial_signups.mariana_tek_id ties that person to the MT member record,
--      so a member's whole browsing history is one query.
--
-- Nothing here stores a name, email or IP on the click itself. The click rows
-- stay anonymous; identity arrives by join, and only for people who chose to
-- give it. Deleting a trial_signups row orphans the clicks back to anonymous.

-- ── 1. the click log ────────────────────────────────────────────────────────
create table if not exists public.site_clicks (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  visitor_id    text,          -- persistent, localStorage. The join key.
  session_id    text,          -- per-tab, for reconstructing one sitting.

  -- what they clicked
  kind          text not null, -- 'internal' | 'outbound' | 'tel' | 'mailto' | 'app_store' | 'button' | 'download'
  href          text,          -- destination, truncated client-side
  link_text     text,          -- the visible label, so reports read in English
  element_id    text,          -- id or data-track attribute if the element has one

  -- where they were standing
  page_path     text,
  studio_slug   text,

  -- who sent them (same attribution the rest of the funnel uses)
  fbp           text,
  fbc           text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  referrer      text,

  device_hint   text,
  build_id      text
);

create index if not exists site_clicks_visitor_idx on public.site_clicks (visitor_id, created_at desc);
create index if not exists site_clicks_created_idx on public.site_clicks (created_at desc);
create index if not exists site_clicks_kind_idx    on public.site_clicks (kind, created_at desc);
create index if not exists site_clicks_studio_idx  on public.site_clicks (studio_slug, created_at desc);

comment on table public.site_clicks is
  'Every click on betterbodybootcamp.com. Anonymous on its own; becomes attributable to a person by joining visitor_id to trial_signups.visitor_id.';

-- Insert-only for the browser. The anon key can write a click and can never
-- read the table back, same posture as page_views.
alter table public.site_clicks enable row level security;

drop policy if exists site_clicks_anon_insert on public.site_clicks;
create policy site_clicks_anon_insert on public.site_clicks
  for insert to anon with check (true);

-- ── 2. the join key, on both ends ───────────────────────────────────────────
alter table public.trial_signups add column if not exists visitor_id text;
create index if not exists trial_signups_visitor_idx on public.trial_signups (visitor_id);

comment on column public.trial_signups.visitor_id is
  'The browser that signed this person up. Join to link_clicks.visitor_id and page_views.visitor_id to see everything they did before and after, including clicks made before they identified themselves.';

alter table public.page_views add column if not exists visitor_id text;
create index if not exists page_views_visitor_idx on public.page_views (visitor_id);

-- ── 3. one row per click, with the person attached where we know them ───────
create or replace view public.click_history as
select
  c.created_at,
  c.kind,
  c.link_text,
  c.href,
  c.page_path,
  coalesce(c.studio_slug, l.name)        as studio,
  t.name                                  as person,
  t.phone,
  t.email,
  t.payment_status,
  t.front_desk_stage,
  t.mariana_tek_id,
  c.utm_source,
  c.utm_campaign,
  c.visitor_id
from public.site_clicks c
left join public.trial_signups t
       on t.visitor_id = c.visitor_id
      and t.deleted_at is null
left join public.locations l on l.id = t.location_id
order by c.created_at desc;

comment on view public.click_history is
  'Every click with the person attached where we know them. person is null for visitors who never identified themselves. A single person shows up across all their clicks, including ones made before they filled in the form.';

-- ── 4. what each link is worth ──────────────────────────────────────────────
create or replace view public.link_performance_detail as
select
  c.kind,
  coalesce(nullif(c.link_text, ''), c.href)              as link,
  c.studio_slug                                           as studio,
  count(*)                                                as clicks,
  count(distinct c.visitor_id)                            as people,
  count(distinct t.id)                                    as identified,
  count(distinct t.id) filter (
    where t.payment_status = 'completed')                 as became_customers,
  min(c.created_at)                                       as first_click,
  max(c.created_at)                                       as last_click
from public.site_clicks c
left join public.trial_signups t
       on t.visitor_id = c.visitor_id
      and t.deleted_at is null
group by 1, 2, 3
order by clicks desc;

comment on view public.link_performance_detail is
  'Per link: raw clicks, distinct people, how many of those people we can name, and how many went on to buy. became_customers is the only column that matters when comparing two calls to action.';

-- ── 5. one person, everything they ever did ─────────────────────────────────
create or replace function public.get_person_timeline(p_phone text)
returns table (
  happened_at timestamptz,
  event       text,
  detail      text,
  page_path   text
)
language sql
stable
as $$
  with person as (
    select visitor_id, id, name
    from public.trial_signups
    where phone = p_phone and deleted_at is null and visitor_id is not null
    limit 1
  )
  select c.created_at, 'click: ' || c.kind,
         coalesce(nullif(c.link_text, ''), c.href), c.page_path
  from public.site_clicks c join person p on p.visitor_id = c.visitor_id
  union all
  select v.ts, 'page view', v.path, v.path
  from public.page_views v join person p on p.visitor_id = v.visitor_id
  order by 1 desc
$$;

comment on function public.get_person_timeline(text) is
  'Everything one person did on the site, newest first, by phone number. Clicks and page views interleaved. Only returns rows once that person has identified themselves, because before that there is no phone to look them up by.';

grant select on public.click_history, public.link_performance_detail to anon, authenticated;
grant execute on function public.get_person_timeline(text) to anon, authenticated;
