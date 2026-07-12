-- =====================================================================
--  Dashboard analytics for the firm: completion trend, request aging, and
--  average turnaround. Derived from item_history timestamps (no created_at
--  column needed — the earliest history row per item is its "requested" time).
--  Membership-scoped via my_portals(). Idempotent: safe to re-run.
-- =====================================================================
create or replace function firm_analytics()
returns json language sql stable security definer set search_path = public as $$
  with my_items as (
    select id, status, archived_at
    from request_items
    where engagement_id in (select my_portals())
  ),
  -- earliest history row per item = when it entered the system (creation proxy)
  req as (
    select item_id, min(at) as requested_at
    from item_history
    where item_id in (select id from my_items)
    group by item_id
  ),
  -- first time each item was accepted
  acc as (
    select item_id, min(at) as accepted_at
    from item_history
    where item_id in (select id from my_items) and action ilike '%accept%'
    group by item_id
  ),
  -- items accepted per ISO week over the last 8 weeks
  weekly as (
    select date_trunc('week', accepted_at)::date as wk, count(*)::int as n
    from acc
    where accepted_at >= date_trunc('week', now()) - interval '7 weeks'
    group by 1
  ),
  -- turnaround (days) for accepted items that have a requested time
  turn as (
    select extract(epoch from (a.accepted_at - r.requested_at)) / 86400.0 as days
    from acc a join req r on r.item_id = a.item_id
    where a.accepted_at >= r.requested_at
  ),
  -- currently-open (not accepted, not archived) items and their age
  open_items as (
    select r.requested_at
    from my_items i
    join req r on r.item_id = i.id
    where i.archived_at is null and i.status <> 'accepted'
  ),
  aging as (
    select
      count(*) filter (where now() - requested_at <  interval '7 days')  as d0_7,
      count(*) filter (where now() - requested_at >= interval '7 days'  and now() - requested_at < interval '14 days') as d7_14,
      count(*) filter (where now() - requested_at >= interval '14 days' and now() - requested_at < interval '30 days') as d14_30,
      count(*) filter (where now() - requested_at >= interval '30 days') as d30
    from open_items
  )
  select json_build_object(
    'weekly',          (select coalesce(json_agg(json_build_object('week', wk, 'n', n) order by wk), '[]'::json) from weekly),
    'avgTurnaround',   (select round(avg(days)::numeric, 1) from turn),
    'turnaroundCount', (select count(*)::int from turn),
    'aging',           (select coalesce(row_to_json(aging), json_build_object('d0_7',0,'d7_14',0,'d14_30',0,'d30',0)) from aging)
  );
$$;
