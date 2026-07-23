#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Apply 20260610_ssot_union_inperson.sql
#
# What this does: extends count_paid_canonical + count_unique_paid_customers
# to UNION stripe_paid_mirror with trial_signups WHERE payment_status='completed'
# AND email NOT IN Stripe. After this runs, every dashboard counter (Pulse tiles,
# Trial→Member, Bottom Line, Studio-by-studio) will include MB-direct paid
# trials — Dongha Kim today + 25 other since-launch in-person buyers.
#
# Paste-and-run model: copies SQL to clipboard, opens Supabase SQL editor.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

MIG="supabase/migrations/20260610_ssot_union_inperson.sql"
if [ ! -f "$MIG" ]; then
  echo "✗ migration file missing: $MIG"
  exit 1
fi

echo "━━━ Copying SQL to clipboard ━━━"
cat "$MIG" | pbcopy
echo "✓ ${MIG##*/} → clipboard"
echo ""
echo "Opening Supabase SQL editor…"
open "https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
echo ""
echo "Next:"
echo "  1. Paste (⌘V) into the SQL editor"
echo "  2. Click Run"
echo "  3. Look at the verification rows at the bottom — should see:"
echo "       'astoria today (post-fix)' paid ≥ 1   (Dongha)"
echo "       'since-launch (network)'    paid ≈ 104"
echo "       astoria        ≈ 40"
echo "       williamsburg   ≈ 41"
echo "       fresh-meadows  ≈ 15"
echo "       bayside        ≈ 8"
echo ""
echo "After Run succeeds: hard-refresh the dashboard (⌘⇧R). Astoria's"
echo "Today pulse tile will go 0 → 1, and the Trial→Member / Bottom Line"
echo "cards will reflect the +26 since-launch."
