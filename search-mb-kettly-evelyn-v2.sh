#!/usr/bin/env bash
# v2: search by raw phone string (LIKE %xxx%) since phone_last10 isn't a real
# column. Also: peek at mindbody_clients schema so we can see what columns
# DO exist and how many FM clients are sync'd (sanity check).
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
echo "━━━ Schema sanity — first FM mindbody_client row, all columns ━━━"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?limit=1" | python3 -m json.tool

echo ""
echo "━━━ Total FM clients in our local mirror ━━━"
echo "  (high count = sync working; low/zero = sync broken)"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?home_location_id=eq.3&select=mindbody_id&limit=2000" | python3 -c "import sys,json; print(f'  {len(json.load(sys.stdin))} FM clients found')"

echo ""
echo "━━━ KETTLY — try every match path ━━━"
echo "  → phone contains 5162501957:"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?phone=ilike.%255162501957%25&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool
echo "  → phone contains 5162501957 (no dashes, broader pattern):"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?phone=ilike.%25516%252925%2025019%2057%25&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool
echo "  → last_name ILIKE myrtil (catches Myrtil, Mrytil typos, etc):"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?last_name=ilike.%25myrtil%25&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool
echo "  → first_name ILIKE kettly:"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?first_name=ilike.%25kettly%25&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool

echo ""
echo "━━━ EVELYN — try every match path ━━━"
echo "  → phone contains 9175003894:"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?phone=ilike.%259175003894%25&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool
echo "  → last_name ILIKE frias:"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?last_name=ilike.%25frias%25&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool
echo "  → first_name ILIKE evelyn (might be Evelynn, Evelin, etc):"
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/mindbody_clients?first_name=ilike.%25evelyn%25&select=mindbody_id,first_name,last_name,email,phone,home_location_id" | python3 -m json.tool
