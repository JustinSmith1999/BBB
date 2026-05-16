# Deploy: betterbodybootcamp.com

Vite + React + Tailwind. Auto-deploys to Netlify when you push to GitHub `main`.

## One-time setup

### 1. Push the project to GitHub

Create an empty repo at https://github.com/new (private is fine). Then:

```bash
cd ~/Desktop/betterbodybootcamp-site
git init
git add .
git commit -m "Initial commit from Bolt export"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/REPO_NAME.git
git push -u origin main
```

`.env` is in `.gitignore` so secrets stay local.

### 2. Connect Netlify to GitHub

- https://app.netlify.com → Add new site → Import from GitHub
- Pick the repo you just created
- Build command: `npm run build`
- Publish directory: `dist`
- Click Deploy

### 3. Set environment variables in Netlify

Site → Settings → Environment variables. Add the three keys from your local `.env`:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_STRIPE_PUBLISHABLE_KEY`

Trigger a redeploy after adding them.

### 4. Point betterbodybootcamp.com at this Netlify site

- In your DNS provider, change the A/CNAME for `betterbodybootcamp.com` to your new Netlify site
- In Netlify → Site settings → Domain management → Add `betterbodybootcamp.com`
- Free SSL provisioned in ~5 minutes

## Future workflow

Make changes locally, commit, push:

```bash
git add .
git commit -m "what changed"
git push
```

Netlify watches `main` and auto-deploys every push (~2 min build).

## Local dev

```bash
npm install        # first time
npm run dev        # localhost:5173, live-reload
npm run build      # produces dist/
npm run preview    # serves dist/ locally to verify before push
```

## /dashboard route

`netlify.toml` and `public/_redirects` proxy `betterbodybootcamp.com/dashboard/*`
to `bbbmarketing.netlify.app/*`. URL bar stays at betterbodybootcamp.com. The
dashboard itself lives at `~/Desktop/bbb-marketing/index.html` and deploys
separately to bbbmarketing.netlify.app.

## What lives where

- `src/` — React app (Hero, Locations, Pricing, etc.)
- `public/` — static assets, served as-is
- `netlify/functions/` — Netlify serverless functions
- `supabase/functions/` — Supabase edge functions
- `supabase/migrations/` — DB schema
- `netlify.toml` + `public/_redirects` — routing
- `.env` — local secrets (NOT in git)
- `.env.example` — template, safe to commit
