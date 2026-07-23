#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy Source of Truth — reclass 8 direct-membership buyers + add canonical
# get_source_of_truth RPC + patch v_paid_trials_with_path to honor the new
# is_paid_trial_row predicate.
#
# After this runs:
#   • Paid-trial counts drop by 8 network-wide (Astoria -1, WB -2, FM -5, BS 0)
#   • Those 8 customers still appear on Converted Members
#   • /ops gets a Source of Truth card showing the canonical per-studio numbers
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"

echo "━━━ 1/3 · Copy migration to clipboard + open SQL editor ━━━"
cat supabase/migrations/20260610_source_of_truth.sql | pbcopy
echo "  ✓ SQL on clipboard"
open "https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
echo ""
echo "  In SQL editor: ⌘A → Delete → ⌘V → Run."
echo "  Expected final SELECT result rows:"
echo "    astoria        paid_trials_total=41  direct_members=1"
echo "    williamsburg   paid_trials_total=40  direct_members=2"
echo "    fresh-meadows  paid_trials_total=15  direct_members=5"
echo "    bayside        paid_trials_total= 8  direct_members=0"
echo ""
read -p "  Press ENTER after migration shows 'Success' in SQL editor… "

echo ""
echo "━━━ 2/3 · Verify reclass worked ━━━"
python3 << 'PY'
import json, urllib.request
SRK = open('.env').read()
SRK = [l.split('=',1)[1] for l in SRK.splitlines() if l.startswith('SUPABASE_SERVICE_ROLE_KEY=')][0]
URL = 'https://uracuwugpxqjfgtuobal.supabase.co'
H = {'apikey': SRK, 'Authorization': f'Bearer {SRK}'}

# Call get_source_of_truth
req = urllib.request.Request(f'{URL}/rest/v1/rpc/get_source_of_truth',
    data=b'{}', headers={**H,'Content-Type':'application/json'}, method='POST')
data = json.loads(urllib.request.urlopen(req).read())

print(f"{'Studio':14}{'Trials':>8}{'Stripe':>8}{'POS':>6}{'Direct':>8}{'Conv':>6}{'Members':>9}{'MemRev':>11}{'OnSheet':>10}")
print('─' * 80)
for r in data:
    print(f"{r['studio_slug']:14}{r['paid_trials_total']:>8}{r['paid_trials_stripe']:>8}{r['paid_trials_mb_pos']:>6}{r['direct_members']:>8}{r['converted_members']:>6}{r['total_members']:>9}  ${float(r['member_rev_annualized']):>7.0f}  {r['trials_on_sheet']}/{r['paid_trials_total']:>3}")

# Network totals
T = lambda k: sum(r[k] for r in data)
print('─' * 80)
print(f"{'NETWORK':14}{T('paid_trials_total'):>8}{T('paid_trials_stripe'):>8}{T('paid_trials_mb_pos'):>6}{T('direct_members'):>8}{T('converted_members'):>6}{T('total_members'):>9}  ${sum(float(r['member_rev_annualized']) for r in data):>7.0f}  {T('trials_on_sheet')}/{T('paid_trials_total')}")
PY

echo ""
echo "━━━ 3/3 · Next ━━━"
echo "  ▸ /ops Source of Truth card is wired (live as soon as ops.html deploys)"
echo "  ▸ Bottom Line + Studio-by-Studio cards on /dashboard will reflect the"
echo "    reclass too (via v_paid_trials_with_path view update)"
echo ""
echo "  Deploy front-end (Netlify auto-publishes from main):"
echo "    cd ~/Desktop/bbb-marketing"
echo "    git add ops.html index.html"
echo "    git commit -m 'Source of Truth card on /ops + reclass 8 direct-membership buyers'"
echo "    git push"
