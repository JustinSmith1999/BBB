# BBB Projects Ledger

**Justin's single source of truth.** Every initiative across the BBB engagement.
Edit this file when work changes state — `/ops` reads from it.
Do not deploy this file to the public Netlify (it stays in `betterbodybootcamp-site`, not `bbb-marketing/`).

Last updated: 2026-05-31

---

## Legend

- **🔴 in-flight, blocked** — work started, can't progress until something external moves
- **🟡 in-flight, active** — work in progress this session or next
- **🟢 done** — shipped, verified, can be archived
- **⚪ parked** — known about, deliberately not working on now

Each entry: status · owner · next action · blocker · last updated.

---

## ACTIVE — money-bleeding right now

### Bayside checkout diagnosis
- 🟡 in-flight, active · **Owner: Claude (need Justin to OK Chrome MCP access)**
- The math: 1,183 ad clicks · 4.86% CTR · 0 leads · 0 paid in last 14 days. $694 spent. CTR is *higher* than studios that convert. Break is post-click.
- **Next action:** Claude opens https://betterbodybootcamp.com/trial/bayside in Chrome MCP, completes a test checkout end-to-end with $1 Stripe test card, screenshots the failure point.
- Blocker: needs Justin to approve Chrome MCP access dialog.
- Last updated: 2026-05-31

### Fresh Meadows checkout diagnosis
- 🟡 in-flight, active · **Owner: Claude**
- Same shape as Bayside: $523 spent, 10 leads, **0 purchases** in 14d. Less acute than Bayside but same systemic issue.
- **Next action:** piggyback on the Bayside Chrome MCP walk-through — verify /trial/fresh-meadows in the same session.
- Blocker: same as Bayside.
- Last updated: 2026-05-31

### 41 paid customers not in MindBody
- 🔴 in-flight, blocked · **Owner: Justin (gym staff) — or build the auto-provision**
- These customers paid $49 through the website but were never added to MindBody. They can't book classes. Carlos / Steve / Chris are manually creating each profile.
- **Two paths:** (A) /homebase button: "Create MindBody profile" that calls the MindBody REST API for this customer. Safe, opt-in per customer. ~½ day. (B) Auto-provision in stripe-webhook: every paid trial creates a MindBody client immediately after payment. ~½ day. (A) is safer, (B) is the right end state.
- **Next action:** Justin picks (A) or (B). Then Claude builds.
- Blocker: Justin's decision.
- Last updated: 2026-05-31

### Bridget Walsh — refund duplicate charge
- 🟡 in-flight, active · **Owner: Justin (one-time, manual)**
- Paid twice ($49 × 2) using `bwals1194@gmail.com` + `bwalsh1194@gmail.com` (typo, missed 'h'). Audit shows zero other duplicate-email cases since launch.
- **Next action:** Justin opens Stripe Dashboard → search "Bridget Walsh" → refund the duplicate charge.
- Blocker: none — 5-minute task.
- Last updated: 2026-05-31

---

## ACTIVE — non-money, near-term

### /homebase SMS thread UI
- 🟡 in-flight, active · **Owner: Claude**
- Backend is done — every inbound + outbound SMS lands in `sms_messages`, the gateway is plumbed, status webhook updates delivery. UI not built.
- **Next action:** add a "Conversation" panel to the customer-card modal on /homebase. Reads `get_sms_thread(trial_signup_id)` RPC. Includes a textarea + Send button that calls `twilio-outbound-sms`.
- Blocker: none. Can ship after Bayside diagnosis.
- Last updated: 2026-05-31

### Empty `meta_ads` + `meta_ad_insights_daily` tables
- 🔴 in-flight, blocked · **Owner: Claude**
- The Meta Ads "Creatives" card on the dashboard is empty because the per-ad sync isn't writing rows. On-demand `meta-ad-snapshot` works (Justin ran it tonight — full data came back). So the data is reachable; the cron sync path is broken.
- **Next action:** Claude diagnoses why `meta-insights-sync` cron run isn't populating `meta_ads`. Likely a schema change or a missing INSERT path.
- Blocker: needs investigation time.
- Last updated: 2026-05-31

### GBP post creation — Fresh Meadows description
- 🔴 in-flight, blocked · **Owner: Justin**
- Description for the FM Google Business Profile got lost in editor scroll during the original session.
- **Next action:** Justin re-writes the FM description or asks Claude to draft fresh.
- Blocker: Justin.
- Last updated: 2026-05-31

### GSC OAuth secrets — get gsc-sync running
- 🔴 in-flight, blocked · **Owner: Justin**
- Refactored gsc-sync to use OAuth refresh token. OAuth client created in GCP. Need Justin to use the OAuth playground to generate a refresh token, paste 3 secrets into Supabase, deploy.
- **Next action:** Justin does the OAuth playground → refresh token flow. Then SEO numbers light up on the dashboard.
- Blocker: Justin.
- Last updated: 2026-05-31

---

## ACTIVE — structural / safety

### Make `stripe-payment-audit` safe by default
- 🟡 in-flight, active · **Owner: Claude**
- Tonight's first owner-spam wave (13× "New $49 Trial" emails at 6:58 PM) came from this function. It does valuable work — caught 21 paid customers your webhook missed — but it fires owner notifications for each recovered row, including historical ones.
- **Next action:** patch the function to default `skip_emails=true`. Justin opts in to emails via query param when he actually wants them. Lives in `outputs/replacement-files/stripe-payment-audit/` — need to commit to main repo.
- Blocker: none. Should ship before next audit run.
- Last updated: 2026-05-31

### `TRIAL_NOTIFY` recipients → DB table
- ⚪ parked · **Owner: Claude (small)**
- The owner notification recipient list is hardcoded in two edge functions (`stripe-webhook` + `twilio-inbound-sms`). Risk: someone edits one and forgets the other; an owner gets dropped silently.
- **Next action:** create `notification_recipients` table; both functions read at runtime.
- Blocker: not urgent — recipients are stable.
- Last updated: 2026-05-31

### Staging environment
- ⚪ parked · **Owner: Justin + Claude**
- Every deploy is to production. Tonight's spam hit four real owners because there was nowhere to dry-run. A staging Supabase project would let Claude test anything that emails/SMSes before it touches the real owners.
- **Next action:** spin up a second Supabase project + Netlify site as staging. ~½ day of plumbing.
- Blocker: priority — keep parked until Bayside + MindBody are solved.
- Last updated: 2026-05-31

### Notification rate-limit
- ⚪ parked · **Owner: Claude**
- A function in a tight loop (or a Stripe webhook replay) can fire arbitrarily many emails/SMS to one recipient. Add a per-recipient daily cap — e.g. "no more than 20 owner emails per studio per 24h, throttle anything above that."
- **Next action:** implement as a check in `sendTrialEmail` / `notifyOwnersOfSignup` / `notifyStaffOfConvertYes`.
- Blocker: not urgent now that backfill guard is in place.
- Last updated: 2026-05-31

---

## DONE — recent (last 7 days)

### Owner spam stopped — funnel-recovery + 24h backfill guard + tightened YES
- 🟢 done — shipped 2026-05-31
- Disabled `funnel-recovery` cron + deleted function. Added 24h-old `payment_date` guard to `stripe-webhook` so replay can't dump 13 emails again. Tightened `twilio-inbound-sms` YES detection from {YES, Y, YEP, YUP, SURE, OK, OKAY} to {YES, YEP, YUP, YEAH, YESPLEASE} + 12-char max so "ok thanks" doesn't fire 🔥 emails.

### OPS_LEDGER.md + ops dashboard panel (now /ops only)
- 🟢 done — shipped 2026-05-31
- `OPS_LEDGER.md` enumerates every function, cron, notification recipient. Originally on the public dashboard — moved to /ops because owners shouldn't see plumbing.

### Dashboard wording / layout / readability pass
- 🟢 done — shipped 2026-05-31
- Removed redundant eyebrow + h2 pairs ("Trial Leads · By Source" / "Where leads come from" → "Lead Sources" / "Where each paid trial came from"). Killed "J20 Voice SaaS" jargon. Date-anchored pulse cards ("Today · May 31"). Honest footer ("Live: …" + "Not yet wired: …").

### Launch KPI filter fix — 66 → 47 paid
- 🟢 done — shipped 2026-05-31
- `get_launch_kpis` had no filters. Was double-counting legacy_archived + backfill rows. Applied the same filter set used everywhere else.

### SMS gateway scaffolding
- 🟢 done — shipped 2026-05-31
- `sms_messages` table, `match_trial_by_phone` RPC, `get_sms_thread` RPC, inbound/outbound/status webhooks all logging to one place.

### Server-side trial form dedupe (60-min same-email+location)
- 🟢 done — shipped 2026-05-31

### `stripe-payment-audit` initial run — 21 orphans recovered
- 🟢 done — shipped 2026-05-31
- Now in DB. MindBody profiles still need to be created (see "41 paid customers not in MindBody").

---

## CONVENTIONS

- Update an entry the same session you work on it.
- Move 🟢 done entries below the line once they're stable for 3+ days.
- New initiative? Add it under the right section. Don't drop it in a side conversation.
- This file is canonical. The `/ops` dashboard mirrors it.
