# Tickmark PBC — Supabase backend

The backend is managed as versioned database migrations plus five Edge
Functions. Do not paste schema changes into the production SQL editor after
adopting this workflow; create a new file under `supabase/migrations/` instead.

## Repository layout

```text
supabase/
  config.toml                  JWT policy for every Edge Function
  migrations/                 ordered database history (source of truth)
  functions/
    portal/                    client code/session gateway
    firmfiles/                 authenticated firm-side R2 operations
    notify/                    authenticated client email delivery
    line-webhook/              public LINE webhook, signature verified
    purge/                     public scheduler endpoint, secret verified
    _shared/                   R2 and LINE helpers
```

`supabase/config.toml` deliberately disables JWT verification only for
`portal`, `line-webhook`, and `purge`. Those endpoints perform their own code,
signature, or secret checks. `firmfiles` and `notify` require a firm JWT.

## Fresh environment

Prerequisites: Docker and the Supabase CLI.

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push --dry-run
supabase db push
supabase functions deploy --project-ref <project-ref>
```

For local development, start Supabase and rebuild the database from the full
migration history:

```bash
supabase start
npm run db:reset
```

The CI migration job performs the same clean rebuild on every pull request.

## Edge Function secrets

Set these in each Supabase environment before deploying functions:

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
RESEND_API_KEY
NOTIFY_FROM
APP_URL
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
PURGE_SECRET
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
provided automatically to hosted Edge Functions.

## Existing production database

Production was originally changed through manually-run SQL files, so its
migration history must be reconciled once before enabling automatic deploys.
Follow [BASELINE.md](./BASELINE.md). The deploy workflow refuses to run until
the repository variable `SUPABASE_MIGRATIONS_BASELINED` equals `true`.

## Deployment order

The production workflow always performs:

1. repository structure verification;
2. migration baseline guard;
3. `supabase db push --dry-run`;
4. `supabase db push`;
5. deploy all Edge Functions using `config.toml`;
6. read-only REST and `portal` health checks.

Database changes are applied before functions so newly-deployed code never
depends on a table or RPC that has not been created yet. The frontend is built
separately by Cloudflare Pages after its own CI checks pass.

## R2 purge ownership

Files live in Cloudflare R2. Migration `20260713000400` disables the legacy
Postgres cron purge because it could delete database rows without deleting R2
objects. `.github/workflows/purge.yml` calls the guarded `purge` Edge Function,
which deletes R2 objects first and database rows second.
