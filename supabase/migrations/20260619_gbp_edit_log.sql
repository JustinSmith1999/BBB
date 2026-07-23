-- 2026-06-19 · GBP edit audit log
--
-- Every gbp-edit invocation writes one row per op to this table so we can
-- (a) prove a description / category / post change actually went through,
-- (b) surface recent edits on the /ops "What's Running" panel, and
-- (c) detect when someone (or some retry) silently double-fires the same op.
--
-- The function inserts with service-role; everything else reads via RLS.

create table if not exists public.gbp_edit_log (
  id          bigserial primary key,
  fired_at    timestamptz not null default now(),
  studio_slug text        not null,
  op          text        not null,        -- update_description | update_categories | ...
  payload     jsonb,                       -- the request body (sans secrets)
  ok          boolean,                     -- null = unknown / dry-run, true/false otherwise
  error       text,                        -- API error string if any
  result      jsonb                        -- API response body (or trimmed slice)
);

create index if not exists gbp_edit_log_studio_at_idx
  on public.gbp_edit_log (studio_slug, fired_at desc);

create index if not exists gbp_edit_log_op_at_idx
  on public.gbp_edit_log (op, fired_at desc);

-- RLS: read locked to Justin (matches /ops gate pattern); write is service-role
-- only so the edge function still works without a JWT.
alter table public.gbp_edit_log enable row level security;

drop policy if exists gbp_edit_log_justin_read on public.gbp_edit_log;
create policy gbp_edit_log_justin_read on public.gbp_edit_log
  for select
  using (
    auth.jwt() ->> 'email' = 'justin@j20solutions.com'
    or auth.jwt() ->> 'email' = 'Justin@j20solutions.com'
  );

comment on table public.gbp_edit_log is
  'Audit log for gbp-edit edge function. One row per op per studio per invocation.';
