-- =====================================================================
--  LINE notifications (PER USER) — each user links their own LINE chat and
--  gets notified for portals they're a member of. Idempotent; run once.
-- =====================================================================
alter table profiles add column if not exists line_target text;      -- this user's linked userId/groupId
alter table profiles add column if not exists line_link_code text;   -- one-time linking code

-- (firm-level columns from the earlier version are no longer used)

-- generate a fresh linking code for the current user
create or replace function line_generate_code() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_code text;
begin
  if not exists (select 1 from profiles where id = auth.uid() and approved) then
    raise exception 'account is pending approval';
  end if;
  v_code := 'TM-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  update profiles set line_link_code = v_code where id = auth.uid();
  return v_code;
end; $$;

-- current LINE link status for the current user
create or replace function line_status() returns table(linked boolean, code text)
language sql stable security definer set search_path = public as $$
  select (line_target is not null) as linked, line_link_code as code
  from profiles where id = auth.uid()
$$;

-- disconnect LINE for the current user
create or replace function line_unlink() returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set line_target = null, line_link_code = null where id = auth.uid();
end; $$;
