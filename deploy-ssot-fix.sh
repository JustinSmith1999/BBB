#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Single source of truth + auto-link sweep
#   1. Auto-link sweep:  re-runs mindbody-create-trial-client over every
#      paid trial since launch. Resolves the customers MB recognizes via
#      phone/email lookup; the rest will fail until Carlos flips AddClient
#      permission (#217), and front desk handles them via the new
#      /homebase → Unlinked view.
#   2. SSOT migration:   copies the SQL to clipboard so you can paste +
#      run it in the Supabase SQL editor. Switches
#      get_audience_comparison_all_studios.total_paid_real to read from
#      stripe_paid_mirror DISTINCT customer_email — same source as
#      get_ad_spend_vs_revenue. Studio-by-studio and Trial→Member will
#      now agree on every paid-trial count.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ] || [ "$SRK" = "PASTE-YOUR-KEY-HERE" ]; then
  echo "Paste SUPABASE_SERVICE_ROLE_KEY:"; read -rs SRK; echo ""
fi

echo ""
echo "━━━ 1/3 · Auto-link sweep — every unlinked paid trial since launch ━━━"
echo "    Runs in the background and may take 60-90s — calling MB API per"
echo "    customer. Stays on screen so you can see who linked + who failed."
echo ""
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-create-trial-client" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SRK" \
  --max-time 180 \
  -d '{"since":"2026-05-15T00:00:00Z"}' \
  | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception as e:
  print(f'  curl/parse error: {e}')
  sys.exit(0)
print(f'  processed={d.get(\"processed\")}  created={d.get(\"created\")}  failed={d.get(\"failed\")}')
print()
created = [r for r in (d.get('results') or []) if r.get('status') == 'created']
failed  = [r for r in (d.get('results') or []) if r.get('status') == 'failed']
if created:
  print('  --- LINKED ---')
  for r in created:
    print(f'   ✓ {r.get(\"studio\",\"?\"):15} {r.get(\"email\",\"?\"):35}  MB ID {r.get(\"mindbody_id\",\"?\")}')
  print()
print(f'  --- STILL UNLINKED ({len(failed)}, need manual creation via /homebase → Unlinked) ---')
for r in failed[:8]:
  reason = (r.get('reason') or '').split('\\\\n')[0][:70]
  print(f'   · {r.get(\"studio\",\"?\"):15} {r.get(\"email\",\"?\"):35} {reason}')
if len(failed) > 8:
  print(f'   ... + {len(failed) - 8} more')
"

echo ""
echo "━━━ 2/3 · SSOT migration — copy to clipboard ━━━"
echo "    Path: supabase/migrations/20260609_ssot_paid_trials_canonical.sql"
echo ""
cat supabase/migrations/20260609_ssot_paid_trials_canonical.sql | pbcopy
echo "  ✓ Migration SQL copied to clipboard"
echo ""
echo "  → Open: https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
echo "    Paste, click Run. The two probes at the bottom will show ✓ on every"
echo "    row when the audience-comparison and ad-spend RPCs agree."
echo ""

echo "━━━ 3/3 · After running the SQL, verify with this read-only query ━━━"
echo ""
read -p "Press Enter once you've run the SQL in Supabase..." _

curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_audience_comparison_all_studios" \
  -H "Content-Type: application/json" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -d '{"p_since":"2026-05-15"}' > /tmp/aud.json

curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_ad_spend_vs_revenue" \
  -H "Content-Type: application/json" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -d '{"p_since":"2026-05-15"}' > /tmp/adroi.json

python3 <<'PY'
import json
with open('/tmp/aud.json') as f: aud = json.load(f)
with open('/tmp/adroi.json') as f: adroi = json.load(f)
adroi_by_slug = {r['studio_slug']: r for r in adroi}
print()
print(f"  {'Studio':<15} {'Audience RPC':>12} {'AdROI RPC':>12} {'Match':>10}")
print(f"  {'-'*15} {'-'*12} {'-'*12} {'-'*10}")
tot_aud = 0; tot_adroi = 0
for r in sorted(aud, key=lambda x: x['studio_slug']):
  a = int(r['total_paid_real'] or 0)
  b = int((adroi_by_slug.get(r['studio_slug']) or {}).get('trial_count', 0) or 0)
  tot_aud += a; tot_adroi += b
  tag = '✓' if a == b else '✗'
  print(f"  {r['studio_slug']:<15} {a:>12} {b:>12} {tag:>10}")
print(f"  {'-'*15} {'-'*12} {'-'*12} {'-'*10}")
print(f"  {'TOTAL':<15} {tot_aud:>12} {tot_adroi:>12} {'✓' if tot_aud == tot_adroi else '✗ MISMATCH':>10}")
print()
if tot_aud == tot_adroi:
  print("  Studio-by-studio + Trial→Member cards will now show identical paid totals.")
  print("  Hard-refresh the dashboard (Cmd+Shift+R) to see the unified numbers.")
else:
  print("  Mismatch remains — paste output and we'll dig deeper.")
PY

echo ""
echo "═════════════════════════════════════════════════════════════════════"
echo " Done. Both dashboard cards now read paid trials from the same"
echo " canonical source (stripe_paid_mirror DISTINCT customer_email)."
echo "═════════════════════════════════════════════════════════════════════"
