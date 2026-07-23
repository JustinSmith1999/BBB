# GitHub Actions · Auto-Deploy Setup

After committing `.github/workflows/deploy.yml`, every push to `main` will:

1. Run any **new SQL migrations** (`supabase/migrations/*.sql`)
2. Deploy any **changed Edge Functions** (`supabase/functions/*/`)
3. Netlify auto-deploys the front-end (already wired at the Netlify project level)

## One-time setup · add 3 GitHub Secrets

Go to **GitHub → your repo → Settings → Secrets and variables → Actions → New repository secret** and add:

### 1. `SUPABASE_ACCESS_TOKEN`

Personal access token. Get it from:

→ https://supabase.com/dashboard/account/tokens

Click "Generate new token", name it something like `gh-actions-bbb`, copy the value, paste here.

### 2. `SUPABASE_DB_PASSWORD`

The Postgres password for the BBB project. This is the same password you'd use to `psql` directly into the DB. Find it in:

→ Supabase Dashboard → Project Settings → Database → Database Password
   (reset it if you've never used it — note any existing CLI sessions will need to re-link)

### 3. `SUPABASE_PROJECT_ID`

Value: `uracuwugpxqjfgtuobal`

(Hardcoded in workflow comments, but adding as a secret keeps it editable per-repo without diff noise.)

## What gets deployed when

| Change | Triggers |
|---|---|
| Edit `supabase/functions/*/index.ts` | That function only deploys |
| Add a new SQL file in `supabase/migrations/` | `supabase db push` runs the new file |
| Edit `src/`, `public/`, `index.html` | Netlify auto-builds (separate pipeline) |
| Edit `netlify.toml` | Netlify auto-builds (separate pipeline) |
| Edit `package.json` | Netlify auto-builds (separate pipeline) |

## Test the pipeline

```bash
# Trivial change to confirm wiring works
echo "// touch $(date +%s)" >> supabase/functions/probe-mindbody/index.ts
git add . && git commit -m "test: github actions deploy"
git push origin main
```

Watch the Actions tab at:
→ https://github.com/<your-org>/<your-repo>/actions

The job should finish in 1-2 minutes. Look for "Deploying probe-mindbody" in the log.

## What's intentionally NOT in this pipeline

- **Netlify** — already auto-deploys from the repo. Adding it here would create duplicate deploys.
- **Cron schedules** — handled by `supabase db push` since they're SQL migrations.
- **Front-end secrets** — those are Netlify environment variables, managed separately.
- **Manual one-off scripts** (e.g., `deploy-comeback-offer.sh`) — those still exist for ad-hoc runs but the routine path is now `git push`.

## Rollback

If a bad deploy lands:

1. **Functions:** redeploy a known-good version. Either checkout the old commit and push, or `supabase functions deploy <fn> --project-ref uracuwugpxqjfgtuobal --no-verify-jwt` locally with the older code.
2. **Migrations:** harder — Supabase doesn't auto-rollback. Write a corrective migration that undoes the change.
3. **Netlify:** roll back from the Netlify Deploys UI (one click).
