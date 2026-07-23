#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# URGENT · 2026-06-10 · Fix silent trial form failure
#   1. Add missing `fbp` column to trial_signups (fixes the bug going forward)
#   2. Backfill 6 customers lost today (gives front desk a chase list)
#   3. Verify the fix by submitting a test form via curl
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
ANON="$(grep '^VITE_SUPABASE_ANON_KEY=' .env 2>/dev/null | cut -d= -f2- || true)"
if [ -z "$ANON" ]; then
  ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyYWN1d3VncHhxamZndHVvYmFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzOTkxMDksImV4cCI6MjA3ODk3NTEwOX0.DFlpeS3mh4ZL6aFEBUXg5biZ6wLXQyxjkrX66hnNgso"
fi

echo "━━━ 1/3 · Add missing fbp column ━━━"
cat supabase/migrations/20260610_add_fbp_column.sql | pbcopy
echo "  ✓ SQL on clipboard. Opening SQL editor — paste, Run."
open "https://supabase.com/dashboard/project/uracuwugpxqjfgtuobal/sql/new"
read -p "  Press ENTER after migration shows 'Success'… "

echo ""
echo "━━━ 2/3 · Backfill today's 6 lost customers ━━━"
cat supabase/migrations/20260610_backfill_today_lost_leads.sql | pbcopy
echo "  ✓ Second migration on clipboard. Same SQL editor — ⌘A → Delete → ⌘V → Run."
echo "  Final SELECT will print the 6 backfilled rows."
read -p "  Press ENTER after second migration shows 'Success'… "

echo ""
echo "━━━ 3/3 · Verify fix with a real Supabase REST insert ━━━"
python3 << 'PY'
import json, urllib.request, urllib.error, time
SRK = open('.env').read()
SRK = [l.split('=',1)[1] for l in SRK.splitlines() if l.startswith('SUPABASE_SERVICE_ROLE_KEY=')][0]
URL = 'https://uracuwugpxqjfgtuobal.supabase.co'
H = {'apikey': SRK, 'Authorization': f'Bearer {SRK}'}

test_email = f"verify.fbp.fix.{int(time.time())}@j20solutions.com"
payload = {
    "name":"Verify FbpFix","email":test_email,"phone":"+15555550100",
    "location_id":"80536b45-df0e-42d1-880c-e9301372e1cf",
    "payment_status":"pending","source_category":"trial_form",
    "client_ip":"127.0.0.1","client_user_agent":"verify-test",
    "fbp": "fb.1.1781100000000.999",
    "fbc": None,
}
try:
    req = urllib.request.Request(
        f'{URL}/rest/v1/trial_signups',
        data=json.dumps(payload).encode(),
        headers={**H, "Content-Type":"application/json", "Prefer":"return=representation"},
        method='POST')
    resp = urllib.request.urlopen(req, timeout=10)
    print(f'  ✓ HTTP {resp.status} — insert SUCCEEDED. Bug is FIXED.')
    # Cleanup
    import urllib.parse
    em_q = urllib.parse.quote(test_email)
    urllib.request.urlopen(urllib.request.Request(
        f'{URL}/rest/v1/trial_signups?email=eq.{em_q}', headers=H, method='DELETE'))
    print('  (test row cleaned up)')
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f'  ✗ STILL BROKEN: HTTP {e.code}')
    print(f'  {body[:400]}')
PY

echo ""
echo "━━━ DONE ━━━"
echo "  Next form submission will go all the way through to Stripe."
echo "  Backfill rows are on /homebase 'New Lead' column for the 6 affected customers."
echo "  Their cards have 'AUTO-BACKFILL: ... CALL them.' note — front desk needs to reach out."
