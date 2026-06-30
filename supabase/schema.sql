-- =====================================================================
--  Tickmark PBC portal — Supabase backend schema
--  Run this in the Supabase SQL editor (or via `supabase db push`).
--
--  Security model in one paragraph:
--    • Firm staff sign in with Supabase Auth. Row Level Security (RLS)
--      limits them to engagements belonging to their own firm.
--    • Clients DO NOT touch the database directly. They go through the
--      `portal` Edge Function, which verifies the 16-digit code on the
--      server (bcrypt), issues a short-lived session token, and performs
--      every read/upload with the service role. So the anon key can read
--      nothing sensitive — RLS denies it by default.
-- =====================================================================

create extension if not exists pgcrypto;   -- bcrypt for the passcode
create extension if not exists pg_cron;    -- scheduled auto-delete

-- ---------------------------------------------------------------------
--  Core tables
-- ---------------------------------------------------------------------
create table if not exists firms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- One row per firm-staff user, linked to the Supabase Auth user.
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  firm_id     uuid not null references firms(id) on delete cascade,
  full_name   text,
  approved    boolean not null default false,   -- admin must approve before use
  created_at  timestamptz not null default now()
);
-- for existing databases (idempotent):
alter table profiles add column if not exists approved boolean not null default false;

-- A portal = one engagement for one client.
create table if not exists engagements (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references firms(id) on delete cascade,
  client        text not null,
  template      text not null,
  period_end    date,
  passcode_hash text not null,                       -- bcrypt hash of the 16-digit code
  expires_at    timestamptz,                         -- null = never expires
  auto_delete   boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists idx_engagements_firm    on engagements(firm_id);
create index if not exists idx_engagements_expiry   on engagements(expires_at) where auto_delete;

create table if not exists request_items (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  ref           text,
  category      text not null default 'General',
  description   text not null,
  required      boolean not null default true,
  due_date      date,
  status        text not null default 'outstanding',  -- outstanding|submitted|review|accepted|returned
  note          text default '',                       -- return reason (shown to the client)
  firm_note     text not null default '',              -- firm's note/instruction for this item (shown to the client)
  sort          int  not null default 0
);
create index if not exists idx_items_engagement on request_items(engagement_id);
-- for existing databases (idempotent):
alter table request_items add column if not exists firm_note text not null default '';

create table if not exists item_files (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references request_items(id) on delete cascade,
  engagement_id uuid not null references engagements(id) on delete cascade,
  name          text not null,
  size          bigint not null,
  type          text,
  storage_path  text not null,                        -- e.g. {engagement_id}/{item_id}/{filename}
  uploaded_at   timestamptz not null default now()
);
create index if not exists idx_files_item on item_files(item_id);

create table if not exists item_history (
  id       uuid primary key default gen_random_uuid(),
  item_id  uuid not null references request_items(id) on delete cascade,
  at       timestamptz not null default now(),
  by       text not null,                              -- 'Firm' | 'Client'
  action   text not null
);

-- Short-lived client sessions, created after a correct 16-digit code.
create table if not exists portal_sessions (
  token_hash    text primary key,                     -- sha256 of the opaque token we hand the client
  engagement_id uuid not null references engagements(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index if not exists idx_sessions_eng on portal_sessions(engagement_id);

-- Brute-force throttle for the unlock endpoint.
create table if not exists unlock_throttle (
  engagement_id uuid primary key references engagements(id) on delete cascade,
  failed        int not null default 0,
  locked_until  timestamptz
);

-- ---------------------------------------------------------------------
--  Auth bootstrap: create a firm + profile automatically on signup.
--  Pass firm_name / full_name in the signup metadata.
-- ---------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_firm uuid;
begin
  insert into firms(name)
    values (coalesce(new.raw_user_meta_data->>'firm_name', 'My Firm'))
    returning id into v_firm;
  insert into profiles(id, firm_id, full_name)
    values (new.id, v_firm, new.raw_user_meta_data->>'full_name');
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------
--  RPCs (security definer) — hashing/verification happen inside the DB,
--  so the raw 16-digit code never travels further than this function.
-- ---------------------------------------------------------------------

-- Firm staff: create a portal. Returns the new engagement id.
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
  values (
    v_firm, p_client, p_template, p_period_end,
    crypt(p_code, gen_salt('bf')),
    case when p_retention_days is null then null
         else now() + make_interval(days => p_retention_days) end,
    coalesce(p_auto_delete, true)
  )
  returning id into v_id;
  return v_id;
end; $$;

-- Firm staff: change a portal's 16-digit code.
create or replace function set_portal_code(p_engagement uuid, p_code text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(regexp_replace(p_code, '\D', '', 'g')) <> 16 then
    raise exception 'passcode must be exactly 16 digits';
  end if;
  update engagements
     set passcode_hash = crypt(p_code, gen_salt('bf'))
   where id = p_engagement
     and firm_id = (select firm_id from profiles where id = auth.uid());
  if not found then raise exception 'engagement not found for this firm'; end if;
end; $$;

-- Called by the Edge Function (service role) to check a code.
create or replace function verify_portal_code(p_engagement uuid, p_code text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean;
begin
  select (passcode_hash = crypt(p_code, passcode_hash))
         and (expires_at is null or expires_at > now())
    into ok
    from engagements where id = p_engagement;
  return coalesce(ok, false);
end; $$;

-- ---------------------------------------------------------------------
--  Row Level Security — firm staff only. Clients never hit these tables
--  directly (the Edge Function uses the service role, which bypasses RLS).
-- ---------------------------------------------------------------------
alter table firms           enable row level security;
alter table profiles        enable row level security;
alter table engagements     enable row level security;
alter table request_items   enable row level security;
alter table item_files      enable row level security;
alter table item_history    enable row level security;
alter table portal_sessions enable row level security;  -- no policies => deny all but service role
alter table unlock_throttle enable row level security;  -- same

-- helper: the caller's firm
create or replace function my_firm() returns uuid language sql stable security definer set search_path = public as $$
  select firm_id from profiles where id = auth.uid() and approved
$$;

drop policy if exists own_profile on profiles;
create policy own_profile on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists member_firm on firms;
create policy member_firm on firms
  for select using (id = my_firm());

drop policy if exists firm_engagements on engagements;
create policy firm_engagements on engagements
  for all using (firm_id = my_firm()) with check (firm_id = my_firm());

drop policy if exists firm_items on request_items;
create policy firm_items on request_items
  for all using (engagement_id in (select id from engagements where firm_id = my_firm()))
  with check (engagement_id in (select id from engagements where firm_id = my_firm()));

drop policy if exists firm_files on item_files;
create policy firm_files on item_files
  for all using (engagement_id in (select id from engagements where firm_id = my_firm()))
  with check (engagement_id in (select id from engagements where firm_id = my_firm()));

drop policy if exists firm_history on item_history;
create policy firm_history on item_history
  for all using (item_id in (
    select i.id from request_items i
    join engagements e on e.id = i.engagement_id
    where e.firm_id = my_firm()))
  with check (item_id in (
    select i.id from request_items i
    join engagements e on e.id = i.engagement_id
    where e.firm_id = my_firm()));

-- ---------------------------------------------------------------------
--  Storage: a private bucket called "pbc".
--  Create it once in the dashboard (Storage > New bucket, name = pbc,
--  Public = OFF), or with the SQL below.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('pbc', 'pbc', false)
  on conflict (id) do nothing;

-- Firm staff may read files under their own engagements' folders.
-- Path convention: {engagement_id}/{item_id}/{filename}
drop policy if exists firm_read_pbc on storage.objects;
create policy firm_read_pbc on storage.objects
  for select using (
    bucket_id = 'pbc'
    and (storage.foldername(name))[1] in (
      select id::text from engagements where firm_id = my_firm()
    )
  );

-- (Clients upload via signed URLs minted by the Edge Function, so they
--  need no storage policy of their own.)

-- ---------------------------------------------------------------------
--  90-day auto-delete: nightly purge of expired auto-delete portals.
--  Deletes the storage objects first, then the engagement row (which
--  cascades items/files/history/sessions).
-- ---------------------------------------------------------------------
create or replace function purge_expired_portals() returns void
language plpgsql security definer set search_path = public, storage as $$
begin
  delete from storage.objects
   where bucket_id = 'pbc'
     and (storage.foldername(name))[1] in (
       select id::text from engagements
        where auto_delete and expires_at is not null and expires_at < now()
     );

  delete from engagements
   where auto_delete and expires_at is not null and expires_at < now();
end; $$;

-- Unschedule first so re-running this script doesn't error on a duplicate job.
do $$
begin
  perform cron.unschedule('purge-expired-portals');
exception when others then null;  -- job didn't exist yet
end $$;

select cron.schedule(
  'purge-expired-portals',
  '0 3 * * *',                         -- every day at 03:00 UTC
  $$ select purge_expired_portals(); $$
);

-- Done.
