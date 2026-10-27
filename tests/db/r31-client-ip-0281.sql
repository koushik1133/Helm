-- r31-client-ip-0281.sql -- 0281: the caller's address comes from Cloudflare's cf-connecting-ip first, so a made-up
-- x-forwarded-for entry no longer buys a fresh per-network limit (Contact sales, Suggestions, public enquiry form) and is
-- no longer written into the quote-acceptance record / package choice. Fallback order unchanged when the header is missing.
-- Rolled back. Local disposable PG only. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _tp(name text, result text); grant all on _tp to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.hdr(p jsonb) returns void language plpgsql as $$
begin perform set_config('request.headers', p::text, false); end $$;
create or replace function pg_temp.anon(p_cf text, p_xff text) returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  perform set_config('request.headers', jsonb_strip_nulls(jsonb_build_object('cf-connecting-ip', p_cf, 'x-forwarded-for', p_xff,
    'user-agent', 'TestUA/1'))::text, false);
  perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.form(p_email text) returns jsonb language sql as $$
  select jsonb_build_object('name', 'Priya Sharma', 'email', p_email, 'company', 'Sharma Events', 'plan', 'studio',
    'message', 'We run 40 weddings a year.', 'consent', true, 'source', 'contact_page') $$;
grant execute on function pg_temp.form(text) to anon, authenticated, service_role;

-- earlier suites may leave older 0271 / 0276 bodies or grants behind: put the current ones back first (rolled back)
\ir ../../supabase/migrations/0271_contact_sales.sql
\ir ../../supabase/migrations/0276_public_captcha.sql
-- re-run safe: twice more on top of the clean install
\ir ../../supabase/migrations/0281_client_ip_trust.sql
\ir ../../supabase/migrations/0281_client_ip_trust.sql

-- 0x shape + privileges
do $$ begin
  perform pg_temp.res('01 helper exists, internal only (no anon / signed-in execute)',
    to_regprocedure('public._r31_client_ip()') is not null
    and not has_function_privilege('anon', 'public._r31_client_ip()', 'execute')
    and not has_function_privilege('authenticated', 'public._r31_client_ip()', 'execute'));
  perform pg_temp.res('02 the four re-issued functions carry the 0281 marker',
    (select count(*) from pg_proc p where p.oid in ('public._r24_ip_hash()'::regprocedure, 'public._r24s_ip_hash()'::regprocedure,
       'public._pkg_req_meta()'::regprocedure, 'public.tg_consent_snapshot()'::regprocedure)
       and position('r31-client-ip-0281' in p.prosrc) > 0) = 4);
  perform pg_temp.res('03 privileges unchanged: still no anon / signed-in execute on any of them',
    not has_function_privilege('anon', 'public._r24_ip_hash()', 'execute')
    and not has_function_privilege('anon', 'public._r24s_ip_hash()', 'execute')
    and not has_function_privilege('anon', 'public._pkg_req_meta()', 'execute')
    and not has_function_privilege('authenticated', 'public.tg_consent_snapshot()', 'execute'));
  perform pg_temp.res('04 consent trigger still attached to quote_consents',
    exists (select 1 from pg_trigger t where t.tgname = 'ab_consent_snapshot' and t.tgrelid = 'public.quote_consents'::regclass
              and t.tgfoid = 'public.tg_consent_snapshot()'::regprocedure));
  perform pg_temp.res('05 still one of each function (re-issued in place, nothing renamed)',
    (select count(*) from pg_proc where proname in ('_r24_ip_hash', '_r24s_ip_hash', '_pkg_req_meta', 'tg_consent_snapshot', '_r31_client_ip')) = 5);
exception when others then insert into _tp values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- 1x the address itself
do $$ begin
  perform pg_temp.hdr('{"cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.1.1.1, 203.0.113.7"}');
  perform pg_temp.res('10 Cloudflare header wins over a typed x-forwarded-for entry', public._r31_client_ip() = '203.0.113.7', public._r31_client_ip());
  perform pg_temp.hdr('{"x-forwarded-for": "198.51.100.4, 10.0.0.1", "x-real-ip": "10.9.9.9"}');
  perform pg_temp.res('11 no Cloudflare header (local / tests): first x-forwarded-for entry, as before', public._r31_client_ip() = '198.51.100.4');
  perform pg_temp.hdr('{"x-real-ip": "192.0.2.9"}');
  perform pg_temp.res('12 ... then x-real-ip', public._r31_client_ip() = '192.0.2.9');
  perform pg_temp.hdr('{"user-agent": "x"}');
  perform pg_temp.res('13 no address at all -> null', public._r31_client_ip() is null);
  perform set_config('request.headers', '', false);
  perform pg_temp.res('14 no request (a job / the SQL editor) -> null', public._r31_client_ip() is null);
  perform set_config('request.headers', 'not json', false);
  perform pg_temp.res('15 unreadable headers -> null, no error', public._r31_client_ip() is null);
  perform pg_temp.hdr('{"cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6"}');
  perform pg_temp.res('16 enquiry + sales hashes follow the Cloudflare address',
    public._r24_ip_hash() = encode(sha256(convert_to('helm-enq:203.0.113.7', 'UTF8')), 'hex')
    and public._r24s_ip_hash() = encode(sha256(convert_to('helm-sales:203.0.113.7', 'UTF8')), 'hex'));
  perform pg_temp.res('17 package choice hash follows the Cloudflare address',
    public._pkg_req_meta() ->> 'ip_hash' = md5('helm-pkg:203.0.113.7') and public._pkg_req_meta() ->> 'ua' is null);
  perform pg_temp.hdr('{"x-forwarded-for": "203.0.113.7"}');
  perform pg_temp.res('18 an ordinary visitor keeps the SAME hash as before 0281 (no reset of anyone''s history)',
    public._r24s_ip_hash() = encode(sha256(convert_to('helm-sales:203.0.113.7', 'UTF8')), 'hex'));
  perform set_config('request.headers', '', false);
exception when others then perform set_config('request.headers', '', false); insert into _tp values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- 2x the attack: a bot sends a new made-up x-forwarded-for entry with every Contact sales message
do $$ declare r jsonb; n int := 0; i int; begin
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sales.%';
  for i in 1..9 loop
    perform pg_temp.anon('192.0.2.50', '10.20.30.' || i || ', 192.0.2.50');
    r := public.submit_sales_enquiry(pg_temp.form('r31bot' || i || '@x.in'));
    if r ->> 'ok' = 'true' then n := n + 1; end if;
  end loop;
  perform pg_temp.res('20 Contact sales: 8 an hour per network even with a new fake x-forwarded-for each time',
    n = 8 and r ->> 'reason' = 'rate', n || ' ' || r::text);
  perform pg_temp.anon('192.0.2.51', '10.20.30.1');
  r := public.submit_sales_enquiry(pg_temp.form('r31other@x.in'));
  perform pg_temp.res('21 a different real network is not blocked', r ->> 'ok' = 'true', r::text);
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sales.%';
exception when others then perform pg_temp.su(); insert into _tp values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _tp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R31-CLIENT-IP-0281: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R31-CLIENT-IP-0281: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _tp;
rollback;
