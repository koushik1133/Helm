-- APPLY-0198.sql - paste into the Supabase SQL editor (staging first, then production), AFTER the trial bundle (0179-0186).
-- Additive + idempotent: no closing before the event day (studio time zone), clearer stage moves, Cancel event, conflict acknowledgements. No row is changed. Safe to run twice.
begin;
-- 0198_event_stages_closure.sql - CANONICAL forward-only.
-- REQUIRES 0049 + 0148 + 0152 (close gate), 0052 + 0084 (lifecycle stages), 0042 (OTP expiry helper);
-- after 0184 when installed (trial retention purge list gets the two new tables).
--
-- In plain words - owner test on a trial studio, 18 Oct 2026 (event on 7 Nov 2026):
--   1. CLOSING. The event could be closed weeks before it happened. Closing now needs the event day
--      to be over in the STUDIO's own time zone (organizations.timezone, default Asia/Kolkata):
--      "You can close this event after 7 Nov 2026 (event day)." (error HL425). Nobody can override
--      that - an event that will not happen is CANCELLED instead (3). An event with no date is a
--      new close blocker (an admin can still override it with a reason, like a balance owed).
--      The existing balance / equipment / never-confirmed gate (0049/0110/0152) is unchanged and
--      still runs on the server: money still owed blocks closing unless an admin gives a reason.
--      close_event_blockers() now also reports event_date / studio_today / too_early /
--      no_event_date / close_after so the Closure page can say it before anyone clicks.
--   2. STAGES. set_lifecycle_stage keeps every 0052 rule and adds:
--        - a CONFIRMED event can not be moved back before Confirmed (that flip-flopped the stage
--          strip: the page showed "Confirmed" while the stored stage said Lead/Quote);
--        - a cancelled or closed event's stage can not change (reopen / it is cancelled);
--        - moving to the stage it is already on is a no-op (no write, no audit noise);
--        - forward gates, each one listed in plain words (HL409, an admin can still override):
--            Planning   needs: menu locked, layout v1 (a saved floor layout with objects)
--            Event Day  opens on the event date (studio time zone)
--            Settlement once the event date has arrived (studio time zone, was server UTC)
--      lifecycle_stage_blockers() returns the same list for the stage strip.
--   3. CANCEL EVENT. cancel_event(quote, reason): admin or manager with quotes edit, reason
--      5..1000 chars. Status becomes 'cancelled' (lifecycle stage and every payment / reservation
--      row are kept as they are), the client approval link is revoked and open OTPs expire. Every
--      cancellation is recorded in public.event_cancellations + audit_log. A closed event is
--      reopened first. A cancelled event can still be closed later to settle it (0152 rule).
--   4. CONFLICT ACKNOWLEDGEMENTS. public.calendar_conflict_acks: "mark acknowledged" on a calendar
--      clash (same date / venue / crew / vendor / stock). Rows are written only through
--      ack_calendar_conflict / unack_calendar_conflict (un-acknowledge stamps revoked_at, nothing
--      is deleted). Readable by the studio's members with quotes view.
--
-- ZERO DATA LOSS: 2 new tables, new functions, CREATE OR REPLACE of _a49_close_blockers,
-- _a49_blocker_text, _a49_close_gate, set_lifecycle_stage(uuid,text,text) and
-- lifecycle_stage_blockers (same signatures + grants). No table, column, row, trigger or policy
-- is dropped or deleted; no existing row is updated. Sample-data clones that insert closed
-- sample events directly are not affected (no trigger is added on quotes / event_closure).
-- Additive + idempotent: safe to run twice. ASCII only.

do $$ begin
  if to_regprocedure('public._a49_close_blockers(uuid)') is null
     or to_regprocedure('public._a49_blocker_text(jsonb)') is null
     or to_regprocedure('public._a49_close_gate(uuid,text)') is null
     or to_regprocedure('public.helm_invoice_total(uuid)') is null then
    raise exception 'STOP: apply 0049 + 0110 + 0148 + 0152 (close gate) first'; end if;
  if to_regprocedure('public.set_lifecycle_stage__pre0052(uuid,text)') is null
     or to_regprocedure('public._a52_stage_idx(text)') is null
     or to_regprocedure('public._a52_has_consent(uuid)') is null
     or to_regclass('public.lifecycle_stage_overrides') is null then
    raise exception 'STOP: apply 0052 + 0084 (lifecycle stages) first'; end if;
end $$;

-- ---- 0) helpers --------------------------------------------------------------------------
-- the studio's own calendar day (organizations.timezone; a missing / unknown zone -> Asia/Kolkata)
create or replace function public._a198_org_today(p_org uuid)
returns date language plpgsql stable security definer set search_path = '' as $$
-- helm-0198-stages
declare v_tz text;
begin
  select nullif(btrim(o.timezone), '') into v_tz from public.organizations o where o.id = p_org;
  begin
    return (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;
  exception when others then
    return (now() at time zone 'Asia/Kolkata')::date;
  end;
end $$;

create or replace function public._a198_stage_label(p text)
returns text language sql immutable set search_path = '' as $$
  select case p when 'lead' then 'Lead' when 'discovery' then 'Discovery' when 'proposal' then 'Proposal'
                when 'quote' then 'Quote' when 'confirmed' then 'Confirmed' when 'planning' then 'Planning'
                when 'resources' then 'Resources' when 'ready' then 'Ready' when 'event_day' then 'Event Day'
                when 'settlement' then 'Settlement' when 'closed' then 'Closure' else coalesce(p, '') end;
$$;

create or replace function public._a198_day(p date)
returns text language sql immutable set search_path = '' as $$
  select to_char(p, 'FMDD Mon YYYY');
$$;

-- ---- 1) close gate: the event day must be over (studio time zone) ------------------------
create or replace function public._a49_close_blockers(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 0110 body + manager-1019-0152: not_booked blocker + helm-0198-stages: event day over
declare v_total numeric; v_paid numeric; v_owed numeric; v_items jsonb; v_n int; v_status text; v_nb text;
        v_date date; v_org uuid; v_today date; v_early boolean := false; v_nodate boolean := false;
begin
  select coalesce(nullif(q.pricing ->> 'total', '')::numeric, 0), q.status, q.event_date, q.org_id
    into v_total, v_status, v_date, v_org
    from public.quotes q where q.id = p_quote;
  if coalesce(v_total, 0) > 0 then v_total := public.helm_invoice_total(p_quote); end if;
  v_paid := coalesce(public.helm_total_paid(p_quote, null, null), 0);
  v_owed := greatest(coalesce(v_total, 0) - v_paid, 0);
  if v_owed <= 0.5 then v_owed := 0; end if;
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item', coalesce(i.name, 'item'), 'qty', c.qty_out, 'issued_to', c.issued_to)
           order by c.checked_out_at), '[]'::jsonb)
    into v_n, v_items
    from public.inventory_checkouts c left join public.inventory_items i on i.id = c.item_id
   where c.quote_id = p_quote and c.status = 'out';
  -- 0152: a cancelled event may still be closed; anything else must be confirmed AND priced
  if coalesce(v_status, '') <> 'cancelled' then
    if coalesce(v_status, '') <> 'confirmed' then v_nb := 'unconfirmed';
    elsif coalesce(v_total, 0) <= 0 then v_nb := 'unpriced'; end if;
  end if;
  -- 0198: the event day must be over (a cancelled event is closed whenever it is settled)
  v_today := public._a198_org_today(v_org);
  if coalesce(v_status, '') <> 'cancelled' then
    if v_date is null then v_nodate := true;
    elsif v_date >= v_today then v_early := true; end if;
  end if;
  return jsonb_build_object('total', coalesce(v_total, 0), 'paid', v_paid, 'balance_owed', v_owed,
                            'open_checkouts', v_n, 'checkouts', v_items, 'not_booked', v_nb,
                            'event_date', v_date, 'studio_today', v_today,
                            'too_early', v_early, 'no_event_date', v_nodate,
                            'close_after', case when v_date is not null then public._a198_day(v_date) end,
                            'blocked', (v_owed > 0 or v_n > 0 or v_nb is not null or v_early or v_nodate));
end $$;

create or replace function public._a49_blocker_text(b jsonb)
returns text language sql immutable set search_path = '' as $$
  -- manager-1019-0152: + not_booked; helm-0198-stages: + event day / no date
  select concat_ws('; ',
    case when coalesce((b ->> 'too_early')::boolean, false)
         then 'the event day (' || coalesce(b ->> 'close_after', '') || ') is not over yet' end,
    case when coalesce((b ->> 'no_event_date')::boolean, false) then 'the event has no date yet' end,
    case when b ->> 'not_booked' = 'unconfirmed' then 'the quote was never confirmed by the client'
         when b ->> 'not_booked' = 'unpriced' then 'the quote has no price yet' end,
    case when (b ->> 'balance_owed')::numeric > 0
         then 'client balance still owed: ' || to_char((b ->> 'balance_owed')::numeric, 'FM999999999990.00') end,
    case when (b ->> 'open_checkouts')::int > 0
         then (b ->> 'open_checkouts') || ' equipment checkout(s) still out: '
              || (select string_agg(x ->> 'item' || ' x' || (x ->> 'qty'), ', ')
                    from (select x from jsonb_array_elements(b -> 'checkouts') x limit 8) s) end);
$$;

create or replace function public._a49_close_gate(p_quote uuid, p_reason text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- close-gate-0148: ASCII-only messages; helm-0198-stages: no closing before the event day is over
declare b jsonb; v_org uuid := public.current_org_id(); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
        v_status text; v_date date; v_today date;
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  select q.status, q.event_date into v_status, v_date from public.quotes q where q.id = p_quote for update;
  -- 0198: hard rule, no override - an event that will not happen is cancelled instead
  v_today := public._a198_org_today(v_org);
  if coalesce(v_status, '') <> 'cancelled' and v_date is not null and v_date >= v_today then
    raise exception 'You can close this event after % (event day).', public._a198_day(v_date)
      using errcode = 'HL425', hint = 'event_not_over',
            detail = jsonb_build_object('event_date', v_date, 'studio_today', v_today)::text;
  end if;
  b := public._a49_close_blockers(p_quote);
  if not (b ->> 'blocked')::boolean then return; end if;
  if v_reason is null then
    raise exception 'Can''t close this event yet: %.', public._a49_blocker_text(b)
      using errcode = 'P0001', detail = b::text,
            hint = 'Collect the balance or return the equipment first, or an admin can close with an override reason.';
  end if;
  if coalesce(public.user_role(), '') <> 'admin' then
    raise exception 'Only an admin can close an event with something outstanding (%).', public._a49_blocker_text(b)
      using errcode = '42501';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 1000 then
    raise exception 'override reason must be 5 to 1000 characters' using errcode = '22023';
  end if;
  insert into public.event_close_overrides(org_id, quote_id, actor, actor_email, reason, balance_owed, open_checkouts, blockers)
    values (v_org, p_quote, auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), v_reason,
            (b ->> 'balance_owed')::numeric, (b ->> 'open_checkouts')::int, b);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'close_override', 'event_closure',
            p_quote::text, p_quote, jsonb_build_object('reason', v_reason, 'blockers', b), v_org);
end $$;

-- ---- 2) lifecycle stages ----------------------------------------------------------------------
-- what blocks moving p_quote forward to p_stage: [] = allowed; {stale:true} entries can't be overridden
create or replace function public._a198_stage_blockers(p_quote uuid, p_stage text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0198-stages: 0052/0084 gates + planning readiness + event day, dates in the studio time zone
declare q record; v_from int; v_to int; b jsonb := '[]'::jsonb; v_today date; v_need text[] := array[]::text[];
begin
  select q2.lifecycle_stage, q2.event_date, q2.consent_stale, q2.org_id into q from public.quotes q2 where q2.id = p_quote;
  if not found then return b; end if;
  v_from := coalesce(public._a52_stage_idx(coalesce(q.lifecycle_stage, 'quote')), 4);
  v_to := public._a52_stage_idx(p_stage);
  if v_to is null or v_to <= v_from then return b; end if;            -- same / backward: no forward gate
  v_today := public._a198_org_today(q.org_id);
  if v_from < 5 and v_to >= 5 then                                    -- crosses 'confirmed'
    if coalesce(q.consent_stale, false) then
      b := b || jsonb_build_object('gate', 'confirmed', 'stale', true,
             'message', 'the price changed after the client approved - the client must approve again');
    elsif not public._a52_has_consent(p_quote) then
      b := b || jsonb_build_object('gate', 'confirmed',
             'message', 'the client has not approved the quote yet (OTP consent)');
    end if;
  elsif v_from < 6 and v_to >= 6 and coalesce(q.consent_stale, false) then   -- planning while stale
    b := b || jsonb_build_object('gate', 'planning', 'stale', true,
           'message', 'the price changed after the client approved - the client must approve again');
  end if;
  if v_from < 6 and v_to >= 6 then                                    -- crosses 'planning'
    if not exists (select 1 from public.event_plan p where p.quote_id = p_quote and p.menu_locked) then
      v_need := v_need || 'menu locked'::text;
    end if;
    if not exists (select 1 from public.quote_versions v where v.quote_id = p_quote and coalesce(v.object_count, 0) > 0) then
      v_need := v_need || 'layout v1'::text;
    end if;
    if cardinality(v_need) > 0 then
      b := b || jsonb_build_object('gate', 'planning', 'needs', to_jsonb(v_need),
             'message', 'Planning needs: ' || array_to_string(v_need, ', '));
    end if;
  end if;
  if v_from < 10 and v_to >= 10 and (q.event_date is null or q.event_date > v_today) then
    b := b || jsonb_build_object('gate', 'settlement',
           'message', case when q.event_date is null then 'the event has no date yet'
                           else 'the event date (' || to_char(q.event_date, 'DD Mon YYYY') || ') has not arrived' end);
  elsif v_from < 9 and v_to >= 9 and (q.event_date is null or q.event_date > v_today) then
    b := b || jsonb_build_object('gate', 'event_day',
           'message', case when q.event_date is null then 'the event has no date yet'
                           else 'Event Day opens on ' || public._a198_day(q.event_date) || ' (the event date)' end);
  end if;
  return b;
end $$;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text, p_override_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0198-stages: 0084 body + confirmed floor, cancelled / closed lock, no-op, _a198 gates
declare v_org uuid := public.current_org_id(); v_cur text; v_status text; v_closed boolean; b jsonb;
        v_reason text := nullif(btrim(coalesce(p_override_reason, '')), ''); v_msg text;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_stage = 'closed' then raise exception 'Close the event from its Closure page.' using errcode = '22023'; end if;
  if public._a52_stage_idx(p_stage) is null then raise exception 'invalid stage: %', p_stage using errcode = '22023'; end if;
  select coalesce(q.lifecycle_stage, 'quote'), q.status into v_cur, v_status from public.quotes q
   where q.id = p_quote_id and q.org_id = v_org for update;
  if not found then raise exception 'no such event' using errcode = '42501'; end if;
  v_closed := v_cur = 'closed' or exists (select 1 from public.event_closure c where c.quote_id = p_quote_id and c.closed_at is not null);
  if v_closed then
    raise exception 'This event is closed - reopen it from its Closure page.' using errcode = '22023';
  end if;
  if p_stage = v_cur then return jsonb_build_object('stage', v_cur, 'unchanged', true); end if;   -- no write
  if coalesce(v_status, '') = 'cancelled' then
    raise exception 'This event is cancelled, so its stage can no longer change.' using errcode = '22023', hint = 'event_cancelled';
  end if;
  if coalesce(v_status, '') = 'confirmed' and public._a52_stage_idx(p_stage) < 5 then
    raise exception 'This event is confirmed, so it can''t go back to %. Use Cancel event if it will not happen.',
      public._a198_stage_label(p_stage) using errcode = '22023', hint = 'stage_confirmed_floor';
  end if;
  b := public._a198_stage_blockers(p_quote_id, p_stage);
  if jsonb_array_length(b) > 0 then
    select string_agg(x ->> 'message', '; ') into v_msg from jsonb_array_elements(b) x;
    if exists (select 1 from jsonb_array_elements(b) x where (x ->> 'stale')::boolean) then
      raise exception 'Can''t move to % - %.', public._a198_stage_label(p_stage), v_msg
        using errcode = 'HL428', detail = b::text, hint = 'Send the client a new approval link.';
    end if;
    if v_reason is null then
      raise exception 'Can''t move to % yet - %.', public._a198_stage_label(p_stage), v_msg
        using errcode = 'HL409', detail = b::text, hint = 'An admin can move it anyway with a reason.';
    end if;
    if coalesce(public.user_role(), '') <> 'admin' then
      raise exception 'Only an admin can skip a stage check (%).', v_msg using errcode = '42501';
    end if;
    if length(v_reason) < 5 or length(v_reason) > 1000 then
      raise exception 'override reason must be 5 to 1000 characters' using errcode = '22023';
    end if;
    insert into public.lifecycle_stage_overrides(org_id, quote_id, actor, actor_email, from_stage, to_stage, reason, blockers)
      values (v_org, p_quote_id, auth.uid(), (select u.email from auth.users u where u.id = auth.uid()),
              v_cur, p_stage, v_reason, b);
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'stage_override', 'quotes',
              p_quote_id::text, p_quote_id,
              jsonb_build_object('from', v_cur, 'to', p_stage, 'reason', v_reason, 'blockers', b), v_org);
  end if;
  return public.set_lifecycle_stage__pre0052(p_quote_id, p_stage);
end $$;

-- read-only: what blocks a move (for the stage strip). Backward / hard rules come back as
-- {"hard": true} entries so the page can explain them without trying the move.
create or replace function public.lifecycle_stage_blockers(p_quote_id uuid, p_stage text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0198-stages
declare q record;
begin
  if not public.has_area('quotes', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  select q2.status, coalesce(q2.lifecycle_stage, 'quote') as stage into q
    from public.quotes q2 where q2.id = p_quote_id and q2.org_id = public.current_org_id();
  if not found then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  if public._a52_stage_idx(p_stage) is null then return '[]'::jsonb; end if;
  if q.stage = 'closed' or exists (select 1 from public.event_closure c where c.quote_id = p_quote_id and c.closed_at is not null) then
    return jsonb_build_array(jsonb_build_object('gate', 'closed', 'hard', true,
             'message', 'This event is closed - reopen it from its Closure page.'));
  end if;
  if coalesce(q.status, '') = 'cancelled' then
    return jsonb_build_array(jsonb_build_object('gate', 'cancelled', 'hard', true,
             'message', 'This event is cancelled, so its stage can no longer change.'));
  end if;
  if coalesce(q.status, '') = 'confirmed' and public._a52_stage_idx(p_stage) < 5 then
    return jsonb_build_array(jsonb_build_object('gate', 'confirmed_floor', 'hard', true,
             'message', 'This event is confirmed, so it can''t go back to ' || public._a198_stage_label(p_stage) || '.'));
  end if;
  return public._a198_stage_blockers(p_quote_id, p_stage);
end $$;

-- ---- 3) cancel event -------------------------------------------------------------------------
create table if not exists public.event_cancellations (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete restrict,
  quote_id             uuid not null,
  actor                uuid,
  actor_email          text,
  reason               text not null check (length(btrim(reason)) between 5 and 1000),
  prev_status          text,
  prev_stage           text,
  prev_approval_status text,
  paid_at_cancel       numeric not null default 0,
  created_at           timestamptz not null default now()
);
create index if not exists event_cancellations_quote_idx on public.event_cancellations(org_id, quote_id);
alter table public.event_cancellations enable row level security;
revoke all on public.event_cancellations from public, anon, authenticated;
grant select on public.event_cancellations to authenticated;
grant all on public.event_cancellations to service_role;
drop policy if exists "a198 cancellations read" on public.event_cancellations;
create policy "a198 cancellations read" on public.event_cancellations for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));

create or replace function public.cancel_event(p_quote_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0198-stages: an event that will not happen (status cancelled, everything else kept)
declare v_org uuid := public.current_org_id(); v_reason text := btrim(coalesce(p_reason, ''));
        q record; v_paid numeric; v_email text;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public.user_role(), '') not in ('admin', 'manager') then
    raise exception 'Only an admin or a manager can cancel an event.' using errcode = '42501';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 1000 then
    raise exception 'Give a reason of 5 to 1000 characters for cancelling.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || coalesce(p_quote_id::text, ''), 0));
  select q2.id, q2.status, coalesce(q2.lifecycle_stage, 'quote') as stage, q2.approval_status, q2.deleted_at
    into q from public.quotes q2 where q2.id = p_quote_id and q2.org_id = v_org for update;
  if not found then raise exception 'not authorized for this event' using errcode = '42501'; end if;
  if q.status = 'cancelled' then return jsonb_build_object('status', 'cancelled', 'unchanged', true); end if;
  if q.deleted_at is not null then
    raise exception 'This event is in Deleted - restore it first.' using errcode = '22023';
  end if;
  if q.stage = 'closed' or exists (select 1 from public.event_closure c where c.quote_id = p_quote_id and c.closed_at is not null) then
    raise exception 'This event is closed - an admin can reopen it first if it has to be cancelled.' using errcode = '22023';
  end if;
  v_paid := coalesce(public.helm_total_paid(p_quote_id, null, null), 0);
  select u.email into v_email from auth.users u where u.id = auth.uid();
  insert into public.event_cancellations(org_id, quote_id, actor, actor_email, reason, prev_status, prev_stage,
                                         prev_approval_status, paid_at_cancel)
    values (v_org, p_quote_id, auth.uid(), v_email, v_reason, q.status, q.stage, q.approval_status, v_paid);
  update public.quotes qq
     set status = 'cancelled',
         approval_token_revoked_at = case when qq.approval_token is not null then coalesce(qq.approval_token_revoked_at, now())
                                          else qq.approval_token_revoked_at end,
         updated_at = now()
   where qq.id = p_quote_id;
  perform public._a42_expire_open_otps(p_quote_id);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), v_email, 'event_cancelled', 'quotes', p_quote_id::text, p_quote_id,
            jsonb_build_object('reason', v_reason, 'from_status', q.status, 'stage', q.stage, 'paid', v_paid), v_org);
  return jsonb_build_object('status', 'cancelled', 'paid', v_paid, 'refund_to_review', v_paid > 0);
end $$;

-- ---- 4) calendar conflict acknowledgements ----------------------------------------------------
create table if not exists public.calendar_conflict_acks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete restrict,
  quote_id     uuid not null,
  conflict_key text not null check (length(conflict_key) between 3 and 500),
  note         text check (note is null or length(note) <= 500),
  acked_by     uuid,
  acked_email  text,
  acked_at     timestamptz not null default now(),
  revoked_at   timestamptz,
  revoked_by   uuid
);
create unique index if not exists calendar_conflict_acks_open_uq
  on public.calendar_conflict_acks(org_id, conflict_key) where revoked_at is null;
create index if not exists calendar_conflict_acks_quote_idx on public.calendar_conflict_acks(org_id, quote_id);
alter table public.calendar_conflict_acks enable row level security;
revoke all on public.calendar_conflict_acks from public, anon, authenticated;
grant select on public.calendar_conflict_acks to authenticated;
grant all on public.calendar_conflict_acks to service_role;
drop policy if exists "a198 conflict acks read" on public.calendar_conflict_acks;
create policy "a198 conflict acks read" on public.calendar_conflict_acks for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));

create or replace function public.ack_calendar_conflict(p_quote_id uuid, p_key text, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0198-stages
declare v_org uuid := public.current_org_id(); v_key text := btrim(coalesce(p_key, ''));
        v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_id uuid;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  if length(v_key) < 3 or length(v_key) > 500 then raise exception 'invalid conflict key' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'Keep the note under 500 characters.' using errcode = '22023'; end if;
  select a.id into v_id from public.calendar_conflict_acks a
   where a.org_id = v_org and a.conflict_key = v_key and a.revoked_at is null;
  if v_id is null then
    insert into public.calendar_conflict_acks(org_id, quote_id, conflict_key, note, acked_by, acked_email)
      values (v_org, p_quote_id, v_key, v_note, auth.uid(), (select u.email from auth.users u where u.id = auth.uid()))
      on conflict do nothing
      returning id into v_id;
  end if;
  return jsonb_build_object('acknowledged', true, 'id', v_id, 'key', v_key);
end $$;

create or replace function public.unack_calendar_conflict(p_quote_id uuid, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0198-stages: nothing is deleted - the open acknowledgement is stamped revoked
declare v_org uuid := public.current_org_id(); n int;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  update public.calendar_conflict_acks a set revoked_at = now(), revoked_by = auth.uid()
   where a.org_id = v_org and a.conflict_key = btrim(coalesce(p_key, '')) and a.revoked_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('acknowledged', false, 'revoked', n);
end $$;

-- ---- 5) studio guards on the new tables (when this database has them) -----------------------
do $$ declare t text; begin
  foreach t in array array['event_cancellations', 'calendar_conflict_acks'] loop
    if to_regprocedure('public.tg_quote_org_match()') is not null then
      execute format('drop trigger if exists zz_quote_org_match on public.%I', t);
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null then
      execute format('drop trigger if exists zzz_studio_read_only on public.%I', t);
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
end $$;

-- ---- 5b) trial retention (0184): the two new tables are this studio's event records -------------
-- An expired, never-paid trial's purge (0184, owner switch, off by default) empties them with the
-- rest of the events; without this they would only be reported as "unclassified" and kept.
-- Patched in place (text replace on the list, once); skipped when 0184 is not installed.
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''event_cancellations''' in v_def) > 0 then return; end if;
  if position('''event_close_overrides'', ''lifecycle_stage_overrides'',' in v_def) = 0 then
    raise notice '0198: _tr184_purge_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''event_close_overrides'', ''lifecycle_stage_overrides'',',
                  '''event_close_overrides'', ''lifecycle_stage_overrides'', ''event_cancellations'', ''calendar_conflict_acks'',');
end $$;

-- ---- 6) grants ---------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['_a198_org_today(uuid)', '_a198_stage_label(text)', '_a198_day(date)',
                           '_a198_stage_blockers(uuid, text)', '_a49_close_blockers(uuid)',
                           '_a49_blocker_text(jsonb)', '_a49_close_gate(uuid, text)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
  foreach f in array array['set_lifecycle_stage(uuid, text, text)', 'lifecycle_stage_blockers(uuid, text)',
                           'cancel_event(uuid, text)', 'ack_calendar_conflict(uuid, text, text)',
                           'unack_calendar_conflict(uuid, text)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.' || f || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
end $$;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 close gate refuses before the event day (HL425, no override)', position('HL425' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) > 0
      and position('_a198_org_today' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) > 0),
  ('02 close gate keeps the balance / equipment / booking checks', position('helm_invoice_total' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) > 0
      and position('not_booked' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) > 0
      and position('too_early' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) > 0),
  ('03 close_event still runs the gate', position('_a49_close_gate' in pg_get_functiondef('public.close_event(uuid,boolean)'::regprocedure)) > 0
      and position('_a49_close_gate' in pg_get_functiondef('public.close_event(uuid,boolean,text)'::regprocedure)) > 0),
  ('04 set_lifecycle_stage uses the 0198 rules', position('helm-0198-stages' in pg_get_functiondef('public.set_lifecycle_stage(uuid,text,text)'::regprocedure)) > 0
      and position('_a198_stage_blockers' in pg_get_functiondef('public.set_lifecycle_stage(uuid,text,text)'::regprocedure)) > 0),
  ('05 2-arg set_lifecycle_stage goes through the 3-arg one', position('set_lifecycle_stage(p_quote_id, p_stage, null::text)' in pg_get_functiondef('public.set_lifecycle_stage(uuid,text)'::regprocedure)) > 0),
  ('06 lifecycle_stage_blockers explains the 0198 gates', position('_a198_stage_blockers' in pg_get_functiondef('public.lifecycle_stage_blockers(uuid,text)'::regprocedure)) > 0),
  ('07 cancel_event + conflict ack RPCs for signed-in users only', to_regprocedure('public.cancel_event(uuid,text)') is not null
      and has_function_privilege('authenticated', 'public.cancel_event(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.cancel_event(uuid,text)', 'execute')
      and has_function_privilege('authenticated', 'public.ack_calendar_conflict(uuid,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.ack_calendar_conflict(uuid,text,text)', 'execute')
      and has_function_privilege('authenticated', 'public.unack_calendar_conflict(uuid,text)', 'execute')),
  ('08 helpers not callable by the app', not has_function_privilege('authenticated', 'public._a198_org_today(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._a198_stage_blockers(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public._a49_close_gate(uuid,text)', 'execute')),
  ('09 new tables have RLS on, no direct app writes', (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.event_cancellations'::regclass, 'public.calendar_conflict_acks'::regclass))
      and not has_table_privilege('authenticated', 'public.event_cancellations', 'insert')
      and not has_table_privilege('authenticated', 'public.calendar_conflict_acks', 'insert')
      and not has_table_privilege('anon', 'public.calendar_conflict_acks', 'select')),
  ('10 studio today works for every studio', not exists (select 1 from public.organizations o where public._a198_org_today(o.id) is null)),
  ('11 no trigger added on quotes / event_closure', not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid in ('public.quotes'::regclass, 'public.event_closure'::regclass) and p.proname like '%198%')),
  ('12 trial retention (0184, if installed) classifies the new tables', to_regprocedure('public._tr184_purge_tables()') is null
      or ('event_cancellations' = any(public._tr184_purge_tables()) and 'calendar_conflict_acks' = any(public._tr184_purge_tables())))
) v(item, ok) order by item;
