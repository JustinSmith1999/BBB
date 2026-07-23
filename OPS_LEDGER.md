# BBB Operations Ledger

**Single source of truth for every deployed function, every cron job, every notification path.**
**Read this at the start of every session before touching anything that can email or text.**
**If a function isn't here, it doesn't exist. If you deploy something new, add it here in the same PR.**

Last full audit: **2026-06-01** (added CAPI monitoring, daily digest, membership conversion infra).

## Send-path allowlist (BBB_SEND_PATHS_ENABLED)

Every function that emails or texts checks `BBB_SEND_PATHS_ENABLED` env var (comma-separated). If its send path isn't in the list, the function no-ops.

**Default (production, set on stripe-webhook + bbb-send-paths-status + every send-capable function):**
```
stripe_owner_sms,stripe_customer_welcome_email
```

| Send path | Function | What it sends | Default | How to enable |
|---|---|---|---|---|
| `stripe_owner_email` | stripe-webhook | Owner inbox email per paid trial | OFF | Add to env var on stripe-webhook |
| `stripe_owner_sms` | stripe-webhook | Owner SMS per paid trial | **ON** | (default) |
| `stripe_customer_welcome_email` | stripe-webhook | Customer welcome email | **ON** | (default) |
| `stripe_customer_welcome_sms` | stripe-webhook | Customer welcome SMS | OFF | Add to env var |
| `justin_daily_digest` | daily-ops-digest | Justin@J20solutions.com 6am ET digest | OFF | Add to env var on all 3 functions (digest + webhook + paths-status) |
| `trial_membership_nudge` | trial-membership-nudge | Customer SMS at day 12+ / 5+ classes asking them to convert to monthly | OFF — **DO NOT ENABLE WITHOUT JUSTIN'S EXPLICIT GO** | (1) Uncomment cron in `20260601_membership_conversion_infra.sql` and re-run; (2) add path to env vars on trial-membership-nudge + stripe-webhook + bbb-send-paths-status; (3) Justin manually invokes function with `{"dry_run":true}` to preview, then with `{}` for live |

---

## 1. Notification paths — every place that emails or texts somebody

### Email TO gym owners (high-risk — this is what spammed them)

| Trigger | Function | Recipients | Volume per event | Status |
|---|---|---|---|---|
| Customer pays $49 (Stripe `checkout.session.completed`) | `stripe-webhook` → `notifyStaffOfTrial` | `TRIAL_NOTIFY[studio]` = 2–3 inboxes per studio (Carlos / Steve / Chris / studio@) | 1 email per paid trial | **ACTIVE** |
| Customer replies YES to Convert SMS | `twilio-inbound-sms` → `notifyStaffOfConvertYes` | `TRIAL_NOTIFY[studio]` | 1 email per YES reply (loose match: YES/Y/YEP/YUP/SURE/OK/OKAY) | **ACTIVE** |
| Daily digest of unmatched paid trials | `funnel-recovery` (NOT IN REPO — deployed only) | `TRIAL_NOTIFY[studio]` | 1 email per studio per day | **KILLED 2026-05-31** (Justin unscheduled cron + deleted function via dashboard) |

### SMS TO gym owners (high-risk)

| Trigger | Function | Recipients | Volume per event | Status |
|---|---|---|---|---|
| Customer pays $49 | `stripe-webhook` → `notifyOwnersBySms` | rows in `location_owners` WHERE `notify_signups=true` | 1 SMS per owner per paid trial (Astoria/WB = 2 owners = 2 SMS) | **ACTIVE** |

### Email TO customers (lower-risk — they expect these)

| Trigger | Function | Recipients | Status |
|---|---|---|---|
| Customer pays $49 | `stripe-webhook` → welcome email | customer | ACTIVE |
| Form filled, didn't pay within X hours | `abandoned-cart-followup` (cron) | customer; `reply_to` = studio inbox | ACTIVE — runs on cron |
| Customer fills contact form | `send-contact-email` | studio inbox + customer ack | ACTIVE |

### SMS TO customers (lower-risk)

| Trigger | Function | Recipients | Status |
|---|---|---|---|
| Customer pays $49 | `stripe-webhook` → welcome SMS | customer | ACTIVE |
| Customer has 2+ MindBody visits, hasn't converted | `trial-convert-followup` (cron, every 30 min) | customer (asks them to reply YES to convert to monthly) | ACTIVE — careful, YES replies cascade to owner email |
| Staff manually sends from /homebase | `twilio-outbound-sms` | customer; logged to `sms_messages` | ACTIVE (UI not built yet) |

### How the cascade works (why one paid trial = many notifications)

A single $49 Stripe checkout fires:
1. Email to 2–3 owner inboxes (stripe-webhook)
2. SMS to 1–3 owner phones (stripe-webhook)
3. Welcome email to customer (stripe-webhook)
4. Welcome SMS to customer (stripe-webhook)

= **4–7 outbound messages per paid trial.** This is the existing baseline. Any new owner-notification path stacks on top of this. **Before adding any new notification, check whether this list already covers the use case.**

---

## 2. Edge Functions — every function deployed to `uracuwugpxqjfgtuobal.supabase.co`

In `supabase/functions/`:

| Function | Purpose | Sends notifications? | Last source edit | In cron? |
|---|---|---|---|---|
| `create-trial-checkout` | Build Stripe Checkout session for /trial form | No | 2026-05-31 | No |
| `stripe-webhook` | Handle Stripe events (paid, failed, refunded) | **YES — owner email + SMS, customer email + SMS** | 2026-05-29 | No (fires per event) |
| `abandoned-cart-followup` | Email customers who didn't complete checkout | Email to customer only | 2026-05-21 | **YES** |
| `trial-convert-followup` | SMS customers with 2+ visits asking them to convert | SMS to customer; YES replies hit `twilio-inbound-sms` | 2026-05-27 | **YES — every 30 min** |
| `twilio-inbound-sms` | Receive Twilio webhook for inbound SMS | **YES — owner email on YES detection** | 2026-05-31 | No |
| `twilio-outbound-sms` | Staff-initiated SMS from /homebase | SMS to customer; logs to `sms_messages` | 2026-05-31 | No |
| `twilio-status-webhook` | Track Twilio delivery state | No | 2026-05-31 | No |
| `meta-insights-sync` | Pull Meta Ads spend/clicks/impressions | No | 2026-05-26 | **YES — every 6h** |
| `mindbody-visits-sync` | Pull MindBody class visits | No | 2026-05-26 | **YES — hourly** |
| `mindbody-sales-sync` | Pull MindBody sales | No | 2026-05-27 | No (manual) |
| `mindbody-webhook` | Receive MindBody event callbacks | No | 2026-05-16 | No |
| `mindbody-proxy` | Proxy calls to MindBody REST | No | 2026-05-16 | No |
| `mindbody-oauth-callback` | OAuth handshake | No | 2026-05-16 | No |
| `gsc-sync` | Pull Google Search Console data | No | 2026-05-30 | **YES — daily** (not yet deployed: needs OAuth secrets) |
| `vapi-calls-sync` | Pull J20 front-desk AI call records | No | 2026-05-18 | **YES — every 15 min** |
| `track-link` | Log clicks on /ig, /email, /flyer, /gbp tracked links | No | 2026-05-29 | No |
| `subscribe-newsletter` | Newsletter signup form | No | 2026-05-16 | No |
| `send-contact-email` | Contact form submissions | Email to studio + customer ack | 2026-05-27 | No |
| `get-comms-history` | API: pull SMS/email history for /homebase | No (read-only) | 2026-05-28 | No |
| `get-location-stripe-key` | API: return the per-studio Stripe key | No | 2026-05-16 | No |
| `test-gohighlevel-webhook` | Legacy probe | No | 2026-05-16 | No |
| ~~`funnel-recovery`~~ | ~~Daily digest of paid customers not in MindBody~~ | ~~Owner email — daily per studio~~ | **DELETED 2026-05-31** | **DELETED 2026-05-31** |

### Previously deployed-only functions, now in repo (audited 2026-06-01)

Pulled from `outputs/replacement-files/supabase/functions/` and committed. Audit findings below.

| Function | Cron caller | Schedule | What it sends | Owner-spam risk | Action taken |
|---|---|---|---|---|---|
| `trial-onboarding-sequence` | `trial-onboarding-sequence-hourly` | `0 * * * *` | 4-touch email sequence to **customer only** (D1 welcome, D7 check-in, D14 final-day, D17 winback). Tracks sends per row to prevent double-fire. `reply_to` = studio inbox. | None — owner not in `to:` | None needed |
| `stripe-payment-audit` | `stripe-payment-audit-30min` | `*/30 * * * *` | Safety-net for missed Stripe webhooks. For every paid PI not in trial_signups, calls `handle-paid-trial` (which fires owner email + customer welcome + CAPI). | **Was HIGH** — manual `?days=N` runs dumped N owner emails | **Default flipped to `skip_emails=true` on 2026-06-01.** Opt back in with `?skip_emails=false` for rare manual re-fires. |
| `funnel-recovery` | none (cron killed 2026-05-31) | n/a | `?action=promote_orphans` triggers welcome+owner-email per orphan. `?action=studio_digest` emails per-studio TRIAL_NOTIFY list of unmatched customers. | **HIGH** — caused the 2026-05-31 BBB Recovery digest spam | **Hard-killed 2026-06-01:** requires `BBB_RECOVERY_ENABLED=true` env var + `dry_run` is now default. Even an authenticated call with the secret no-ops unless both gates are open. |
| `winback-fire` | `winback-fire-oneshot` | `0 14 19 5 *` (already fired May 19) | One-shot bulk send to lapsed members from `winback_sends` table. **Customer only.** `reply_to` = studio inbox. | None — owner not in `to:` | None needed |
| `winback-followup` | `winback-followup-daily` | `0 14 * * *` (currently paused) | D3 + D7 follow-ups to original winback recipients. Skips replies/conversions/opt-outs. **Customer only.** | None — owner not in `to:` | Leave paused until business decides to resume |

### Still in `replacement-files/`, not yet copied to repo (lower priority)

Listed for future-me: `backfill-capi-purchases`, `backfill-location-emails`, `handle-paid-trial`, `mindbody-trial-sync`, `trial-onboarding-sms`, `studio-analytics`. Risk profile unknown without source — none currently on a cron we've observed firing in /ops.

### Other deployed-only crons that DO NOT email owners

| Job | Calls | Risk |
|---|---|---|
| `bbb_meta_insights_sync` | `/meta-insights-sync` (in repo) | None — pulls Meta data, no notifications |
| `refresh_dashboard_kpis_5min` | `public.refresh_dashboard_kpis()` (SQL function) | **Was failing every 5min until 2026-06-01 fix migration.** Now uses only existing columns. |

---

## 3. Cron jobs (pg_cron) — every scheduled task

Listed in execution order. Query against `cron.job` to confirm what's actually scheduled:

```sql
SELECT jobid, jobname, schedule, command, active
FROM cron.job
ORDER BY jobid;
```

| Job | Schedule | Function called | Owner-facing? |
|---|---|---|---|
| `mindbody-visits-sync-hourly` | `0 * * * *` (hourly) | `mindbody-visits-sync` | No |
| `meta-insights-sync-6h` | every 6h | `meta-insights-sync` | No |
| `trial-convert-followup-30min` | `*/30 * * * *` | `trial-convert-followup` | **Indirectly — YES replies cascade to owner email** |
| `vapi-calls-sync-15min` | every 15 min | `vapi-calls-sync` | No |
| `gsc-sync-daily` | daily | `gsc-sync` | No (not yet running pending OAuth secrets) |
| `abandoned-cart-followup-*` | daily-ish | `abandoned-cart-followup` | No (customer only) |
| ~~`funnel-recovery-daily`~~ | ~~daily~~ | ~~`funnel-recovery`~~ | **DELETED 2026-05-31** |

**To kill any cron job in a hurry:**
```sql
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = '<name>';
-- or by command match if jobname unknown:
SELECT cron.unschedule(jobid) FROM cron.job WHERE command ILIKE '%<function-name>%';
```

---

## 4. Owner notification recipients (the actual inboxes & phones)

### Email — `TRIAL_NOTIFY` in `stripe-webhook/index.ts` and `twilio-inbound-sms/index.ts`

| Studio | Recipients |
|---|---|
| bayside | carlos@betterbodybootcamp.com, bayside@betterbodybootcamp.com |
| fresh-meadows | carlos@betterbodybootcamp.com, freshmeadows@betterbodybootcamp.com |
| williamsburg | steve@betterbodybootcamp.com, chris@betterbodybootcamp.com, williamsburg@betterbodybootcamp.com |
| astoria | steve@betterbodybootcamp.com, chris@betterbodybootcamp.com, astoria@betterbodybootcamp.com |

**These lists are duplicated in two places.** If you change them, change both — and at some point we should move them to a `notification_recipients` table queried at runtime.

### SMS — `location_owners` table, WHERE `notify_signups = true`

Seeded in migration `20260527_location_owners.sql`. Query to see current:
```sql
SELECT l.name AS studio, lo.owner_name, lo.phone, lo.notify_signups
FROM location_owners lo
JOIN locations l ON l.id = lo.location_id
WHERE lo.notify_signups = true
ORDER BY l.name;
```

To temporarily silence one owner's SMS without breaking the path:
```sql
UPDATE location_owners SET notify_signups = false WHERE phone = '<E.164 number>';
```

---

## 5. Change-control rules (the rule that would have stopped funnel-recovery)

1. **Every edge function must be committed to git before deploy.** No "I'll commit it later." `funnel-recovery` was deployed without git commit, became invisible to this ledger, and nobody could find it when it started spamming.
2. **Any new function that emails or texts an owner must add a row to section 1 of this ledger in the same PR.**
3. **Any new cron job must be added to section 3 in the same migration that creates it.**
4. **Before adding a new owner notification:** count how many already fire on the same event (see section 1, "How the cascade works"). If the event already triggers N notifications, the answer is to consolidate, not add the N+1th.
5. **At session start:** read this file. If anything in section 1, 2, or 3 has drifted from reality, fix the ledger before doing anything else.

---

## 6. Known structural risks (not yet fixed)

- **Notification recipients hardcoded in two files** — `TRIAL_NOTIFY` lives in `stripe-webhook` and `twilio-inbound-sms`. Should move to `notification_recipients` table.
- **No staging environment** — every deploy is to production. The funnel-recovery incident hit four real gym owners because there's nowhere to dry-run.
- **No notification rate limit** — a function in a tight loop (or a Stripe webhook replay) can fire arbitrarily many emails/SMS. Should add a per-recipient daily cap.
- **Convert SMS YES-detection is loose** — matches OK/Y/YEP/YUP/SURE. A customer texting "ok thanks" sends an "🔥 Convert YES" email to all owners. Tighten the match before re-enabling that path.
