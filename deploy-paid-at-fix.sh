#!/usr/bin/env bash
# Deploy sync-stripe-paid-mirror with the paid_at=charge.created fix,
# then re-pull the last 30 days from Stripe so every existing row gets
# its paid_at corrected (upsert on stripe_payment_intent_id).
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ] || [ "$SRK" = "PASTE-YOUR-KEY-HERE" ]; then
  echo "Paste your SUPABASE_SERVICE_ROLE_KEY:"
  read -rs SRK
  echo ""
  # Replace placeholder/empty line in .env
  if grep -q '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null; then
    # macOS sed in-place
    sed -i '' "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$SRK|" .env
  else
    echo "SUPABASE_SERVICE_ROLE_KEY=$SRK" >> .env
  fi
fi

q() { curl -s "$1" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"; }

echo ""
echo "━━━ Step 1/4 · Deploy patched sync-stripe-paid-mirror ━━━"
echo ""
npx -y supabase@latest functions deploy sync-stripe-paid-mirror \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ Step 2/4 · Full 30-day backfill (hours=720) ━━━"
echo "    Re-pulls every PI since ~May 10. Upsert will overwrite paid_at"
echo "    with charge.created (the actual succeeded-at). Slow — ~1-2 min."
echo ""
curl -s -X POST \
  "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sync-stripe-paid-mirror?hours=720&since=2026-05-15" \
  -H "Authorization: Bearer $SRK" \
  -H "Content-Type: application/json" | python3 -m json.tool

echo ""
echo "━━━ Step 3/4 · Verify Yaritza's paid_at is now correct ━━━"
echo "    Expected: 2026-06-09T15:45:28+00:00 (was 2026-06-09T01:07:15)"
echo ""
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?customer_email=eq.yaritkeit@gmail.com&select=customer_name,paid_at,stripe_payment_intent_id" \
  | python3 -m json.tool

echo ""
echo "━━━ Step 4/4 · Re-run FM pulse probe ━━━"
echo ""
TODAY_ET=$(TZ='America/New_York' date '+%Y-%m-%d')

echo "── get_daily_pulse for FM (what the dashboard tile reads) ──"
curl -s -X POST \
  "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_daily_pulse" \
  -H "Content-Type: application/json" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -d '{"p_studio":"fresh-meadows"}' | python3 -m json.tool

echo ""
echo "── Raw mirror — every FM row paid today ET ($TODAY_ET) ──"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?studio_slug=eq.fresh-meadows&paid_at=gte.${TODAY_ET}T04:00:00&select=customer_name,paid_at" \
  | python3 -m json.tool

echo ""
echo "═════════════════════════════════════════════════════════════════════"
echo " If Yaritza's paid_at = 15:45:28 above → fix worked. Hard-refresh"
echo " /homebase (Cmd+Shift+R) and the FM 'Today' tile flips to 1 Paid."
echo ""
echo " The fix is also live for all future signups — sync will write"
echo " charge.created (succeeded-at) instead of pi.created (started-at)."
echo "═════════════════════════════════════════════════════════════════════"
