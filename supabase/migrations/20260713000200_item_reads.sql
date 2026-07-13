-- =====================================================================
--  Migration 20260713000200: per-item read marks for unread-comment notifications
--  that disappears once the item is opened. Per firm USER (each staff member
--  has their own read state).
-- =====================================================================
create table if not exists item_reads (
  item_id uuid not null references request_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (item_id, user_id)
);
alter table item_reads enable row level security;

-- A user manages only their own read-marks, on items in portals they belong to.
drop policy if exists own_item_reads on item_reads;
create policy own_item_reads on item_reads for all
  using (user_id = auth.uid()
    and item_id in (select id from request_items where engagement_id in (select my_portals())))
  with check (user_id = auth.uid()
    and item_id in (select id from request_items where engagement_id in (select my_portals())));

-- Mark an item's comments as read now (for the calling user).
create or replace function mark_item_read(p_item uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from request_items
    where id = p_item and engagement_id in (select my_portals())
  ) then
    return;  -- not my portal → no-op
  end if;
  insert into item_reads(item_id, user_id, seen_at)
  values (p_item, auth.uid(), now())
  on conflict (item_id, user_id) do update set seen_at = now();
end $$;

-- Items in an engagement that have CLIENT comments the caller hasn't read yet,
-- with the unread count per item.
create or replace function unread_comment_items(p_engagement uuid)
returns table(item_id uuid, n int)
language sql stable security definer set search_path = public as $$
  select ic.item_id, count(*)::int
  from item_comments ic
  join request_items i on i.id = ic.item_id
  left join item_reads ir on ir.item_id = ic.item_id and ir.user_id = auth.uid()
  where i.engagement_id = p_engagement
    and i.engagement_id in (select my_portals())          -- authz
    and ic.by = 'Client'
    and (ir.seen_at is null or ic.created_at > ir.seen_at)
  group by ic.item_id;
$$;
