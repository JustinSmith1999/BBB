#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 2026-07-02 · FIX: /homebase shows no attendance since June 29
#
# ROOT CAUSE (verified against prod): mariana-tek-visits-sync has been disabled
# since the 6/27 cutover — MT_VISITS_VERIFIED was hardcoded false, so the
# function threw on every call and mariana_tek_visits stayed EMPTY (0 rows).
# MindBody visits froze 6/29. Net: the front-desk board has had zero visit /
# attendance data for ~a week, so every customer looks like they never came in.
#
# This flips MT_VISITS_VERIFIED = true, deploys, and DRY-RUNS first (reads MT,
# writes nothing) so we can eyeball the real Mariana Tek response before we
# trust it. Then backfills, then the existing 15-min cron keeps it fresh.
#
# Run: bash ~/Desktop/betterbodybootcamp-site/fix-homebase-visits.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$HOME/Desktop/betterbodybootcamp-site"

REF=uracuwugpxqjfgtuobal
SB="https://${REF}.supabase.co"
ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyYWN1d3VncHhxamZndHVvYmFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzOTkxMDksImV4cCI6MjA3ODk3NTEwOX0.DFlpeS3mh4ZL6aFEBUXg5biZ6wLXQyxjkrX66hnNgso"
SECRET="bbb-test-2026-05-27"

echo ""
echo "━━━ 1/3 · Deploy the (now-enabled) visits sync ━━━"
supabase functions deploy mariana-tek-visits-sync --no-verify-jwt --project-ref "$REF"

echo ""
echo "━━━ 2/3 · DRY RUN — pull 10 days of MT visits, write NOTHING ━━━"
echo "    Look at total_visits and dry_run_sample below. If total_visits > 0 and"
echo "    the sample rows have real mt_client_id / starts_at / signed_in values,"
echo "    the endpoint is correct — continue to the backfill."
echo "    If you see an 'error' per studio (HTTP 404 / wrong filter), STOP and"
echo "    paste the output back to me — I'll correct the endpoint/field mapping."
echo ""
curl -sS -X POST "${SB}/functions/v1/mariana-tek-visits-sync" \
  -H "Authorization: Bearer ${ANON}" -H "apikey: ${ANON}" \
  -H "x-bbb-secret: ${SECRET}" -H "Content-Type: application/json" \
  -d '{"lookback_days":10,"dry_run":true}' | python3 -m json.tool
echo ""
read -r -p "Did the dry run pull real visits with no errors? [y/N] " ok
if [[ "$ok" != "y" && "$ok" != "Y" ]]; then
  echo "Stopping before any writes. Paste the dry-run output to Claude to fix the endpoint."
  exit 0
fi

echo ""
echo "━━━ 3/3 · BACKFILL — write the last 10 days of visits for real ━━━"
curl -sS -X POST "${SB}/functions/v1/mariana-tek-visits-sync" \
  -H "Authorization: Bearer ${ANON}" -H "apikey: ${ANON}" \
  -H "x-bbb-secret: ${SECRET}" -H "Content-Type: application/json" \
  -d '{"lookback_days":10}' | python3 -m json.tool

echo ""
echo "✓ Done. The existing 15-min cron (mariana_tek_visits_sync_15min) now keeps"
echo "  it fresh. Reload /homebase — the Attended column + visit chips + at-risk"
echo "  flags should reflect who's actually been coming in."
echo ""
echo "  Verify row count any time:"
echo "  psql / SQL editor →  select count(*), max(starts_at) from mariana_tek_visits;"
