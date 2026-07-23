#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy: #220 (function email-lookup) + #222 (RPC direct_link_c) + multi-
# studio diagnostic — "are we missing purchases at other locations too?"
# ─────────────────────────────────────────────────────────────────────────────
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

echo ""
echo "━━━ Step 1/2 · Deploying mindbody-create-trial-client (layered lookup) ━━━"
npx -y supabase@latest functions deploy mindbody-create-trial-client \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ Step 2/2 · Migration SQL ready — paste in Supabase SQL editor ━━━"
echo ""
echo "Path: $HOME/Desktop/betterbodybootcamp-site/supabase/migrations/20260609_converted_members_direct_link.sql"
echo ""
echo "Open: https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
echo "Then paste the migration file's contents and run."
echo ""
echo "Already on your clipboard:"
cat supabase/migrations/20260609_converted_members_direct_link.sql | pbcopy
echo "  ✓ Migration SQL copied to clipboard"
echo ""
echo "✅ Function deployed. Run the SQL in Supabase to ship the RPC update."
