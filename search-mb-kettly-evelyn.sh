#!/usr/bin/env bash
# Search local mindbody_clients for Kettly Myrtil and Evelyn Frias by phone
# (last 10 digits) and by name. If neither, fall back to the live MB API.
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ]; then
  echo "Paste your SUPABASE_SERVICE_ROLE_KEY:"
  read -rs SRK
  echo ""
fi

q() { curl -s "$1" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"; }

echo ""
echo "━━━ Kettly Myrtil — phone 516-250-1957 ━━━"
echo "  → match by phone last-10 (5162501957):"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?phone_last10=eq.5162501957&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool
echo "  → match by name (first=kettly, last=myrtil — case-insensitive):"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?first_name=ilike.kettly&last_name=ilike.myrtil&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool

echo ""
echo "━━━ Evelyn Frias — phone 917-500-3894 ━━━"
echo "  → match by phone last-10 (9175003894):"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?phone_last10=eq.9175003894&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool
echo "  → match by name (first=evelyn, last=frias):"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?first_name=ilike.evelyn&last_name=ilike.frias&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool

echo ""
echo "━━━ If either MB ID appears above — check their sales history ━━━"
echo "  (run separately once you have the MB IDs — or paste them and I'll do it)"
