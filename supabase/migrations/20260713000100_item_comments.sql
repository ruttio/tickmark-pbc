-- =====================================================================
--  Migration 20260713000100: per-item two-way comment thread on each request item
--  (firm ⇄ client), separate from the one-shot `note` / return reason.
--  Versioned migration; depends on portal sharing.
--
--  The message bodies live here; posting a comment ALSO writes an
--  item_history row (action 'Commented') so it flows into the existing
--  activity feed + unread badges for free.
-- =====================================================================
create table if not exists item_comments (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references request_items(id) on delete cascade,
  engagement_id uuid not null references engagements(id) on delete cascade,
  by            text not null,                    -- 'Firm' | 'Client'
  author        text,                             -- firm member's name/email; null for the client
  body          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_comments_item on item_comments(item_id, created_at);

alter table item_comments enable row level security;

-- Firm staff may read/write comments on portals they're a member of.
-- Uses the membership model (my_portals(), from portal_members) to match
-- portal_items / portal_files / portal_history after migration_portal_sharing.
-- (Clients read/write via the portal Edge Function with the service role,
--  gated by their session token — they need no policy of their own.)
drop policy if exists firm_comments on item_comments;
create policy firm_comments on item_comments
  for all using (engagement_id in (select my_portals()))
  with check (engagement_id in (select my_portals()));
