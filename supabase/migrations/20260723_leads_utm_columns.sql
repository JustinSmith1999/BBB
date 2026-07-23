-- 20260723_leads_utm_columns.sql
-- Add UTM/source columns to the leads table so contact-form leads (the biggest
-- previously-untagged bucket) carry their attribution. send-contact-email now
-- populates these. Safe to re-run.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS utm_source   text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS utm_medium   text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS utm_content  text;
