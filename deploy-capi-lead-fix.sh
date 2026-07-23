#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy: CAPI Lead fix for the Bayside dashboard "6 leads, 7 paid" bug.
#
# What this ships:
#   1. New Edge function:  meta-capi-lead          (server-side Lead → Meta)
#   2. Edge function update: create-trial-checkout  (invokes #1 fire-and-forget)
#   3. Site update: LocationTrialSignup.tsx         (shared event_id for dedupe)
#
# WHY: Browser-side fbq('track','Lead') gets eaten by Safari ITP / iOS 17+ /
# ad blockers on ~30-40% of NYC traffic. Bayside dashboard: 6 leads reported,
# 7 paid — paid > leads is mathematically impossible unless leads silently
# drop. This adds a server-side Lead event that fires regardless of client
# blocking. Once live, Meta's algorithm finally sees what a "good lead" looks
# like at Bayside → CPL should drop from $91 toward Williamsburg's $33 over
# the next 7-10 days of learning.
#
# Dedupe is via shared event_id passed browser → backend → CAPI. When both
# fire (clean browsers) Meta merges. When browser blocked, CAPI fires alone.
# Never double-counts.
# ─────────────────────────────────────────────────────────────────────────────
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

echo ""
echo "━━━ Step 1/3 · Deploy meta-capi-lead (new) ━━━"
npx -y supabase@latest functions deploy meta-capi-lead \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ Step 2/3 · Deploy create-trial-checkout (now invokes CAPI Lead) ━━━"
npx -y supabase@latest functions deploy create-trial-checkout \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ Step 3/3 · Build + deploy site (browser event_id wiring) ━━━"
npm run build
npx -y netlify deploy --prod --dir=dist

echo ""
echo "✅ Done."
echo ""
echo "Verify within the next hour:"
echo "  1. Meta Events Manager → Bayside pixel (931144729719242) → Test Events"
echo "     submit a test form, you should see TWO Lead events arrive that get"
echo "     deduped to ONE in Meta's view (server + browser, same event_id)."
echo "  2. After a real paid trial: capi_events table should have a new row"
echo "     with event_name='Lead' and ok=true for that studio."
echo "  3. Tomorrow's dashboard: Bayside 'leads' column should start matching"
echo "     trial_signups count more closely (or exceed paid trials, not lag)."
