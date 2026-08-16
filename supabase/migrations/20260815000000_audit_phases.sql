-- =====================================================================
--  Audit phases (20260815000000) — a portal's periods can now be named
--  audit phases, not just bookkeeping months.
--
--  WHY: an annual audit is not one lump of work. After planning and interim
--  procedures the team draws a sample, and only THEN does it know which
--  documents to request. The firm wants to work those stages as separate
--  "phases" inside the one portal (one link, one code), flipping between them
--  with the same switcher a monthly client uses for months — but a phase is
--  named ("หลังสุ่มตัวอย่าง"), not a month, and a new phase starts EMPTY
--  rather than cloning the previous phase's request list.
--
--  This is a UI/data-shape change only. cadence stays a free-text hint on
--  engagements ('once' | 'monthly' | 'phased'); no new permission surface.
--  Two adjustments to the period machinery make it work:
--    1) open_period accepts a phase-style key ('phase-0003') alongside the
--       month key ('2026-07'), and can be told NOT to clone.
--    2) set_period_label lets the firm rename a phase.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1) open_period — now key-format-flexible and clone-optional.
--
--  Adding a parameter changes the signature, so drop the old one first (a
--  bare CREATE OR REPLACE would otherwise leave two overloads and make the
--  PostgREST call ambiguous). Behaviour for the monthly path is unchanged:
--  p_clone defaults to true, so every existing caller keeps cloning.
-- ---------------------------------------------------------------------
drop function if exists open_period(uuid, text, text, date, date, uuid);

create or replace function open_period(
  p_engagement uuid,
  p_period_key text,
  p_label      text,
  p_period_end date    default null,
  p_due_date   date    default null,
  p_clone_from uuid    default null,   -- null = clone the most recent period
  p_clone      boolean default true    -- false = start the period empty (phases)
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_src uuid; v_sort int;
begin
  if p_engagement not in (select my_portals()) then
    raise exception 'not a member of this portal';
  end if;
  -- A month key ('2026-07') or a zero-padded phase key ('phase-0003'). Both
  -- sort lexicographically the same way they sort chronologically/numerically.
  if coalesce(p_period_key, '') !~ '^\d{4}-\d{2}$'
     and coalesce(p_period_key, '') !~ '^phase-\d+$' then
    raise exception 'period_key must look like 2026-07 or phase-0003';
  end if;

  select coalesce(max(sort), -1) + 1 into v_sort from periods where engagement_id = p_engagement;

  insert into periods (engagement_id, period_key, label, period_end, due_date, sort)
  values (p_engagement, p_period_key, p_label, p_period_end, p_due_date, v_sort)
  returning id into v_id;

  -- Cloning the previous request list is right for a recurring month, wrong for
  -- a fresh audit phase (which requests a different, sample-driven set).
  if p_clone then
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
  end if;

  return v_id;
end $$;

-- ---------------------------------------------------------------------
--  2) set_period_label — rename a phase (or a month, though months are never
--     renamed in the UI). Mirrors set_period_status's RLS guard exactly.
-- ---------------------------------------------------------------------
create or replace function set_period_label(p_period uuid, p_label text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(btrim(p_label), '') = '' then
    raise exception 'label must not be empty';
  end if;
  update periods
     set label = btrim(p_label)
   where id = p_period
     and engagement_id in (select my_portals());
  if not found then raise exception 'period not found in your portals'; end if;
end $$;
