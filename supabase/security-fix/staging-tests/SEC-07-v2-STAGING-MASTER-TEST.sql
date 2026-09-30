-- =============================================================================
-- SEC-07 v2 — STAGING MASTER TEST (one file). STAGING ONLY: xizehqgeyjcfpzrdymly
-- Paste the WHOLE file into the Supabase SQL editor and Run. The result table
-- starts with the verdict rows. The two CONCURRENCY TAB sections at the bottom
-- are inside a comment and do NOT run with the file (see instructions there).
--
-- Safety
--  * Aborts before writing anything unless SEC-07 v2 is present (production has
--    no SEC-07, so it aborts there), unless no trigger on a touched table calls
--    code outside schema public (DB webhooks / pg_net), and unless the test ids
--    are free.
--  * Synthetic rows only: ids start with ee5ec07e-0000-4000-8000- (2 test
--    studios). Never calls request_otp / _notify / payment / send functions.
--  * A NEW function is created only inside a sub-transaction that is rolled back.
--  * Cleanup runs at the start and at the end; an unexpected error rolls back
--    the whole run (nothing is left). Real rows are fingerprinted before/after.
-- =============================================================================

-- ---------------------------------------------------------------- 0. helpers (session-temporary)
drop table if exists pg_temp.sec07_r;
drop table if exists pg_temp.sec07_fp;
create temp table sec07_r (ord serial, grp text, test text, expected text, actual text, ok boolean);
create temp table sec07_fp (tbl text primary key, before_h text, after_h text);

create or replace function pg_temp.sec07_rec(g text, t text, e text, a text, ok boolean) returns void
language sql as $f$ insert into pg_temp.sec07_r(grp, test, expected, actual, ok) values (g, t, e, coalesce(a,'<null>'), coalesce(ok,false)) $f$;

-- act as a test user (uuid), as 'anon', or clear claims (null). Role changes are transaction-local.
create or replace function pg_temp.sec07_act(p_who text) returns void language plpgsql as $f$
begin
  if p_who is null then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  elsif p_who = 'anon' then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    set local role anon;
  else
    perform set_config('request.jwt.claim.sub', p_who, true);
    perform set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end $f$;

-- stop every later block if the precheck failed
create or replace function pg_temp.sec07_guard() returns void language plpgsql as $f$
begin
  if exists (select 1 from pg_temp.sec07_r where grp in ('PRECHECK','STRUCTURAL') and not ok) then
    raise exception 'SEC-07 MASTER TEST ABORTED — precheck/structural FAIL: %',
      (select string_agg(test || ' = ' || actual, '; ' order by ord) from pg_temp.sec07_r where grp in ('PRECHECK','STRUCTURAL') and not ok);
  end if;
end $f$;

-- remove every synthetic row (loops until nothing is left to delete)
create or replace function pg_temp.sec07_cleanup() returns int language plpgsql as $f$
declare r record; n int; total int := 0; pass int := 0;
begin
  reset role;
  loop
    pass := pass + 1; n := 0;
    for r in select c.table_name from information_schema.columns c
               join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
              where c.table_schema = 'public' and c.column_name = 'org_id' and c.table_name not in ('organizations','profiles')
              order by c.table_name = 'quotes', c.table_name   -- quotes last in each pass
    loop
      begin
        execute format('delete from public.%I where org_id::text like %L', r.table_name, 'ee5ec07e-0000-4000-8000-%');
        get diagnostics n = row_count; total := total + n;
      exception when foreign_key_violation then null;   -- retried next pass
      end;
    end loop;
    exit when pass >= 6 or not exists (select 1 from public.quotes where org_id::text like 'ee5ec07e-0000-4000-8000-%') and n = 0;
  end loop;
  -- rows that point at test ids without a test org_id (e.g. audit entries)
  for r in select t.table_name from information_schema.tables t
            where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name not in ('organizations','profiles')
  loop
    begin
      execute format('delete from public.%I x where x::text like %L', r.table_name, '%ee5ec07e-0000-4000-8000-%');
      get diagnostics n = row_count; total := total + n;
    exception when others then null;
    end;
  end loop;
  delete from public.profiles where id::text like 'ee5ec07e-0000-4000-8000-%';     get diagnostics n = row_count; total := total + n;
  delete from public.organizations where id::text like 'ee5ec07e-0000-4000-8000-%'; get diagnostics n = row_count; total := total + n;
  delete from auth.users where id::text like 'ee5ec07e-0000-4000-8000-%';          get diagnostics n = row_count; total := total + n;
  -- the deletes above write audit entries that name the test ids: remove those last
  for r in select t.table_name from information_schema.tables t
            where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name not in ('organizations','profiles')
  loop
    execute format('delete from public.%I x where x::text like %L', r.table_name, '%ee5ec07e-0000-4000-8000-%');
    get diagnostics n = row_count; total := total + n;
  end loop;
  return total;
end $f$;

-- count every row anywhere in public (and auth.users) that mentions a test id
create or replace function pg_temp.sec07_leftover() returns bigint language plpgsql as $f$
declare r record; n bigint; total bigint := 0;
begin
  for r in select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' loop
    execute format('select count(*) from public.%I x where x::text like %L or x::text like %L', r.table_name,
                   '%ee5ec07e-0000-4000-8000-%', '%ee5ec06e-0000-4000-8000-%') into n;
    total := total + n;
  end loop;
  select total + count(*) into total from auth.users where id::text like 'ee5ec07e-0000-4000-8000-%' or id::text like 'ee5ec06e-0000-4000-8000-%';
  select total + count(*) into total from pg_proc where proname = 'zz_sec07_probe';
  return total;
end $f$;

-- fingerprint of every NON-test row in public + auth.users
create or replace function pg_temp.sec07_fingerprint(p_after boolean) returns void language plpgsql as $f$
declare r record; h text;
begin
  for r in select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' loop
    execute format('select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) from public.%I x where x::text not like %L',
                   '|', '', r.table_name, '%ee5ec07e-0000-4000-8000-%') into h;
    if p_after then update pg_temp.sec07_fp set after_h = h where tbl = r.table_name;
    else insert into pg_temp.sec07_fp(tbl, before_h) values (r.table_name, h); end if;
  end loop;
  select md5(coalesce(string_agg(u::text, '|' order by u::text), '')) into h from auth.users u where id::text not like 'ee5ec07e-0000-4000-8000-%';
  if p_after then update pg_temp.sec07_fp set after_h = h where tbl = 'auth.users';
  else insert into pg_temp.sec07_fp(tbl, before_h) values ('auth.users', h); end if;
end $f$;

-- ---------------------------------------------------------------- 1. environment / safety precheck
do $$
declare v text; v_ok boolean;
begin
  perform pg_temp.sec07_rec('PRECHECK', 'running as', 'postgres', current_user, current_user = 'postgres');
  perform pg_temp.sec07_rec('PRECHECK', 'transaction isolation', 'read committed', current_setting('transaction_isolation'),
                            current_setting('transaction_isolation') = 'read committed');
  -- SEC-07 v2 present (production has no SEC-07 → the file stops here there)
  v_ok := to_regprocedure('public.generate_approval_token(uuid)') is not null
          and pg_get_functiondef('public.generate_approval_token(uuid)'::regprocedure) like '%SEC-07 G1%';
  perform pg_temp.sec07_rec('PRECHECK', 'SEC-07 v2 installed (staging)', 'true', v_ok::text, v_ok);
  v_ok := to_regprocedure('public.generate_approval_token(uuid)') is not null
          and pg_get_functiondef('public.generate_approval_token(uuid)'::regprocedure) like '%SEC-05 F10%';
  perform pg_temp.sec07_rec('PRECHECK', 'SEC-05 installed', 'true', v_ok::text, v_ok);
  v_ok := to_regprocedure('public.return_reservation(uuid,numeric)') is not null and to_regprocedure('public.invitation_preview(text)') is not null;
  perform pg_temp.sec07_rec('PRECHECK', 'SEC-06 installed', 'true', v_ok::text, v_ok);
  -- no trigger on a table this test writes to calls code outside schema public (DB webhooks, pg_net, …)
  select string_agg(t.tgrelid::regclass || '.' || t.tgname || ' -> ' || p.pronamespace::regnamespace || '.' || p.proname, ', ')
    into v
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal and p.pronamespace <> 'public'::regnamespace
     and t.tgrelid in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                        where (n.nspname = 'public' and c.relname in ('quotes','quote_otps','work_tokens','event_tasks','organizations','profiles',
                                                                     'leads','lead_archive','audit_log','notifications'))
                           or (n.nspname = 'auth' and c.relname = 'users'));
  perform pg_temp.sec07_rec('PRECHECK', 'no external trigger (webhook/pg_net) on touched tables', 'none', coalesce(v, 'none'), v is null);
  -- test phone numbers (+99 = unassigned country code) have no codes in real data
  select count(*)::text into v from public.quote_otps
   where org_id::text not like 'ee5ec07e-0000-4000-8000-%' and regexp_replace(phone, '[^0-9]', '', 'g') like '990%';
  perform pg_temp.sec07_rec('PRECHECK', 'test phone numbers (+99…) unused by real data', '0', v, v = '0');
  -- test ids free: only rows from an earlier run of THIS test may exist (they are removed next)
  select string_agg(id::text || ' ' || name, ', ') into v from public.organizations
   where id::text like 'ee5ec07e-0000-4000-8000-%' and name not like 'SEC07-TEST%';
  perform pg_temp.sec07_rec('PRECHECK', 'test ids not used by real data', 'none', coalesce(v, 'none'), v is null);
  perform pg_temp.sec07_guard();   -- stop here (nothing written) if anything above failed
end $$;

-- ---------------------------------------------------------------- 2. SEC-07 v2 structural verification
do $$
declare v_ok boolean; v text; n_cand int; n_guard int; n_missing int; n_unexp int;
begin
  v_ok := not exists (select 1 from public.quotes where approval_token is not null and approval_token_expires_at is null);
  perform pg_temp.sec07_rec('STRUCTURAL', 'G1 every approval link has an expiry', 'true', v_ok::text, v_ok);
  v_ok := exists (select 1 from pg_trigger where tgname = 'zz_approval_token_expiry' and tgrelid = 'public.quotes'::regclass);
  perform pg_temp.sec07_rec('STRUCTURAL', 'G1 expiry trigger on quotes', 'true', v_ok::text, v_ok);
  v_ok := not exists (select 1 from public.work_tokens where expires_at is null);
  perform pg_temp.sec07_rec('STRUCTURAL', 'G2 every worker link has an expiry', 'true', v_ok::text, v_ok);
  v := coalesce((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'work_tokens' and column_name = 'expires_at'), '<none>');
  perform pg_temp.sec07_rec('STRUCTURAL', 'G2 work_tokens.expires_at default dropped (v2)', '<none>', v, v = '<none>');
  v_ok := exists (select 1 from pg_trigger where tgname = 'zz_work_token_expiry' and tgrelid = 'public.work_tokens'::regclass)
      and exists (select 1 from pg_trigger where tgname = 'zz_work_token_renew' and tgrelid = 'public.event_tasks'::regclass);
  perform pg_temp.sec07_rec('STRUCTURAL', 'G2 issue + renew triggers', 'true', v_ok::text, v_ok);
  v_ok := exists (select 1 from pg_trigger where tgname = 'zz_otp_rate_limit' and tgrelid = 'public.quote_otps'::regclass)
      and coalesce(pg_get_functiondef(to_regprocedure('public.tg_otp_rate_limit()')), '') ~ 'helm:otp:phone:.*helm:otp:quote:';
  perform pg_temp.sec07_rec('STRUCTURAL', 'G3 OTP trigger, locks phone then quote', 'true', v_ok::text, v_ok);
  with cand as (select c.table_name::text t from information_schema.columns c
                  join information_schema.columns o on o.table_schema = c.table_schema and o.table_name = c.table_name and o.column_name = 'org_id'
                  join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
                 where c.table_schema = 'public' and c.column_name = 'quote_id' and c.table_name <> 'quotes'),
       guarded as (select replace(g.tgrelid::regclass::text, 'public.', '') t, encode(g.tgargs, 'escape') args
                     from pg_trigger g where g.tgname = 'zz_quote_org_match' and not g.tgisinternal)
  select (select count(*) from cand), (select count(*) from guarded),
         (select count(*) from cand where t not in (select t from guarded)),
         (select count(*) from guarded where t not in (select t from cand))
       + (select count(*) from guarded where args like 'allow_dangling%' and t not in ('audit_log','lead_archive'))
    into n_cand, n_guard, n_missing, n_unexp;
  perform pg_temp.sec07_rec('STRUCTURAL', 'G4 quote/studio guard coverage', 'missing=0 unexpected=0',
                            'candidates=' || n_cand || ' guarded=' || n_guard || ' missing=' || n_missing || ' unexpected=' || n_unexp,
                            n_cand > 0 and n_missing = 0 and n_unexp = 0);
  with owners as (select distinct p.proowner r from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
       eff as (select coalesce((select defaclacl from pg_default_acl where defaclrole = o.r and defaclnamespace = 0 and defaclobjtype = 'f'), acldefault('f', o.r))
                   || coalesce((select defaclacl from pg_default_acl where defaclrole = o.r and defaclnamespace = 'public'::regnamespace and defaclobjtype = 'f'), '{}'::aclitem[]) acl
                 from owners o)
  select bool_and(not exists (select 1 from aclexplode(acl) a where a.grantee in (0, 'anon'::regrole) and a.privilege_type = 'EXECUTE'))
     and bool_and(exists (select 1 from aclexplode(acl) a where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'))
    into v_ok from eff;
  perform pg_temp.sec07_rec('STRUCTURAL', 'G5 default privileges: PUBLIC/anon no, authenticated yes', 'true', v_ok::text, coalesce(v_ok, false));
  perform pg_temp.sec07_guard();
end $$;

-- ---------------------------------------------------------------- 3. synthetic test data
select pg_temp.sec07_guard();
select pg_temp.sec07_cleanup();          -- leftovers of an earlier interrupted run
do $$   -- residue of the earlier SEC-06 editor test (audit entries without a studio id, ids ee5ec06e-0000-4000-8000-…)
declare r record; n int; total int := 0;
begin
  perform pg_temp.sec07_guard();
  for r in select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' loop
    execute format('delete from public.%I x where x::text like %L', r.table_name, '%ee5ec06e-0000-4000-8000-%');
    get diagnostics n = row_count; total := total + n;
  end loop;
  perform pg_temp.sec07_rec('CLEANUP', 'SEC-06 test residue removed first (informational)', 'any', total::text, true);
end $$;
select pg_temp.sec07_fingerprint(false); -- real rows, before
do $$ begin
  perform pg_temp.sec07_guard();
  insert into auth.users(id, email) values
    ('ee5ec07e-0000-4000-8000-0000000000a1', 'sec07-a@example.invalid'),
    ('ee5ec07e-0000-4000-8000-0000000000b1', 'sec07-b@example.invalid');
  insert into public.organizations(id, name) values
    ('ee5ec07e-0000-4000-8000-00000000000a', 'SEC07-TEST Studio A'),
    ('ee5ec07e-0000-4000-8000-00000000000b', 'SEC07-TEST Studio B');
  insert into public.profiles(id, org_id, role) values
    ('ee5ec07e-0000-4000-8000-0000000000a1', 'ee5ec07e-0000-4000-8000-00000000000a', 'admin'),
    ('ee5ec07e-0000-4000-8000-0000000000b1', 'ee5ec07e-0000-4000-8000-00000000000b', 'admin')
  on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  insert into public.quotes(id, org_id, code, title, pricing, event_date) values
    ('ee5ec07e-0000-4000-8000-00000000c001', 'ee5ec07e-0000-4000-8000-00000000000a', 'SEC07-T1', 'SEC07 approval link', '{"gstPct":18,"chairs":1,"chairPrice":1}', current_date + 90),
    ('ee5ec07e-0000-4000-8000-00000000c002', 'ee5ec07e-0000-4000-8000-00000000000a', 'SEC07-T2', 'SEC07 no event / otp phone', '{"gstPct":18,"chairs":1,"chairPrice":1}', null),
    ('ee5ec07e-0000-4000-8000-00000000c003', 'ee5ec07e-0000-4000-8000-00000000000a', 'SEC07-T3', 'SEC07 otp quote', '{"gstPct":18,"chairs":1,"chairPrice":1}', null),
    ('ee5ec07e-0000-4000-8000-00000000c004', 'ee5ec07e-0000-4000-8000-00000000000a', 'SEC07-T4', 'SEC07 delete', '{"gstPct":18,"chairs":1,"chairPrice":1}', null),
    ('ee5ec07e-0000-4000-8000-00000000c005', 'ee5ec07e-0000-4000-8000-00000000000a', 'SEC07-T5', 'SEC07 worker link', '{"gstPct":18,"chairs":1,"chairPrice":1}', current_date + 90);
  -- quote T2: 2 codes to one number in the last hour (written two ways) + 1 older than an hour
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id, created_at) values
    ('ee5ec07e-0000-4000-8000-00000000c002', '+99 0000 070707', 'x', now() + interval '10 min', 'ee5ec07e-0000-4000-8000-00000000000a', now()),
    ('ee5ec07e-0000-4000-8000-00000000c002', '990000070707',   'x', now() + interval '10 min', 'ee5ec07e-0000-4000-8000-00000000000a', now()),
    ('ee5ec07e-0000-4000-8000-00000000c002', '990000070707',   'x', now() - interval '110 min', 'ee5ec07e-0000-4000-8000-00000000000a', now() - interval '2 hours');
  -- quote T3: 9 codes today, each to a different number
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
  select 'ee5ec07e-0000-4000-8000-00000000c003', '99071000' || g, 'x', now() + interval '10 min', 'ee5ec07e-0000-4000-8000-00000000000a'
    from generate_series(10, 18) g;
end $$;

-- ---------------------------------------------------------------- 4. G1 approval links
do $$
declare A text := 'ee5ec07e-0000-4000-8000-0000000000a1'; B text := 'ee5ec07e-0000-4000-8000-0000000000b1';
        Q1 uuid := 'ee5ec07e-0000-4000-8000-00000000c001'; Q2 uuid := 'ee5ec07e-0000-4000-8000-00000000c002';
        t1 uuid; t1b uuid; t2 uuid; t3 uuid; v text; d int; ok boolean;
begin
  perform pg_temp.sec07_guard();
  -- issue
  perform pg_temp.sec07_act(A); t1 := public.generate_approval_token(Q1); reset role; perform pg_temp.sec07_act(null);
  select approval_token_expires_at::date - current_date into d from public.quotes where id = Q1;
  perform pg_temp.sec07_rec('G1', 'issue: expiry = event date + 30 days', '120 days', d || ' days', d = 120);
  perform pg_temp.sec07_act(A); t1b := public.generate_approval_token(Q1); reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G1', 're-issue of a LIVE link keeps the same token', 'same', case when t1b = t1 then 'same' else 'changed' end, t1b = t1);
  perform pg_temp.sec07_act('anon'); v := public.public_get_quote(t1) ->> 'code'; reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G1', 'client (anon) opens a live link', 'SEC07-T1', v, v = 'SEC07-T1');
  -- another studio cannot mint a link for this quote
  begin
    perform pg_temp.sec07_act(B); perform public.generate_approval_token(Q1); v := 'NO ERROR';
  exception when others then v := sqlerrm;
  end;
  reset role; perform pg_temp.sec07_act(null);
  ok := v <> 'NO ERROR' and (select approval_token from public.quotes where id = Q1) = t1;
  perform pg_temp.sec07_rec('G1', 'other studio cannot issue the link', 'error, token unchanged', v, ok);
  -- expiry cannot be cleared
  update public.quotes set approval_token_expires_at = null where id = Q1;
  select (approval_token_expires_at is not null) into ok from public.quotes where id = Q1;
  perform pg_temp.sec07_rec('G1', 'expiry cannot be cleared', 'true', ok::text, ok);
  -- expired link is refused
  update public.quotes set approval_token_expires_at = now() - interval '1 minute' where id = Q1;
  begin
    perform pg_temp.sec07_act('anon'); perform public.public_get_quote(t1); v := 'NO ERROR';
  exception when others then v := sqlerrm;
  end;
  reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G1', 'client (anon) refused on an EXPIRED link', 'invalid link', v, v = 'invalid link');
  -- approval does not revive an expired link
  update public.quotes set approval_status = 'approved' where id = Q1;
  select approval_token_expires_at < now() into ok from public.quotes where id = Q1;
  perform pg_temp.sec07_rec('G1', 'approval does not revive an expired link', 'true', ok::text, ok);
  update public.quotes set approval_status = 'sent' where id = Q1;
  -- staff re-issue gives a NEW token; old one stays dead
  perform pg_temp.sec07_act(A); t2 := public.generate_approval_token(Q1); reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_act('anon'); v := public.public_get_quote(t2) ->> 'code'; reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G1', 're-issue of expired link: NEW token works', 'new token, SEC07-T1',
                            case when t2 <> t1 then 'new token, ' else 'SAME token, ' end || coalesce(v, '<null>'), t2 <> t1 and v = 'SEC07-T1');
  begin
    perform pg_temp.sec07_act('anon'); perform public.public_get_quote(t1); v := 'NO ERROR';
  exception when others then v := sqlerrm;
  end;
  reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G1', 'old (replaced) token refused', 'invalid link', v, v = 'invalid link');
  -- live link follows a later event date
  update public.quotes set event_date = current_date + 200 where id = Q1;
  select approval_token_expires_at::date - current_date into d from public.quotes where id = Q1;
  perform pg_temp.sec07_rec('G1', 'live link extended when event moves later', '230 days', d || ' days', d = 230);
  -- revoke, then re-issue
  perform pg_temp.sec07_act(A); perform public.revoke_approval_token(Q1); reset role; perform pg_temp.sec07_act(null);
  begin
    perform pg_temp.sec07_act('anon'); perform public.public_get_quote(t2); v := 'NO ERROR';
  exception when others then v := sqlerrm;
  end;
  reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G1', 'revoked link refused', 'invalid link', v, v = 'invalid link');
  perform pg_temp.sec07_act(A); t3 := public.generate_approval_token(Q1); reset role; perform pg_temp.sec07_act(null);
  select approval_token_revoked_at is null and approval_token_expires_at > now() and t3 <> t2 into ok from public.quotes where id = Q1;
  perform pg_temp.sec07_rec('G1', 're-issue after revoke: new live token, revoke flag cleared', 'true', ok::text, ok);
  -- quote without an event date: 30 days
  perform pg_temp.sec07_act(A); perform public.generate_approval_token(Q2); reset role; perform pg_temp.sec07_act(null);
  select approval_token_expires_at::date - current_date into d from public.quotes where id = Q2;
  perform pg_temp.sec07_rec('G1', 'quote without event date: expiry = 30 days', '30 days', d || ' days', d = 30);
end $$;

-- ---------------------------------------------------------------- 5. G2 worker links
do $$
declare Q5 uuid := 'ee5ec07e-0000-4000-8000-00000000c005'; Q2 uuid := 'ee5ec07e-0000-4000-8000-00000000c002';
        OA uuid := 'ee5ec07e-0000-4000-8000-00000000000a';
        W1 uuid := 'ee5ec07e-0000-4000-8000-00000000f001'; W2 uuid := 'ee5ec07e-0000-4000-8000-00000000f002';
        v text; d int; ok boolean;
begin
  perform pg_temp.sec07_guard();
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values (W1, Q5, '9907000001', 'SEC07 worker 1', OA);
  select expires_at::date - current_date into d from public.work_tokens where token = W1;
  perform pg_temp.sec07_rec('G2', 'issue: expiry = event date + 14 days', '104 days', d || ' days', d = 104);
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values (W2, Q2, '9907000002', 'SEC07 worker 2', OA);
  select expires_at::date - current_date into d from public.work_tokens where token = W2;
  perform pg_temp.sec07_rec('G2', 'issue without event date: expiry = 60 days', '60 days', d || ' days', d = 60);
  perform pg_temp.sec07_act('anon'); ok := public.worker_get_tasks(W1) is not null; reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G2', 'worker (anon) opens a live link', 'true', ok::text, ok);
  update public.work_tokens set expires_at = now() - interval '1 day' where token = W1;
  begin
    perform pg_temp.sec07_act('anon'); perform public.worker_get_tasks(W1); v := 'NO ERROR';
  exception when others then v := sqlerrm;
  end;
  reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G2', 'worker refused on an EXPIRED link', 'link expired or revoked', v, v = 'link expired or revoked');
  insert into public.event_tasks(quote_id, category, title, assignee_phone, status, org_id)
  values (Q5, 'setup', 'SEC07 task for another worker', '9907000009', 'assigned', OA);
  select expires_at < now() into ok from public.work_tokens where token = W1;
  perform pg_temp.sec07_rec('G2', 'task for a DIFFERENT worker does not renew this link', 'true', ok::text, ok);
  insert into public.event_tasks(quote_id, category, title, assignee_phone, status, org_id)
  values (Q5, 'setup', 'SEC07 task 1', '9907000001', 'assigned', OA);
  select expires_at::date - current_date into d from public.work_tokens where token = W1;
  perform pg_temp.sec07_act('anon'); ok := public.worker_get_tasks(W1) is not null; reset role; perform pg_temp.sec07_act(null);
  perform pg_temp.sec07_rec('G2', 'new assignment renews the expired link', '104 days, opens', d || ' days, ' || case when ok then 'opens' else 'refused' end, d = 104 and ok);
  update public.work_tokens set revoked_at = now(), expires_at = now() - interval '1 day' where token = W1;
  insert into public.event_tasks(quote_id, category, title, assignee_phone, status, org_id)
  values (Q5, 'setup', 'SEC07 task 2', '9907000001', 'assigned', OA);
  begin
    perform pg_temp.sec07_act('anon'); perform public.worker_get_tasks(W1); v := 'NO ERROR';
  exception when others then v := sqlerrm;
  end;
  reset role; perform pg_temp.sec07_act(null);
  select expires_at < now() into ok from public.work_tokens where token = W1;
  perform pg_temp.sec07_rec('G2', 'REVOKED link not renewed by a new assignment', 'still expired, refused',
                            case when ok then 'still expired, ' else 'RENEWED, ' end || v, ok and v = 'link expired or revoked');
end $$;

-- ---------------------------------------------------------------- 6. G3 OTP send limits (sequential; concurrency: TAB 1 + TAB 2 below)
do $$
declare Q2 uuid := 'ee5ec07e-0000-4000-8000-00000000c002'; Q3 uuid := 'ee5ec07e-0000-4000-8000-00000000c003';
        OA uuid := 'ee5ec07e-0000-4000-8000-00000000000a'; v text;
begin
  perform pg_temp.sec07_guard();
  -- number +99 0000 070707 (unassigned country code): 2 in the last hour + 1 older
  begin
    insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values (Q2, '+99-0000-070707', 'x', now() + interval '10 min', OA);
    v := 'accepted';
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G3', 'phone: 3rd code in an hour accepted (older code not counted)', 'accepted', v, v = 'accepted');
  begin
    insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values (Q2, '(+99) 0000-070707', 'x', now() + interval '10 min', OA);
    v := 'accepted';
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G3', 'phone: 4th code in an hour refused (any formatting)', 'too many codes sent to this number…', v, v like 'too many codes sent to this number%');
  begin
    insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values (Q2, '+99 0000 070708', 'x', now() + interval '10 min', OA);
    v := 'accepted';
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G3', 'phone: a different number is not blocked', 'accepted', v, v = 'accepted');
  -- quote T3: 9 codes today
  begin
    insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values (Q3, '9907200001', 'x', now() + interval '10 min', OA);
    v := 'accepted';
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G3', 'quote: 10th code today accepted', 'accepted', v, v = 'accepted');
  begin
    insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values (Q3, '9907200002', 'x', now() + interval '10 min', OA);
    v := 'accepted';
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G3', 'quote: 11th code today refused', 'too many codes requested for this quote…', v, v like 'too many codes requested for this quote%');
end $$;

-- ---------------------------------------------------------------- 7. G4 cross-studio / unknown quote
do $$
declare Q1 uuid := 'ee5ec07e-0000-4000-8000-00000000c001'; Q4 uuid := 'ee5ec07e-0000-4000-8000-00000000c004';
        Q5 uuid := 'ee5ec07e-0000-4000-8000-00000000c005';
        OA uuid := 'ee5ec07e-0000-4000-8000-00000000000a'; OB uuid := 'ee5ec07e-0000-4000-8000-00000000000b'; v text; ok boolean;
begin
  perform pg_temp.sec07_guard();
  begin
    insert into public.event_tasks(quote_id, category, title, status, org_id) values (Q1, 'setup', 'SEC07 cross', 'assigned', OB);
    v := 'accepted';
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G4', 'task for another studio''s quote refused', 'quote belongs to another studio', v, v like '%another studio%');
  begin
    insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('ee5ec07e-0000-4000-8000-00000000f009', Q1, '9907000003', 'SEC07 cross', OB);
    v := 'accepted';
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G4', 'worker link for another studio''s quote refused', 'quote belongs to another studio', v, v like '%another studio%');
  begin
    update public.event_tasks set org_id = OB where quote_id = Q5 and title = 'SEC07 task 1';
    v := case when found then 'accepted' else 'no row' end;
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G4', 'moving an existing task to another studio refused', 'quote belongs to another studio', v, v like '%another studio%');
  begin
    insert into public.event_tasks(quote_id, category, title, status, org_id) values ('ee5ec07e-0000-4000-8000-0000deadbeef', 'setup', 'SEC07 unknown', 'assigned', OA);
    v := 'accepted';
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G4', 'task for an unknown quote refused', 'quote not found', v, v like '%quote not found%' or v like '%foreign key%');
  begin
    delete from public.quotes where id = Q4;
    select not exists (select 1 from public.quotes where id = Q4) into ok; v := ok::text;
  exception when others then v := sqlerrm; ok := false;
  end;
  perform pg_temp.sec07_rec('G4', 'deleting a quote still works (audit keeps its id)', 'true', v, ok);
end $$;

-- ---------------------------------------------------------------- 8. G5 function privileges
do $$
declare v text; ok boolean;
begin
  perform pg_temp.sec07_guard();
  begin   -- probe: created, checked, then rolled back
    create function public.zz_sec07_probe() returns int language sql as 'select 1';
    v := (not has_function_privilege('anon', 'public.zz_sec07_probe()', 'EXECUTE')
          and has_function_privilege('authenticated', 'public.zz_sec07_probe()', 'EXECUTE')
          and not exists (select 1 from aclexplode((select proacl from pg_proc where oid = 'public.zz_sec07_probe()'::regprocedure)) a where a.grantee = 0))::text;
    raise exception 'G5PROBE:%', v;
  exception when others then v := sqlerrm;
  end;
  perform pg_temp.sec07_rec('G5', 'NEW public function: PUBLIC/anon cannot, authenticated can (probe rolled back)', 'G5PROBE:true', v, v = 'G5PROBE:true');
  select bool_and(has_function_privilege('anon', f, 'EXECUTE')) into ok
    from unnest(array['public.public_get_quote(uuid)','public.public_get_portal(uuid)','public.worker_get_tasks(uuid)',
                      'public.invitation_preview(text)','public.request_otp(uuid,text)']) f;
  perform pg_temp.sec07_rec('G5', 'existing client/worker/invite RPCs still callable by anon', 'true', ok::text, ok);
  ok := not has_function_privilege('anon', 'public.generate_approval_token(uuid)', 'EXECUTE')
        and has_function_privilege('authenticated', 'public.generate_approval_token(uuid)', 'EXECUTE');
  perform pg_temp.sec07_rec('G5', 'generate_approval_token: anon no, staff yes', 'true', ok::text, ok);
  select bool_and(not has_function_privilege('anon', f, 'EXECUTE') and not has_function_privilege('authenticated', f, 'EXECUTE')) into ok
    from unnest(array['public.tg_otp_rate_limit()','public.tg_quote_org_match()','public.tg_work_token_expiry()','public.tg_work_token_renew()']) f;
  perform pg_temp.sec07_rec('G5', 'SEC-07 trigger functions not callable via the API', 'true', ok::text, ok);
end $$;

-- ---------------------------------------------------------------- 9. other regression checks
do $$
declare n int;
begin
  perform pg_temp.sec07_guard();
  select count(*) into n from public.notifications where quote_id::text like 'ee5ec07e-0000-4000-8000-%';
  perform pg_temp.sec07_rec('REGRESSION', 'no SMS/WhatsApp/email queued for test quotes', '0', n::text, n = 0);
  perform pg_temp.sec07_rec('REGRESSION', 'session role back to postgres', 'postgres', current_user, current_user = 'postgres');
end $$;

-- ---------------------------------------------------------------- 10/11/12. cleanup, leftover check, summary
select pg_temp.sec07_act(null);
select pg_temp.sec07_cleanup();
select pg_temp.sec07_fingerprint(true);
do $$
declare n bigint; v text;
begin
  n := pg_temp.sec07_leftover();
  perform pg_temp.sec07_rec('CLEANUP', 'leftover test rows, SEC-07 + SEC-06 ids (all public tables + auth.users + probe)', '0', n::text, n = 0);
  select string_agg(tbl, ', ' order by tbl) into v from pg_temp.sec07_fp where before_h is distinct from after_h;
  perform pg_temp.sec07_rec('CLEANUP', 'real (non-test) rows unchanged in every table', 'none changed', coalesce(v, 'none changed'),
                            v is null and exists (select 1 from pg_temp.sec07_fp));
end $$;

with r as (select * from pg_temp.sec07_r),
s as (
  select (select bool_and(ok) from r where grp in ('PRECHECK','STRUCTURAL')) as st,
         (select bool_and(ok) from r where grp in ('G1','G2','G3','G4','G5','REGRESSION')) as be,
         (select count(*) filter (where ok) from r where grp in ('G1','G2','G3','G4','G5','REGRESSION')) as be_pass,
         (select count(*) from r where grp in ('G1','G2','G3','G4','G5','REGRESSION')) as be_all,
         (select bool_and(ok) from r where grp = 'CLEANUP') as cl,
         (select actual from r where grp = 'CLEANUP' and test like 'leftover%') as lo)
select * from (
  select 0 as ord, '== SUMMARY' as grp,
         'FINAL STAGING VERDICT: ' || case when st and be and be_all = 36 and cl then 'PASS' else 'FAIL' end
         || '  (then run CONCURRENCY TAB 1 + TAB 2)' as test, '' as expected, '' as actual, '' as result from s
  union all select 1, '== SUMMARY', 'SEC-07 STRUCTURAL: ' || case when st then 'PASS' else 'FAIL' end, '', '', '' from s
  union all select 2, '== SUMMARY', 'SEC-07 BEHAVIOR: ' || case when be and be_all = 36 then 'PASS' else 'FAIL' end || ' (' || be_pass || '/' || be_all || ', expected 36/36)', '', '', '' from s
  union all select 3, '== SUMMARY', 'SEC-07 CLEANUP: ' || case when cl then 'PASS' else 'FAIL' end, '', '', '' from s
  union all select 4, '== SUMMARY', 'LEFTOVER TEST ROWS: ' || coalesce(lo, '?'), '', '', '' from s
  union all select 5, '== SUMMARY', 'SEC-07 CONCURRENCY: not in this run — see CONCURRENCY TAB 1 / TAB 2 at the bottom of the file', '', '', '' from s
  union all select 10 + ord, grp, test, expected, actual, case when ok then 'PASS' else 'FAIL' end from r
) x order by ord;


/* =============================================================================
   CONCURRENCY TAB 1 + TAB 2  (two genuinely separate sessions: two editor tabs)
   Run AFTER the main file. Copy only the text between the markers.
   1. Open a NEW editor tab, paste the TAB 1 section, Run (it holds 20 s).
   2. Within those 20 s, in ANOTHER new tab, paste the TAB 2 section, Run.
   TAB 2 must wait, then show SEC-07 CONCURRENCY: PASS and LEFTOVER TEST ROWS: 0.
   ============================================================================

-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> CONCURRENCY TAB 1 — copy from here
begin;
insert into public.organizations(id, name) values ('ee5ec07e-0000-4000-8000-00000000000c', 'SEC07-TEST Studio C') on conflict (id) do nothing;
insert into public.quotes(id, org_id, code, title, pricing) values
  ('ee5ec07e-0000-4000-8000-0000000cc001', 'ee5ec07e-0000-4000-8000-00000000000c', 'SEC07-C1', 'SEC07 concurrency', '{"gstPct":18,"chairs":1,"chairPrice":1}')
on conflict (id) do nothing;
delete from public.quote_otps where quote_id = 'ee5ec07e-0000-4000-8000-0000000cc001';
insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values
  ('ee5ec07e-0000-4000-8000-0000000cc001', '+99 0000 077777', 'x', now() + interval '10 min', 'ee5ec07e-0000-4000-8000-00000000000c'),
  ('ee5ec07e-0000-4000-8000-0000000cc001', '990000077777',   'x', now() + interval '10 min', 'ee5ec07e-0000-4000-8000-00000000000c');
commit;
begin;
insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values
  ('ee5ec07e-0000-4000-8000-0000000cc001', '+99-0000-077777', 'x', now() + interval '10 min', 'ee5ec07e-0000-4000-8000-00000000000c');
select pg_sleep(20);
commit;
select 'CONCURRENCY TAB 1: done (3rd code committed) — read the result in TAB 2' as tab1, clock_timestamp() as at;
-- <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< CONCURRENCY TAB 1 — copy to here

-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> CONCURRENCY TAB 2 — copy from here
drop table if exists pg_temp.sec07_c;
create temp table sec07_c (ord int, line text);
do $$
declare t0 timestamptz; waited numeric; v text; n int; lo bigint; r record; ok boolean;
begin
  if not exists (select 1 from public.quotes where id = 'ee5ec07e-0000-4000-8000-0000000cc001') then
    insert into pg_temp.sec07_c values (0, 'SEC-07 CONCURRENCY: NOT RUN — run TAB 1 first, then TAB 2 within 20 s');
  else
    t0 := clock_timestamp();
    begin   -- 4th code to the same number while TAB 1 holds the 3rd one uncommitted
      insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values
        ('ee5ec07e-0000-4000-8000-0000000cc001', '(+99) 0000-077777', 'x', now() + interval '10 min', 'ee5ec07e-0000-4000-8000-00000000000c');
      v := 'ACCEPTED';
    exception when others then v := sqlerrm;
    end;
    waited := round(extract(epoch from clock_timestamp() - t0)::numeric, 1);
    select count(*) into n from public.quote_otps
     where quote_id = 'ee5ec07e-0000-4000-8000-0000000cc001' and regexp_replace(phone, '[^0-9]', '', 'g') = '990000077777';
    ok := waited >= 2 and v like 'too many codes sent to this number%' and n = 3;
    insert into pg_temp.sec07_c values
      (1, 'TAB 2 waited for TAB 1: ' || waited || ' s (expect >= 2)'),
      (2, 'TAB 2 4th code: ' || v || ' (expect: too many codes sent to this number…)'),
      (3, 'codes stored for the number: ' || n || ' (expect 3)'),
      (0, 'SEC-07 CONCURRENCY: ' || case when ok then 'PASS' else 'FAIL' end
          || case when v = 'ACCEPTED' then ' — 4th code ACCEPTED: the limit is NOT serialized'
                  when waited < 2 then ' — TAB 2 did not wait: start it while TAB 1 is still running' else '' end);
  end if;
  -- cleanup of the concurrency fixtures (Studio C)
  delete from public.quote_otps where org_id = 'ee5ec07e-0000-4000-8000-00000000000c';
  for r in select c.table_name from information_schema.columns c
             join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
            where c.table_schema = 'public' and c.column_name = 'org_id' and c.table_name not in ('quotes','organizations','profiles')
  loop execute format('delete from public.%I where org_id = %L', r.table_name, 'ee5ec07e-0000-4000-8000-00000000000c'); end loop;
  delete from public.quotes where org_id = 'ee5ec07e-0000-4000-8000-00000000000c';
  for r in select t.table_name from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> 'organizations' loop
    execute format('delete from public.%I x where x::text like %L', r.table_name, '%ee5ec07e-0000-4000-8000-%');
  end loop;
  delete from public.organizations where id::text like 'ee5ec07e-0000-4000-8000-%';
  for r in select t.table_name from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' loop
    execute format('delete from public.%I x where x::text like %L', r.table_name, '%ee5ec07e-0000-4000-8000-%');
  end loop;
  lo := 0;
  for r in select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' loop
    execute format('select count(*) from public.%I x where x::text like %L', r.table_name, '%ee5ec07e-0000-4000-8000-%') into n;
    lo := lo + n;
  end loop;
  insert into pg_temp.sec07_c values (4, 'LEFTOVER TEST ROWS: ' || lo || ' (expect 0)');
end $$;
select line as concurrency_result from pg_temp.sec07_c order by ord;
-- <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< CONCURRENCY TAB 2 — copy to here
============================================================================= */
