-- =====================================================================
--  Migration 20260720130000: the reminder dedupe key gains the portal period.
--
--  WHY: 20260720120000_periods.sql lets one engagement carry many periods
--  (monthly cadence — one long-lived portal, months appended to it).
--  notify_log's UNIQUE constraint predates that: it is
--  (engagement_id, kind, period), where `period` is only the Bangkok-local
--  SEND month (bangkokPeriod() in _shared/reminders.ts), with no notion of
--  which portal period the email was actually about.
--
--  That is now the wrong key. Failure mode: a portal has two periods open
--  at once (e.g. the firm opens next month early while a late reopen of
--  last month is still outstanding). The automated sweep sends an email
--  about period A and claims (engagement, kind, month) for the whole
--  calendar month. Minutes or days later, period B's own items become due
--  — but the slot for (engagement, kind, month) is already taken, so B's
--  email is silently swallowed as "already sent", even though the client
--  was never told about B at all. See notify/index.ts, now rewritten to
--  enumerate (engagement, open period) pairs and dedupe/send per period.
--
--  `period_key` here mirrors periods.period_key's own machine-key
--  convention (e.g. '2026-07'). It is NOT NULL with a '' sentinel — never
--  nullable — for the one kind that is not period-scoped ('invite': a
--  portal-level "come upload" email, not tied to one month's items).
--  Postgres UNIQUE constraints treat every NULL as distinct from every
--  other NULL, so a nullable column would silently stop deduping invite
--  sends against each other (two NULL rows never collide). '' is a real,
--  self-equal value, so the invite dedupe keeps working exactly as before
--  this migration.
--
--  The Bangkok-local `period` column (send month) stays in the key
--  alongside period_key, it is not replaced by it: a portal period can
--  legitimately stay open for more than one calendar month (a late
--  client), and a reminder that went unanswered in July should still be
--  allowed to re-fire in August for the SAME portal period. Dropping
--  `period` from the key would wrongly suppress that re-nag forever.
--
--  The UNIQUE constraint remains the race guard (never weakened to an
--  application-level check) — see 20260715000200_notify_log.sql for why a
--  SELECT-then-INSERT check is unsafe here.
-- =====================================================================

alter table notify_log add column if not exists period_key text not null default '';

-- Swap the old 3-column unique constraint for the new 4-column one.
-- Written to be safely re-runnable: if the target constraint already
-- exists (a prior run of this same migration), do nothing.
do $$
declare
  v_old_constraint text;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'notify_log'::regclass
       and conname = 'notify_log_engagement_id_kind_period_period_key_key'
  ) then
    -- Drop whatever unique constraint currently sits on the table (the
    -- pre-migration (engagement_id, kind, period) one). There is exactly
    -- one to find on first run; none on a re-run, since it was already
    -- replaced.
    select conname into v_old_constraint
      from pg_constraint
     where conrelid = 'notify_log'::regclass
       and contype = 'u';

    if v_old_constraint is not null then
      execute format('alter table notify_log drop constraint %I', v_old_constraint);
    end if;

    alter table notify_log
      add constraint notify_log_engagement_id_kind_period_period_key_key
      unique (engagement_id, kind, period, period_key);
  end if;
end $$;

create index if not exists idx_notify_log_period_key on notify_log(engagement_id, period_key);
