-- =====================================================================
--  Record WHO performed a firm-side item action (accept / reopen /
--  return / review / note) so the activity feed can show it.
--  Idempotent: safe to re-run.
-- =====================================================================
alter table item_history add column if not exists actor text;   -- firm member's name/email; null for client + legacy rows
