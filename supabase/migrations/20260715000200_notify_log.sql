-- =====================================================================
--  Migration 20260715000200: notify_log — dedupe ledger for automatic
--  reminder emails (see supabase/functions/notify/index.ts).
--
--  Why a UNIQUE constraint and not just an application-level check:
--  the automated sweep (GitHub Actions cron) and a human clicking "send" in
--  the firm UI can race — two overlapping invocations of the `notify`
--  function must not both mail the client. A SELECT-then-INSERT check in
--  application code has a TOCTOU gap; a UNIQUE constraint does not, because
--  Postgres itself serializes the conflicting inserts and only one can win.
--
--  Dedupe key = (engagement_id, kind, period). `period` is the Bangkok-local
--  "YYYY-MM" the send counts against (computed in the Edge Function —
--  bangkokPeriod() in _shared/reminders.ts) so a reminder already sent for
--  July does not block the reminder that becomes due in August. `kind`
--  keeps 'returned' and 'reminder' emails independent of each other, since
--  both can legitimately be true for the same engagement in the same month.
--
--  Idempotent, following repo convention (see 20260629000100_initial_schema.sql).
-- =====================================================================

create table if not exists notify_log (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  kind          text not null,                 -- 'invite' | 'returned' | 'reminder'
  period        text not null,                 -- Bangkok-local 'YYYY-MM', the dedupe window
  sent_at       timestamptz not null default now(),
  sent_by       uuid references auth.users(id) on delete set null,  -- null = automated (cron sweep)
  item_count    int,                            -- items listed in the email, for a future "last reminded" UI
  unique (engagement_id, kind, period)
);
create index if not exists idx_notify_log_engagement on notify_log(engagement_id);

-- ---------------------------------------------------------------------
--  RLS: firm staff may READ the log for portals they belong to (so the UI
--  can later show "last reminded on…"). All writes go through the `notify`
--  Edge Function's service role, which bypasses RLS — there is deliberately
--  no insert/update/delete policy here.
-- ---------------------------------------------------------------------
alter table notify_log enable row level security;

drop policy if exists portal_notify_log_select on notify_log;
create policy portal_notify_log_select on notify_log
  for select using (engagement_id in (select my_portals()));
