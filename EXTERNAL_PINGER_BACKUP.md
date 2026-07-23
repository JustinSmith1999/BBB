# External Pinger Backup Setup (5 minutes, free)

Insurance policy in case pg_net stays unreliable. Set this up once; it can sit dormant. If a pg_cron job goes silent again, this takes over instantly with zero code change on our side.

## Why

pg_cron + pg_net = silent failures we can't see. Our orchestrator function bypasses most of this by making pg_net handle ONE call per cron instead of 20+, but if pg_net dies completely (which it has 3+ times today), an external scheduler keeps the syncs alive.

## Service: cron-job.org (free, reliable, no signup card)

1. Go to https://console.cron-job.org/
2. Sign up with Justin's email (free tier covers up to 50 cron jobs per account; we need 5)
3. For each of the 5 entries below, click **Create cronjob**:

### Job 1 · sync-orch-every5
- **Title:** `BBB sync-orch · every 5 min`
- **URL:** `https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-orchestrator`
- **Schedule:** Every 5 minutes (built-in option in cron-job.org)
- **Request method:** POST
- **Headers:** add header `Authorization` with value `Bearer <SUPABASE_SERVICE_ROLE_KEY>`
- **Headers:** add header `Content-Type` with value `application/json`
- **Request body:** `{"tier":"every5"}`
- **Treat redirects as success:** off
- **Notifications:** "Notify on failure" → email Justin (Settings → Notifications)

### Job 2 · sync-orch-every10
Same as Job 1, but:
- **Title:** `BBB sync-orch · every 10 min`
- **Schedule:** Every 10 minutes
- **Request body:** `{"tier":"every10"}`

### Job 3 · sync-orch-every15
Same as Job 1, but:
- **Title:** `BBB sync-orch · every 15 min`
- **Schedule:** Every 15 minutes
- **Request body:** `{"tier":"every15"}`

### Job 4 · sync-orch-every30
Same as Job 1, but:
- **Title:** `BBB sync-orch · every 30 min`
- **Schedule:** Every 30 minutes
- **Request body:** `{"tier":"every30"}`

### Job 5 · sync-orch-hourly
Same as Job 1, but:
- **Title:** `BBB sync-orch · hourly`
- **Schedule:** Every 1 hour
- **Request body:** `{"tier":"hourly"}`

## What you get for $0

- Every job's last-run status visible in cron-job.org dashboard
- Email notification on any failure
- Each job's last response body saved for 30 days (history visible in their UI)
- Total dashboard view of all 5 jobs at a glance
- Failover: if pg_cron is alive, both fire (orchestrator is idempotent — duplicate calls just hit the same idempotency guards in the downstream functions). If pg_cron dies, this is your only source of truth.

## How to verify it's working

After setting up:
1. Wait 5 minutes
2. Click on Job 1's history → should see "200 OK" responses
3. Check `meta_ad_insights_daily.synced_at` in your DB — should be < 5 min ago and updating every 5 min forever

## When to delete the pg_cron jobs

If cron-job.org runs reliably for 7 days with no failures and your DB never goes stale, you can delete the Supabase-side cron jobs entirely. That removes the pg_cron + pg_net surface area as a failure mode permanently.

For now: keep both running. Redundancy is cheap.
