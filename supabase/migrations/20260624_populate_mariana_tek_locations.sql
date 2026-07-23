-- 2026-06-24 · Populate Mariana Tek location IDs + subdomain on locations table.
--
-- Pulled from betterbodybootcamp.marianatools.com/developer (Web Integrations
-- "HTML Snippets" panel). Single tenant for all 4 studios — subdomain is the
-- same. Per-studio MT location IDs unlock the per-studio schedule/buy iframes
-- on /schedule/[slug] and the backend MT API syncs once those go live.
--
-- Prerequisite: columns added by 20260623_mariana_tek_cutover.sql
-- (mariana_tek_subdomain, mariana_tek_location_id).

UPDATE public.locations
   SET mariana_tek_subdomain = 'betterbodybootcamp',
       mariana_tek_location_id = '48717'
 WHERE lower(replace(name, ' ', '-')) = 'astoria';

UPDATE public.locations
   SET mariana_tek_subdomain = 'betterbodybootcamp',
       mariana_tek_location_id = '48718'
 WHERE lower(replace(name, ' ', '-')) = 'bayside';

UPDATE public.locations
   SET mariana_tek_subdomain = 'betterbodybootcamp',
       mariana_tek_location_id = '48719'
 WHERE lower(replace(name, ' ', '-')) = 'fresh-meadows';

UPDATE public.locations
   SET mariana_tek_subdomain = 'betterbodybootcamp',
       mariana_tek_location_id = '48720'
 WHERE lower(replace(name, ' ', '-')) = 'williamsburg';

-- Verify
SELECT lower(replace(name, ' ', '-')) AS slug,
       mariana_tek_subdomain,
       mariana_tek_location_id,
       data_source
  FROM public.locations
 ORDER BY slug;
