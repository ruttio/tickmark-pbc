# One-time production migration baseline

Use this only for the existing production project whose SQL files were applied
manually before `supabase/migrations/` became the source of truth. A fresh
project must use `supabase db push` and must not repair migrations as applied.

## 1. Protect and inspect production

1. Confirm a recent database backup exists.
2. Pause schema changes through the Dashboard/SQL editor.
3. Link the intended project and inspect history:

```bash
supabase login
supabase link --project-ref <production-project-ref>
supabase migration list
```

Verify that production already contains the feature objects represented by the
first eight migrations: `portal_members`, `client_groups`, `item_comments`,
`item_reads`, the LINE profile columns/RPCs, and `firm_analytics`. If any are
missing, stop and apply/reconcile that migration instead of marking it applied.

## 2. Record the already-applied history

Run each command only after the corresponding production objects have been
verified:

```bash
supabase migration repair --status applied 20260629000100
supabase migration repair --status applied 20260705000100
supabase migration repair --status applied 20260705000200
supabase migration repair --status applied 20260712000100
supabase migration repair --status applied 20260712000200
supabase migration repair --status applied 20260713000100
supabase migration repair --status applied 20260713000200
supabase migration repair --status applied 20260713000300
```

Do not mark `20260713000400` as applied. It is the first migration intentionally
deployed by the new workflow and disables the obsolete database cron purge.

## 3. Preview and apply the first managed migration

```bash
supabase migration list
supabase db push --dry-run
supabase db push
supabase functions deploy --project-ref <production-project-ref>
```

The dry run should list only `20260713000400_disable_legacy_pg_cron_purge.sql`.
If it lists any older migration, stop and reconcile the history before pushing.

## 4. Enable the guarded production workflow

In GitHub, create a `production` Environment and configure the secrets and
variables listed in `DEPLOY.md`. Set the repository/environment variable below
only after all prior steps succeed:

```text
SUPABASE_MIGRATIONS_BASELINED=true
```

Run `Deploy Supabase backend` manually once and verify its read-only smoke
tests. From that point onward, database changes must be new timestamped
migrations committed to Git; do not modify production schema directly.
