#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Welcome flow link fix (#195):
#   • LocationSchedule.tsx — real per-studio MB fallback URL + prominent
#     "Book on MindBody" CTA above the iframe (no more empty-iframe bounce)
#   • stripe-webhook — welcome email + welcome SMS now link directly to the
#     MB classic schedule URL for the customer's studio (zero iframe risk)
#   • manual-welcome-batch — same direct-MB URL for backfill welcomes
#
# Verify after deploy:
#   1. Hit https://betterbodybootcamp.com/schedule/fresh-meadows — the red
#      "Book on MindBody" pill above the iframe should hit
#      https://clients.mindbodyonline.com/classic/ws?studioid=5733997&stype=-7&sLoc=3
#   2. Send a test welcome to yourself: the "Book My First Class →" button
#      should go straight to MindBody, not /schedule/[studio].
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

echo ""
echo "━━━ 1/3 · Deploy stripe-webhook (welcome email + SMS link fix) ━━━"
echo ""
npx -y supabase@latest functions deploy stripe-webhook \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ 2/3 · Deploy manual-welcome-batch (backfill welcomes link fix) ━━━"
echo ""
npx -y supabase@latest functions deploy manual-welcome-batch \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ 3/3 · Build + deploy site (LocationSchedule.tsx) ━━━"
echo ""
npm run build
netlify deploy --prod \
  --message="welcome flow: MB-direct booking link + LocationSchedule fallback CTA (#195)"

echo ""
echo "═════════════════════════════════════════════════════════════════════"
echo " DONE. Spot-check:"
echo "   open https://betterbodybootcamp.com/schedule/fresh-meadows"
echo "   → red 'Book on MindBody' pill above iframe, links to MB classic"
echo "   → fallback link at the bottom now has real studio+location IDs"
echo "═════════════════════════════════════════════════════════════════════"
