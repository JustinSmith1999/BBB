#!/usr/bin/env bash
# Why isn't today's FM paid trial showing on the dashboard?
# Checks every link in the chain: trial_signups → stripe_paid_mirror → meta_insights_daily.
set -e

cd "$HOME/Desktop/betterbodybootcamp-site"

SRK="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$SRK" ]; then
  echo "Paste your SUPABASE_SERVICE_ROLE_KEY:"
  read -rs SRK
  echo ""
fi

FM="6bbbe077-bcc6-4d9d-a10b-7605c1484752"
TODAY="2026-06-09"  # ET

curl_q() {
  curl -s "$1" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
}

echo ""
echo "━━━ A) trial_signups: ANY rows for FM today (any payment status) ━━━"
curl_q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/trial_signups?location_id=eq.${FM}&or=(created_at.gte.${TODAY}T00:00:00,payment_date.gte.${TODAY}T00:00:00)&select=name,email,payment_status,payment_date,created_at,stripe_session_id,source_category&order=created_at.desc" | python3 -m json.tool

echo ""
echo "━━━ B) stripe_paid_mirror: paid rows for FM today ━━━"
curl_q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?studio_slug=eq.fresh-meadows&paid_at=gte.${TODAY}T00:00:00&select=customer_name,customer_email,paid_at,stripe_session_id" | python3 -m json.tool

echo ""
echo "━━━ C) Stripe paid mirror — most recent sync activity (any studio) ━━━"
curl_q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/stripe_paid_mirror?select=studio_slug,paid_at&order=paid_at.desc&limit=5" | python3 -m json.tool

echo ""
echo "━━━ D) meta_insights_daily: what Meta says happened at FM today ━━━"
curl_q "https://uracuwugpxqjfgtuobal.supabase.co/rest/v1/meta_insights_daily?studio_slug=eq.fresh-meadows&date_start=eq.${TODAY}&select=impressions,clicks,leads,purchases,spend_cents" | python3 -m json.tool

echo ""
echo "━━━ INTERPRETATION ━━━"
echo "A has row + B has row  → webhook OK; dashboard cache lag (refresh page)"
echo "A has row + B empty    → Stripe sync cron broken (#86/#128 redux) — call sync-stripe-paid-mirror"
echo "A empty + B has row    → trial_signups insert failed; webhook recovered via mirror"
echo "A empty + B empty      → checkout never reached Stripe OR webhook dead (#140 redux)"
echo "C newest = today       → sync running; check (B) again"
echo "C newest = yesterday   → sync STUCK; trigger it manually"
