-- ============================================================================
-- 0046_d6_money_freeze.sql — owner decision D6: approved money records are frozen.
--
-- Same shape as 0042 RC-5 (event_refunds): a BEFORE UPDATE OR DELETE row trigger that
-- only acts for API callers (current_user anon / authenticated); the service role and
-- the database owner (maintenance, definer paths) are untouched.
--
--   expense_claims  (pending → approved → paid; pending → paid; pending/approved → rejected)
--     * a new claim starts as 'pending' and is stamped with who entered it (created_by);
--     * once approved / paid / rejected: who, description, amount, quote_id, org_id,
--       created_by can't change and the row can't be deleted;
--     * the only further steps: approved → paid, approved → rejected. paid and rejected
--       are final. Reversals = a new (correcting) claim;
--     * maker-checker: whoever entered a claim can't approve it or mark it paid — unless
--       they are the studio admin (a one-person studio must still work; same rule as the
--       refund maker-checker in 0026 / 0032);
--     * any status change needs finance edit (role_access), on top of RLS.
--   change_requests (requested → approved | rejected; both final)
--     * a new change request starts as 'requested', created_by stamped;
--     * once decided: title, detail, price_delta, cost_delta, quote_id, org_id,
--       created_by, decided_at frozen; no delete; no further status change.
--   event_costs (no status column) — "locked" = the event is closed
--     (event_closure.closed_at set by close_event): no insert / update / delete of the
--     cost lines of a closed event. Re-opening the event (close_event false, closure
--     edit) is the legitimate path back.
--
-- Errors: SQLSTATE 42501 with HINT 'money_frozen' (the UI shows the message as-is).
--
-- DRIFT-SAFE: a missing table is skipped with a NOTICE; field comparisons go through
-- to_jsonb(row) so a missing column never breaks a write. Policies are not touched (RLS
-- is not weakened). No DROP TABLE / column, no DELETE, no UPDATE of data, no backfill.
-- Safe to re-run.
-- ============================================================================

create or replace function public._a46_changed(p_new jsonb, p_old jsonb, p_keys text[])
returns boolean language sql immutable set search_path = '' as $$
  select exists (select 1 from unnest(p_keys) k where (p_new -> k) is distinct from (p_old -> k));
$$;
revoke all on function public._a46_changed(jsonb, jsonb, text[]) from public, anon, authenticated;

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
        raise exception 'A new expense claim starts as pending — approve it as a separate step.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
      if n ? 'created_by' then new := jsonb_populate_record(new, jsonb_build_object('created_by', v_me)); end if;
      return new;
    end if;
    v_frozen := v_os in ('approved', 'paid', 'rejected');
    if tg_op = 'DELETE' then
      if v_frozen then
        raise exception 'An approved, paid or rejected expense claim can''t be deleted — add a correcting claim instead.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
      return old;
    end if;
    if (n -> 'created_by') is distinct from (o -> 'created_by') then
      raise exception 'Who entered an expense claim can''t be changed.' using errcode = '42501', hint = 'money_frozen';
    end if;
    if v_frozen and public._a46_changed(n, o, array['who', 'description', 'amount', 'quote_id', 'org_id']) then
      raise exception 'This expense claim is % and locked — its amount and details can''t be changed. Add a correcting claim instead.', v_os
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
        raise exception 'A new change request starts as requested — approve it as a separate step.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
      if n ? 'created_by' then new := jsonb_populate_record(new, jsonb_build_object('created_by', v_me)); end if;
      return new;
    end if;
    v_frozen := v_os in ('approved', 'rejected');
    if tg_op = 'DELETE' then
      if v_frozen then
        raise exception 'A decided change request can''t be deleted — add a new change request instead.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
      return old;
    end if;
    if (n -> 'created_by') is distinct from (o -> 'created_by') then
      raise exception 'Who entered a change request can''t be changed.' using errcode = '42501', hint = 'money_frozen';
    end if;
    if v_frozen and (v_ns is distinct from v_os
         or public._a46_changed(n, o, array['title', 'detail', 'price_delta', 'cost_delta', 'quote_id', 'org_id', 'decided_at'])) then
      raise exception 'This change request is % and locked — add a new change request instead.', v_os
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
        raise exception 'This event is closed — its cost lines are locked. Re-open the event from its Closure page to change them.'
          using errcode = '42501', hint = 'money_frozen';
      end if;
    end if;
    return coalesce(new, old);
  end if;

  return coalesce(new, old);
end $$;
revoke all on function public._a46_tg_money_freeze() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['expense_claims', 'change_requests', 'event_costs'] loop
    if to_regclass('public.' || t) is null then
      raise notice '0046: table public.% is absent — skipped', t;
      continue;
    end if;
    if t <> 'event_costs' and not exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass
                                             and a.attname = 'status' and not a.attisdropped) then
      raise notice '0046: public.% has no status column — skipped', t;
      continue;
    end if;
    execute format('drop trigger if exists ac_a46_money_freeze on public.%I', t);
    execute format('create trigger ac_a46_money_freeze before insert or update or delete on public.%I '
                   'for each row execute function public._a46_tg_money_freeze()', t);
  end loop;
end $$;
