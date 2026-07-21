-- =====================================================================
--  Migration 20260722090000: make dashboard analytics period-aware.
--
--  WHY: 20260720120000_periods.sql let a portal span many monthly periods,
--  but firm_analytics()/firm_analytics_evidence() still average across an
--  engagement's entire history. For a one-off audit portal (exactly one
--  period) that was always the same thing. For a monthly bookkeeping portal
--  it quietly stopped being true: "average days to submit" now blends every
--  month the client has ever had, and nothing about the number's label says
--  so. This is the exact failure the periods migration exists to prevent for
--  request_items — analytics just never caught up.
--
--  FIX: both functions gain an optional p_period. NULL keeps today's
--  behaviour exactly (all periods for the engagement, or all engagements) —
--  a one-off portal has exactly one period, so passing its id or leaving
--  p_period null produce the identical result; there is no second code path.
--  When p_period is given, every CTE (turnaround, aging, response times,
--  submission timing) is scoped to that period alone, because they all read
--  from the same `my_items` base.
--
--  Also: firm_analytics_evidence() now tags each item row with the period it
--  belongs to (`periodLabel`, `periodSort`), so a report that spans several
--  months — because the firm explicitly asked for "ทุกงวด" — still shows,
--  row by row, which month each figure came from. periods.period_key is
--  never selected here; period_key is a sort key, not something to show a
--  reader (see periods migration header).
--
--  No metric's definition changes — same formulas, same skip rules, same
--  rounding. Only the population each one is computed over can now be
--  narrowed to a single period. Versioned migration; depends on
--  20260713000300_analytics.sql, 20260715000100_analytics_evidence.sql and
--  20260720120000_periods.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
--  firm_analytics — add p_period, threaded into the single shared my_items
--  CTE that every other CTE reads from.
-- ---------------------------------------------------------------------
drop function if exists firm_analytics(uuid);

create or replace function firm_analytics(p_engagement uuid default null, p_period uuid default null)
returns json language sql stable security definer set search_path = public as $$
  with my_items as (
    select id, status, archived_at, due_date
    from request_items
    where engagement_id in (select my_portals())
      and (p_engagement is null or engagement_id = p_engagement)
      and (p_period is null or period_id = p_period)
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

-- ---------------------------------------------------------------------
--  firm_analytics_evidence — same p_period, plus each item row now carries
--  the label of the period it belongs to (never its period_key), so a
--  report that spans multiple periods can still say, per row, which month
--  it came from.
-- ---------------------------------------------------------------------
drop function if exists firm_analytics_evidence(uuid);

create or replace function firm_analytics_evidence(p_engagement uuid default null, p_period uuid default null)
returns json language sql stable security definer set search_path = public as $$
  with my_items as (
    select i.id, i.status, i.archived_at, i.due_date, i.ref, i.description, e.client,
           p.label as period_label, p.sort as period_sort
    from request_items i
    join engagements e on e.id = i.engagement_id
    left join periods p on p.id = i.period_id
    where i.engagement_id in (select my_portals())
      and (p_engagement is null or i.engagement_id = p_engagement)
      and (p_period is null or i.period_id = p_period)
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
  item_rows as (
    select
      i.client, i.ref, i.description, i.status, i.due_date,
      i.period_label, i.period_sort,
      (i.archived_at is not null) as archived,
      r.requested_at, fs.first_submit, s.submitted_at as last_submit,
      a.accepted_at, v.viewed_at,
      -- Each duration in days, null when the pair is missing or out of order.
      -- Full precision on purpose: the report averages these and must land on
      -- the same value firm_analytics() rounds to one decimal.
      case when a.accepted_at >= r.requested_at
        then extract(epoch from (a.accepted_at - r.requested_at)) / 86400.0 end as turnaround_days,
      case when fs.first_submit >= r.requested_at
        then extract(epoch from (fs.first_submit - r.requested_at)) / 86400.0 end as client_respond_days,
      case when a.accepted_at >= s.submitted_at
        then extract(epoch from (a.accepted_at - s.submitted_at)) / 86400.0 end as firm_review_days,
      case when v.viewed_at >= fs.first_submit
        then extract(epoch from (v.viewed_at - fs.first_submit)) / 86400.0 end as firm_view_days,
      case when i.due_date is not null and fs.first_submit is not null
        then (i.due_date - fs.first_submit::date) end as days_before_due
    from my_items i
    left join req r        on r.item_id = i.id
    left join acc a        on a.item_id = i.id
    left join sub s        on s.item_id = i.id
    left join sub_first fs on fs.item_id = i.id
    left join first_view v on v.item_id = i.id
  ),
  comment_seq as (
    select ic.item_id, ic.by, ic.created_at,
      lag(ic.by)         over (partition by ic.item_id order by ic.created_at) as prev_by,
      lag(ic.created_at) over (partition by ic.item_id order by ic.created_at) as prev_at
    from item_comments ic where ic.item_id in (select id from my_items)
  ),
  reply_rows as (
    select i.client, i.description, cs.prev_by, cs.prev_at, cs.by, cs.created_at,
      extract(epoch from (cs.created_at - cs.prev_at)) / 86400.0 as days
    from comment_seq cs
    join my_items i on i.id = cs.item_id
    where (cs.by = 'Firm' and cs.prev_by = 'Client')
       or (cs.by = 'Client' and cs.prev_by = 'Firm')
  )
  select json_build_object(
    'now', now(),
    'items', (select coalesce(json_agg(json_build_object(
        'client', client, 'ref', ref, 'description', description,
        'status', status, 'archived', archived, 'dueDate', due_date,
        'periodLabel', period_label, 'periodSort', period_sort,
        'requestedAt', requested_at, 'firstSubmit', first_submit, 'lastSubmit', last_submit,
        'acceptedAt', accepted_at, 'viewedAt', viewed_at,
        'turnaroundDays', turnaround_days, 'clientRespondDays', client_respond_days,
        'firmReviewDays', firm_review_days, 'firmViewDays', firm_view_days,
        'daysBeforeDue', days_before_due
      ) order by client, due_date nulls last, description), '[]'::json) from item_rows),
    'replies', (select coalesce(json_agg(json_build_object(
        'client', client, 'description', description,
        'prevBy', prev_by, 'prevAt', prev_at, 'by', by, 'at', created_at, 'days', days
      ) order by client, created_at), '[]'::json) from reply_rows)
  );
$$;
