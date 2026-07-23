#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy: EXTREME SEO Phase 1 + react-helmet-async helmet fix.
#
# What this ships:
#   1. react-helmet-async pinned 2.0.5 (was ^3.0.0 fork → silently dead)
#   2. Per-studio FAQ data (src/lib/studioFaq.ts)
#   3. FAQPage + Service + Speakable JSON-LD schemas on /locations/[slug]
#   4. Visible Q&A + Programs sections on /locations/[slug]
#   5. robots.txt with explicit Google-Extended / GPTBot / ClaudeBot allows
#
# Run: bash ~/Desktop/betterbodybootcamp-site/deploy-seo-helmet-fix.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

SITE_DIR="$HOME/Desktop/betterbodybootcamp-site"
cd "$SITE_DIR"

echo ""
echo "━━━ Step 1/3 · Reinstalling deps (pulls in react-helmet-async@2.0.5) ━━━"
npm install

echo ""
echo "━━━ Step 2/3 · Building Vite bundle ━━━"
npm run build

echo ""
echo "━━━ Step 3/3 · Deploying to Netlify (production) ━━━"
npx -y netlify-cli deploy \
  --prod \
  --dir=dist \
  --message="SEO Phase 1: per-studio FAQ schema + Q&A sections + pin helmet 2.0.5 (was silently dead on 3.0.0 fork)"

echo ""
echo "✅ DONE. Now check https://betterbodybootcamp.com/locations/williamsburg"
echo "   View page source and confirm <script type=\"application/ld+json\"> shows up."
