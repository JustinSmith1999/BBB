-- 2026-06-27 — FULL MindBody → Mariana Tek cutover
-- =====================================================================
-- All 4 BBB studios are live on MT today (combined $1,502.50 sales,
-- 191 reservations confirmed via /api/customer/v1/classes audit on
-- 2026-06-27). MindBody is effectively dead — but the website's trial
-- signup pipe still routes through stripe-webhook → mindbody-create-
-- trial-client because locations.data_source = 'mindbody'.
--
-- This migration flips the routing AND populates the MT location IDs +
-- shared tenant subdomain so mariana-tek-create-trial-client doesn't
-- have to lean on its hardcoded fallback map.
--
-- All 4 MT location IDs confirmed live via GET /api/locations/ today:
--   Williamsburg  → 48720
--   Astoria       → 48717
--   Bayside       → 48718
--   Fresh Meadows → 48719
--
-- ROLLBACK: re-run with 'mindbody' in place of 'mariana_tek' below.
--           DO NOT clear mariana_tek_location_id / subdomain on rollback
--           — those are useful even if data_source flips back.

BEGIN;

-- 1) Populate MT routing fields on every studio row.
UPDATE locations SET
  mariana_tek_subdomain   = 'betterbodybootcamp',
  mariana_tek_location_id = '48720'
WHERE name = 'Williamsburg';

UPDATE locations SET
  mariana_tek_subdomain   = 'betterbodybootcamp',
  mariana_tek_location_id = '48717'
WHERE name = 'Astoria';

UPDATE locations SET
  mariana_tek_subdomain   = 'betterbodybootcamp',
  mariana_tek_location_id = '48718'
WHERE name = 'Bayside';

UPDATE locations SET
  mariana_tek_subdomain   = 'betterbodybootcamp',
  mariana_tek_location_id = '48719'
WHERE name = 'Fresh Meadows';

-- 2) Flip the trial pipe so stripe-webhook routes to the MT create
--    function instead of the MindBody one.
UPDATE locations
   SET data_source = 'mariana_tek'
 WHERE name IN ('Williamsburg', 'Astoria', 'Bayside', 'Fresh Meadows');

-- 3) Sanity check — should return 4 rows, all data_source='mariana_tek'.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
    FROM locations
   WHERE name IN ('Williamsburg', 'Astoria', 'Bayside', 'Fresh Meadows')
     AND (data_source IS DISTINCT FROM 'mariana_tek'
       OR mariana_tek_subdomain   IS NULL
       OR mariana_tek_location_id IS NULL);
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      '20260627_mt_full_cutover: % studio rows still missing MT fields — aborting',
      bad_count;
  END IF;
END $$;

COMMIT;

-- Post-flight verification (run by hand after commit):
--   SELECT name, data_source, mariana_tek_subdomain, mariana_tek_location_id
--     FROM locations
--    WHERE name IN ('Williamsburg', 'Astoria', 'Bayside', 'Fresh Meadows')
--    ORDER BY name;
