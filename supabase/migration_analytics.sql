-- =====================================================================
--  Dashboard analytics for the firm: completion trend, average turnaround,
--  and request aging in THREE modes (so the UI can toggle):
--    • requested — open items, age since first requested
--    • waiting   — items submitted/under review, age since the client's last upload
--    • overdue   — non-accepted items past due, days overdue
--  Optional p_engagement filters to one client's portal (null = all).
--  Derived from item_history timestamps. Membership-scoped via my_portals().
--  Idempotent: safe to re-run.
-- =====================================================================
drop function if exists firm_analytics();
drop function if exists firm_analytics(uuid);

create or replace function firm_analytics(p_engagement uuid default null)
returns json language sql stable security definer set search_path = public as $$
  with my_items as (
    select id, status, archived_at, due_date
    from request_items
    where engagement_id in (select my_portals())
      and (p_engagement is null or engagement_id = p_engagement)
  ),
  req as (  -- earliest history row per item = when it was requested
    select item_id, min(at) as requested_at
    from item_history where item_id in (select id from my_items)
    group by item_id
  ),
  acc as (  -- first accept per item
    select item_id, min(at) as accepted_at
    from item_history where item_id in (select id from my_items) and action ilike '%accept%'
    group by item_id
  ),
  sub as (  -- latest client upload (Submitted) per item
    select item_id, max(at) as submitted_at
    from item_history where item_id in (select id from my_items) and action ilike '%submit%'
    group by item_id
  ),
  weekly as (
    select date_trunc('week', accepted_at)::date as wk, count(*)::int as n
    from acc where accepted_at >= date_trunc('week', now()) - interval '7 weeks'
    group by 1
  ),
  turn as (
    select extract(epoch from (a.accepted_at - r.requested_at)) / 86400.0 as days
    from acc a join req r on r.item_id = a.item_id
    where a.accepted_at >= r.requested_at
  ),
  age_req as (
    select r.requested_at as ts
    from my_items i join req r on r.item_id = i.id
    where i.archived_at is null and i.status <> 'accepted'
  ),
  age_wait as (
    select s.submitted_at as ts
    from my_items i join sub s on s.item_id = i.id
    where i.archived_at is null and i.status in ('submitted', 'review')
  ),
  age_over as (
    select i.due_date::timestamptz as ts
    from my_items i
    where i.archived_at is null and i.status <> 'accepted'
      and i.due_date is not null and i.due_date < current_date
  )
  select json_build_object(
    'weekly',          (select coalesce(json_agg(json_build_object('week', wk, 'n', n) order by wk), '[]'::json) from weekly),
    'avgTurnaround',   (select round(avg(days)::numeric, 1) from turn),
    'turnaroundCount', (select count(*)::int from turn),
    'aging', json_build_object(
      'requested', (select json_build_object(
        'd0_7',   count(*) filter (where now() - ts <  interval '7 days'),
        'd7_14',  count(*) filter (where now() - ts >= interval '7 days'  and now() - ts < interval '14 days'),
        'd14_30', count(*) filter (where now() - ts >= interval '14 days' and now() - ts < interval '30 days'),
        'd30',    count(*) filter (where now() - ts >= interval '30 days')
      ) from age_req),
      'waiting', (select json_build_object(
        'd0_7',   count(*) filter (where now() - ts <  interval '7 days'),
        'd7_14',  count(*) filter (where now() - ts >= interval '7 days'  and now() - ts < interval '14 days'),
        'd14_30', count(*) filter (where now() - ts >= interval '14 days' and now() - ts < interval '30 days'),
        'd30',    count(*) filter (where now() - ts >= interval '30 days')
      ) from age_wait),
      'overdue', (select json_build_object(
        'd0_7',   count(*) filter (where now() - ts <  interval '7 days'),
        'd7_14',  count(*) filter (where now() - ts >= interval '7 days'  and now() - ts < interval '14 days'),
        'd14_30', count(*) filter (where now() - ts >= interval '14 days' and now() - ts < interval '30 days'),
        'd30',    count(*) filter (where now() - ts >= interval '30 days')
      ) from age_over)
    )
  );
$$;
