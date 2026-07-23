#!/usr/bin/env bash
# Cross-check the same metric across every data source it should match.
# Any row that says ⚠️ MISMATCH is a real inconsistency on the dashboard.
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ]; then
  echo "Paste your SUPABASE_SERVICE_ROLE_KEY:"
  read -rs SRK
  echo ""
  echo "(saving to .env so you don't have to do this again)"
  echo "SUPABASE_SERVICE_ROLE_KEY=$SRK" >> .env
fi

q() { curl -s "$1" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"; }
SINCE="2026-05-15"

echo ""
echo "═════════════════════════════════════════════════════════════════════"
echo " DASHBOARD CONSISTENCY AUDIT · since launch (${SINCE})"
echo "═════════════════════════════════════════════════════════════════════"

echo ""
echo "── A · Paid trials per studio — every source ──────────────────────────"
echo ""
printf "%-15s %12s %12s %12s %12s\n" "Studio" "trial_sgnp" "stripe_mir" "Meta_purch" "RPC_aud_cmp"
printf "%-15s %12s %12s %12s %12s\n" "------" "----------" "----------" "----------" "-----------"

for SLUG in astoria williamsburg bayside fresh-meadows; do
  # Source 1: trial_signups (payment_status=completed)
  # We need location_id, derive from slug. Hardcode the mapping:
  case $SLUG in
    astoria)       LOC="dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45" ;;
    williamsburg)  LOC="80536b45-df0e-42d1-880c-e9301372e1cf" ;;
    bayside)       LOC="5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7" ;;
    fresh-meadows) LOC="6bbbe077-bcc6-4d9d-a10b-7605c1484752" ;;
  esac
  TS=$(q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?location_id=eq.${LOC}&payment_status=eq.completed&payment_date=gte.${SINCE}T00:00:00&deleted_at=is.null&select=id" \
    | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
  SM=$(q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?studio_slug=eq.${SLUG}&paid_at=gte.${SINCE}T00:00:00&select=stripe_charge_id" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else 0)")
  MI=$(q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/meta_insights_daily?studio_slug=eq.${SLUG}&date_start=gte.${SINCE}&select=purchases" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(sum(r.get('purchases',0) or 0 for r in d) if isinstance(d,list) else 0)")
  RP=$(curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_audience_comparison_all_studios" \
    -H "Content-Type: application/json" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
    -d "{\"p_since\":\"${SINCE}\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);r=[x for x in d if x.get('studio_slug')=='${SLUG}'];print(r[0].get('total_paid_real',0) if r else 0)")
  printf "%-15s %12s %12s %12s %12s\n" "$SLUG" "$TS" "$SM" "$MI" "$RP"
done

echo ""
echo "  Legend: trial_sgnp = trial_signups (ground truth)"
echo "          stripe_mir = stripe_paid_mirror (canonical)"
echo "          Meta_purch = meta_insights_daily.purchases (what Meta sees)"
echo "          RPC_aud_cmp = get_audience_comparison_all_studios.total_paid_real"
echo ""
echo "  trial_sgnp ≈ stripe_mir ≈ RPC_aud_cmp = clean (Meta will be lower — Pixel drops)"
echo "  Any large gap (>2) between the first 3 = a real bug to chase"
echo ""

echo "── B · Converted members per studio — RPC vs manual sum ───────────────"
echo ""
printf "%-15s %12s %12s\n" "Studio" "RPC" "Sum_check"
printf "%-15s %12s %12s\n" "------" "---" "---------"
RPCDATA=$(curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_converted_members" \
  -H "Content-Type: application/json" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -d "{\"p_since\":\"${SINCE}\"}")
for SLUG in astoria williamsburg bayside fresh-meadows; do
  CNT=$(echo "$RPCDATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(sum(1 for r in d if r.get('studio_slug')=='${SLUG}'))")
  REV=$(echo "$RPCDATA" | python3 -c "import sys,json;d=json.load(sys.stdin);print(round(sum(float(r.get('total_member_rev_usd',0) or 0) for r in d if r.get('studio_slug')=='${SLUG}'),2))")
  printf "%-15s %12s %12s\n" "$SLUG" "$CNT × members" "\$${REV} rev"
done

echo ""
echo "── C · Dashboard 'Today' should match Stripe 'Today' ──────────────────"
echo ""
TODAY="2026-06-09"
printf "%-15s %12s %12s\n" "Studio" "stripe_today" "ts_today"
printf "%-15s %12s %12s\n" "------" "------------" "--------"
for SLUG in astoria williamsburg bayside fresh-meadows; do
  case $SLUG in
    astoria)       LOC="dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45" ;;
    williamsburg)  LOC="80536b45-df0e-42d1-880c-e9301372e1cf" ;;
    bayside)       LOC="5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7" ;;
    fresh-meadows) LOC="6bbbe077-bcc6-4d9d-a10b-7605c1484752" ;;
  esac
  SM=$(q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?studio_slug=eq.${SLUG}&paid_at=gte.${TODAY}T00:00:00&select=stripe_charge_id" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else 0)")
  TS=$(q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?location_id=eq.${LOC}&payment_status=eq.completed&payment_date=gte.${TODAY}T00:00:00&deleted_at=is.null&select=id" \
    | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
  printf "%-15s %12s %12s\n" "$SLUG" "$SM" "$TS"
done

echo ""
echo "── D · MindBody linking gap — paid but no MB ID ───────────────────────"
echo ""
UNLINKED=$(q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?payment_status=eq.completed&payment_date=gte.${SINCE}T00:00:00&mindbody_id=is.null&deleted_at=is.null&select=id" \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
TOTAL=$(q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?payment_status=eq.completed&payment_date=gte.${SINCE}T00:00:00&deleted_at=is.null&select=id" \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
PCT=$(python3 -c "print(round(${UNLINKED}/max(${TOTAL},1)*100,1))")
echo "  ${UNLINKED} of ${TOTAL} paid trials have no MB ID (${PCT}%)"
echo "  Anything > 0 means the dashboard's Converted Members is undercounting."
echo ""

echo "═════════════════════════════════════════════════════════════════════"
echo " DONE. Anything that didn't line up above is what to ask about next."
echo "═════════════════════════════════════════════════════════════════════"
