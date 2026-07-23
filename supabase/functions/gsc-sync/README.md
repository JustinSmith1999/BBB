# gsc-sync — Google Search Console → Supabase

Pulls daily Search Analytics rows (date × query × page) from GSC and writes
them to `gsc_search_performance`. The dashboard's SEO card reads from
`get_gsc_summary()` on top of that table.

## Why OAuth instead of a service account?

The `betterbodybootcamp.com` Google Workspace has the
`iam.disableServiceAccountKeyCreation` org policy auto-enforced as part of
Google's "Secure by Default" rollout, so JSON service-account keys can't be
generated. OAuth refresh tokens work around this cleanly without weakening
the security posture.

## One-time setup

GCP project + OAuth client are already created (project `bbb-gsc-sync`,
client `BBB GSC Sync Client`). What's left:

### 1. Grab the OAuth credentials from GCP

The OAuth client page is open in your browser. From the **Additional information** panel:
- Copy the **Client ID** (long string ending in `.apps.googleusercontent.com`)
- Click the copy icon next to **Client secret** to copy the secret

### 2. Get a refresh token via OAuth Playground

1. Open https://developers.google.com/oauthplayground
2. Click the gear icon (top right) → check **"Use your own OAuth credentials"**
3. Paste your Client ID and Client Secret → Close
4. **Step 1** (left panel): in the "Input your own scopes" box, paste:
   ```
   https://www.googleapis.com/auth/webmasters.readonly
   ```
   Click **Authorize APIs**
5. Sign in as `carlos@betterbodybootcamp.com` (the account with GSC access)
6. Approve the consent screen (it'll say "BBB GSC Sync" since Internal user type)
7. You'll be redirected back to the playground with an auth code in **Step 2**
8. Click **Exchange authorization code for tokens**
9. Copy the **Refresh token** from the response (long string, starts with `1//`)

### 3. Paste the three secrets into Supabase

```bash
cd ~/Desktop/betterbodybootcamp-site

supabase link --project-ref uracuwugpxqjfgtuobal  # if not already linked

supabase secrets set GSC_CLIENT_ID="<paste client ID>"
supabase secrets set GSC_CLIENT_SECRET="<paste client secret>"
supabase secrets set GSC_REFRESH_TOKEN="<paste refresh token>"
```

### 4. Run the migration + deploy the function

```bash
supabase db push                                       # creates gsc_search_performance + get_gsc_summary
supabase functions deploy gsc-sync --no-verify-jwt    # deploys edge function
```

### 5. Dry-run to confirm auth works

```bash
curl -X POST https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/gsc-sync \
  -H "Content-Type: application/json" \
  -d '{"days": 7, "dry_run": true}'
```

Expect `"ok": true` with a `sample` of 5 rows. Common failures:
- `Missing one of GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN`
  → secret wasn't pasted; re-run `supabase secrets set`
- `Token refresh failed: 400 invalid_grant`
  → refresh token was revoked or copied wrong; redo step 2
- `GSC query failed: 403`
  → the signed-in account (carlos@) doesn't have access to the GSC property; add Carlos as a User in Search Console → Settings → Users and permissions

### 6. Real sync (writes 28 days of data)

```bash
curl -X POST https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/gsc-sync \
  -H "Content-Type: application/json" \
  -d '{"days": 28}'
```

Expect `"ok": true` with a `rows_written` count.

### 7. Schedule nightly via pg_cron

In the Supabase SQL editor:

```sql
SELECT cron.schedule(
  'gsc-sync-nightly',
  '0 6 * * *',  -- 6am UTC = 2am ET
  $$
  SELECT net.http_post(
    url := 'https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/gsc-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('days', 7)
  );
  $$
);
```

### 8. Reload the owner dashboard

The SEO card lights up once at least one row is in `gsc_search_performance`.

## Notes

- GSC has a ~2-day data delay; we fetch up to "yesterday".
- We sync 28 days by default. Upserts on `(date, studio_slug, query, page)`
  make re-running safe — late-arriving rows update in place.
- The first run can be 10k+ rows. Subsequent daily runs are usually <2k rows.
- The refresh token doesn't expire unless explicitly revoked or unused for 6
  months. If it ever stops working, redo step 2 to get a fresh one.
- The OAuth client is "Internal" user type, so only Workspace users at
  betterbodybootcamp.com can authorize it. No Google verification needed.
