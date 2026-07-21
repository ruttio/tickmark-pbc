-- =====================================================================
--  Deliverable revisions + the client's way to talk back (20260721090000).
--
--  Two gaps in 20260720120100_deliverables.sql, both found in real use:
--
--  1) A deliverable could only ever be delivered once. Attaching a corrected
--     file to an already-delivered one left status/acknowledged_at untouched,
--     so a client who had confirmed receipt of v1 was recorded as having
--     acknowledged a file they never saw. For a feature whose entire purpose
--     is delivery evidence in a tax dispute, that is worse than having no
--     record at all.
--
--  2) The client had exactly one verb: "รับทราบ". If the filing was wrong
--     they had to leave the portal and phone the firm — the same
--     email-and-phone chase this product exists to end. The request side has
--     had comments + a return-with-reason loop since the beginning; this is
--     that same loop pointed the other way.
--
--  REVISIONS BUMP ON RELEASE, NOT ON UPLOAD. `deliverables.revision` is the
--  RELEASED revision; a file carries the revision it belongs to. Files the
--  firm is assembling for the next round are written at revision+1 and stay
--  invisible to the client until the firm presses send — so a half-assembled
--  correction never leaks, and a batch of five files bumps the counter once
--  rather than five times (which a per-row trigger would have done).
-- =====================================================================

alter table deliverables add column if not exists revision int not null default 1;
-- The client's reason when they ask for a correction. Mirrors
-- request_items.note, which holds the firm's reason when it returns an item.
alter table deliverables add column if not exists revision_note text not null default '';
-- status now also takes 'revision_requested' (client asked for a fix).
--   draft -> delivered -> acknowledged
--                     \-> revision_requested -> delivered -> ...

alter table deliverable_files add column if not exists revision int not null default 1;
create index if not exists idx_deliverable_files_revision
  on deliverable_files(deliverable_id, revision);

-- ---------------------------------------------------------------------
--  File revision assignment.
--
--  Set here rather than by the caller so every writer agrees, and computed
--  from the parent's CURRENT released revision so it is naturally idempotent
--  across a multi-file upload: every file in one batch lands on the same
--  number because the parent's revision does not move until release.
-- ---------------------------------------------------------------------
create or replace function deliverable_files_set_revision()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_status text; v_rev int;
begin
  select status, revision into v_status, v_rev
    from deliverables where id = new.deliverable_id;
  if v_status is null then return new; end if;   -- FK will reject it anyway
  -- Still assembling the first release: the file belongs to that revision.
  -- Already released: this is material for the NEXT one.
  new.revision := case when v_status = 'draft' then v_rev else v_rev + 1 end;
  return new;
end $$;

drop trigger if exists trg_deliverable_files_set_revision on deliverable_files;
create trigger trg_deliverable_files_set_revision
  before insert on deliverable_files
  for each row execute function deliverable_files_set_revision();

-- ---------------------------------------------------------------------
--  Release. Replaces the version in 20260720120100 (same name, so this
--  migration owns it from here).
--
--  First release: draft -> delivered, revision stays 1.
--  Later releases: requires pending files at revision+1, then bumps and
--  CLEARS viewed_at/acknowledged_at — those are evidence about a specific
--  revision, and carrying them across a new one is the bug this fixes.
-- ---------------------------------------------------------------------
create or replace function deliver_deliverable(p_deliverable uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_eng uuid; v_status text; v_rev int; v_pending int;
begin
  select engagement_id, status, revision into v_eng, v_status, v_rev
    from deliverables where id = p_deliverable;
  if v_eng is null or v_eng not in (select my_portals()) then
    raise exception 'deliverable not found in your portals';
  end if;

  if v_status = 'draft' then
    if not exists (select 1 from deliverable_files
                    where deliverable_id = p_deliverable and revision = v_rev) then
      raise exception 'ยังไม่มีไฟล์ในรายการนี้ — แนบไฟล์ก่อนส่งให้ลูกค้า';
    end if;
    update deliverables
       set status = 'delivered', delivered_at = coalesce(delivered_at, now())
     where id = p_deliverable;
    return;
  end if;

  -- Re-release: only meaningful if there is actually something new to send.
  select count(*) into v_pending from deliverable_files
   where deliverable_id = p_deliverable and revision = v_rev + 1;
  if v_pending = 0 then
    raise exception 'ยังไม่มีไฟล์ใหม่ — แนบไฟล์รุ่นใหม่ก่อนส่งอีกครั้ง';
  end if;

  update deliverables
     set revision = v_rev + 1,
         status = 'delivered',
         delivered_at = now(),      -- the new revision's delivery moment
         viewed_at = null,          -- evidence resets: it belongs to a revision
         acknowledged_at = null,
         revision_note = ''         -- the request that prompted this is answered
   where id = p_deliverable;
end $$;

-- ---------------------------------------------------------------------
--  request_deliverable_revision — the client's "this isn't right" verb.
--  Called by the portal Edge Function with the service role (clients never
--  touch these tables directly), so it takes the engagement explicitly and
--  verifies the deliverable belongs to it rather than trusting the id.
-- ---------------------------------------------------------------------
create or replace function request_deliverable_revision(
  p_deliverable uuid, p_engagement uuid, p_note text
) returns void language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status from deliverables
   where id = p_deliverable and engagement_id = p_engagement;
  if v_status is null then raise exception 'deliverable not found'; end if;
  -- A draft was never sent, so there is nothing to take issue with.
  if v_status = 'draft' then raise exception 'deliverable not delivered'; end if;

  update deliverables
     set status = 'revision_requested',
         revision_note = left(coalesce(p_note, ''), 2000),
         -- Asking for a correction withdraws any acknowledgement of this
         -- revision: the client is on record as NOT accepting it.
         acknowledged_at = null
   where id = p_deliverable and engagement_id = p_engagement;
end $$;

-- ---------------------------------------------------------------------
--  Comments, mirroring item_comments (20260713000100) exactly so both
--  sides of the portal behave the same way and the UI can reuse the thread
--  component it already has.
-- ---------------------------------------------------------------------
create table if not exists deliverable_comments (
  id             uuid primary key default gen_random_uuid(),
  deliverable_id uuid not null references deliverables(id) on delete cascade,
  -- Denormalised for the same reason as deliverable_files: every
  -- authorisation path in this codebase resolves by engagement.
  engagement_id  uuid not null references engagements(id) on delete cascade,
  by             text not null,              -- 'Firm' | 'Client'
  author         text,                       -- firm member's name; null for the client
  body           text not null,
  created_at     timestamptz not null default now()
);
create index if not exists idx_deliverable_comments_parent
  on deliverable_comments(deliverable_id, created_at);

alter table deliverable_comments enable row level security;
drop policy if exists portal_deliverable_comments on deliverable_comments;
create policy portal_deliverable_comments on deliverable_comments for all
  using (engagement_id in (select my_portals()))
  with check (engagement_id in (select my_portals()));
