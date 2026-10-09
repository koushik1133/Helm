-- booklet-tax.sql -- 0081: public_get_booklet also returns the quote's tax label keys
-- (taxCountry / taxName / taxInclusive), allow-listed and sanitised; nothing private leaks;
-- quotes without them get exactly the 0075 payload. Fixture studio A. Rolled back. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _bt(name text, result text); grant all on _bt to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _bt values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.setp(p jsonb) returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set pricing = p, deleted_at = null where id = 'a0000000-0000-4000-8000-00000000da01';
  set local session_replication_role = origin; end $$;

do $$ declare qa text := 'a0000000-0000-4000-8000-00000000da01'; r jsonb; r0 jsonb; q jsonb;
begin
  perform pg_temp.su();
  update public.organizations set brand = '{"accent":"#aa3355","billing":{"gstin":"SECRET-BILLING-ID","address":"SECRET-BILLING-ADDR"}}'::jsonb
   where id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.setp('{"chairs":10,"chairPrice":100,"gstPct":5,"total":1000,"currency":"AED","taxCountry":"ae","taxName":"<b>VAT</b> (UAE)","taxInclusive":true,"internalCost":555,"computed":{"subtotal":1000,"totalGst":48,"total":1000}}'::jsonb);
  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa::uuid); perform pg_temp.put('tok', r ->> 'token');

  perform pg_temp.res('01 helper wrapped once (pre0081 exists)', to_regprocedure('public.public_get_booklet__pre0081(uuid)') is not null);
  perform pg_temp.res('02 anon: reader yes, inner no', has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.public_get_booklet__pre0081(uuid)', 'execute'));
  perform pg_temp.res('03 authenticated: inner function not callable', not has_function_privilege('authenticated', 'public.public_get_booklet__pre0081(uuid)', 'execute'));

  perform pg_temp.anon();
  r := public.public_get_booklet(pg_temp.get('tok')::uuid); q := r -> 'quote';
  perform pg_temp.res('04 taxCountry upper-cased', q ->> 'taxCountry' = 'AE', q::text);
  perform pg_temp.res('05 taxName sanitised (no < > characters)', q ->> 'taxName' = 'bVAT/b (UAE)', q ->> 'taxName');
  perform pg_temp.res('06 taxInclusive true', (q -> 'taxInclusive') = 'true'::jsonb, q::text);
  perform pg_temp.res('07 currency + computed still there', q ->> 'currency' = 'AED' and (q #>> '{computed,totalGst}') = '48', q::text);
  perform pg_temp.res('08 private fields never leave', position('SECRET-BILLING' in r::text) = 0 and position('internalCost' in r::text) = 0
    and not (r -> 'studio') ? 'billing', r::text);

  -- hostile / invalid values are dropped
  perform pg_temp.setp('{"chairs":10,"chairPrice":100,"gstPct":18,"total":1180,"taxCountry":"x1","taxName":"<<>>","taxInclusive":"yes"}'::jsonb);
  perform pg_temp.anon();
  q := public.public_get_booklet(pg_temp.get('tok')::uuid) -> 'quote';
  perform pg_temp.res('09 invalid country / empty name / non-true inclusive dropped',
    not (q ? 'taxCountry') and not (q ? 'taxName') and not (q ? 'taxInclusive'), q::text);
  perform pg_temp.setp('{"chairs":10,"chairPrice":100,"gstPct":18,"total":1180,"taxName":"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}'::jsonb);
  perform pg_temp.anon();
  q := public.public_get_booklet(pg_temp.get('tok')::uuid) -> 'quote';
  perform pg_temp.res('10 taxName capped at 24 chars', char_length(q ->> 'taxName') = 24, q ->> 'taxName');

  -- India / no tax keys: payload identical to the 0075 reader
  perform pg_temp.setp('{"chairs":10,"chairPrice":100,"gstPct":18,"total":1180,"computed":{"cgst":90,"sgst":90,"total":1180}}'::jsonb);
  perform pg_temp.su();
  r0 := public.public_get_booklet__pre0081(pg_temp.get('tok')::uuid);
  perform pg_temp.anon();
  r := public.public_get_booklet(pg_temp.get('tok')::uuid);
  perform pg_temp.res('11 no tax keys -> quote block unchanged', (r -> 'quote') = (r0 -> 'quote'), (r -> 'quote')::text);
  perform pg_temp.res('12 CGST/SGST split still returned', (r #>> '{quote,computed,cgst}') = '90' and (r #>> '{quote,computed,sgst}') = '90');

  -- other tenant's quote pricing never mixes in: token is bound to quote A
  perform pg_temp.su();
  perform pg_temp.res('13 token resolves to studio A quote only', (r #>> '{event,code}') = (select code from public.quotes where id = qa::uuid), r #>> '{event,code}');
  perform pg_temp.res('14 reader still definer + empty search_path', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'public_get_booklet' and p.prosecdef and p.proconfig @> array['search_path=""']));
end $$;

select name, result from _bt order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'BOOKLET-TAX: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'BOOKLET-TAX: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _bt;
rollback;
