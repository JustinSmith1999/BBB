#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# mindbody-create-trial-client — switch to V6 UserToken auth
#
# Root cause of the "MissingRequiredFields" wall: the function was sending
# deprecated V5 `SourceCredentials`/`StaffCredentials` headers in
# `name|pass` plaintext format. MindBody V6 silently rejects writes under
# those headers and returns a generic schema-validation error.
#
# Fix: call /usertoken/issue with staff Username/Password, get an
# AccessToken back, send it as `Authorization: <token>` (no Bearer prefix).
# This matches probe-mindbody + mindbody-visits-sync which already work.
#
# After deploy: retry every unlinked paid trial in one batch.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ] || [ "$SRK" = "PASTE-YOUR-KEY-HERE" ]; then
  echo "Paste SUPABASE_SERVICE_ROLE_KEY:"; read -rs SRK; echo ""
fi

echo ""
echo "━━━ 1/3 · Deploy patched mindbody-create-trial-client ━━━"
echo ""
npx -y supabase@latest functions deploy mindbody-create-trial-client \
  --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

echo ""
echo "━━━ 2/3 · Smoke test — single dry_run against one customer ━━━"
echo "    Verifies the new auth path before we batch-retry everyone."
echo ""
# Find any unlinked paid trial; doesn't matter which one for the dry-run.
TEST_ID=$(curl -s "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?payment_status=eq.completed&payment_date=gte.2026-05-15T00:00:00&deleted_at=is.null&mindbody_id=is.null&select=id&limit=1" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")

if [ -z "$TEST_ID" ]; then
  echo "  No unlinked paid trials to test against — likely already cleared."
else
  echo "  Test customer ID: $TEST_ID"
  echo ""
  curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-create-trial-client" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $SRK" \
    --max-time 60 \
    -d "{\"trial_signup_ids\":[\"$TEST_ID\"], \"dry_run\":true}" \
    | python3 -m json.tool | head -50
fi

echo ""
echo "━━━ 3/3 · Live retry — every unlinked paid trial since launch ━━━"
echo "    This may take 60-120s — calls MB API per customer."
echo ""
curl -s -X POST "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/mindbody-create-trial-client" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SRK" \
  --max-time 180 \
  -d '{"since":"2026-05-15T00:00:00Z"}' \
  | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception as e:
  print(f'  parse error: {e}'); sys.exit(0)
print(f'  processed={d.get(\"processed\")}  created={d.get(\"created\")}  failed={d.get(\"failed\")}')
print()
created = [r for r in (d.get('results') or []) if r.get('status') == 'created']
failed  = [r for r in (d.get('results') or []) if r.get('status') == 'failed']
if created:
  print(f'  --- LINKED ({len(created)} customers) ---')
  for r in created:
    print(f'   ✓ {r.get(\"studio\",\"?\"):15} {r.get(\"email\",\"?\"):35}  MB ID {r.get(\"mindbody_id\",\"?\")}  ({r.get(\"reason\",\"\")[:40]})')
  print()
if failed:
  print(f'  --- STILL FAILED ({len(failed)}) ---')
  for r in failed[:10]:
    reason = (r.get('reason') or '').split('\\\\n')[0][:90]
    print(f'   · {r.get(\"studio\",\"?\"):15} {r.get(\"email\",\"?\"):35} {reason}')
  if len(failed) > 10:
    print(f'   ... + {len(failed) - 10} more')
"

echo ""
echo "═════════════════════════════════════════════════════════════════════"
echo " Done. If you see 'LINKED' rows above, V6 auth is working — MindBody"
echo " is now accepting our AddClient calls. The customers listed got real"
echo " MB accounts and will receive their password-setup email within ~2 min."
echo ""
echo " Refresh /homebase → Unlinked tab. The badge count should drop sharply."
echo " Refresh the owner dashboard. Williamsburg conversion rate should jump"
echo " above 0% once the linked customers' MB sales data flows in (24h)."
echo "═════════════════════════════════════════════════════════════════════"
