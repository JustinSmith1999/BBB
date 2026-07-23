-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-23 · Mariana Tek (MT) cutover infrastructure
--
-- WHY: We're cutting over from MindBody (MB) to Mariana Tek on Thursday 6/25.
-- Everything in our stack currently reads from MB. This migration builds the
-- PARALLEL plumbing so we can:
--   (1) Dual-run MB + MT syncs during the overlap window
--   (2) Flip studios over one-at-a-time via a `data_source` column on locations
--   (3) Keep every dashboard RPC working without a rewrite (unified views)
--   (4) Roll back any studio instantly by flipping data_source back to 'mindbody'
--
-- DESIGN: Mirror-the-shape — every MT table mirrors its MB counterpart's
-- column set 1:1 (renamed for clarity) so the unified_* views below can simply
-- UNION ALL. Anything MT-specific that doesn't have an MB twin goes in `raw`
-- jsonb.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. locations: add MT credentials + per-studio cutover toggle ───────────
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS mariana_tek_subdomain text,
  ADD COLUMN IF NOT EXISTS mariana_tek_api_key   text,
  ADD COLUMN IF NOT EXISTS mariana_tek_location_id text,
  ADD COLUMN IF NOT EXISTS data_source           text DEFAULT 'mindbody' NOT NULL;

-- Allowed values for data_source. Per-studio toggle drives:
--   - which sync function writes to which table
--   - which side the unified_* views surface for that studio
--   - which create-trial-client function stripe-webhook calls on $49 paid
ALTER TABLE public.locations
  DROP CONSTRAINT IF EXISTS locations_data_source_check;
ALTER TABLE public.locations
  ADD CONSTRAINT locations_data_source_check
  CHECK (data_source IN ('mindbody', 'mariana_tek', 'dual'));

COMMENT ON COLUMN public.locations.data_source IS
  'Per-studio cutover toggle. "mindbody" = pre-cutover (MT syncs skip this row). "mariana_tek" = post-cutover (MB syncs skip this row, unified views read MT). "dual" = overlap window (both run, unified reads MT, MB still backed up). Flip via UPDATE locations SET data_source = ''mariana_tek'' WHERE name = ''X'';';

COMMENT ON COLUMN public.locations.mariana_tek_subdomain IS
  'Per-studio MT subdomain. Example: bbb-bayside.marianatek.com → ''bbb-bayside''. Used as base URL for /api/* calls.';

COMMENT ON COLUMN public.locations.mariana_tek_api_key IS
  'Per-studio MT Studio API key issued by integrations@marianatek.com. Bearer token.';

-- ── 2. trial_signups: add mariana_tek_id (parallel to mindbody_id) ─────────
ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS mariana_tek_id text;

CREATE INDEX IF NOT EXISTS trial_signups_mt_id_idx
  ON public.trial_signups (mariana_tek_id)
  WHERE mariana_tek_id IS NOT NULL;

COMMENT ON COLUMN public.trial_signups.mariana_tek_id IS
  'MT customer ID set by mariana-tek-create-trial-client on $49 paid (post-cutover) or by clients-sync match. Parallel to mindbody_id — both can be set during overlap.';

-- ── 3. mariana_tek_sales — mirror of mindbody_sales ───────────────────────
DROP TABLE IF EXISTS public.mariana_tek_sales CASCADE;
CREATE TABLE public.mariana_tek_sales (
  mt_sale_id            text PRIMARY KEY,
  studio_slug           text NOT NULL,
  location_id           uuid REFERENCES public.locations(id),
  sale_date_time        timestamptz,
  customer_mt_id        text,
  customer_first_name   text,
  customer_last_name    text,
  customer_email        text,
  payment_method        text,
  item_names            text,
  item_count            int,
  total_cents           bigint DEFAULT 0,
  raw                   jsonb,
  synced_at             timestamptz DEFAULT now()
);

CREATE INDEX mariana_tek_sales_studio_date_idx
  ON public.mariana_tek_sales (studio_slug, sale_date_time DESC);
CREATE INDEX mariana_tek_sales_email_idx
  ON public.mariana_tek_sales (customer_email)
  WHERE customer_email IS NOT NULL;
CREATE INDEX mariana_tek_sales_customer_idx
  ON public.mariana_tek_sales (customer_mt_id)
  WHERE customer_mt_id IS NOT NULL;

ALTER TABLE public.mariana_tek_sales ENABLE ROW LEVEL SECURITY;
-- No anon SELECT policy — dashboard reads via SECURITY DEFINER RPCs only.

-- ── 4. mariana_tek_clients — mirror of mindbody_clients ───────────────────
DROP TABLE IF EXISTS public.mariana_tek_clients CASCADE;
CREATE TABLE public.mariana_tek_clients (
  mt_id           text PRIMARY KEY,
  studio_slug     text,
  email           text,
  first_name      text,
  last_name       text,
  phone           text,
  dob             date,
  created_at_mt   timestamptz,
  raw             jsonb,
  synced_at       timestamptz DEFAULT now()
);

CREATE INDEX mariana_tek_clients_email_idx
  ON public.mariana_tek_clients (lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX mariana_tek_clients_studio_idx
  ON public.mariana_tek_clients (studio_slug);

ALTER TABLE public.mariana_tek_clients ENABLE ROW LEVEL SECURITY;

-- ── 5. mariana_tek_visits — mirror of mindbody_visits ─────────────────────
DROP TABLE IF EXISTS public.mariana_tek_visits CASCADE;
CREATE TABLE public.mariana_tek_visits (
  mt_visit_id     text PRIMARY KEY,
  studio_slug     text NOT NULL,
  mt_client_id    text,
  mt_class_id     text,
  starts_at       timestamptz,
  signed_in       boolean DEFAULT false,
  status          text,
  raw             jsonb,
  synced_at       timestamptz DEFAULT now()
);

CREATE INDEX mariana_tek_visits_client_starts_idx
  ON public.mariana_tek_visits (mt_client_id, starts_at DESC);
CREATE INDEX mariana_tek_visits_studio_date_idx
  ON public.mariana_tek_visits (studio_slug, starts_at DESC);

ALTER TABLE public.mariana_tek_visits ENABLE ROW LEVEL SECURITY;

-- ── 6. Unified views — read MB OR MT based on locations.data_source ───────
-- These are the cutover keystone. Existing RPCs that read mindbody_sales
-- get re-pointed at unified_sales in the follow-up migration. During overlap
-- we surface MT when data_source is 'mariana_tek' or 'dual', MB otherwise.

CREATE OR REPLACE VIEW public.unified_sales AS
SELECT
  s.mindbody_sale_id        AS sale_id,
  'mindbody'::text          AS source,
  s.studio_slug,
  s.location_id,
  s.sale_date_time,
  s.customer_mindbody_id    AS customer_external_id,
  s.customer_first_name,
  s.customer_last_name,
  s.customer_email,
  s.payment_method,
  s.item_names,
  s.item_count,
  s.total_cents,
  s.raw,
  s.synced_at
FROM public.mindbody_sales s
JOIN public.locations l
  ON lower(replace(l.name, ' ', '-')) = s.studio_slug
WHERE l.data_source IN ('mindbody', 'dual')

UNION ALL

SELECT
  m.mt_sale_id              AS sale_id,
  'mariana_tek'::text       AS source,
  m.studio_slug,
  m.location_id,
  m.sale_date_time,
  m.customer_mt_id          AS customer_external_id,
  m.customer_first_name,
  m.customer_last_name,
  m.customer_email,
  m.payment_method,
  m.item_names,
  m.item_count,
  m.total_cents,
  m.raw,
  m.synced_at
FROM public.mariana_tek_sales m
JOIN public.locations l
  ON lower(replace(l.name, ' ', '-')) = m.studio_slug
WHERE l.data_source IN ('mariana_tek', 'dual');

COMMENT ON VIEW public.unified_sales IS
  'Cutover view — surfaces MB sales for studios with data_source=mindbody, MT sales for data_source=mariana_tek, BOTH for data_source=dual. All sales RPCs should read from this.';

CREATE OR REPLACE VIEW public.unified_clients AS
SELECT
  c.mindbody_id           AS external_id,
  'mindbody'::text        AS source,
  NULL::text              AS studio_slug,
  c.email,
  c.first_name,
  c.last_name,
  c.phone,
  c.dob,
  NULL::timestamptz       AS created_at_external,
  c.raw,
  c.synced_at
FROM public.mindbody_clients c

UNION ALL

SELECT
  m.mt_id                 AS external_id,
  'mariana_tek'::text     AS source,
  m.studio_slug,
  m.email,
  m.first_name,
  m.last_name,
  m.phone,
  m.dob,
  m.created_at_mt         AS created_at_external,
  m.raw,
  m.synced_at
FROM public.mariana_tek_clients m;

COMMENT ON VIEW public.unified_clients IS
  'Cutover view — clients-by-email lookups should read here so they hit either MB or MT depending on which side the customer lives in.';

CREATE OR REPLACE VIEW public.unified_visits AS
SELECT
  v.mindbody_visit_id     AS visit_id,
  'mindbody'::text        AS source,
  v.studio_slug,
  v.mindbody_client_id    AS client_external_id,
  NULL::text              AS class_external_id,
  v.starts_at,
  v.signed_in,
  NULL::text              AS status,
  v.raw,
  v.synced_at
FROM public.mindbody_visits v
JOIN public.locations l
  ON lower(replace(l.name, ' ', '-')) = v.studio_slug
WHERE l.data_source IN ('mindbody', 'dual')

UNION ALL

SELECT
  m.mt_visit_id           AS visit_id,
  'mariana_tek'::text     AS source,
  m.studio_slug,
  m.mt_client_id          AS client_external_id,
  m.mt_class_id           AS class_external_id,
  m.starts_at,
  m.signed_in,
  m.status,
  m.raw,
  m.synced_at
FROM public.mariana_tek_visits m
JOIN public.locations l
  ON lower(replace(l.name, ' ', '-')) = m.studio_slug
WHERE l.data_source IN ('mariana_tek', 'dual');

COMMENT ON VIEW public.unified_visits IS
  'Cutover view — visit-history + first_visit_at + "attended" signals should read here.';

GRANT SELECT ON public.unified_sales TO postgres, service_role;
GRANT SELECT ON public.unified_clients TO postgres, service_role;
GRANT SELECT ON public.unified_visits TO postgres, service_role;

-- ── 7. Cutover status RPC — single call shows where every studio is ──────
CREATE OR REPLACE FUNCTION public.get_cutover_status()
RETURNS TABLE (
  studio_slug           text,
  data_source           text,
  mt_subdomain          text,
  has_mt_api_key        boolean,
  mb_sales_24h          bigint,
  mt_sales_24h          bigint,
  mb_clients_total      bigint,
  mt_clients_total      bigint,
  last_mt_sync          timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH studios AS (
    SELECT id, lower(replace(name, ' ', '-')) AS slug, data_source,
           mariana_tek_subdomain, mariana_tek_api_key
      FROM public.locations
  )
  SELECT s.slug,
         s.data_source,
         s.mariana_tek_subdomain,
         (s.mariana_tek_api_key IS NOT NULL) AS has_mt_api_key,
         (SELECT count(*) FROM public.mindbody_sales mb
            WHERE mb.studio_slug = s.slug
              AND mb.sale_date_time > now() - interval '24 hours')::bigint AS mb_sales_24h,
         (SELECT count(*) FROM public.mariana_tek_sales mt
            WHERE mt.studio_slug = s.slug
              AND mt.sale_date_time > now() - interval '24 hours')::bigint AS mt_sales_24h,
         (SELECT count(*) FROM public.mindbody_clients)::bigint            AS mb_clients_total,
         (SELECT count(*) FROM public.mariana_tek_clients mc
            WHERE mc.studio_slug = s.slug)::bigint                          AS mt_clients_total,
         (SELECT max(synced_at) FROM public.mariana_tek_sales mt
            WHERE mt.studio_slug = s.slug)                                  AS last_mt_sync
    FROM studios s
   ORDER BY s.slug;
$$;

COMMENT ON FUNCTION public.get_cutover_status() IS
  'Justin-facing cutover dashboard query. Returns one row per studio with MB vs MT sale counts for the last 24h plus credential / source / last-sync state. Used by /ops cutover panel + Thursday runbook.';

REVOKE ALL ON FUNCTION public.get_cutover_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cutover_status() TO service_role;

-- ── 8. Sanity verification ────────────────────────────────────────────────
SELECT 'cutover_infra' AS check,
       (SELECT count(*) FROM public.locations WHERE data_source IS NOT NULL) AS studios_with_source,
       (SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name LIKE 'mariana_tek%') AS mt_tables_present,
       (SELECT count(*) FROM information_schema.views
          WHERE table_schema = 'public'
            AND table_name LIKE 'unified_%') AS unified_views_present;
