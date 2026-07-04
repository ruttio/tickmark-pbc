-- =====================================================================
--  LINE notifications — firm links a LINE chat; client uploads push there.
--  Idempotent. Run once in the SQL editor.
-- =====================================================================
alter table firms add column if not exists line_target text;      -- linked userId/groupId
alter table firms add column if not exists line_link_code text;    -- one-time linking code

-- generate a fresh linking code for the caller's firm
create or replace function line_generate_code() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_firm uuid; v_code text;
begin
  select firm_id into v_firm from profiles where id = auth.uid() and approved;
  if v_firm is null then raise exception 'account is pending approval'; end if;
  v_code := 'TM-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  update firms set line_link_code = v_code where id = v_firm;
  return v_code;
end; $$;

-- current LINE link status for the caller's firm
create or replace function line_status() returns table(linked boolean, code text)
language sql stable security definer set search_path = public as $$
  select (f.line_target is not null) as linked, f.line_link_code as code
  from firms f join profiles p on p.firm_id = f.id
  where p.id = auth.uid()
$$;

-- disconnect LINE for the caller's firm
create or replace function line_unlink() returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid;
begin
  select firm_id into v_firm from profiles where id = auth.uid() and approved;
  update firms set line_target = null, line_link_code = null where id = v_firm;
end; $$;
