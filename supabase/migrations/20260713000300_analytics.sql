-- =====================================================================
--  Migration 20260713000300: dashboard analytics. Optional p_engagement scopes to one
--  client's portal (null = all). Membership-scoped via my_portals().
--  Returns:
--    weekly            — accepted items per week (last 8 weeks)
--    avgTurnaround/…   — request → accept, average days
--    aging.{requested|waiting|overdue} — open-item age buckets, 3 modes
--    submissionTiming  — how early/late clients submit vs the due date
--    responseTimes.{…} — avg days + count for each side's responsiveness:
--        clientRespond   requested → first upload           (client)
--        firmReview      last upload → accepted             (firm)
--        firmView        first upload → firm first opens file (firm)
--        firmReply       client comment → firm reply        (firm)
--        clientReply     firm comment → client reply        (client)
--  Versioned migration; depends on comments and item history.
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
  req as (
    select item_id, min(at) as requested_at
    from item_history where item_id in (select id from my_items) group by item_id
  ),
  acc as (
    select item_id, min(at) as accepted_at
    from item_history where item_id in (select id from my_items) and action ilike '%accept%' group by item_id
  ),
  sub as (        -- latest client upload per item
    select item_id, max(at) as submitted_at
    from item_history where item_id in (select id from my_items) and action ilike '%submit%' group by item_id
  ),
  sub_first as (  -- first client upload per item
    select item_id, min(at) as first_submit
    from item_history where item_id in (select id from my_items) and action ilike '%submit%' group by item_id
  ),
  first_view as ( -- first time the firm opened/downloaded a file on the item
    select item_id, min(firm_downloaded_at) as viewed_at
    from item_files where item_id in (select id from my_items) and firm_downloaded_at is not null group by item_id
  ),
  weekly as (
    select date_trunc('week', accepted_at)::date as wk, count(*)::int as n
    from acc where accepted_at >= date_trunc('week', now()) - interval '7 weeks' group by 1
  ),
  turn as (
    select extract(epoch from (a.accepted_at - r.requested_at)) / 86400.0 as days
    from acc a join req r on r.item_id = a.item_id where a.accepted_at >= r.requested_at
  ),
  age_req as (
    select r.requested_at as ts from my_items i join req r on r.item_id = i.id
    where i.archived_at is null and i.status <> 'accepted'
  ),
  age_wait as (
    select s.submitted_at as ts from my_items i join sub s on s.item_id = i.id
    where i.archived_at is null and i.status in ('submitted', 'review')
  ),
  age_over as (
    select i.due_date::timestamptz as ts from my_items i
    where i.archived_at is null and i.status <> 'accepted' and i.due_date is not null and i.due_date < current_date
  ),
  -- submission timing vs due date (days before due; <=0 = on/after due)
  timing as (
    select (i.due_date - fs.first_submit::date) as db
    from my_items i join sub_first fs on fs.item_id = i.id where i.due_date is not null
  ),
  -- response times (days)
  client_respond as (
    select extract(epoch from (fs.first_submit - r.requested_at)) / 86400.0 as days
    from sub_first fs join req r on r.item_id = fs.item_id where fs.first_submit >= r.requested_at
  ),
  firm_review as (
    select extract(epoch from (a.accepted_at - s.submitted_at)) / 86400.0 as days
    from acc a join sub s on s.item_id = a.item_id where a.accepted_at >= s.submitted_at
  ),
  firm_view as (
    select extract(epoch from (v.viewed_at - fs.first_submit)) / 86400.0 as days
    from first_view v join sub_first fs on fs.item_id = v.item_id where v.viewed_at >= fs.first_submit
  ),
  comment_seq as (
    select ic.by, ic.created_at,
      lag(ic.by)         over (partition by ic.item_id order by ic.created_at) as prev_by,
      lag(ic.created_at) over (partition by ic.item_id order by ic.created_at) as prev_at
    from item_comments ic where ic.item_id in (select id from my_items)
  ),
  firm_reply as (
    select extract(epoch from (created_at - prev_at)) / 86400.0 as days
    from comment_seq where by = 'Firm' and prev_by = 'Client'
  ),
  client_reply as (
    select extract(epoch from (created_at - prev_at)) / 86400.0 as days
    from comment_seq where by = 'Client' and prev_by = 'Firm'
  )
  select json_build_object(
    'statusBreakdown', (select json_build_object(
        'outstanding', count(*) filter (where status = 'outstanding'),
        'submitted',   count(*) filter (where status = 'submitted'),
        'review',      count(*) filter (where status = 'review'),
        'accepted',    count(*) filter (where status = 'accepted'),
        'returned',    count(*) filter (where status = 'returned'),
        'reopened',    count(*) filter (where status = 'reopened'),
        'total',       count(*)
      ) from my_items where archived_at is null),
    'weekly',          (select coalesce(json_agg(json_build_object('week', wk, 'n', n) order by wk), '[]'::json) from weekly),
    'avgTurnaround',   (select round(avg(days)::numeric, 1) from turn),
    'turnaroundCount', (select count(*)::int from turn),
    'aging', json_build_object(
      'requested', (select json_build_object('d0_7',count(*) filter (where now()-ts< interval '7 days'),'d7_14',count(*) filter (where now()-ts>=interval '7 days' and now()-ts<interval '14 days'),'d14_30',count(*) filter (where now()-ts>=interval '14 days' and now()-ts<interval '30 days'),'d30',count(*) filter (where now()-ts>=interval '30 days')) from age_req),
      'waiting',   (select json_build_object('d0_7',count(*) filter (where now()-ts< interval '7 days'),'d7_14',count(*) filter (where now()-ts>=interval '7 days' and now()-ts<interval '14 days'),'d14_30',count(*) filter (where now()-ts>=interval '14 days' and now()-ts<interval '30 days'),'d30',count(*) filter (where now()-ts>=interval '30 days')) from age_wait),
      'overdue',   (select json_build_object('d0_7',count(*) filter (where now()-ts< interval '7 days'),'d7_14',count(*) filter (where now()-ts>=interval '7 days' and now()-ts<interval '14 days'),'d14_30',count(*) filter (where now()-ts>=interval '14 days' and now()-ts<interval '30 days'),'d30',count(*) filter (where now()-ts>=interval '30 days')) from age_over)
    ),
    -- distribution of days-before-due, binned around the due date (0)
    'submissionTiming', (select json_build_object(
        'e22', count(*) filter (where db >= 22),
        'e15', count(*) filter (where db between 15 and 21),
        'e8',  count(*) filter (where db between 8 and 14),
        'e4',  count(*) filter (where db between 4 and 7),
        'e1',  count(*) filter (where db between 1 and 3),
        'due', count(*) filter (where db = 0),
        'l1',  count(*) filter (where db between -3 and -1),
        'l4',  count(*) filter (where db between -6 and -4),
        'l7',  count(*) filter (where db <= -7)
      ) from timing),
    'responseTimes', json_build_object(
      'clientRespond', (select json_build_object('avg', round(avg(days)::numeric,1), 'n', count(*)::int) from client_respond),
      'firmReview',    (select json_build_object('avg', round(avg(days)::numeric,1), 'n', count(*)::int) from firm_review),
      'firmView',      (select json_build_object('avg', round(avg(days)::numeric,1), 'n', count(*)::int) from firm_view),
      'firmReply',     (select json_build_object('avg', round(avg(days)::numeric,1), 'n', count(*)::int) from firm_reply),
      'clientReply',   (select json_build_object('avg', round(avg(days)::numeric,1), 'n', count(*)::int) from client_reply)
    )
  );
$$;
