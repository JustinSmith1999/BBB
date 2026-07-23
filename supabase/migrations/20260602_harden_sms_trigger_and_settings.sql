-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-06-02 — Harden SMS gateway + add shared studio_settings
--
-- Two things in one migration because they ship together:
--
--   PART 1 — Fix sms_messages insert failures.
--   The trigger _sms_bump_last_touch references trial_signups.last_inbound_at
--   and .last_inbound_body in the inbound branch but those columns were never
--   created by any prior migration. When an inbound SMS arrives the UPDATE
--   raises 42703 (undefined_column) which rolls the original INSERT back.
--   Outbound has an EXCEPTION block on last_attempt_at, but the inbound
--   path didn't, so every inbound text was silently failing too. Fix:
--     1. Add the two missing columns IF NOT EXISTS.
--     2. Re-create the trigger with a single exception block that catches
--        any column-related error in either direction, so the gateway is
--        bullet-proof against future column drift.
--
--   PART 2 — Per-studio settings (conversion goal, etc.)
--   /homebase Conversion tab currently stores the goal % in localStorage so
--   every browser sees a different number. Build a studio_settings table
--   keyed by location_id with JSON-blob settings so we can grow without
--   schema changes. Conversion goal is the first key.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1: SMS gateway hardening
-- ═══════════════════════════════════════════════════════════════════════════

-- The two columns the trigger expects but no prior migration creates.
ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS last_inbound_at   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_inbound_body TEXT        NULL;

-- Index for "cards with an unanswered inbound" lookups on /homebase.
CREATE INDEX IF NOT EXISTS idx_trial_last_inbound_at
  ON public.trial_signups (last_inbound_at DESC NULLS LAST)
  WHERE last_inbound_at IS NOT NULL;

-- Re-create the trigger with one catch-all exception block. The original had
-- the inbound UPDATE unwrapped, so any column drift would crash the insert.
-- Wrapping both branches means the SMS gateway stays writable even if a
-- future schema change removes a column.
CREATE OR REPLACE FUNCTION public._sms_bump_last_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.trial_signup_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF NEW.direction = 'inbound' THEN
      UPDATE public.trial_signups
         SET last_inbound_at   = NEW.sent_at,
             last_inbound_body = LEFT(NEW.body, 500)
       WHERE id = NEW.trial_signup_id;
    ELSE
      -- outbound
      UPDATE public.trial_signups
         SET last_attempt_at = NEW.sent_at
       WHERE id = NEW.trial_signup_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never let a touch-tracking update kill the message log row. Log a
    -- NOTICE so it's still visible in Postgres logs.
    RAISE NOTICE 'sms_bump_last_touch failed silently: % %', SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- The trigger reference itself doesn't change, but re-bind for clarity.
DROP TRIGGER IF EXISTS sms_bump_last_touch ON public.sms_messages;
CREATE TRIGGER sms_bump_last_touch
  AFTER INSERT ON public.sms_messages
  FOR EACH ROW EXECUTE FUNCTION public._sms_bump_last_touch();

-- Explicit INSERT policy so non-service-role keys can write too (the edge
-- function uses service role and bypasses RLS, but a future Realtime
-- INSERT-from-client flow would need this).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'sms_messages' AND policyname = 'sms_insert_service'
  ) THEN
    CREATE POLICY "sms_insert_service"
      ON public.sms_messages FOR INSERT
      TO service_role WITH CHECK (true);
  END IF;
END$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2: studio_settings (shared per-studio config)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.studio_settings (
  location_id           UUID PRIMARY KEY REFERENCES public.locations(id) ON DELETE CASCADE,
  conversion_goal_pct   INT  NOT NULL DEFAULT 20 CHECK (conversion_goal_pct BETWEEN 0 AND 100),
  -- Forward-compat: misc settings as JSON so we don't migrate per knob.
  settings              JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            TEXT NULL
);

ALTER TABLE public.studio_settings ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read. Edge functions and dashboard can both query.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'studio_settings' AND policyname = 'studio_settings_read'
  ) THEN
    CREATE POLICY "studio_settings_read"
      ON public.studio_settings FOR SELECT
      TO anon, authenticated USING (true);
  END IF;
END$$;


-- ── RPCs: read + write conversion goal (and ad-hoc settings later) ────────
CREATE OR REPLACE FUNCTION public.get_studio_settings(p_location_id UUID)
RETURNS TABLE(
  location_id         UUID,
  conversion_goal_pct INT,
  settings            JSONB,
  updated_at          TIMESTAMPTZ,
  updated_by          TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  -- Returns one row even if no settings exist yet (defaults from the schema).
  SELECT
    p_location_id                         AS location_id,
    COALESCE(s.conversion_goal_pct, 20)   AS conversion_goal_pct,
    COALESCE(s.settings, '{}'::jsonb)     AS settings,
    s.updated_at,
    s.updated_by
  FROM (SELECT 1) _
  LEFT JOIN public.studio_settings s ON s.location_id = p_location_id;
$$;
GRANT EXECUTE ON FUNCTION public.get_studio_settings(UUID) TO anon, authenticated;


CREATE OR REPLACE FUNCTION public.set_studio_conversion_goal(
  p_location_id UUID,
  p_goal_pct    INT,
  p_updated_by  TEXT DEFAULT NULL
)
RETURNS public.studio_settings
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.studio_settings;
BEGIN
  IF p_goal_pct IS NULL OR p_goal_pct < 0 OR p_goal_pct > 100 THEN
    RAISE EXCEPTION 'conversion_goal_pct must be 0..100, got %', p_goal_pct;
  END IF;

  INSERT INTO public.studio_settings (location_id, conversion_goal_pct, updated_by, updated_at)
  VALUES (p_location_id, p_goal_pct, p_updated_by, now())
  ON CONFLICT (location_id) DO UPDATE
    SET conversion_goal_pct = EXCLUDED.conversion_goal_pct,
        updated_by          = EXCLUDED.updated_by,
        updated_at          = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_studio_conversion_goal(UUID, INT, TEXT) TO authenticated;


-- ── Seed defaults so the dashboard always has a baseline goal ─────────────
INSERT INTO public.studio_settings (location_id, conversion_goal_pct)
SELECT id, 20 FROM public.locations
ON CONFLICT (location_id) DO NOTHING;


-- ── Sanity check ──────────────────────────────────────────────────────────
SELECT
  to_regclass('public.studio_settings')                          AS studio_settings_exists,
  to_regclass('public.sms_messages')                             AS sms_messages_exists,
  (SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='trial_signups'
      AND column_name='last_inbound_at')                         AS last_inbound_at_col,
  (SELECT COUNT(*) FROM public.studio_settings)                  AS studios_seeded;
