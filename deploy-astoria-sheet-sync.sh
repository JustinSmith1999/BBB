#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy multi-studio sheet sync — Astoria + WB + FM + Bayside
#   1. Deploy sheet-sync-astoria Edge Function (handles all 4 studios)
#   2. Paste SQL migration (table + reconciliation RPC) into editor
#   3. Run initial sync for all 4
#   4. Verify per-studio
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"

echo "━━━ 1/4 · Deploy sheet-sync-astoria Edge Function ━━━"
npx -y supabase@latest functions deploy sheet-sync-astoria \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ 2/4 · Copy migration to clipboard + open Supabase SQL editor ━━━"
MIG="supabase/migrations/20260610_astoria_sheet_sync.sql"
cat "$MIG" | pbcopy
echo "  ✓ Migration SQL copied to clipboard"
echo "  Opening Supabase SQL editor — paste (⌘V) and Run"
open "https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
echo ""
read -p "  Press ENTER after the migration shows 'Success' in the SQL editor… "

echo ""
echo "━━━ 3/4 · Run initial sync for all 4 studios ━━━"
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sheet-sync-astoria" \
  -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
  --max-time 60 -d '{}' | python3 -m json.tool

echo ""
echo "━━━ 4/4 · Reconciliation breakdown per studio ━━━"
for STUDIO in astoria williamsburg fresh-meadows bayside; do
  echo ""
  echo "  ▸ $STUDIO"
  curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_sheet_vs_db_reconciliation" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
    -d "{\"p_studio\":\"$STUDIO\"}" \
    | python3 -c "
import json,sys
from collections import Counter
rows = json.load(sys.stdin)
print(f'    Sheet entries since launch: {len(rows)}')
verdicts = Counter(r['drift_verdict'] for r in rows)
for v, n in verdicts.most_common():
    print(f'      {v:10}  {n}')
pending = [r for r in rows if r['drift_verdict'] == 'pending']
if pending:
    print(f'    PENDING (sheet ahead of MB):')
    for r in pending[:10]:
        sold = r.get('membership_sold_label') or 'Joined Y'
        val = r.get('membership_value_usd')
        print(f\"      {r['start_date']}  {(r['prospect_name'] or '?'):28}  {sold[:22]:22}  \${val or 0:.0f}\")
"
done

echo ""
echo ""
echo "━━━ Schedule hourly cron (one-time) ━━━"
echo "  In Supabase SQL editor, run:"
echo ""
echo "    SELECT cron.schedule("
echo "      'sheet-sync-hourly',"
echo "      '0 * * * *',"
echo "      \$\$ SELECT net.http_post("
echo "        url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/sheet-sync-astoria',"
echo "        headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT secret FROM vault.secrets WHERE name='service_role_jwt'))"
echo "      ); \$\$"
echo "    );"
