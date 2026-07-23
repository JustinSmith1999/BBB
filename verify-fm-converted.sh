#!/usr/bin/env bash
# Cross-check 4 FM "Converted" cards against the strict dashboard RPC.
# Anyone in /homebase's Converted column but missing from this RPC is a
# front-desk drag without a real membership purchase behind it.
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ]; then
  echo "Paste your SUPABASE_SERVICE_ROLE_KEY:"
  read -rs SRK
  echo ""
fi

echo ""
echo "━━━ A) Who does the dashboard RPC count as a FM converted member? ━━━"
echo "    (Strict definition: had a non-trial sale ≥ \$10 after their trial)"
echo ""
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/rpc/get_converted_members" \
  -H "Content-Type: application/json" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  -d '{"p_studio_slug":"fresh-meadows"}' | python3 -m json.tool

echo ""
echo "━━━ B) The 4 FM /homebase cards — front_desk_stage + mindbody_id ━━━"
curl -s "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?and=(location_id.eq.6bbbe077-bcc6-4d9d-a10b-7605c1484752,front_desk_stage.eq.member,deleted_at.is.null)&select=name,email,mindbody_id,front_desk_stage,payment_date" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" | python3 -m json.tool

echo ""
echo "━━━ C) For each of those 4 MB IDs — what MEMBERSHIP sales exist? ━━━"
echo "    (filtering out trial / water / towel / snack — only real packages)"
echo ""
# Extract MB IDs from B and query their sales
MB_IDS=$(curl -s "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?and=(location_id.eq.6bbbe077-bcc6-4d9d-a10b-7605c1484752,front_desk_stage.eq.member,deleted_at.is.null,mindbody_id.not.is.null)&select=mindbody_id" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" | python3 -c "import sys,json;print(','.join(r['mindbody_id'] for r in json.load(sys.stdin) if r.get('mindbody_id')))")
echo "Checking MB IDs: $MB_IDS"
if [ -n "$MB_IDS" ]; then
  curl -s "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_sales?customer_mindbody_id=in.(${MB_IDS})&studio_slug=eq.fresh-meadows&total_cents=gte.1000&select=customer_mindbody_id,sale_date_time,item_names,total_cents&order=sale_date_time.desc" \
    -H "apikey: $SRK" -H "Authorization: Bearer $SRK" | python3 -m json.tool
fi

echo ""
echo "━━━ INTERPRETATION ━━━"
echo "Card appears in (A) → real converted member (revenue-backed)"
echo "Card in (B) but not (A) → front-desk drag, no membership purchase behind it"
echo "  → consider dragging back to Attended or Lost so the dashboard tells truth"
