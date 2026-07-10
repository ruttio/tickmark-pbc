-- =====================================================================
--  Client Groups — one link + one 16-digit code for several company
--  portals. A grouped engagement is reached ONLY through its group link
--  (its individual ?e= link is disabled by the edge function).
--
--  Idempotent: safe to re-run. Paste into the Supabase SQL editor.
-- =====================================================================

-- 1. Groups ------------------------------------------------------------
create table if not exists client_groups (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references firms(id) on delete cascade,
  name          text not null,
  passcode_hash text not null,                 -- bcrypt of the 16-digit group code
  expires_at    timestamptz,                   -- null = never expires
  created_at    timestamptz not null default now()
);
create index if not exists idx_client_groups_firm on client_groups(firm_id);

-- 2. Engagements can belong to a group (null = standalone) -------------
alter table engagements add column if not exists group_id uuid references client_groups(id) on delete set null;
create index if not exists idx_engagements_group on engagements(group_id);

-- 3. Sessions can be group-scoped (group_id set, engagement_id null) ----
alter table portal_sessions add column if not exists group_id uuid references client_groups(id) on delete cascade;
alter table portal_sessions alter column engagement_id drop not null;
create index if not exists idx_sessions_group on portal_sessions(group_id);

-- 4. Brute-force throttle for the group unlock endpoint ----------------
create table if not exists group_unlock_throttle (
  group_id     uuid primary key references client_groups(id) on delete cascade,
  failed       int not null default 0,
  locked_until timestamptz
);

-- 5. RLS — firm staff manage their own groups; sessions/throttle are
--    service-role only (deny all), like the per-portal tables. ---------
alter table client_groups        enable row level security;
alter table group_unlock_throttle enable row level security;  -- no policy => deny all but service role

drop policy if exists firm_groups on client_groups;
create policy firm_groups on client_groups
  for all using (firm_id = my_firm()) with check (firm_id = my_firm());

-- 6. RPCs (security definer) — mirror the per-portal code helpers so the
--    raw 16-digit code never leaves the DB. ----------------------------

-- Firm: create a group. Returns the new group id.
create or replace function create_client_group(p_name text, p_code text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_firm uuid; v_id uuid;
begin
  if length(regexp_replace(p_code, '\D', '', 'g')) <> 16 then
    raise exception 'group code must be exactly 16 digits';
  end if;
  select firm_id into v_firm from profiles where id = auth.uid() and approved;
  if v_firm is null then raise exception 'account is pending approval (or no firm profile)'; end if;

  insert into client_groups(firm_id, name, passcode_hash)
  values (v_firm, coalesce(nullif(trim(p_name), ''), 'กลุ่มลูกค้า'), crypt(p_code, gen_salt('bf')))
  returning id into v_id;
  return v_id;
end; $$;

-- Firm: reset a group's code.
create or replace function set_group_code(p_group uuid, p_code text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(regexp_replace(p_code, '\D', '', 'g')) <> 16 then
    raise exception 'group code must be exactly 16 digits';
  end if;
  update client_groups
     set passcode_hash = crypt(p_code, gen_salt('bf'))
   where id = p_group
     and firm_id = (select firm_id from profiles where id = auth.uid());
  if not found then raise exception 'group not found for this firm'; end if;
end; $$;

-- Called by the Edge Function (service role) to check a group code.
create or replace function verify_group_code(p_group uuid, p_code text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean;
begin
  select (passcode_hash = crypt(p_code, passcode_hash))
         and (expires_at is null or expires_at > now())
    into ok
    from client_groups where id = p_group;
  return coalesce(ok, false);
end; $$;

-- Firm: assign an engagement to a group (or null to un-assign). Both the
-- engagement and the group must belong to the caller's firm.
create or replace function set_engagement_group(p_engagement uuid, p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_firm uuid;
begin
  select firm_id into v_firm from profiles where id = auth.uid() and approved;
  if v_firm is null then raise exception 'account is pending approval (or no firm profile)'; end if;
  if p_group is not null and not exists (select 1 from client_groups where id = p_group and firm_id = v_firm) then
    raise exception 'group not found for this firm';
  end if;
  update engagements set group_id = p_group where id = p_engagement and firm_id = v_firm;
  if not found then raise exception 'engagement not found for this firm'; end if;
end; $$;
