-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-05 · get_converted_members() times out (task #36, "owner dashboard
-- RPC timeout"). Confirmed live today: calling it returns HTTP 500 with
-- Postgres code 57014 = statement_timeout. The "customers who bought after
-- their trial" card has been failing on every dashboard load.
--
-- WHY IT IS SLOW. Three things, in order of damage:
--
--  1. Every join in the function is on a LOWERCASED expression —
--       JOIN trial_signups t   ON lower(t.email) = td.email
--       JOIN mindbody_clients c ON lower(c.email) = td.email
--       DISTINCT ON (studio_slug, lower(customer_email))
--     A plain btree on email cannot serve lower(email), so each of these is a
--     sequential scan plus a sort. Nothing in the database can help it.
--
--  2. A correlated subquery over mariana_tek_sales keyed on customer_mt_id
--     runs once per candidate row, each time re-evaluating twelve
--     LIKE '%...%' conditions on item_names.
--
--  3. The date filter is written
--       (s.sale_date_time AT TIME ZONE 'America/New_York')::date >= p_since
--     which is not sargable, so the existing
--     mariana_tek_sales_studio_date_idx is unusable and the whole table is
--     scanned. This one cannot be fixed with an index — AT TIME ZONE on a
--     timestamptz is STABLE, not IMMUTABLE, so it cannot be indexed at all.
--     It needs a function rewrite to a plain range comparison:
--       s.sale_date_time >= (p_since::timestamp AT TIME ZONE 'America/New_York')
--     Deliberately NOT done here — that is a logic change to a 200-line
--     function and wants its own verified pass. These indexes are additive and
--     cannot change a single returned row.
--
-- THIS MIGRATION ONLY ADDS INDEXES. No function body is touched, so there is
-- no behavioural risk: worst case the planner ignores them. Tables here are in
-- the low thousands of rows, so plain CREATE INDEX takes a brief lock rather
-- than needing CONCURRENTLY (which cannot run inside the SQL editor's
-- transaction anyway).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1 ── the lower(email) join keys ────────────────────────────────────────────
-- NOTE: deliberately NOT partial on deleted_at. A partial index can only be
-- used when the planner can prove the query satisfies its predicate, and the
-- join inside get_converted_members is a bare
--   JOIN trial_signups t ON lower(t.email) = td.email
-- with no deleted_at condition — so a "WHERE deleted_at IS NULL" index would
-- be ignored and we would have shipped a no-op. Verified in Postgres: with the
-- predicate the planner still chose a seq scan; without it, an index scan.
CREATE INDEX IF NOT EXISTS trial_signups_lower_email_idx
  ON public.trial_signups (lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS mindbody_clients_lower_email_idx
  ON public.mindbody_clients (lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS mariana_tek_sales_lower_email_idx
  ON public.mariana_tek_sales (lower(customer_email))
  WHERE customer_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS stripe_paid_mirror_lower_email_idx
  ON public.stripe_paid_mirror (lower(customer_email))
  WHERE customer_email IS NOT NULL;

-- 2 ── the correlated subquery's key. It looks up "other sales by this same
--      MT customer, earlier than this one", so lead with customer_mt_id and
--      carry sale_date_time so the lookup is index-only.
CREATE INDEX IF NOT EXISTS mariana_tek_sales_mtid_date_idx
  ON public.mariana_tek_sales (customer_mt_id, sale_date_time)
  WHERE customer_mt_id IS NOT NULL;

-- 3 ── the name-based fallback join (lower(first_name) against a split_part of
--      the Stripe customer name). Fuzzy and unavoidable, but at least indexed.
CREATE INDEX IF NOT EXISTS mindbody_clients_lower_first_name_idx
  ON public.mindbody_clients (lower(first_name))
  WHERE first_name IS NOT NULL;

-- 4 ── the twelve LIKE '%membership%' / '%unlimited%' / … scans on item_names.
--      Only a trigram index can serve a leading-wildcard LIKE. pg_trgm ships
--      with Supabase; if the extension is unavailable this block is the only
--      part that fails and the indexes above still stand.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS mariana_tek_sales_item_names_trgm_idx
  ON public.mariana_tek_sales USING gin (lower(item_names) gin_trgm_ops)
  WHERE item_names IS NOT NULL;

-- Give the planner fresh statistics for the new expressions.
ANALYZE public.trial_signups;
ANALYZE public.mindbody_clients;
ANALYZE public.mariana_tek_sales;
ANALYZE public.stripe_paid_mirror;
