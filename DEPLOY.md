# Deploying Tickmark PBC portal (Cloudflare Pages)

The app is a **static Vite site** with two entries — `index.html` (firm) and
`client.html` (client) — talking to a separately deployed Supabase backend.
Hosting is just static files; there is no Node server to run.

```
www.tickmark-pbc.com  ──>  Cloudflare Pages (serves dist/)  ──>  Supabase
                                                                 (per environment)
```

---

## 1. Push the repo to GitHub

```bash
git add .
git commit -m "…"
git remote add origin https://github.com/<you>/tickmark-pbc.git
git branch -M main
git push -u origin main
```

`.gitignore` keeps `.env.local`, `node_modules`, and `dist` out of the repo.

## 2. Create the Cloudflare Pages project

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**
2. Pick the `tickmark-pbc` repo
3. Build settings:
   | Field | Value |
   |-------|-------|
   | Framework preset | **Vite** (or *None*) |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Node version | 18+ (set `NODE_VERSION=20` env var if needed) |
4. **Environment variables** (Settings → Environment variables → Production *and* Preview):
   ```
   VITE_SUPABASE_URL       = https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY  = <anon public key>
   ```
   These are public (RLS-gated) and get inlined into the build by Vite. Use a
   staging Supabase project for Preview deployments; do not point previews at
   production.
5. **Save and Deploy.** You get a `*.pages.dev` URL. Both `/` (firm) and
   `/client.html?e=…` (client) work because it's a multi-page build.

> Every `git push` to `main` redeploys automatically; PRs get preview URLs.

## 3. Custom domain

1. Cloudflare Pages project → **Custom domains → Set up a domain**
2. Add **`www.tickmark-pbc.com`** (and `tickmark-pbc.com`, redirected to www).
3. If the domain's DNS is on Cloudflare, records are added automatically.
   Otherwise add the `CNAME` Cloudflare shows. SSL is issued automatically.

Cheapest path: buy the domain at **Cloudflare Registrar** (at-cost) so domain +
DNS + hosting all live in one dashboard.

## 4. Supabase backend deployment

Database changes live in `supabase/migrations/`, while Edge Function JWT rules
live in `supabase/config.toml`. The workflow `.github/workflows/deploy-backend.yml`
applies migrations first, deploys all functions second, then performs read-only
smoke tests.

Create a GitHub Environment named **`production`** with:

| Type | Name | Value |
|------|------|-------|
| Secret | `SUPABASE_ACCESS_TOKEN` | Supabase personal access token |
| Secret | `SUPABASE_PROJECT_ID` | Production project reference |
| Secret | `SUPABASE_DB_PASSWORD` | Production database password |
| Secret | `SUPABASE_ANON_KEY` | Production public anon key |
| Secret | `PURGE_SECRET` | Same value configured on the purge function |
| Variable | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| Variable | `SUPABASE_MIGRATIONS_BASELINED` | `true` only after baseline |

For the existing production project, complete
`supabase/BASELINE.md` before setting the baseline variable. The deployment
workflow intentionally fails before touching production until this is done.

The scheduled keep-alive and purge workflows use the same `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `PURGE_SECRET` configuration rather than hardcoded
project credentials.

## 5. Supabase production hardening (do before real clients)

| Setting | Where | Why |
|---------|-------|-----|
| **Re-enable "Confirm email"** | Auth → Sign In / Providers → Email | we turned it off only for local testing |
| **Site URL** = `https://www.tickmark-pbc.com` | Auth → URL Configuration | confirmation / reset links point to prod |
| **Redirect URLs** add the prod domain | Auth → URL Configuration | OAuth/magic-link callbacks |
| **Custom SMTP** (Resend / SendGrid / SES) | Auth → SMTP | built-in email is rate-limited to a few/hour |
| **Pro plan** ($25/mo) | Billing | no pausing + daily backups (matters for client docs) |
| Tighten **CORS** to the prod origin | edit `supabase/functions/portal/index.ts` then redeploy | currently `*` |

### R2 bucket CORS is a *separate* allowlist — and it is not in this repo

Uploads do not go through the Edge Functions. The function only mints a
presigned URL; the browser then PUTs the bytes **straight to R2**, so that
request is governed by the **bucket's own CORS policy**, configured by hand in
Cloudflare → R2 → bucket `pbc` → Settings → CORS Policy. Nothing in this
repository can change it, and nothing here records what is in it.

Every origin that uploads must be listed there, including dev ones. The
symptom when an origin is missing is a bare **`Failed to fetch`** at the moment
of upload — no server error, no log line anywhere, because the browser blocks
the request before it is sent.

This is why `.claude/launch.json` pins the dev server to **5173**: that port is
in the bucket's allowlist. Moving the dev port (as commit `a748a6f` did, to
5199) silently breaks every upload until the new origin is added in Cloudflare.
Change the port only together with the bucket policy.

To lock CORS down later, change `Access-Control-Allow-Origin` in the functions
to `https://www.tickmark-pbc.com` and redeploy all functions:
```bash
supabase functions deploy --project-ref <project-ref>
```

## 6. Keep-alive (only needed while on the free plan)

`.github/workflows/keepalive.yml` pings the DB daily so a free-tier project never
pauses. It activates once the repo is on GitHub (Actions tab → enable). On Pro
this is unnecessary — Pro projects don't pause.

---

### Notes
- **No SSR / API routes** — pure static, so Cloudflare Pages' free tier (commercial
  use allowed, unlimited bandwidth) fits well.
- The Supabase **Edge Function** is deployed separately via the Supabase CLI, *not*
  by Cloudflare — Cloudflare only serves the frontend.
