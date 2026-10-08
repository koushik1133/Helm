-- auth-limits.sql — 0050 server-side two-step lockout + durable rate_hit.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _al; create temp table _al(name text, result text); grant all on _al to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.as_user(p_email text, p_aal text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
declare c text := current_setting('request.jwt.claims', true); r text := current_user;
begin perform pg_temp.su(); insert into _al values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end);
  if coalesce(c, '') <> '' then perform set_config('request.jwt.claims', c, false); end if;
  if r in ('anon', 'authenticated', 'service_role') then execute format('set role %I', r); end if; end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

do $$ begin perform pg_temp.su();
  delete from public.auth_mfa_attempts; delete from public.auth_rate_hits;
end $$;

-- ---- MFA lockout ---------------------------------------------------------------------
do $$ declare j jsonb; i int; ok boolean; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal1'); execute 'set role authenticated';
  j := public.mfa_lock_status();
  perform pg_temp.res('01 fresh account is not locked', j->>'locked' = 'false' and (j->>'fails')::int = 0, j::text);
  for i in 1..4 loop j := public.mfa_record_failure(); end loop;
  perform pg_temp.res('02 four wrong codes: counted, not locked', j->>'locked' = 'false' and (j->>'fails')::int = 4, j::text);
  j := public.mfa_record_failure();
  perform pg_temp.res('03 fifth wrong code locks for ~15 minutes', j->>'locked' = 'true' and (j->>'retry_after')::int between 890 and 900, j::text);
  j := public.mfa_lock_status();
  perform pg_temp.res('04 status (another tab/device) sees the lock', j->>'locked' = 'true', j::text);
  j := public.mfa_record_failure();
  perform pg_temp.res('05 while locked nothing more is counted', j->>'locked' = 'true' and (j->>'fails')::int = 5, j::text);
  perform pg_temp.res('06 aal1 cannot clear its own lock', public.mfa_record_success() = false and (public.mfa_lock_status()->>'locked') = 'true');
  perform pg_temp.res('07 the lock is audited', (select count(*) from public.audit_log where action = 'auth.mfa.locked') >= 1);
  -- another user is unaffected
  perform pg_temp.as_user('b_admin@b.test', 'aal1'); execute 'set role authenticated';
  perform pg_temp.res('08 lock is per user', public.mfa_lock_status()->>'locked' = 'false');
  -- lock expiry
  perform pg_temp.su(); update public.auth_mfa_attempts set locked_until = now() - interval '1 second';
  perform pg_temp.as_user('a_admin@a.test', 'aal1'); execute 'set role authenticated';
  j := public.mfa_lock_status();
  perform pg_temp.res('09 expired lock reads as unlocked, fresh count', j->>'locked' = 'false' and (j->>'fails')::int = 0, j::text);
  j := public.mfa_record_failure();
  perform pg_temp.res('10 after expiry counting restarts at 1', j->>'locked' = 'false' and (j->>'fails')::int = 1, j::text);
  perform pg_temp.as_user('a_admin@a.test', 'aal2'); execute 'set role authenticated';
  ok := public.mfa_record_success();
  perform pg_temp.res('11 aal2 session clears the counter', ok and (public.mfa_lock_status()->>'fails')::int = 0);
  perform pg_temp.res('12 aal unchanged (still whatever the JWT says)', auth.jwt()->>'aal' = 'aal2');
  -- direct table access refused
  perform pg_temp.res('13 table not readable/writable by clients',
    pg_temp.try('select * from public.auth_mfa_attempts') = '42501' and pg_temp.try('delete from public.auth_mfa_attempts') = '42501');
  perform pg_temp.res('14 rate_hit not callable by a signed-in user', pg_temp.try('select public.rate_hit(''x'', ''k'', 60, 5)') = '42501');
  perform pg_temp.su(); perform auth.login_anon(); execute 'set role anon';
  perform pg_temp.res('15 anon refused', pg_temp.try('select public.mfa_record_failure()') = '42501'
    and pg_temp.try('select public.mfa_lock_status()') = '42501' and pg_temp.try('select public.rate_hit(''x'', ''k'', 60, 5)') = '42501');
end $$;

-- recorder is itself rate-limited
do $$ declare j jsonb; i int; ok boolean; begin
  perform pg_temp.su(); delete from public.auth_rate_hits; delete from public.auth_mfa_attempts;
  perform pg_temp.as_user('b_admin@b.test', 'aal1'); execute 'set role authenticated';
  for i in 1..31 loop j := public.mfa_record_failure(); end loop;
  perform pg_temp.res('16 recorder rate-limited after 30 calls / 10 min', j->>'locked' = 'true' and (j->>'retry_after')::int > 0, j::text);
end $$;

-- ---- rate_hit (service role) --------------------------------------------------------
do $$ declare r int; i int; begin
  perform pg_temp.su(); delete from public.auth_rate_hits; execute 'set role service_role';
  for i in 1..3 loop r := public.rate_hit('edge.test', 'k1', 60, 3); end loop;
  perform pg_temp.res('17 within limit → 0', r = 0, r::text);
  r := public.rate_hit('edge.test', 'k1', 60, 3);
  perform pg_temp.res('18 over limit → retry-after seconds', r between 1 and 60, r::text);
  perform pg_temp.res('19 other key independent', public.rate_hit('edge.test', 'k2', 60, 3) = 0);
  perform pg_temp.res('20 bad input refused', pg_temp.try('select public.rate_hit(''BAD BUCKET'', ''k'', 60, 3)') = '22023'
    and pg_temp.try('select public.rate_hit(''b'', '''', 60, 3)') = '22023' and pg_temp.try('select public.rate_hit(''b'', ''k'', 0, 3)') = '22023');
  execute 'reset role'; update public.auth_rate_hits set window_start = now() - interval '61 seconds' where key = 'k1';
  execute 'set role service_role';
  perform pg_temp.res('21 window rolls over', public.rate_hit('edge.test', 'k1', 60, 3) = 0);
end $$;

do $$ begin perform pg_temp.su(); delete from public.auth_mfa_attempts; delete from public.auth_rate_hits; end $$;
select name, result from _al order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 21 then 'AUTH-LIMITS: ALL PASS (21/21)'
            else 'AUTH-LIMITS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/21 ran' end from _al;
