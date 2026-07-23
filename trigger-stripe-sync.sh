#!/usr/bin/env bash
# Manually trigger sync-stripe-paid-mirror to pull today's paid trials from
# every studio's Stripe account into the dashboard's source-of-truth mirror.
# After this runs, FM should show Yaritza Pachon and the dashboard "Today"
# tile should tick up.
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ]; then
  echo "Paste your SUPABASE_SERVICE_ROLE_KEY:"
  read -rs SRK
  echo ""
fi

echo ""
echo "━━━ Triggering sync-stripe-paid-mirror (pulls last 24h from each studio) ━━━"
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-stripe-paid-mirror" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SRK" \
  -d '{}' | python3 -m json.tool

echo ""
echo "━━━ Verifying: FM rows in stripe_paid_mirror since today 00:00 UTC ━━━"
curl -s "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?studio_slug=eq.fresh-meadows&paid_at=gte.2026-06-09T00:00:00&select=customer_name,customer_email,paid_at&order=paid_at.desc" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" | python3 -m json.tool

echo ""
echo "✅ If Yaritza appears above, refresh the dashboard — FM should show 1 paid today."
echo "   If she's STILL missing, the sync skipped her — paste the output and we'll dig."
