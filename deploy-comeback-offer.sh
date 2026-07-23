#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy the full $29 / 1-Week Comeback Offer flow.
#
# Stripe products + prices were already created via API on 2026-06-11.
# This script ships:
#   1. Migration: locations.stripe_comeback_price_id + trial_signups tracking
#      columns + comeback_funnel_v view + source_category constraint
#   2. Edge Function: comeback-offer-cron (SMS first, email 3 days later)
#   3. Re-deploy: create-trial-checkout (adds 'comeback' variant)
#   4. Re-deploy: stripe-webhook (stamps comeback_converted_at on conversion)
#   5. Migration: schedule comeback-offer-cron hourly
#   6. Front-end: deploy /comeback/[studio] route via Netlify
#   7. Dry-run smoke test
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"
PROJECT="uracuwugpxqjfgtuobal"
SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2-)"

echo "━━━ 1/7 · Schema migration · price IDs + tracking columns ━━━"
cat supabase/migrations/20260611_comeback_offer_29.sql | pbcopy
echo "  ✓ SQL on clipboard. Paste, Run."
open "https://supabase.com/dashboard/project/${PROJECT}/sql/new"
read -p "  Press ENTER after migration shows 'Success' (verify SELECT shows all 4 stripe_comeback_price_id populated)… "
echo ""

echo "━━━ 2/7 · Deploy comeback-offer-cron Edge Function ━━━"
supabase functions deploy comeback-offer-cron --no-verify-jwt --project-ref "$PROJECT"
echo "  ✓ Deployed"
echo ""

echo "━━━ 3/7 · Re-deploy create-trial-checkout (now supports 'comeback' variant) ━━━"
supabase functions deploy create-trial-checkout --no-verify-jwt --project-ref "$PROJECT"
echo "  ✓ Deployed"
echo ""

echo "━━━ 4/7 · Re-deploy stripe-webhook (stamps comeback_converted_at) ━━━"
supabase functions deploy stripe-webhook --no-verify-jwt --project-ref "$PROJECT"
echo "  ✓ Deployed"
echo ""

echo "━━━ 5/7 · Install hourly cron ━━━"
cat supabase/migrations/20260611_schedule_comeback_offer_cron.sql | pbcopy
echo "  ✓ Cron SQL on clipboard. ⌘A → ⌫ → ⌘V → Run in same editor."
read -p "  Press ENTER after cron registers (final SELECT shows comeback-offer-hourly active)… "
echo ""

echo "━━━ 6/7 · Deploy front-end (adds /comeback/[studio] route) ━━━"
cd "$HOME/Desktop/betterbodybootcamp-site"
npm run build
netlify deploy --prod --dir=dist --message="$29 Comeback offer: route + form + tracking"
echo "  ✓ Deployed"
echo ""

echo "━━━ 7/7 · Dry-run smoke test ━━━"
curl -sS -X POST "https://${PROJECT}.supabase.co/functions/v1/comeback-offer-cron" \
  -H "Authorization: Bearer $SRK" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true}' --max-time 40 \
  | python3 - <<'PYEOF'
import json, sys
d = json.load(sys.stdin)
if d.get('error'):
    print(f"  ERROR: {d.get('error')} — {d.get('message','')[:200]}")
else:
    print(f"  Eligible candidates:           {d.get('processed', 0)}")
    print(f"  WOULD send SMS:                {d.get('sent_sms', 0)}")
    print(f"  WOULD send email (3d branch):  {d.get('sent_email', 0)}")
    print(f"  Skipped (already paid/member): {d.get('skipped_already_paid_or_member', 0)}")
    print(f"  Skipped (neither yet due):     {d.get('skipped_neither_due', 0)}")
PYEOF
echo ""

echo "━━━ DONE ━━━"
echo "  /comeback/astoria        · https://betterbodybootcamp.com/comeback/astoria"
echo "  /comeback/bayside        · https://betterbodybootcamp.com/comeback/bayside"
echo "  /comeback/fresh-meadows  · https://betterbodybootcamp.com/comeback/fresh-meadows"
echo "  /comeback/williamsburg   · https://betterbodybootcamp.com/comeback/williamsburg"
echo ""
echo "  Inspect dashboard funnel: SELECT * FROM public.comeback_funnel_v ORDER BY original_abandoned_at DESC LIMIT 20;"
echo "  Inspect cron history:     SELECT * FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname='comeback-offer-hourly') ORDER BY start_time DESC LIMIT 10;"
echo "  Re-fire manually (live):  curl -X POST .../comeback-offer-cron -H \"Authorization: Bearer \$SRK\" -d '{}'"
