#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 2026-07-02 · QA sweep fixes — one-shot deploy
#
# Ships (site — betterbodybootcamp.com):
#   QA #1  trial page: meta-capi-pageview + visitor tracking restored (was
#          written locally but NEVER DEPLOYED — prod ran the pre-CAPI build)
#   QA #2  trial page: schedule/lead-capture form default-open (pre-payment capture)
#   QA #7  trial page: MT widget scoped to /intro-offers (no $2,199 catalog)
#   QA #8  Meta pixel autoConfig=false (kills double PageView on _mt rewrite)
#   #508   Bayside Stripe-checkout fallback — FINALLY deployed
#   QA #3  /comeback → /comeback/bayside redirect (bare URL 404'd)
#   QA #14 font-display:swap on display fonts
#   QA #16 schedule class names line-clamp-2 instead of truncate
#   + everything else accumulated in the working tree since last deploy
#
# Ships (bbb-marketing — /dashboard + /homebase):
#   QA #4/#6/#9/#10 dashboard: conv-rate cap + from_trial split, ROAS as
#          multiple, Today tile trial-only revenue, MT-era source labels,
#          heatmap caption
#   QA #5/#12/#13/#17 homebase: month cohort = Performance cohort (+ "Show
#          older" toggle), Astoria + Williamsburg tabs, pace projection blend
#          before day 7, UNVERIFIED badge suppressed on MT evidence
#
# SQL (paste in Supabase SQL editor — script copies to clipboard + opens it):
#   supabase/migrations/20260702_qa_dashboard_fixes.sql  (RPC rewrites)
#   supabase/migrations/20260702_qa_homebase_fixes.sql   (get_homebase_mt_verified)
#
# Run: bash ~/Desktop/betterbodybootcamp-site/deploy-qa-fixes.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SITE="$HOME/Desktop/betterbodybootcamp-site"
DASH="$HOME/Desktop/bbb-marketing"

green() { printf "\n\e[32m━━━ %s ━━━\e[0m\n" "$1"; }

green "1/4 · Build + deploy site (betterbodybootcamp.com)"
cd "$SITE"
npm run build
netlify deploy --prod --dir=dist --message="QA sweep 2026-07-02: trial CAPI+capture+intro-offers, Bayside fallback, pixel dedupe, comeback redirect, fonts, schedule names"

green "2/4 · Deploy dashboard + homebase (bbbmarketing.netlify.app)"
cd "$DASH"
netlify deploy --prod --dir=. --message="QA sweep 2026-07-02: conv-rate/ROAS/Today-tile/source-labels · homebase cohort+tabs+pace+badge"

green "3/4 · Migrations → clipboard + Supabase SQL editor"
cat "$SITE/supabase/migrations/20260702_qa_dashboard_fixes.sql" \
    "$SITE/supabase/migrations/20260702_qa_homebase_fixes.sql" | pbcopy
echo "✓ Both migrations on clipboard (dashboard fixes first, then homebase RPC)."
open "https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
echo "  → Paste (⌘V), Run. Verification queries are at the bottom of the file;"
echo "    expect: Astoria from_trial ≤ 49, member revenue collapses from \$108k"
echo "    to post-launch-attributable, Today revenue in \$49/\$29 multiples."

green "4/4 · Post-deploy live checks (manual, ~3 min)"
cat <<'CHECKS'
  □ /trial/astoria — DevTools Network: exactly ONE facebook /tr PageView,
    and a POST to /functions/v1/meta-capi-pageview (this was the big one)
  □ /trial/astoria — widget shows ONLY the $49 intro offer (no $2,199 catalog)
  □ /trial/bayside — Stripe form renders (first/last/email/phone), submits to checkout
  □ /comeback — redirects to /comeback/bayside
  □ /dashboard Astoria — conversion rate ≤ 100%, ROAS shown as "N×",
    membership revenue no longer $108k, Today tile revenue matches Paid count
  □ /homebase — July Board totals match Conversion tab; 4 studio tabs;
    "Show N older" pill reveals carry-over cards
  ⚠ NOT FIXED (needs a decision): /dashboard + /homebase data access is
    anon-key-only — anyone with the page source can read/write all customer
    rows via the REST API. Real fix = move reads behind locked RPCs or real
    auth. Say the word and I'll build it.
CHECKS
