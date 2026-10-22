-- ─────────────────────────────────────────────────────────────────────────────
-- Point the dashboard's traffic card at our own data, 2026-10-21.
--
-- WHY. get_netlify_summary read netlify_analytics_daily / _pages / _sources,
-- which have always been empty, because netlify-analytics-sync 404s: Netlify
-- Web Analytics is a paid per-site add-on and it is not enabled on
-- betterbodybootcamp. So the card has shown 0 pageviews and "No Netlify
-- analytics synced yet" for its entire life.
--
-- Buying the add-on was the other option and it is the worse one. capi_events
-- already holds 20,116 landing rows, and unlike Netlify's anonymous server-side
-- counts it carries studio_slug, utm_*, fbp and fbc — so the same numbers come
-- out per studio AND join to a named person via lead-journey. Strictly more
-- useful, already paid for.
--
-- The sibling RPC get_netlify_landing_conversion ALREADY reads capi_events and
-- already returns real per-studio numbers. Only the summary half was dead, so
-- this is the smaller half of that card catching up with the other.
--
-- SHAPE IS UNCHANGED on purpose: same keys, same types, so index.html keeps
-- working and the only front-end change is wording.
--
-- UNIQUE VISITORS CAVEAT, stated here because the number will be read as truth:
-- capi_events has no visitor_id. The best identity available is fbp (one
-- browser), falling back to client_ip. fbp coverage is only ~12%, so this
-- undercounts people who block the Meta pixel and overcounts households and
-- carriers sharing an IP. Treat it as a trend line, not a headcount. Netlify's
-- own number would have been differently wrong, not more right.
-- ─────────────────────────────────────────────────────────────────────────────

-- The existing function returns a different type (it was built against the
-- netlify_analytics_* tables), and Postgres will not let CREATE OR REPLACE
-- change a return type. Drop it first. Safe: nothing but the dashboard calls
-- it, and the dashboard reads the same keys either way.
drop function if exists public.get_netlify_summary(int);
drop function if exists public.get_netlify_summary();

create or replace function public.get_netlify_summary(p_days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with win as (
  select now() - make_interval(days => greatest(coalesce(p_days,30), 1)) as since
),
ev as (
  select
    e.attempted_at,
    e.visitor_meta,
    coalesce(
      nullif(e.visitor_meta->>'fbp',''),
      nullif(e.visitor_meta->>'client_ip','')
    ) as person_key,
    -- store the path only; the full URL carries query strings with utm noise
    -- and would shatter "top pages" into hundreds of near-duplicate rows.
    nullif(
      regexp_replace(
        coalesce(e.visitor_meta->>'page_url',''),
        '^https?://[^/]+', ''
      ), ''
    ) as raw_path,
    coalesce(
      nullif(e.visitor_meta->>'utm_source',''),
      nullif(e.visitor_meta->>'referrer_host',''),
      'direct'
    ) as source
  from public.capi_events e, win
  where e.event_name = 'PageView'
    and e.attempted_at >= win.since
),
clean as (
  select *, split_part(coalesce(raw_path,'/'), '?', 1) as path from ev
),
daily as (
  select date_trunc('day', attempted_at)::date as d,
         count(*)                               as pageviews,
         count(distinct person_key)             as visitors
  from clean group by 1 order by 1
),
pages as (
  select path, count(*) as pageviews
  from clean where path is not null
  group by 1 order by 2 desc limit 10
),
sources as (
  select source, count(*) as referrals
  from clean group by 1 order by 2 desc limit 10
)
select jsonb_build_object(
  'window_days',           greatest(coalesce(p_days,30), 1),
  'total_pageviews',       (select count(*)                   from clean),
  'total_unique_visitors', (select count(distinct person_key) from clean),
  'last_synced',           (select max(attempted_at)          from clean),
  'daily',       (select coalesce(jsonb_agg(jsonb_build_object(
                    'date', d, 'pageviews', pageviews, 'visitors', visitors
                  ) order by d), '[]'::jsonb) from daily),
  'top_pages',   (select coalesce(jsonb_agg(jsonb_build_object(
                    'path', path, 'pageviews', pageviews
                  ) order by pageviews desc), '[]'::jsonb) from pages),
  'top_sources', (select coalesce(jsonb_agg(jsonb_build_object(
                    'source', source, 'referrals', referrals
                  ) order by referrals desc), '[]'::jsonb) from sources),
  'top_countries', '[]'::jsonb,   -- capi_events stores no geo; empty, not fake
  'source_table', 'capi_events'   -- so the card can say where the number is from
);
$$;

comment on function public.get_netlify_summary(int) is
  'Site traffic summary from capi_events PageView rows (NOT Netlify — that add-on '
  'is not enabled and its tables are empty). Unique visitors keyed on fbp, falling '
  'back to client_ip; see the migration header for why that is a trend, not a headcount. '
  'Name kept for backwards compatibility with the owner dashboard.';

grant execute on function public.get_netlify_summary(int) to anon, authenticated;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- Expect a non-zero total_pageviews and a last_synced within the hour.
select
  (public.get_netlify_summary(30))->>'total_pageviews'       as pageviews_30d,
  (public.get_netlify_summary(30))->>'total_unique_visitors' as visitors_30d,
  (public.get_netlify_summary(30))->>'last_synced'           as most_recent_landing,
  (public.get_netlify_summary(30))->>'source_table'          as reading_from;


-- ─────────────────────────────────────────────────────────────────────────────
-- Retire the dead nightly sync.
--
-- cron job `netlify-analytics-sync-nightly` (added 2026-06-03, runs 03:30 ET)
-- has been firing every night and failing every night with a 404, because the
-- Netlify Analytics add-on is not enabled on the site. Now that the card no
-- longer reads its tables, it is pure noise in cron.job_run_details and it
-- buries real sync failures.
--
-- The edge function itself is LEFT DEPLOYED on purpose: if the add-on is ever
-- bought, re-running this one cron.schedule line turns it back on. Nothing is
-- dropped, so this is reversible.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('netlify-analytics-sync-nightly');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- already gone; fine
END$$;

-- Expect ZERO rows.
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'netlify-analytics-sync-nightly';
