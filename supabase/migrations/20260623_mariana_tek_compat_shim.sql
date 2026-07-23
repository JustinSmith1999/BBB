-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-23 · MT → MB compatibility shim (shadow-write triggers)
--
-- WHY: We have 41 SQL files defining RPCs that read mindbody_sales /
-- mindbody_clients / mindbody_visits. Rewriting all 41 before Thursday is not
-- realistic. Instead, every INSERT/UPDATE on a mariana_tek_* table mirrors
-- into the matching mindbody_* table with the column mapping below. Then
-- every existing dashboard RPC keeps working untouched post-cutover.
--
-- KEY MAPPING: We prefix the foreign key with "mt:" so a shadowed row is
-- distinguishable from a real MB row but the schema is identical. RPCs that
-- treat the id as opaque (the vast majority) are not affected. RPCs that
-- string-match the id (rare) can branch on the prefix.
--
-- ROLLBACK: DROP TRIGGER mt_sales_shadow_to_mb ON public.mariana_tek_sales;
-- (then delete the shadowed rows from mindbody_sales WHERE mindbody_sale_id
-- LIKE 'mt:%')
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Sales shadow-write ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shadow_mt_sale_to_mb()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.mindbody_sales (
    mindbody_sale_id,
    studio_slug,
    location_id,
    sale_date_time,
    customer_mindbody_id,
    customer_first_name,
    customer_last_name,
    customer_email,
    payment_method,
    item_names,
    item_count,
    total_cents,
    raw,
    synced_at
  )
  VALUES (
    'mt:' || NEW.mt_sale_id,
    NEW.studio_slug,
    (SELECT id FROM public.locations
       WHERE lower(replace(name, ' ', '-')) = NEW.studio_slug
       LIMIT 1)::int,  -- mindbody_sales.location_id is int, swallow nulls cleanly
    NEW.sale_date_time,
    CASE WHEN NEW.customer_mt_id IS NOT NULL
         THEN 'mt:' || NEW.customer_mt_id
         ELSE NULL END,
    NEW.customer_first_name,
    NEW.customer_last_name,
    NEW.customer_email,
    NEW.payment_method,
    NEW.item_names,
    NEW.item_count,
    NEW.total_cents,
    jsonb_build_object('shadow_from', 'mariana_tek_sales', 'mt_raw', NEW.raw),
    NEW.synced_at
  )
  ON CONFLICT (mindbody_sale_id) DO UPDATE SET
    sale_date_time      = EXCLUDED.sale_date_time,
    customer_email      = EXCLUDED.customer_email,
    customer_first_name = EXCLUDED.customer_first_name,
    customer_last_name  = EXCLUDED.customer_last_name,
    payment_method      = EXCLUDED.payment_method,
    item_names          = EXCLUDED.item_names,
    item_count          = EXCLUDED.item_count,
    total_cents         = EXCLUDED.total_cents,
    raw                 = EXCLUDED.raw,
    synced_at           = EXCLUDED.synced_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mt_sales_shadow_to_mb ON public.mariana_tek_sales;
CREATE TRIGGER mt_sales_shadow_to_mb
  AFTER INSERT OR UPDATE ON public.mariana_tek_sales
  FOR EACH ROW EXECUTE FUNCTION public.shadow_mt_sale_to_mb();

-- ── 2. Clients shadow-write ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shadow_mt_client_to_mb()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.mindbody_clients (
    mindbody_id,
    email,
    first_name,
    last_name,
    phone,
    dob,
    raw,
    synced_at
  )
  VALUES (
    'mt:' || NEW.mt_id,
    NEW.email,
    NEW.first_name,
    NEW.last_name,
    NEW.phone,
    NEW.dob,
    jsonb_build_object('shadow_from', 'mariana_tek_clients', 'mt_raw', NEW.raw),
    NEW.synced_at
  )
  ON CONFLICT (mindbody_id) DO UPDATE SET
    email      = EXCLUDED.email,
    first_name = EXCLUDED.first_name,
    last_name  = EXCLUDED.last_name,
    phone      = EXCLUDED.phone,
    dob        = EXCLUDED.dob,
    raw        = EXCLUDED.raw,
    synced_at  = EXCLUDED.synced_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mt_clients_shadow_to_mb ON public.mariana_tek_clients;
CREATE TRIGGER mt_clients_shadow_to_mb
  AFTER INSERT OR UPDATE ON public.mariana_tek_clients
  FOR EACH ROW EXECUTE FUNCTION public.shadow_mt_client_to_mb();

-- ── 3. Visits shadow-write ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shadow_mt_visit_to_mb()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.mindbody_visits (
    mindbody_visit_id,
    studio_slug,
    mindbody_client_id,
    starts_at,
    signed_in,
    raw,
    synced_at
  )
  VALUES (
    'mt:' || NEW.mt_visit_id,
    NEW.studio_slug,
    CASE WHEN NEW.mt_client_id IS NOT NULL
         THEN 'mt:' || NEW.mt_client_id
         ELSE NULL END,
    NEW.starts_at,
    NEW.signed_in,
    jsonb_build_object(
      'shadow_from', 'mariana_tek_visits',
      'status', NEW.status,
      'mt_class_id', NEW.mt_class_id,
      'mt_raw', NEW.raw
    ),
    NEW.synced_at
  )
  ON CONFLICT (mindbody_visit_id) DO UPDATE SET
    starts_at = EXCLUDED.starts_at,
    signed_in = EXCLUDED.signed_in,
    raw       = EXCLUDED.raw,
    synced_at = EXCLUDED.synced_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mt_visits_shadow_to_mb ON public.mariana_tek_visits;
CREATE TRIGGER mt_visits_shadow_to_mb
  AFTER INSERT OR UPDATE ON public.mariana_tek_visits
  FOR EACH ROW EXECUTE FUNCTION public.shadow_mt_visit_to_mb();

-- ── 4. Helper: list every shadowed row (cutover audit) ────────────────────
CREATE OR REPLACE FUNCTION public.get_shadow_row_counts()
RETURNS TABLE (
  table_name  text,
  total       bigint,
  shadowed    bigint,
  pct_shadow  numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  SELECT 'mindbody_sales'::text,
         (SELECT count(*) FROM public.mindbody_sales),
         (SELECT count(*) FROM public.mindbody_sales WHERE mindbody_sale_id LIKE 'mt:%'),
         CASE WHEN (SELECT count(*) FROM public.mindbody_sales) = 0 THEN 0
              ELSE round(100.0 *
                (SELECT count(*) FROM public.mindbody_sales WHERE mindbody_sale_id LIKE 'mt:%')::numeric
                / (SELECT count(*) FROM public.mindbody_sales)::numeric, 1) END
  UNION ALL
  SELECT 'mindbody_clients'::text,
         (SELECT count(*) FROM public.mindbody_clients),
         (SELECT count(*) FROM public.mindbody_clients WHERE mindbody_id LIKE 'mt:%'),
         CASE WHEN (SELECT count(*) FROM public.mindbody_clients) = 0 THEN 0
              ELSE round(100.0 *
                (SELECT count(*) FROM public.mindbody_clients WHERE mindbody_id LIKE 'mt:%')::numeric
                / (SELECT count(*) FROM public.mindbody_clients)::numeric, 1) END
  UNION ALL
  SELECT 'mindbody_visits'::text,
         (SELECT count(*) FROM public.mindbody_visits),
         (SELECT count(*) FROM public.mindbody_visits WHERE mindbody_visit_id LIKE 'mt:%'),
         CASE WHEN (SELECT count(*) FROM public.mindbody_visits) = 0 THEN 0
              ELSE round(100.0 *
                (SELECT count(*) FROM public.mindbody_visits WHERE mindbody_visit_id LIKE 'mt:%')::numeric
                / (SELECT count(*) FROM public.mindbody_visits)::numeric, 1) END;
$$;

REVOKE ALL ON FUNCTION public.get_shadow_row_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shadow_row_counts() TO service_role;

COMMENT ON FUNCTION public.get_shadow_row_counts() IS
  'After cutover, this should show ramping "shadowed" counts for the studios that flipped. If MT sync errors out, this stays at 0 and the % shadow stops growing — easy alarm condition.';

-- ── 5. Sanity ────────────────────────────────────────────────────────────
SELECT 'shim_installed' AS check,
       (SELECT count(*) FROM pg_trigger
          WHERE tgname IN ('mt_sales_shadow_to_mb', 'mt_clients_shadow_to_mb', 'mt_visits_shadow_to_mb')
            AND tgrelid::regclass::text LIKE 'public.mariana_tek_%')
         AS triggers_present;
