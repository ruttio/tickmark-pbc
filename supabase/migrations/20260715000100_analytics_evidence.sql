-- =====================================================================
--  Migration 20260715000100: the evidence behind firm_analytics.
--
--  firm_analytics() collapses the logs straight to averages, so a reader has
--  to take the numbers on faith. This returns the rows those averages were
--  built from — one per request item, plus one per comment reply pair — so the
--  PDF report can re-derive every dashboard figure in front of the reader and
--  show its working.
--
--  The CTEs mirror 20260713000300_analytics.sql line for line. Two shared
--  quirks are deliberate and must stay in sync:
--    · archived items still count toward turnaround / response times (only
--      statusBreakdown and aging filter them out) — hence the `archived` flag,
--      which the report surfaces rather than hides.
--    · a duration is only counted when the end timestamp is at or after the
--      start; out-of-order log rows drop out. Those land here as null, and the
--      report lists them under "ตัดออกจากค่าเฉลี่ย" with the reason.
--
--  `now` is the server clock at query time: aging buckets are relative to it,
--  so the report ages every row against the same instant the RPC did.
--  Versioned migration; depends on the analytics migration.
-- =====================================================================
drop function if exists firm_analytics_evidence();
drop function if exists firm_analytics_evidence(uuid);

create or replace function firm_analytics_evidence(p_engagement uuid default null)
returns json language sql stable security definer set search_path = public as $$
  with my_items as (
    select i.id, i.status, i.archived_at, i.due_date, i.ref, i.description, e.client
    from request_items i
    join engagements e on e.id = i.engagement_id
    where i.engagement_id in (select my_portals())
      and (p_engagement is null or i.engagement_id = p_engagement)
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
