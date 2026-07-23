#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# All-in-one consistency fix:
#   #230 — get_audience_comparison_all_studios → reads stripe_paid_mirror
#   #231 — list orphan stripe_paid_mirror rows (no matching trial_signups)
#          so you can backfill or manually inspect
#   #232 — audit Bayside's 2 "converted members" → what they actually bought
# ─────────────────────────────────────────────────────────────────────────────
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ]; then
  echo "Paste your SUPABASE_SERVICE_ROLE_KEY:"
  read -rs SRK
  echo ""
fi

q() { curl -s "$1" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"; }
SINCE="2026-05-15"

echo ""
echo "━━━ #230 · Migration SQL ready — paste in Supabase SQL editor ━━━"
echo ""
echo "Path: supabase/migrations/20260609_audience_comparison_stripe_ssot.sql"
echo ""
echo "Open: https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
echo "Then paste contents + run."
echo ""
cat supabase/migrations/20260609_audience_comparison_stripe_ssot.sql | pbcopy
echo "  ✓ Migration SQL copied to clipboard"
echo ""

echo ""
echo "━━━ #231 · Orphan stripe_paid_mirror rows (in mirror but not trial_signups) ━━━"
echo ""
echo "  These are the 6 paid customers the dashboard is missing."
echo "  Each row is real money from Stripe; trial_signups insert failed for them."
echo ""
# Find stripe_paid_mirror rows since launch whose customer_email doesn't exist
# in trial_signups (completed, since launch, not deleted).
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?paid_at=gte.${SINCE}T00:00:00&select=studio_slug,customer_name,customer_email,paid_at,stripe_charge_id&order=paid_at.asc" \
  > /tmp/spm_rows.json
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?payment_date=gte.${SINCE}T00:00:00&payment_status=eq.completed&deleted_at=is.null&select=email" \
  > /tmp/ts_emails.json

python3 <<'PY'
import json
with open('/tmp/spm_rows.json') as f: spm = json.load(f)
with open('/tmp/ts_emails.json') as f: ts = json.load(f)
ts_emails = {row['email'].lower().strip() for row in ts if row.get('email')}
orphans = []
for row in spm:
    email = (row.get('customer_email') or '').lower().strip()
    if email and email not in ts_emails:
        orphans.append(row)
print(f"  Found {len(orphans)} orphan rows:")
print()
for r in orphans:
    print(f"   · {r.get('paid_at','?')[:10]}  {r.get('studio_slug','?'):15} {r.get('customer_name','?'):25} {r.get('customer_email','?'):35}  charge={r.get('stripe_charge_id','?')}")
print()
print("  Next: backfill these into trial_signups manually OR via a one-shot RPC.")
print("  Once #230 ships, the dashboard already counts them correctly — this")
print("  is just to make /homebase show their cards too.")
PY

echo ""
echo "━━━ #232 · Bayside 'converted members' — what did they actually buy? ━━━"
echo ""
echo "  Avg \$189/conversion at Bayside vs \$650 at Astoria suggests these are"
echo "  small add-ons, not real memberships."
echo ""
# Get the 2 Bayside customers the RPC counts as converted
BAYSIDE_DATA=$(curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_converted_members" \
  -H "Content-Type: application/json" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -d '{"p_studio_slug":"bayside"}')
echo "$BAYSIDE_DATA" | python3 -m json.tool
echo ""

# For each Bayside MB ID, pull the actual non-trial sales rows
MB_IDS=$(echo "$BAYSIDE_DATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(','.join(r['mindbody_id'] for r in d if r.get('mindbody_id')))")
echo ""
echo "  Bayside MB IDs the RPC matched: $MB_IDS"
echo "  Their actual non-trial sales (ALL of them — what's really there):"
echo ""
if [ -n "$MB_IDS" ]; then
  q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_sales?customer_mindbody_id=in.(${MB_IDS})&studio_slug=eq.bayside&select=customer_mindbody_id,sale_date_time,item_names,total_cents&order=sale_date_time.desc" | python3 -m json.tool
fi

echo ""
echo "═════════════════════════════════════════════════════════════════════"
echo " Now: paste the SQL (in clipboard) into Supabase SQL editor + Run."
echo " That ships #230. The orphan list + Bayside audit above tells you"
echo " what to do for #231 + #232."
echo "═════════════════════════════════════════════════════════════════════"
