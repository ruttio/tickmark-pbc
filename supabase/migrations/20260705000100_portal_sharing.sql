-- =====================================================================
--  Per-portal sharing migration (20260705000100) — access becomes membership-based.
--  Versioned migration; preserves existing access (current firm staff are
--  backfilled as owners of their firm's portals). Run once in the SQL editor.
-- =====================================================================

-- 1) membership table --------------------------------------------------
create table if not exists portal_members (
  engagement_id uuid not null references engagements(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'member',   -- 'owner' | 'member'
  can_delete    boolean not null default false,    -- members may delete items only when true
  created_at    timestamptz not null default now(),
  primary key (engagement_id, user_id)
);
alter table portal_members enable row level security;
create index if not exists idx_portal_members_user on portal_members(user_id);

-- 2) backfill: current firm staff become owners of their firm's portals
insert into portal_members (engagement_id, user_id, role)
select e.id, p.id, 'owner'
from engagements e join profiles p on p.firm_id = e.firm_id
on conflict (engagement_id, user_id) do nothing;

-- 3) helpers (security definer => bypass RLS, avoids policy recursion) --
create or replace function my_portals() returns setof uuid
language sql stable security definer set search_path = public as $$
  select pm.engagement_id from portal_members pm
   where pm.user_id = auth.uid()
     and exists (select 1 from profiles p where p.id = auth.uid() and p.approved)
$$;

create or replace function my_portal_role(p_engagement uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from portal_members where engagement_id = p_engagement and user_id = auth.uid()
$$;

create or replace function my_portal_perms(p_engagement uuid)
returns table(role text, can_delete boolean)
language sql stable security definer set search_path = public as $$
  select role, can_delete from portal_members where engagement_id = p_engagement and user_id = auth.uid()
$$;

-- 4) replace firm-based policies with portal-membership ones -----------
drop policy if exists firm_engagements on engagements;
drop policy if exists portal_engagements on engagements;
drop policy if exists portal_engagements_select on engagements;
drop policy if exists portal_engagements_update on engagements;
drop policy if exists portal_engagements_delete on engagements;
create policy portal_engagements_select on engagements for select using (id in (select my_portals()));
create policy portal_engagements_update on engagements for update
  using (id in (select my_portals())) with check (id in (select my_portals()));
-- delete a portal: owner only
create policy portal_engagements_delete on engagements for delete using (my_portal_role(id) = 'owner');

drop policy if exists firm_items on request_items;
drop policy if exists portal_items on request_items;
create policy portal_items on request_items for all
  using (engagement_id in (select my_portals())) with check (engagement_id in (select my_portals()));

drop policy if exists firm_files on item_files;
drop policy if exists portal_files on item_files;
create policy portal_files on item_files for all
  using (engagement_id in (select my_portals())) with check (engagement_id in (select my_portals()));

drop policy if exists firm_history on item_history;
drop policy if exists portal_history on item_history;
create policy portal_history on item_history for all
  using (item_id in (select i.id from request_items i where i.engagement_id in (select my_portals())))
  with check (item_id in (select i.id from request_items i where i.engagement_id in (select my_portals())));

drop policy if exists portal_members_select on portal_members;
create policy portal_members_select on portal_members for select
  using (engagement_id in (select my_portals()));
-- (writes to portal_members go only through the owner-gated RPCs below)

-- 5) storage: folder engagement_id must be a portal I belong to --------
drop policy if exists firm_read_pbc on storage.objects;
create policy firm_read_pbc on storage.objects for select
  using (bucket_id = 'pbc' and (storage.foldername(name))[1] in (select mp::text from my_portals() mp));
drop policy if exists firm_write_pbc on storage.objects;
create policy firm_write_pbc on storage.objects for insert
  with check (bucket_id = 'pbc' and (storage.foldername(name))[1] in (select mp::text from my_portals() mp));
drop policy if exists firm_delete_pbc on storage.objects;
create policy firm_delete_pbc on storage.objects for delete
  using (bucket_id = 'pbc' and (storage.foldername(name))[1] in (select mp::text from my_portals() mp));

-- 6) create_engagement: the creator becomes the portal owner ----------
create or replace function create_engagement(
  p_client text, p_template text, p_period_end date,
  p_code text, p_retention_days int, p_auto_delete boolean
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_firm uuid; v_id uuid;
begin
  if length(regexp_replace(p_code, '\D', '', 'g')) <> 16 then
    raise exception 'passcode must be exactly 16 digits';
  end if;
  select firm_id into v_firm from profiles where id = auth.uid() and approved;
  if v_firm is null then raise exception 'account is pending approval (or no firm profile)'; end if;
  insert into engagements(firm_id, client, template, period_end, passcode_hash, expires_at, auto_delete)
  values (v_firm, p_client, p_template, p_period_end, crypt(p_code, gen_salt('bf')),
    case when p_retention_days is null then null else now() + make_interval(days => p_retention_days) end,
    coalesce(p_auto_delete, true))
  returning id into v_id;
  insert into portal_members(engagement_id, user_id, role) values (v_id, auth.uid(), 'owner');
  return v_id;
end; $$;

-- 7) member-management RPCs (owner-gated) ------------------------------
create or replace function add_portal_member(p_engagement uuid, p_email text, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  if my_portal_role(p_engagement) <> 'owner' then raise exception 'only the portal owner can add members'; end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then raise exception 'ยังไม่มีบัญชีอีเมลนี้ — ให้ผู้ใช้สมัคร (และรออนุมัติ) ก่อน'; end if;
  insert into portal_members(engagement_id, user_id, role)
    values (p_engagement, v_uid, case when p_role = 'owner' then 'owner' else 'member' end)
    on conflict (engagement_id, user_id) do update set role = excluded.role;
end; $$;

create or replace function set_portal_member(p_engagement uuid, p_user uuid, p_role text, p_can_delete boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if my_portal_role(p_engagement) <> 'owner' then raise exception 'only the portal owner can change roles'; end if;
  update portal_members
     set role = case when p_role = 'owner' then 'owner' else 'member' end,
         can_delete = coalesce(p_can_delete, false)
   where engagement_id = p_engagement and user_id = p_user;
end; $$;

create or replace function remove_portal_member(p_engagement uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if my_portal_role(p_engagement) <> 'owner' then raise exception 'only the portal owner can remove members'; end if;
  if p_user = auth.uid() then raise exception 'cannot remove yourself'; end if;
  delete from portal_members where engagement_id = p_engagement and user_id = p_user;
end; $$;

create or replace function list_portal_members(p_engagement uuid)
returns table(user_id uuid, email text, role text, can_delete boolean)
language sql stable security definer set search_path = public as $$
  select pm.user_id, u.email, pm.role, pm.can_delete
  from portal_members pm join auth.users u on u.id = pm.user_id
  where pm.engagement_id = p_engagement
    and p_engagement in (select my_portals())
  order by (pm.role = 'owner') desc, u.email
$$;
