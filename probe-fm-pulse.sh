#!/usr/bin/env bash
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"
SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ]; then echo "Paste SUPABASE_SERVICE_ROLE_KEY:"; read -rs SRK; echo ""; fi

echo ""
echo "━━━ A · get_daily_pulse live RPC for FM ━━━"
echo "    (this is exactly what the dashboard tile calls)"
echo ""
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_daily_pulse" \
  -H "Content-Type: application/json" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -d '{"p_studio":"fresh-meadows"}' | python3 -m json.tool

echo ""
echo "━━━ B · count_paid_canonical live RPC for FM today ━━━"
echo ""
TODAY_ET=$(TZ='America/New_York' date '+%Y-%m-%d')
echo "  ET today = $TODAY_ET"
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/count_paid_canonical" \
  -H "Content-Type: application/json" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -d "{\"p_studio\":\"fresh-meadows\",\"p_since\":\"${TODAY_ET}\",\"p_until\":\"${TODAY_ET}\"}" | python3 -m json.tool

echo ""
echo "━━━ C · Raw stripe_paid_mirror — every FM row paid today (ET) ━━━"
echo ""
curl -s "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?studio_slug=eq.fresh-meadows&paid_at=gte.${TODAY_ET}T04:00:00&select=customer_name,customer_email,paid_at,studio_slug" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" | python3 -m json.tool

echo ""
echo "━━━ INTERPRETATION ━━━"
echo "If A.today.paid >= 1   → RPC is correct; hard-refresh dashboard (Cmd+Shift+R)"
echo "If A.today.paid = 0    → real bug; B + C show where to fix it"
echo "If B = 1 but A = 0     → bug is in get_daily_pulse's call to canonical (date math)"
echo "If C empty but mirror previously had her → row got deleted (Stripe refund? cleanup?)"
