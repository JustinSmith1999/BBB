#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# bbb.sh — one entry point for Better Body Bootcamp ops.
#
# THE KEY FEATURE: this script self-locates to the repo it lives in (the line
# `cd "$(dirname "$0")"` below), so EVERY command runs from the correct folder
# no matter where you invoke it from. That's what kills the "Entrypoint path
# does not exist" wrong-directory trap — you can run it from ~, from
# bbb-marketing, from anywhere, and function deploys still work.
#
# USAGE (run from anywhere):
#   bash ~/Desktop/betterbodybootcamp-site/bbb.sh <command> [args]
#
# Tip: add an alias so you can just type `bbb <command>`:
#   echo "alias bbb='bash ~/Desktop/betterbodybootcamp-site/bbb.sh'" >> ~/.zshrc && source ~/.zshrc
#
# COMMANDS:
#   deploy-fn <name>   Deploy one Supabase edge function (from the right dir).
#   capi               Deploy the CAPI purchase fn + backfill 30 days of missed
#                      Purchase events to Meta. Fixes the 404 tracking gap.
#   deploy-site        Commit + push the site (Netlify auto-builds). Pass a
#                      message: bbb.sh deploy-site "your message"
#   sync               Re-run the MT attendance + orders sync (dry-run first).
#   unlock             Clear a stale .git/index.lock.
#   help               Show this.
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Self-locate: always operate from THIS script's repo. Kills wrong-dir bugs.
cd "$(dirname "$0")"
REPO="$(pwd)"

PROJECT_REF="uracuwugpxqjfgtuobal"
ADMIN_SECRET="bbb-test-2026-05-27"
FN_BASE="https://${PROJECT_REF}.supabase.co/functions/v1"

c_green() { printf "\033[32m%s\033[0m\n" "$1"; }
c_red()   { printf "\033[31m%s\033[0m\n" "$1"; }
c_bold()  { printf "\033[1m%s\033[0m\n" "$1"; }

# ── Guard: confirm we're actually in the site repo (sentinel: the functions dir)
require_repo() {
  if [ ! -d "$REPO/supabase/functions" ]; then
    c_red "✗ Not in the betterbodybootcamp-site repo (no supabase/functions/)."
    c_red "  This script must live in ~/Desktop/betterbodybootcamp-site/"
    exit 1
  fi
}

cmd_deploy_fn() {
  require_repo
  local fn="${1:-}"
  if [ -z "$fn" ]; then c_red "Usage: bbb.sh deploy-fn <function-name>"; exit 1; fi
  if [ ! -f "$REPO/supabase/functions/$fn/index.ts" ]; then
    c_red "✗ No such function: supabase/functions/$fn/index.ts"
    c_red "  Available:"; ls "$REPO/supabase/functions/" | sed 's/^/    /'
    exit 1
  fi
  c_bold "━━━ Deploying $fn (from $REPO) ━━━"
  supabase functions deploy "$fn" --no-verify-jwt --project-ref "$PROJECT_REF"
  c_green "✓ Deployed $fn"
}

cmd_capi() {
  require_repo
  c_bold "━━━ 1/3 · Deploy mariana-tek-capi-purchase-sync ━━━"
  supabase functions deploy mariana-tek-capi-purchase-sync --no-verify-jwt --project-ref "$PROJECT_REF"

  c_bold "━━━ 2/3 · Smoke test (dry run, writes nothing) ━━━"
  curl -sS -X POST "${FN_BASE}/mariana-tek-capi-purchase-sync" \
    -H "x-bbb-secret: ${ADMIN_SECRET}" -H 'Content-Type: application/json' \
    -d '{"lookback_hours":6,"dry_run":true}' | python3 -m json.tool | head -30 || true

  c_bold "━━━ 3/3 · Backfill 30 days of missed Purchase events (real) ━━━"
  echo "    Deduped by event_id (mt_<sale_id>) — safe to re-run, no double-fire."
  curl -sS -X POST "${FN_BASE}/mariana-tek-capi-purchase-sync" \
    -H "x-bbb-secret: ${ADMIN_SECRET}" -H 'Content-Type: application/json' \
    -d '{"lookback_hours":720}' | python3 -m json.tool | head -40 || true
  c_green "✓ CAPI live. Confirm in Meta Events Manager → Test Events / Purchase count."
}

cmd_deploy_site() {
  require_repo
  local msg="${1:-chore: deploy site}"
  c_bold "━━━ Commit + push site (Netlify auto-builds) ━━━"
  rm -f "$REPO/.git/index.lock" 2>/dev/null || true
  git add -A
  if git diff --cached --quiet; then
    c_green "Nothing to commit — working tree clean."
  else
    git commit -m "$msg"
  fi
  git push
  c_green "✓ Pushed. Netlify build: https://app.netlify.com/"
}

cmd_sync() {
  require_repo
  c_bold "━━━ MT attendance sync (dry run) ━━━"
  curl -sS -X POST "${FN_BASE}/mariana-tek-visits-sync" \
    -H "x-bbb-secret: ${ADMIN_SECRET}" -H 'Content-Type: application/json' \
    -d '{"lookback_days":3,"dry_run":true}' | python3 -m json.tool | head -25 || true
  c_green "✓ If totals look right, re-run without dry_run via the fix-bayside script."
}

cmd_unlock() {
  rm -f "$REPO/.git/index.lock" 2>/dev/null && c_green "✓ Cleared stale git lock." || c_green "No lock to clear."
}

case "${1:-help}" in
  deploy-fn)   shift; cmd_deploy_fn "${1:-}";;
  capi)        cmd_capi;;
  deploy-site) shift; cmd_deploy_site "${1:-}";;
  sync)        cmd_sync;;
  unlock)      cmd_unlock;;
  help|*)      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//';;
esac
