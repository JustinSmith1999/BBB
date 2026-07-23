#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy mindbody-capi-purchase-sync — the long-term fix for the in-person
# CAPI signal gap that caused today's WB delivery collapse.
#
# 1. Deploy the Edge Function
# 2. Run it once in dry-run mode so you can see what it WOULD send tomorrow
# 3. Install the pg_cron entry (08:15 UTC = 04:15 ET daily)
# 4. Verify the cron job is registered
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
PROJECT="uracuwugpxqjfgtuobal"

echo "━━━ 1/4 · Deploy mindbody-capi-purchase-sync ━━━"
supabase functions deploy mindbody-capi-purchase-sync \
  --no-verify-jwt \
  --project-ref "$PROJECT"
echo "  ✓ Deployed"
echo ""

echo "━━━ 2/4 · Dry-run preview (no actual sends) ━━━"
curl -sS -X POST "https://${PROJECT}.supabase.co/functions/v1/mindbody-capi-purchase-sync" \
  -H "Authorization: Bearer $SRK" \
  -H "Content-Type: application/json" \
  -d '{"lookback_hours": 48, "dry_run": true}' \
  --max-time 60 \
  > /tmp/mb-capi-dryrun.json
python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/mb-capi-dryrun.json'))
results = d.get('results') or []
would_p = sum(1 for r in results if r.get('event_name')=='Purchase'  and r.get('status')=='dry_run')
would_s = sum(1 for r in results if r.get('event_name')=='Subscribe' and r.get('status')=='dry_run')
print("  processed:            ", d.get('processed', 0))
print("  WOULD send Purchase:  ", would_p)
print("  WOULD send Subscribe: ", would_s)
print("  skipped (already fired today):", d.get('skipped_already_fired', 0))
print("  skipped (no email on client): ", d.get('skipped_no_email', 0))
print("  skipped (not eligible):       ", d.get('skipped_not_eligible', 0))
if d.get('error'):
    print("  ERROR:", d.get('error'), d.get('message','')[:200])
PYEOF
echo ""

echo "━━━ 3/4 · Install pg_cron entry ━━━"
cat supabase/migrations/20260611_schedule_mb_capi_purchase_sync.sql | pbcopy
echo "  ✓ SQL on clipboard. Opening SQL editor — paste, Run."
open "https://supabase.com/dashboard/project/${PROJECT}/sql/new"
read -p "  Press ENTER after SQL shows 'Success' (final SELECT will print the new cron row)… "
echo ""

echo "━━━ 4/4 · Smoke test — fire one real run live ━━━"
curl -sS -X POST "https://${PROJECT}.supabase.co/functions/v1/mindbody-capi-purchase-sync" \
  -H "Authorization: Bearer $SRK" \
  -H "Content-Type: application/json" \
  -d '{"lookback_hours": 24}' \
  --max-time 60 \
  > /tmp/mb-capi-smoke.json
python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/mb-capi-smoke.json'))
print("  processed:        ", d.get('processed', 0))
print("  sent Purchase:    ", d.get('sent_purchase', 0))
print("  sent Subscribe:   ", d.get('sent_subscribe', 0))
print("  already fired:    ", d.get('skipped_already_fired', 0))
print("  failed:           ", d.get('failed', 0))
if d.get('error'):
    print("  ERROR:", d.get('error'), d.get('message','')[:200])
PYEOF
echo ""

echo "━━━ DONE ━━━"
echo "  The cron will run at 04:15 ET nightly (08:15 UTC)."
echo "  Inspect runs:  SELECT * FROM cron.job WHERE jobname='\''mindbody-capi-purchase-sync'\'';"
echo "  Inspect history: SELECT * FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname='\''mindbody-capi-purchase-sync'\'') ORDER BY start_time DESC LIMIT 10;"
echo "  Inspect CAPI:  SELECT * FROM capi_events WHERE event_id LIKE '\''mb_%'\'' ORDER BY attempted_at DESC LIMIT 20;"
