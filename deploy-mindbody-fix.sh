#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy: MindBody account-creation fix.
#
# What this ships:
#   1. stripe-webhook  — NEW: fires mindbody-create-trial-client on every
#      checkout.session.completed (fire-and-forget via EdgeRuntime.waitUntil).
#      This is the missing link that broke EVERY $49 trial since launch.
#   2. mindbody-create-trial-client — the existing function with the 2026-06-08
#      AddClient address-defaults patch. Now actually getting called.
#
# Effect from this deploy forward (per Justin: "Option A, no backfill"):
#   - New paid customer → MindBody AddClient runs → MB sends them the
#     password-setup email → customer sets password → /schedule/[studio]
#     login works → they can book classes.
#   - The 47 historical unlinked trials are NOT backfilled.
#
# Run: bash ~/Desktop/betterbodybootcamp-site/deploy-mindbody-fix.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

SITE_DIR="$HOME/Desktop/betterbodybootcamp-site"
cd "$SITE_DIR"

PROJECT_REF="uracuwugpxqjfgtuobal"

echo ""
echo "━━━ Step 1/2 · Deploying mindbody-create-trial-client (with AddClient patch) ━━━"
npx -y supabase@latest functions deploy mindbody-create-trial-client \
  --no-verify-jwt \
  --project-ref "$PROJECT_REF"

echo ""
echo "━━━ Step 2/2 · Deploying stripe-webhook (with new MB invocation) ━━━"
npx -y supabase@latest functions deploy stripe-webhook \
  --no-verify-jwt \
  --project-ref "$PROJECT_REF"

echo ""
echo "✅ DONE."
echo ""
echo "Next paid trial will trigger an AddClient call to MindBody."
echo "Verify by:"
echo "  1. Watch the Supabase Edge Function logs for mindbody-create-trial-client"
echo "  2. After a real signup, check trial_signups.mindbody_id is populated"
echo "  3. Customer should receive the MindBody password-setup email within ~2 min"
echo ""
echo "If anything errors, the welcome email + Stripe webhook still complete —"
echo "MB creation is fire-and-forget. Errors land in Supabase function logs."
