#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy Pending Contracts card + 5-min cron cadence
#   1. Deploy updated sheet-sync-astoria edge function (extracts contract_signed)
#   2. Run migration that adds contract_signed col + get_pending_contracts RPC
#   3. Run migration that schedules 5-min syncs for everything
#   4. Verify pending contracts surface
#   5. Push front-end with new /ops card
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"

echo "━━━ 1/5 · Deploy updated sheet-sync-astoria (extracts contract_signed) ━━━"
npx -y supabase@latest functions deploy sheet-sync-astoria \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ 2/5 · Run Pending Contracts migration ━━━"
cat supabase/migrations/20260610_pending_contracts.sql | pbcopy
echo "  ✓ SQL on clipboard. Opening SQL editor — paste, Run."
open "https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
read -p "  Press ENTER after migration shows 'Success'… "

echo ""
echo "━━━ 3/5 · Run 5-min cron schedules migration ━━━"
cat supabase/migrations/20260610_5min_cron_all_syncs.sql | pbcopy
echo "  ✓ SQL on clipboard. Same SQL editor — ⌘A → Delete → ⌘V → Run."
read -p "  Press ENTER after migration shows 'Success'… "

echo ""
echo "━━━ 4/5 · Force-sync sheets + verify Pending Contracts surface ━━━"
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sheet-sync-astoria" \
  -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
  --max-time 60 -d '{}' | python3 -m json.tool | head -30

echo ""
echo "Pending contracts right now:"
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_pending_contracts" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -d '{}' \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
if isinstance(data, dict): print(f'  error: {data}'); exit()
print(f'  Total: {len(data)}')
by_status = {}
total_value = 0
for r in data:
    by_status[r['status']] = by_status.get(r['status'], 0) + 1
    if r['status'] != 'lead_open':
        total_value += float(r.get('membership_value_usd') or 0)
for s, n in sorted(by_status.items()):
    print(f'    {s:20}  {n}')
print(f'  Total at risk: \${total_value:,.0f}')
print()
for r in data[:10]:
    print(f\"    [{r['studio_slug']:14}] {(r['customer_name'] or '?')[:24]:24}  {(r['membership_sold'] or '—')[:24]:24}  \${r.get('membership_value_usd') or 0:.0f}  trial_ends={r['trial_end_date']}  status={r['status']}\")
"

echo ""
echo "━━━ 5/5 · Push front-end (ops.html + index.html) ━━━"
echo "  Run:"
echo ""
echo "    cd ~/Desktop/bbb-marketing"
echo "    netlify deploy --prod --dir=. --message='Pending Contracts on /ops + /dashboard'"
echo ""
echo "  After ~60s:"
echo "    • https://betterbodybootcamp.com/ops      — Pending Contracts card at top"
echo "    • https://betterbodybootcamp.com/dashboard — Pending Contracts card on each"
echo "      studio + network overview (hidden when empty). Customers auto-vanish"
echo "      from this card the moment their MB contract is entered + first month bills."
