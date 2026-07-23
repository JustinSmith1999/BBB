#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 2026-07-06 · FIX: Bayside app-paid trials + attendance showing NOWHERE
#
# TWO separate pipelines were broken:
#
#  (1) ATTENDANCE  (mariana-tek-visits-sync → mariana_tek_visits → /homebase
#      Attended column). Was returning HTTP 406 "Could not satisfy the request
#      Accept header" on every studio because it sent Accept: application/json.
#      MT's admin API is JSON:API and requires application/vnd.api+json.
#      → FIXED in code (mtHeaders). This script redeploys + dry-runs it.
#
#  (2) APP PURCHASES  (mt-orders-sync → mariana_tek_sales + trial_signups →
#      /homebase board + dashboard revenue). It's INCREMENTAL (only pulls order
#      ids above the last synced id). If the cron stalled OR a Bayside product
#      wasn't classified as a trial, those buyers never hit trial_signups and
#      show up nowhere. → This runs a full_refresh that re-reads EVERY recent
#      order and re-classifies, catching the missed Bayside app-trials.
#
# Everything DRY-RUNS first (reads MT, writes nothing). You eyeball the numbers,
# then one 'y' commits BOTH backfills. All writes are idempotent upserts —
# re-running can't create duplicates.
#
# Run: bash ~/Desktop/betterbodybootcamp-site/fix-bayside-missing.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$HOME/Desktop/betterbodybootcamp-site"

REF=uracuwugpxqjfgtuobal
SB="https://${REF}.supabase.co"
ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyYWN1d3VncHhxamZndHVvYmFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzOTkxMDksImV4cCI6MjA3ODk3NTEwOX0.DFlpeS3mh4ZL6aFEBUXg5biZ6wLXQyxjkrX66hnNgso"
SECRET="bbb-test-2026-05-27"

hdr=( -H "Authorization: Bearer ${ANON}" -H "apikey: ${ANON}" -H "x-bbb-secret: ${SECRET}" -H "Content-Type: application/json" )

echo ""
echo "━━━ 1/5 · Deploy visits-sync + orders-sync (Accept fix + OAuth auto-refresh) ━━━"
echo "    Root cause of the 401s: the static MT access token expired. Both syncs"
echo "    now auto-refresh from MT_OAUTH_REFRESH_TOKEN (same as mt-public-classes),"
echo "    so this can't silently break again when the token rotates."
supabase functions deploy mariana-tek-visits-sync --no-verify-jwt --project-ref "$REF"
supabase functions deploy mt-orders-sync          --no-verify-jwt --project-ref "$REF"

echo ""
echo "━━━ 2/5 · DRY RUN attendance — 10 days, writes NOTHING ━━━"
echo "    Want: each studio status 'ok', total_visits > 0, sample rows with"
echo "    real mt_client_id / starts_at. If you still see HTTP 406/400, STOP"
echo "    and paste to Claude."
echo ""
curl -sS -X POST "${SB}/functions/v1/mariana-tek-visits-sync" \
  "${hdr[@]}" -d '{"lookback_days":10,"dry_run":true}' | python3 -m json.tool

echo ""
echo "━━━ 3/5 · DRY RUN app-orders re-pull — writes NOTHING ━━━"
echo "    Want: new_trials > 0 (these are the missed app buyers). Watch the"
echo "    Bayside count. If new_trials is 0 but Bayside says people paid, the"
echo "    classifier is mis-tagging their product — paste this to Claude."
echo ""
curl -sS -X POST "${SB}/functions/v1/mt-orders-sync" \
  "${hdr[@]}" -d '{"full_refresh":true,"limit":50,"dry_run":true}' | python3 -m json.tool

echo ""
read -r -p "Do BOTH dry runs look right (attendance + new_trials)? Commit writes? [y/N] " ok
if [[ "$ok" != "y" && "$ok" != "Y" ]]; then
  echo "Stopped before any writes. Paste both dry-run blocks to Claude."
  exit 0
fi

echo ""
echo "━━━ 4/5 · BACKFILL attendance (last 10 days, for real) ━━━"
curl -sS -X POST "${SB}/functions/v1/mariana-tek-visits-sync" \
  "${hdr[@]}" -d '{"lookback_days":10}' | python3 -m json.tool

echo ""
echo "━━━ 5/5 · BACKFILL app orders (full refresh, for real) ━━━"
echo "    Inserts every missed mt_app trial into trial_signups + mirrors all"
echo "    sales. Fires welcome emails ONLY for brand-new trial rows."
curl -sS -X POST "${SB}/functions/v1/mt-orders-sync" \
  "${hdr[@]}" -d '{"full_refresh":true,"limit":50}' | python3 -m json.tool

echo ""
echo "✓ Done. Reload /homebase — Bayside board should now show the app-paid"
echo "  trials, and the Attended column should reflect real check-ins."
echo ""
echo "  Row-count sanity (SQL editor):"
echo "    select studio_slug, count(*) from trial_signups"
echo "      where source_category='mt_app' group by 1 order by 2 desc;"
echo "    select count(*), max(starts_at) from mariana_tek_visits;"
