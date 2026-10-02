-- advisor-hardening.sql — asserts the 0014 fixes that clear the Supabase Security
-- Advisor ERROR/WARN on the canonical path. Requires canonical migrations applied.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _ah; create temp table _ah(name text, result text);

do $$
begin
  -- 1) ledger table has RLS enabled (clears rls_disabled_in_public ERROR)
  if (select relrowsecurity from pg_class where oid = to_regclass('public.helm_schema_migrations')) then
    insert into _ah values('helm_schema_migrations RLS enabled','PASS');
  else insert into _ah values('helm_schema_migrations RLS enabled','FAIL: RLS off'); end if;

  -- 2) anon + authenticated have NO privilege on the ledger
  if not has_table_privilege('anon','public.helm_schema_migrations','select')
     and not has_table_privilege('authenticated','public.helm_schema_migrations','select')
     and not has_table_privilege('anon','public.helm_schema_migrations','insert')
     and not has_table_privilege('authenticated','public.helm_schema_migrations','insert') then
    insert into _ah values('ledger denied to anon/authenticated','PASS');
  else insert into _ah values('ledger denied to anon/authenticated','FAIL: API role has access'); end if;

  -- 3) set_updated_at has a pinned search_path (clears function_search_path_mutable)
  if exists (select 1 from pg_proc where oid = to_regprocedure('public.set_updated_at()')
             and proconfig is not null
             and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then
    insert into _ah values('set_updated_at search_path pinned','PASS');
  else insert into _ah values('set_updated_at search_path pinned','FAIL: mutable search_path'); end if;
exception when others then insert into _ah values('advisor-hardening setup','FAIL: '||left(sqlerrm,50)); end $$;

select name, result from _ah order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'ADVISOR-HARDENING: ALL PASS ('||count(*)||' checks)' else 'ADVISOR-HARDENING: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _ah;
