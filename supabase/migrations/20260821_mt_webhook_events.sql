-- 2026-08-21: raw log for incoming Mariana Tek webhook events (mt-webhook fn).
-- Run in the Supabase SQL editor.
create table if not exists public.mt_webhook_events (
  id             uuid primary key default gen_random_uuid(),
  action         text not null,
  tenant         text,
  event_datetime timestamptz,
  payload        jsonb,
  headers        jsonb,
  verified       boolean not null default false,
  received_at    timestamptz not null default now()
);

create index if not exists mt_webhook_events_action_idx
  on public.mt_webhook_events (action, received_at desc);

alter table public.mt_webhook_events enable row level security;
-- service-role only; no anon policies on purpose.
