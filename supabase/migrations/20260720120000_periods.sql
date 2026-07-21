-- =====================================================================
--  Periods migration (20260720120000) — a portal can now span many periods.
--
--  WHY: the firm's recurring work is monthly Thai bookkeeping + tax filing.
--  Modelling each month as its own engagement would mean ~12 portals per
--  client per year, each with its OWN 16-digit code — the client would have
--  to re-learn a code every month, and the firm dashboard would drown.
--  So a monthly client keeps ONE long-lived portal (one link, one code) and
--  months are appended to it as `periods`.
--
--  An annual audit engagement is simply a portal with exactly one period, so
--  there is no second code path anywhere: everything reads through periods.
--
--  Isolation is UNAFFECTED by this change. A client session is still pinned
--  to one engagement (portal_sessions.engagement_id); periods live strictly
--  inside that engagement, so no new cross-tenant surface is introduced.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1) The period table
-- ---------------------------------------------------------------------
create table if not exists periods (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  -- Sortable machine key, always Gregorian: '2026-07'. Display is Buddhist-era
  -- (see `label`) but NEVER sort or compare on the display string.
  period_key    text not null,
  label         text not null,                     -- 'ก.ค. 2569'
  period_end    date,
  due_date      date,                              -- statutory filing deadline
  -- 'open'   = the client may upload
  -- 'closed' = read-only for the client; the firm can reopen it
  status        text not null default 'open',
  closed_at     timestamptz,
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  unique (engagement_id, period_key)
);
create index if not exists idx_periods_engagement on periods(engagement_id, period_key desc);

-- Cadence drives the UI only (whether to offer "open next month" and the period
-- switcher). It is deliberately NOT a permission or a data-shape switch.
alter table engagements add column if not exists cadence text not null default 'once';  -- 'once' | 'monthly'

alter table request_items add column if not exists period_id uuid references periods(id) on delete cascade;
create index if not exists idx_items_period on request_items(period_id);

-- ---------------------------------------------------------------------
--  2) Backfill — every existing engagement becomes a single-period portal.
--     Idempotent: re-running adds nothing (guarded by the unique key and by
--     only touching items whose period_id is still null).
-- ---------------------------------------------------------------------
do $$
declare
  th_month text[] := array['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                           'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
begin
  insert into periods (engagement_id, period_key, label, period_end, status)
  select
    e.id,
    to_char(coalesce(e.period_end, e.created_at::date), 'YYYY-MM'),
    -- Thai display: abbreviated month + Buddhist year (Gregorian + 543).
    th_month[extract(month from coalesce(e.period_end, e.created_at::date))::int]
      || ' ' || (extract(year from coalesce(e.period_end, e.created_at::date))::int + 543)::text,
    e.period_end,
    'open'
  from engagements e
  on conflict (engagement_id, period_key) do nothing;

  -- Attach every orphan item to its engagement's (single) period.
  update request_items i
     set period_id = p.id
    from periods p
   where p.engagement_id = i.engagement_id
     and i.period_id is null;
end $$;

-- ---------------------------------------------------------------------
--  2b) Never let an item exist outside a period.
--
--  The client portal serves ONE period at a time, so an item with a null
--  period_id is invisible to the client while still looking perfectly
--  normal to the firm — a silent "I sent you that request" / "no you
--  didn't" bug, which is exactly the failure this product exists to end.
--
--  A trigger rather than an application-side default because writers are
--  not in lockstep: the frontend (Cloudflare) and the backend (this DB +
--  Edge Functions) deploy on separate pipelines, so there is always a
--  window where a not-yet-updated bundle inserts rows against an updated
--  schema. The invariant belongs where every writer meets.
-- ---------------------------------------------------------------------
create or replace function request_items_default_period()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.period_id is null then
    -- Newest OPEN period; fall back to the newest overall so an insert can
    -- never fail outright just because every month happens to be closed.
    select id into new.period_id
      from periods
     where engagement_id = new.engagement_id
     order by (status = 'open') desc, period_key desc
     limit 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_request_items_default_period on request_items;
create trigger trg_request_items_default_period
  before insert on request_items
  for each row execute function request_items_default_period();

-- ---------------------------------------------------------------------
--  3) RLS — same membership model as every other table here.
-- ---------------------------------------------------------------------
alter table periods enable row level security;
drop policy if exists portal_periods on periods;
create policy portal_periods on periods for all
  using (engagement_id in (select my_portals()))
  with check (engagement_id in (select my_portals()));

-- ---------------------------------------------------------------------
--  4) open_period — create the next period and carry the request list over.
--
--  The firm presses a button; this clones the previous period's live items
--  (archived ones are intentionally left behind) with their statuses reset.
--  Deliberately manual rather than scheduled: a month with nothing to collect
--  should not silently sprout an empty portal page in front of the client.
-- ---------------------------------------------------------------------
create or replace function open_period(
  p_engagement uuid,
  p_period_key text,
  p_label      text,
  p_period_end date default null,
  p_due_date   date default null,
  p_clone_from uuid default null      -- null = clone the most recent period
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_src uuid; v_sort int;
begin
  if p_engagement not in (select my_portals()) then
    raise exception 'not a member of this portal';
  end if;
  if coalesce(p_period_key, '') !~ '^\d{4}-\d{2}$' then
    raise exception 'period_key must look like 2026-07';
  end if;

  select coalesce(max(sort), -1) + 1 into v_sort from periods where engagement_id = p_engagement;

  insert into periods (engagement_id, period_key, label, period_end, due_date, sort)
  values (p_engagement, p_period_key, p_label, p_period_end, p_due_date, v_sort)
  returning id into v_id;

  -- Pick the source period to copy the request list from.
  v_src := p_clone_from;
  if v_src is null then
    select id into v_src from periods
     where engagement_id = p_engagement and id <> v_id
     order by period_key desc limit 1;
  end if;

  if v_src is not null then
    -- Guard against cloning across portals even if a bad id is passed in.
    if not exists (select 1 from periods where id = v_src and engagement_id = p_engagement) then
      raise exception 'source period is not in this portal';
    end if;
    insert into request_items (engagement_id, period_id, ref, category, description, required, due_date, status, sort)
    select p_engagement, v_id, i.ref, i.category, i.description, i.required, p_due_date, 'outstanding', i.sort
      from request_items i
     where i.period_id = v_src
       and i.archived_at is null
     order by i.sort;
  end if;

  return v_id;
end $$;

-- ---------------------------------------------------------------------
--  5) set_period_status — close a finished month (read-only for the client)
--     or reopen it when a late document turns up.
-- ---------------------------------------------------------------------
create or replace function set_period_status(p_period uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('open', 'closed') then
    raise exception 'status must be open or closed';
  end if;
  update periods
     set status = p_status,
         closed_at = case when p_status = 'closed' then now() else null end
   where id = p_period
     and engagement_id in (select my_portals());
  if not found then raise exception 'period not found in your portals'; end if;
end $$;
