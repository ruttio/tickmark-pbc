-- =====================================================================
--  Delete a period (20260816000000) — undo a phase created by mistake.
--
--  Closing a phase makes it read-only, but a phase opened in error (wrong
--  name, wrong moment) should be removable outright, not left cluttering the
--  switcher forever. Deleting the period row cascades to its request_items
--  (period_id ... on delete cascade) and on to their item_files, so nothing
--  is orphaned in the DB; any R2 objects left behind are swept by the purge
--  job exactly as they are for a deleted engagement. Deliverables are
--  on-delete-set-null, so a bookkeeping month's delivered work is unlinked
--  rather than destroyed (audit phases have no deliverables anyway).
--
--  Guard: a portal must always keep at least one period (the whole app reads
--  through periods — request_items_default_period() has to have something to
--  resolve to), so the LAST remaining period can never be deleted.
-- =====================================================================
create or replace function delete_period(p_period uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_eng uuid; v_count int;
begin
  select engagement_id into v_eng from periods
   where id = p_period and engagement_id in (select my_portals());
  if v_eng is null then raise exception 'period not found in your portals'; end if;

  select count(*) into v_count from periods where engagement_id = v_eng;
  if v_count <= 1 then
    raise exception 'a portal must keep at least one period';
  end if;

  delete from periods where id = p_period;  -- cascades to request_items -> item_files
end $$;
