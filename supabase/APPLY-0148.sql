-- APPLY-0148.sql - paste into the Supabase SQL editor (staging first, then prod). ASCII-only.
-- Additive + idempotent: CREATE OR REPLACE of _a49_close_gate + (guarded) tg_audit; no rows change.
begin;
-- ---- 1) close gate: ASCII-only messages -------------------------------------------------
do $$ begin
  if to_regprocedure('public._a49_close_blockers(uuid)') is null
     or to_regprocedure('public._a49_blocker_text(jsonb)') is null then
    raise exception 'STOP: 0049 (close gate) is not installed on this database';
  end if;
end $$;

create or replace function public._a49_close_gate(p_quote uuid, p_reason text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- close-gate-0148: ASCII-only messages
declare b jsonb; v_org uuid := public.current_org_id(); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  perform 1 from public.quotes q where q.id = p_quote for update;
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
revoke all on function public._a49_close_gate(uuid, text) from public, anon, authenticated;
grant execute on function public._a49_close_gate(uuid, text) to service_role;

-- ---- 2) audit: role + area on access-matrix edits -----------------------------------------
do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.tg_audit()');
  if v_src is null then
    raise notice '0148: public.tg_audit() not found - audit part skipped';
  elsif position('audit-run2-0042' in v_src) > 0 or position('audit-1017-0148' in v_src) > 0 then
    execute $fn$
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = 'public' as $body$
-- audit-run2-0042: the audit row carries the changed row's studio (C-09)
-- audit-1017-0148: role_access rows also carry role + area (entity id "role:area")
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_id text;
  v_quote uuid;
  v_changed jsonb;
  v_org uuid;
  o jsonb; n jsonb;
begin
  if v_actor is not null then select email into v_email from auth.users where id = v_actor; end if;
  if tg_op = 'DELETE' then n := to_jsonb(OLD); else n := to_jsonb(NEW); end if;
  if tg_op = 'UPDATE' then o := to_jsonb(OLD); end if;

  v_id := coalesce(n->>'id', n->>'quote_id');
  if tg_table_name = 'role_access' then v_id := coalesce(n->>'role', '') || ':' || coalesce(n->>'area', ''); end if;
  if tg_table_name = 'quotes' then v_quote := (n->>'id')::uuid;
  elsif n ? 'quote_id' then v_quote := nullif(n->>'quote_id','')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(o->key, n->key))
      into v_changed
      from jsonb_object_keys(n) as key
      where (o->key) is distinct from (n->key)
        and key not in ('updated_at','confirmed_at');
    if v_changed is null then return null; end if;
    if tg_table_name = 'role_access' then
      v_changed := v_changed || jsonb_build_object('role', n->'role', 'area', n->'area');
    end if;
  else
    v_changed := n;
  end if;

  if tg_table_name = 'organizations' and coalesce(n->>'id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'id')::uuid;
  elsif coalesce(n->>'org_id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'org_id')::uuid;
  end if;
  if v_org is null and v_quote is not null then
    select q.org_id into v_org from public.quotes q where q.id = v_quote;
  end if;
  v_org := coalesce(v_org, public.current_org_id());

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_actor, v_email, lower(tg_op), tg_table_name, v_id, v_quote, v_changed, v_org);
  return null;
end $body$
$fn$;
  else
    raise notice '0148: tg_audit on this database is not the known 0042 body - left unchanged';
  end if;
end $do$;
commit;

-- verify (read-only)
select 'close gate message is ASCII-only' as item,
       coalesce((select p.prosrc !~ '[^\x01-\x7f]' and position('close-gate-0148' in p.prosrc) > 0
                   from pg_proc p where p.oid = to_regprocedure('public._a49_close_gate(uuid,text)')), false) as ok
union all select 'close gate still enforces balance + checkouts',
       coalesce((select position('_a49_close_blockers(p_quote)' in p.prosrc) > 0 and position('pg_advisory_xact_lock' in p.prosrc) > 0
                   from pg_proc p where p.oid = to_regprocedure('public._a49_close_gate(uuid,text)')), false)
union all select 'close gate not callable by anon/authenticated',
       not has_function_privilege('authenticated', 'public._a49_close_gate(uuid,text)', 'execute')
       and not has_function_privilege('anon', 'public._a49_close_gate(uuid,text)', 'execute')
union all select 'tg_audit records role + area for role_access',
       coalesce((select position('audit-1017-0148' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public.tg_audit()')), false);
