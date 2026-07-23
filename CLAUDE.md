# CLAUDE.md — Better Body Bootcamp (working memory / session handoff)

_Last updated 2026-07-10. This is the pick-up-where-we-left-off memory. Read the linked docs before re-deriving anything._

**Read first:** `SYSTEM_OVERVIEW.md` (full end-to-end architecture), `OPS_LEDGER.md`,
and in the sibling repo `../bbb-marketing/`: `CLAUDE_HANDOFF_MASTER.md`, `MT-CUTOVER-RUNBOOK.md`.

## What this is
BBB = 4 NYC studios (Astoria, Bayside, Fresh Meadows, Williamsburg), run via J20 Solutions.
Migrated MindBody → **Mariana Tek (MT)** in June 2026. Client-side React SPA (Vite + react-router)
on Netlify (`betterbodybootcamp.com`); Supabase edge functions (Deno/TS), project ref
`uracuwugpxqjfgtuobal`. The two owner tools (owner dashboard + front-desk "Homebase") live in the
sibling `bbb-marketing/` repo.

## Deploy / run workflow
- **Site (this repo):** `git push` → Netlify auto-builds. Or `netlify deploy --prod --build`.
- **Edge functions:** `bbb deploy-fn <name>` (= `supabase functions deploy <name> --no-verify-jwt --project-ref uracuwugpxqjfgtuobal`). Helper script: `bbb.sh` (commands: `deploy-fn`, `capi`, `deploy-site`, `sync`, `unlock`).
- **Migrations:** run the SQL in the Supabase SQL editor (not via CLI).
- **Calling functions:** header `x-bbb-secret: bbb-test-2026-05-27`. Docker isn't running locally; `--no-verify-jwt` is expected.

## MT key facts (memorize — these corrected earlier wrong assumptions)
- Location IDs: **Astoria 48717, Bayside 48718, Fresh Meadows 48719, Williamsburg 48720**.
- The $49 trial = MT membership **contract 14721** ("$49 Two Weeks Trial"). **Verified in MT admin: Active + sellable at ALL FOUR locations.** The old "pass is Astoria-only" theory was WRONG — that was a different, *inactive* "Trial Offer Tags" membership type. So the MT buy widget works at every studio; `../bbb-marketing/mt-support-pass-14721.md` is now moot (no MT ticket needed).
- MT admin uses Ember Simple Auth: the OAuth token lives in `ember_simple_auth-session` localStorage, ~7-day life, client_id `QcTebKIlS9xrrU6Gj2r3gJxrponZVbUPjcbSlWwq` (public). Access/refresh tokens are secrets — never commit them.
- Supabase anon RLS blocks raw tables (`mariana_tek_sales/visits/clients` return `[]` to anon); some RPCs are anon-callable.

## Open items / where we left off (2026-07-10)
1. **Bayside → MT widget: DONE + pushed** (commit `1e09cc2`). `src/pages/LocationTrialSignup.tsx` now sets `useBaysideFallback=false`; Bayside uses the MT buy widget like the others; the Stripe fork below it is now dead code. **Verify:** one real $49 trial on `/trial/bayside` → stays on Bayside checkout, creates an active MT member, can book. Then delete the dead Bayside Stripe block.
2. **CAPI match-quality fix: coded, NOT deployed.** `supabase/functions/mariana-tek-capi-purchase-sync` now joins each MT sale to its `trial_signups` row by email, attaches `fbp/fbc/client_ip/client_user_agent`, and sends `action_source:"website"` (was `physical_store` + hashed PII only = un-attributable; that's why Bayside showed spend with ~0 attributed purchases). Deploy `bbb deploy-fn mariana-tek-capi-purchase-sync`, then dry-run `{"dry_run":true,"lookback_hours":720}` and confirm events show `action_source:website` + populated `match_signals`. Improves attribution going forward only (Meta dedupes history).
3. **MT sync token was dead (401)** → `mt-orders-sync` was blind for days ("no trials in the dashboard"). Fix = set 3 Supabase secrets: `MT_OAUTH_ACCESS_TOKEN`, `MT_OAUTH_REFRESH_TOKEN`, `MT_OAUTH_CLIENT_ID` (client_id above; the access/refresh values come from the MT admin `ember_simple_auth-session` localStorage — do NOT put them in any committed file). Then backfill `mt-orders-sync {"full_refresh":true,"skip_welcome":true}`. **Watch:** if MT rotates the refresh token per use, the sync must persist the rotated token (it currently doesn't) — if it dies again in ~7 days, add that.
4. **`skip_welcome` flag added to `mt-orders-sync`** (prevents late welcome-email blasts on catch-up backfills). Deploy it: `bbb deploy-fn mt-orders-sync`.
5. **`meta-set-budget` built (dry-run default), NOT deployed.** CBO/ABO-aware daily-budget setter per studio. Deploy + dry-run + apply to cut Meta to **$25/day per location**. Usage is in the file header.
6. **Homebase + owner-dashboard redesign (in `../bbb-marketing/`).** Approved mockups: `homebase-redesign-mockup.html`, `dashboard-redesign-mockup.html`. Backup of the live board: `frontdesk.pre-redesign-20260710.bak.html`. NEXT: rebuild the real `frontdesk.html` on the Homebase mockup as a **re-skin only** — preserve ALL logic (auth, Supabase queries, drag-drop, stage RPCs, carryover detection `isCarryOver`/`__carried` + the `strictLen` funnel-count reconciliation, Board/Conversion/Members/History views). Then the same for `index.html` (owner dashboard).
7. **DMARC:** the domain already has a `_dmarc` TXT in GoDaddy, so SendGrid's was skipped (fine). Decide keep vs replace. SendGrid CNAMEs (`em9137`, `s1._domainkey`, `s2._domainkey`) are set.
8. **Paid-but-not-provisioned customer:** at least one Bayside Stripe buyer paid but was never made an active MT member (root cause = the old Stripe fork that collected money without provisioning MT). Comp them the intro pass in MT admin.

## Gotchas
- `create-trial-checkout` (Stripe path) captures `fbp/fbc/client_ip/client_user_agent` onto `trial_signups`; MT-widget purchases may not — the CAPI fix matches on whatever's captured.
- Heavy pages (trial pages, MT admin reports, the dashboards) never reach `document_idle` — only relevant to browser automation, not Claude Code.
