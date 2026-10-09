-- APPLY-0084.sql - ONE paste. Run on STAGING first, then PROD, after APPLY-0083.
-- Pure ASCII, idempotent (safe to paste twice). Last grid: 9 rows, every ok = true.
-- Nothing is deleted or rewritten: existing phone values are left exactly as they are.
-- 0084_r7_polish.sql - CANONICAL forward-only. Plain-ASCII error texts, phone checks, re-open event.
--
-- In plain words:
--   1. Some server messages had a long dash that showed up as garbage (odd symbols) after a
--      copy/paste. The three functions that raise those messages are re-created with the SAME
--      logic; only the dash in the text becomes a plain " - ".
--   2. Staff (crew_members) and nurture contacts: a NEW or CHANGED phone must be 7-15 digits with
--      an optional leading + (spaces, dots, dashes and brackets are ignored). Existing rows are
--      NOT touched or re-checked - a row with an old bad phone can still be edited/deactivated as
--      long as its phone is not changed. Linked staff rows (phone follows the profile) are skipped.
--   3. nurture.phone (WhatsApp) - added only if missing.
--   4. reopen_event(event, reason): an ADMIN (with closure edit rights) re-opens a closed event in
--      their own studio. It clears closed_at and moves the stage back to settlement (via the
--      existing close_event path). Nothing is deleted; payments, ledger, costs are kept. The reason
--      (5-1000 chars) is written to audit_log.
--   Additive + idempotent: safe to run twice.

alter table public.nurture add column if not exists phone text;

create or replace function public._a84_phone_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is null or btrim(p) = '' or regexp_replace(p, '[[:space:]().-]', '', 'g') ~ '^[+]?[0-9]{7,15}$'
$$;
revoke all on function public._a84_phone_ok(text) from public, anon;
grant execute on function public._a84_phone_ok(text) to authenticated, service_role;

create or replace function public._a84_tg_phone_check()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_TABLE_NAME = 'crew_members' and (to_jsonb(new) ->> 'profile_id') is not null then return new; end if;
  if TG_OP = 'UPDATE' and new.phone is not distinct from old.phone then return new; end if;
  if not public._a84_phone_ok(new.phone) then
    raise exception 'Phone numbers need 7-15 digits (an optional leading + is fine).'
      using errcode = '22023', hint = 'invalid_phone';
  end if;
  return new;
end $$;
revoke all on function public._a84_tg_phone_check() from public, anon, authenticated;

drop trigger if exists zz_a84_phone_check on public.crew_members;
create trigger zz_a84_phone_check before insert or update of phone on public.crew_members
  for each row execute function public._a84_tg_phone_check();
drop trigger if exists zz_a84_phone_check on public.nurture;
create trigger zz_a84_phone_check before insert or update of phone on public.nurture
  for each row execute function public._a84_tg_phone_check();

create or replace function public.reopen_event(p_quote_id uuid, p_reason text)
returns public.event_closure language plpgsql volatile security definer set search_path = '' as $$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); r public.event_closure; v_was timestamptz;
begin
  if not public.has_area('closure', 'edit') or coalesce(public.user_role(), '') <> 'admin' then
    raise exception 'Only an admin can re-open a closed event.' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 5 or length(v_reason) > 1000 then
    raise exception 'Give a reason of 5 to 1000 characters to re-open the event.' using errcode = '22023';
  end if;
  perform 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id() for update;
  if not found then raise exception 'no such event' using errcode = '42501'; end if;
  select c.closed_at into v_was from public.event_closure c where c.quote_id = p_quote_id;
  if v_was is null then raise exception 'This event is not closed.' using errcode = '22023'; end if;
  r := public.close_event(p_quote_id, false);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'event_reopen', 'quotes',
            p_quote_id::text, p_quote_id,
            jsonb_build_object('reason', v_reason, 'was_closed_at', v_was, 'to', 'settlement'), public.current_org_id());
  return r;
end $$;
revoke all on function public.reopen_event(uuid, text) from public, anon;
grant execute on function public.reopen_event(uuid, text) to authenticated, service_role;

-- ---- plain-ASCII messages (logic identical to 0046 / 0052) --------------------------------
create or replace function public._a46_tg_money_freeze()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_tbl  text := tg_table_name;
  n      jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  o      jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_os   text  := o ->> 'status';
  v_ns   text  := n ->> 'status';
  v_me   uuid  := auth.uid();
  v_frozen boolean;
  v_closed boolean;
begin
  -- security definer: current_user is the owner here, so read the caller from the JWT role
  if coalesce(auth.jwt() ->> 'role', '') not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;

  -- ---------------------------------------------------------------- expense_claims
  if v_tbl = 'expense_claims' then
    if tg_op = 'INSERT' then
      if coalesce(v_ns, 'pending') <> 'pending' then
        raise exception 'A new expense claim starts as pending - approve it as a separate step.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
      if n ? 'created_by' then new := jsonb_populate_record(new, jsonb_build_object('created_by', v_me)); end if;
      return new;
    end if;
    v_frozen := v_os in ('approved', 'paid', 'rejected');
    if tg_op = 'DELETE' then
      if v_frozen then
        raise exception 'An approved, paid or rejected expense claim can''t be deleted - add a correcting claim instead.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
      return old;
    end if;
    if (n -> 'created_by') is distinct from (o -> 'created_by') then
      raise exception 'Who entered an expense claim can''t be changed.' using errcode = '42501', hint = 'money_frozen';
    end if;
    if v_frozen and public._a46_changed(n, o, array['who', 'description', 'amount', 'quote_id', 'org_id']) then
      raise exception 'This expense claim is % and locked - its amount and details can''t be changed. Add a correcting claim instead.', v_os
        using errcode = '42501', hint = 'money_frozen';
    end if;
    if v_ns is distinct from v_os then
      if not ((v_os = 'pending'  and v_ns in ('approved', 'paid', 'rejected'))
           or (v_os = 'approved' and v_ns in ('paid', 'rejected'))) then
        raise exception 'An expense claim that is % can''t be moved to %.', coalesce(v_os, 'unset'), coalesce(v_ns, 'unset')
          using errcode = '42501', hint = 'money_frozen';
      end if;
      if not public.has_area('finance', 'edit') then
        raise exception 'not authorized' using errcode = '42501';
      end if;
      if v_ns in ('approved', 'paid') and (o ->> 'created_by') is not null
         and (o ->> 'created_by') = v_me::text and coalesce(public.user_role(), '') <> 'admin' then
        raise exception 'Someone else must approve or pay an expense claim you entered.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
    end if;
    return new;
  end if;

  -- ---------------------------------------------------------------- change_requests
  if v_tbl = 'change_requests' then
    if tg_op = 'INSERT' then
      if coalesce(v_ns, 'requested') <> 'requested' then
        raise exception 'A new change request starts as requested - approve it as a separate step.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
      if n ? 'created_by' then new := jsonb_populate_record(new, jsonb_build_object('created_by', v_me)); end if;
      return new;
    end if;
    v_frozen := v_os in ('approved', 'rejected');
    if tg_op = 'DELETE' then
      if v_frozen then
        raise exception 'A decided change request can''t be deleted - add a new change request instead.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
      return old;
    end if;
    if (n -> 'created_by') is distinct from (o -> 'created_by') then
      raise exception 'Who entered a change request can''t be changed.' using errcode = '42501', hint = 'money_frozen';
    end if;
    if v_frozen and (v_ns is distinct from v_os
         or public._a46_changed(n, o, array['title', 'detail', 'price_delta', 'cost_delta', 'quote_id', 'org_id', 'decided_at'])) then
      raise exception 'This change request is % and locked - add a new change request instead.', v_os
        using errcode = '42501', hint = 'money_frozen';
    end if;
    if v_ns is distinct from v_os then
      if not (v_os = 'requested' and v_ns in ('approved', 'rejected')) then
        raise exception 'A change request that is % can''t be moved to %.', coalesce(v_os, 'unset'), coalesce(v_ns, 'unset')
          using errcode = '42501', hint = 'money_frozen';
      end if;
      if not public.has_area('finance', 'edit') then
        raise exception 'not authorized' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- ---------------------------------------------------------------- event_costs
  if v_tbl = 'event_costs' then
    if to_regclass('public.event_closure') is not null then
      execute 'select exists (select 1 from public.event_closure c where c.quote_id = any($1) and c.closed_at is not null)'
        into v_closed
        using array_remove(array[(n ->> 'quote_id')::uuid, (o ->> 'quote_id')::uuid], null);
      if coalesce(v_closed, false) then
        raise exception 'This event is closed - its cost lines are locked. Re-open the event from its Closure page to change them.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
    end if;
    return coalesce(new, old);
  end if;

  return coalesce(new, old);
end $$;

create or replace function public._a52_stage_blockers(p_quote uuid, p_stage text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare q record; v_from int; v_to int; b jsonb := '[]'::jsonb;
begin
  select q2.lifecycle_stage, q2.event_date, q2.consent_stale into q from public.quotes q2 where q2.id = p_quote;
  v_from := coalesce(public._a52_stage_idx(coalesce(q.lifecycle_stage, 'quote')), 4);
  v_to := public._a52_stage_idx(p_stage);
  if v_to is null or v_to <= v_from then return b; end if;            -- same / backward: free
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
  if v_from < 10 and v_to >= 10 and (q.event_date is null or q.event_date > current_date) then
    b := b || jsonb_build_object('gate', 'settlement',
           'message', case when q.event_date is null then 'the event has no date yet'
                           else 'the event date (' || to_char(q.event_date, 'DD Mon YYYY') || ') has not arrived' end);
  end if;
  return b;
end $$;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text, p_override_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_cur text; b jsonb; v_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
        v_msg text;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_stage = 'closed' then raise exception 'Close the event from its Closure page.' using errcode = '22023'; end if;
  if public._a52_stage_idx(p_stage) is null then raise exception 'invalid stage: %', p_stage using errcode = '22023'; end if;
  select coalesce(q.lifecycle_stage, 'quote') into v_cur from public.quotes q
   where q.id = p_quote_id and q.org_id = v_org for update;
  if not found then raise exception 'no such event' using errcode = '42501'; end if;
  if v_cur = 'closed' and p_stage <> 'closed' then
    raise exception 'This event is closed - reopen it from its Closure page.' using errcode = '22023';
  end if;
  b := public._a52_stage_blockers(p_quote_id, p_stage);
  if jsonb_array_length(b) > 0 then
    select string_agg(x ->> 'message', '; ') into v_msg from jsonb_array_elements(b) x;
    if exists (select 1 from jsonb_array_elements(b) x where (x ->> 'stale')::boolean) then
      raise exception 'Can''t move to % - %.', p_stage, v_msg
        using errcode = 'HL428', detail = b::text, hint = 'Send the client a new approval link.';
    end if;
    if v_reason is null then
      raise exception 'Can''t move to % yet - %.', p_stage, v_msg
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

-- ---- verify -----------------------------------------------------------------------------
select item, ok from (values
  ('01 nurture.phone column present', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'nurture' and column_name = 'phone')),
  ('02 phone rule', public._a84_phone_ok('+919876543210') and public._a84_phone_ok('98765 43210') and public._a84_phone_ok(null)
      and not public._a84_phone_ok('8765432134567890-=-0987w45e') and not public._a84_phone_ok('12345') and not public._a84_phone_ok('+1234567890123456')),
  ('03 phone triggers on crew_members + nurture', (select count(*) from pg_trigger where tgname = 'zz_a84_phone_check'
      and tgrelid in (to_regclass('public.crew_members'), to_regclass('public.nurture'))) = 2),
  ('04 no table constraint added (old rows untouched)', not exists (select 1 from pg_constraint where conname like '%a84%')),
  ('05 reopen_event: authenticated yes, anon no', has_function_privilege('authenticated', 'public.reopen_event(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.reopen_event(uuid,text)', 'execute')),
  ('06 reopen_event admin-only + audited', (select prosrc like '%''admin''%' and prosrc like '%event_reopen%' from pg_proc where oid = 'public.reopen_event(uuid,text)'::regprocedure)),
  ('07 stage messages plain ASCII', (select bool_and(prosrc !~ '[^\x01-\x7e]') from pg_proc where oid in ('public.set_lifecycle_stage(uuid,text,text)'::regprocedure,
      'public._a52_stage_blockers(uuid,text)'::regprocedure, 'public._a46_tg_money_freeze()'::regprocedure))),
  ('08 closed-event message present', (select prosrc like '%This event is closed - its cost lines are locked%' from pg_proc where oid = 'public._a46_tg_money_freeze()'::regprocedure)),
  ('09 new functions definer-safe (search_path empty)', (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
      where p.oid in ('public.reopen_event(uuid,text)'::regprocedure, 'public._a84_tg_phone_check()'::regprocedure,
                      'public.set_lifecycle_stage(uuid,text,text)'::regprocedure)))
) v(item, ok)
order by item;
