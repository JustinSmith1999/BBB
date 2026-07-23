#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Redeploy mindbody-create-trial-client (now accepts a `since` filter) and
# backfill every paid trial signed up TODAY (ET) that doesn't have a
# mindbody_id yet.
#
# Safe to re-run — the function skips any row that already has mindbody_id.
# ─────────────────────────────────────────────────────────────────────────────
set -e

SITE_DIR="$HOME/Desktop/betterbodybootcamp-site"
cd "$SITE_DIR"
PROJECT_REF="uracuwugpxqjfgtuobal"
FUNCTION_URL="https://${PROJECT_REF}.supabase.co/functions/v1/mindbody-create-trial-client"

echo ""
echo "━━━ Step 1/3 · Redeploying mindbody-create-trial-client with 'since' filter ━━━"
npx -y supabase@latest functions deploy mindbody-create-trial-client \
  --no-verify-jwt \
  --project-ref "$PROJECT_REF"

echo ""
echo "━━━ Step 2/3 · Fetching service role key from supabase secrets ━━━"
# Pull the service role key out of supabase secrets — needed to invoke the
# function with the elevated permissions it requires.
SRK="$(npx -y supabase@latest secrets list --project-ref "$PROJECT_REF" 2>/dev/null \
  | awk -F '|' '/SUPABASE_SERVICE_ROLE_KEY/ {gsub(/ /, "", $2); print $2}' \
  | head -1)"
if [ -z "$SRK" ]; then
  echo "⚠️  Couldn't auto-resolve SUPABASE_SERVICE_ROLE_KEY from supabase secrets list."
  echo "   Paste it here (it's the secret used by stripe-webhook etc):"
  read -rs SRK
  echo ""
fi

echo ""
echo "━━━ Step 3/3 · Running today's backfill ━━━"
RESP="$(curl -s -X POST "$FUNCTION_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SRK" \
  -d '{"since":"today"}')"

echo "$RESP" | python3 -m json.tool || echo "$RESP"

echo ""
echo "✅ Backfill complete. Summary above shows: processed / created / skipped / failed."
echo ""
echo "If you see any 'failed' rows, the 'reason' string tells you why."
echo "Common: 'unrecognized location_id' (data mismatch) or MindBody error."
