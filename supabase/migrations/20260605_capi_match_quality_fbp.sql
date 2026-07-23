-- 20260605_capi_match_quality_fbp.sql
--
-- Adds fbp column to trial_signups so create-trial-checkout can persist the
-- Facebook browser pixel cookie (_fbp) alongside the existing fbc column.
-- client_ip + client_user_agent columns already exist; they were added in a
-- prior migration but were never wired up to either the form/checkout write
-- path or the Meta CAPI send. This patch closes that gap.
--
-- Why:
--   Meta CAPI Purchase events were going out with only hashed em/ph/fn/ln —
--   no client_ip_address, no client_user_agent, no fbc, no fbp. Match quality
--   floored around 4/10. Meta received the event (HTTP 200, events_received:1)
--   but its matching layer couldn't tie the server event to the original ad
--   click, so the conversion went unattributed in Ads Manager.
--
--   Bayside surfaced this most visibly: $372 spend / 8 days / 0 attributed
--   purchases despite real paid trials (Josie 6/2, Yissel 6/1, Danivp 6/1).
--   The condition exists for all 4 studios — Bayside was just the first to
--   hit zero because its ad volume is lowest.
--
-- Companion code changes (deployed together):
--   - create-trial-checkout: captures IP from x-forwarded-for / cf-connecting-ip
--     / x-real-ip headers, UA from user-agent header; writes IP / UA / fbp /
--     fbc to the pending trial_signups row at form submission time.
--   - stripe-webhook: on checkout.session.completed, reads IP / UA / fbp /
--     fbc off the (just-upserted) trial_signups row and passes them into
--     sendMetaPurchaseEvent, which adds client_ip_address + client_user_agent
--     (plain text, per Meta CAPI spec) to user_data alongside the existing
--     hashed em/ph/fn/ln + plain fbp/fbc.

ALTER TABLE public.trial_signups
  ADD COLUMN IF NOT EXISTS fbp text;

COMMENT ON COLUMN public.trial_signups.fbp IS
  'Meta browser pixel cookie (_fbp). Plain text. Read by stripe-webhook to enrich the server-side Purchase CAPI event so Meta can attribute the conversion back to the original ad click.';

-- Sanity probe: count rows that now have each match-quality signal populated.
-- Right after this migration runs, all four counts should be 0. After
-- create-trial-checkout + stripe-webhook redeploy, every NEW pending row
-- (paid or not) should populate client_ip, client_user_agent, and usually
-- fbp; fbc only when the visit had ?fbclid= in the URL.
SELECT
  COUNT(*)                                          AS total_rows,
  COUNT(client_ip)         FILTER (WHERE client_ip          <> '') AS with_ip,
  COUNT(client_user_agent) FILTER (WHERE client_user_agent  <> '') AS with_ua,
  COUNT(fbp)               FILTER (WHERE fbp                <> '') AS with_fbp,
  COUNT(fbc)               FILTER (WHERE fbc                <> '') AS with_fbc
FROM public.trial_signups
WHERE deleted_at IS NULL
  AND created_at >= NOW() - INTERVAL '7 days';
