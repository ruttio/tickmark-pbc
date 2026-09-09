-- =====================================================================
--  Leave a portal (20260909000000) — a member drops their own access.
--
--  remove_portal_member() is owner-gated and explicitly refuses self-removal,
--  so a shared-in member had no way to bow out of a portal themselves. This
--  RPC lets the CURRENT user delete their OWN membership row.
--
--  Owners cannot leave: a portal with no owner is orphaned (only an owner can
--  invite members or delete the portal), so an owner must transfer ownership
--  (promote another member, demote themselves) or delete the portal instead.
--  RLS on portal_members already blocks direct deletes — this security-definer
--  function is the one sanctioned path, scoped hard to auth.uid().
-- =====================================================================
create or replace function leave_portal(p_engagement uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  select role into v_role from portal_members
   where engagement_id = p_engagement and user_id = auth.uid();
  if v_role is null then raise exception 'you are not a member of this portal'; end if;
  if v_role = 'owner' then
    raise exception 'the portal owner cannot leave — transfer ownership or delete the portal';
  end if;
  delete from portal_members where engagement_id = p_engagement and user_id = auth.uid();
end; $$;
