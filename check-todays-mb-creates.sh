#!/usr/bin/env bash
# Did mindbody-create-trial-client succeed for today's 2 paid trials?
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
echo "━━━ Today's paid trials — did MB account get created? ━━━"
echo "    (mindbody_id populated = yes; null = no)"
echo ""
q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?email=in.(yaritkeit@gmail.com,drinkwardnicoke@gmail.com)&select=name,email,payment_date,mindbody_id,location_id" | python3 -m json.tool

echo ""
echo "━━━ If mindbody_id is null — try linking them now (live, not dry_run) ━━━"
echo "   (Will succeed if they already exist in MB under a different email,"
echo "    or create a new MB account if they don't)"
echo ""
# Get the IDs first
IDS=$(q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?email=in.(yaritkeit@gmail.com,drinkwardnicoke@gmail.com)&mindbody_id=is.null&select=id" \
  | python3 -c "import sys,json; print(','.join(f'\"{r[\"id\"]}\"' for r in json.load(sys.stdin)))")
if [ -n "$IDS" ]; then
  echo "Unlinked trial_signup_ids: $IDS"
  echo ""
  curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-create-trial-client" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $SRK" \
    -d "{\"trial_signup_ids\":[${IDS}]}" | python3 -m json.tool
else
  echo "Both already have mindbody_id populated — no action needed."
fi
