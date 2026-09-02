-- 2026-08-28: tables for the native book-class flow (book-class edge fn).
-- booking_codes: short-lived 6-digit verification codes (hashed).
-- booking_devices: long-lived "remembered device" tokens so repeat bookings
--                  skip the code step.

create table if not exists public.booking_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  code_hash   text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists booking_codes_email_idx
  on public.booking_codes (email, created_at desc);

create table if not exists public.booking_devices (
  token        uuid primary key,
  email        text not null,
  mt_user_id   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists booking_devices_email_idx
  on public.booking_devices (email);

alter table public.booking_codes   enable row level security;
alter table public.booking_devices enable row level security;
-- service-role only; no anon policies on purpose (the edge fn is the gatekeeper).
