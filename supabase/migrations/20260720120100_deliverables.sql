-- =====================================================================
--  Deliverables migration (20260720120100) — files now flow firm -> client.
--
--  WHY: until now every file moved client -> firm. The only firm -> client
--  channel was `item_files.is_sample`, which is bound to a request item and
--  carries no status, no period, and no proof of delivery. That cannot
--  represent "here is the ภ.พ.30 we filed on your behalf": the filed return
--  is not a document the CLIENT owes us, so hanging it off a request item
--  misrepresents the workflow and pollutes the client's outstanding list.
--
--  A deliverable is the firm's OUTPUT for a period: the filed return, the
--  monthly financial statements, the payment receipt.
--
--  Delivery is evidence. In a tax context "I never received it" is a real
--  dispute, so we record when the client first opened it (viewed_at) and when
--  they explicitly confirmed receipt (acknowledged_at).
-- =====================================================================

create table if not exists deliverables (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  -- Null = an ad-hoc deliverable not tied to a month (e.g. a one-off letter).
  period_id     uuid references periods(id) on delete set null,
  category      text not null default 'ภาษี',      -- ภาษี | บัญชี | ประกันสังคม | อื่นๆ
  title         text not null,                     -- 'ภ.พ.30 เดือน ก.ค. 2569'
  note          text not null default '',          -- message to the client
  -- 'draft'        = firm is still assembling it; the client CANNOT see it
  -- 'delivered'    = released to the client
  -- 'acknowledged' = the client confirmed receipt
  status        text not null default 'draft',
  due_date      date,                              -- statutory filing deadline
  delivered_at    timestamptz,
  viewed_at       timestamptz,                     -- first time the client opened it
  acknowledged_at timestamptz,
  -- Retention floor. `engagements.auto_delete` is designed for one-off audit
  -- portals, but filed tax documents must be kept for years — the purge job
  -- must refuse to delete a deliverable whose retain_until is still in the
  -- future. Null = fall back to the engagement's own retention.
  retain_until  date,
  sort          int not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists idx_deliverables_engagement on deliverables(engagement_id);
create index if not exists idx_deliverables_period on deliverables(period_id);

create table if not exists deliverable_files (
  id             uuid primary key default gen_random_uuid(),
  deliverable_id uuid not null references deliverables(id) on delete cascade,
  -- Denormalised on purpose: every storage-authorisation path in this codebase
  -- (RLS on storage.objects, `firmfiles`' isMember check, the purge orphan
  -- sweep) resolves a file by its engagement. Keeping engagement_id here means
  -- none of them need to learn about deliverables.
  engagement_id  uuid not null references engagements(id) on delete cascade,
  name           text not null,
  size           bigint not null,
  type           text,
  -- Convention: {engagement_id}/deliverables/{deliverable_id}/{filename}
  -- The leading engagement_id segment is load-bearing — see above.
  storage_path   text not null unique,
  checksum       text,
  uploaded_at    timestamptz not null default now()
);
create index if not exists idx_deliverable_files_parent on deliverable_files(deliverable_id);

-- ---------------------------------------------------------------------
--  RLS — identical membership model to request_items / item_files.
--  Clients never touch these tables directly; the `portal` Edge Function
--  reads them with the service role and filters to the session's engagement.
-- ---------------------------------------------------------------------
alter table deliverables enable row level security;
drop policy if exists portal_deliverables on deliverables;
create policy portal_deliverables on deliverables for all
  using (engagement_id in (select my_portals()))
  with check (engagement_id in (select my_portals()));

alter table deliverable_files enable row level security;
drop policy if exists portal_deliverable_files on deliverable_files;
create policy portal_deliverable_files on deliverable_files for all
  using (engagement_id in (select my_portals()))
  with check (engagement_id in (select my_portals()));

-- ---------------------------------------------------------------------
--  deliver — release a draft to the client. Separate from a plain UPDATE so
--  that "the client can now see this" is one auditable, idempotent step.
-- ---------------------------------------------------------------------
create or replace function deliver_deliverable(p_deliverable uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_eng uuid;
begin
  select engagement_id into v_eng from deliverables where id = p_deliverable;
  if v_eng is null or v_eng not in (select my_portals()) then
    raise exception 'deliverable not found in your portals';
  end if;
  if not exists (select 1 from deliverable_files where deliverable_id = p_deliverable) then
    raise exception 'ยังไม่มีไฟล์ในรายการนี้ — แนบไฟล์ก่อนส่งให้ลูกค้า';
  end if;
  update deliverables
     set status = 'delivered',
         delivered_at = coalesce(delivered_at, now())   -- re-delivering keeps the original timestamp
   where id = p_deliverable
     and status = 'draft';
end $$;
