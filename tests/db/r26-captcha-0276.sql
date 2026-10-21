-- r26-captcha-0276.sql -- 0276: the Cloudflare security check on the SIGNED-OUT public forms (Contact sales, a studio's
-- enquiry form, Suggestions): one-use passes recorded by captcha-verify (service role), used up by the form wrappers only
-- while HQ's rpc_captcha_required switch is on; signed-in people and Helm's own jobs never asked; switch off = as today.
-- Rolled back. Local disposable PG only. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _tp(name text, result text); grant all on _tp to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon(p_ip text) returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  perform set_config('request.headers', jsonb_build_object('x-forwarded-for', p_ip, 'user-agent', 'TestUA/1')::text, false);
  perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.form(p_email text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('name', 'Priya Sharma', 'email', p_email, 'company', 'Sharma Events', 'plan', 'studio',
    'message', 'We run 40 weddings a year.', 'consent', true, 'source', 'contact_page') || p_extra $$;
grant execute on function pg_temp.form(text, jsonb) to anon, authenticated, service_role;
create or replace function pg_temp.pass(p_action text) returns text language plpgsql as $$
declare v uuid; begin perform pg_temp.svc(); v := public.captcha_public_pass_record(p_action); perform pg_temp.su(); return v::text; end $$;
create or replace function pg_temp.switch(p_on boolean) returns void language plpgsql as $$
begin perform pg_temp.su(); update public.helm_hq_settings set rpc_captcha_required = p_on where id; end $$;

-- re-run safe: twice more on top of the clean install
\ir ../../supabase/migrations/0276_public_captcha.sql
\ir ../../supabase/migrations/0276_public_captcha.sql

-- 0x shape + privileges
do $$ begin
  perform pg_temp.res('01 new table: RLS on, no anon / signed-in privilege, service role may insert',
    (select relrowsecurity from pg_class where oid = 'public.captcha_public_passes'::regclass)
    and not has_table_privilege('anon', 'public.captcha_public_passes', 'select')
    and not has_table_privilege('authenticated', 'public.captcha_public_passes', 'insert')
    and has_table_privilege('service_role', 'public.captcha_public_passes', 'insert'));
  perform pg_temp.res('02 only the service role records a pass; nobody calls the check helper directly',
    has_function_privilege('service_role', 'public.captcha_public_pass_record(text)', 'execute')
    and not has_function_privilege('anon', 'public.captcha_public_pass_record(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.captcha_public_pass_record(text)', 'execute')
    and not has_function_privilege('anon', 'public._captcha_public_ok(text, jsonb)', 'execute'));
  perform pg_temp.res('03 the 3 forms are wrappers (marker once) over the renamed bodies; still open to anon + signed in',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
       and p.proname in ('submit_sales_enquiry', 'submit_suggestion', 'public_enquiry_submit') and p.prosrc like '%r26-captcha-0276%') = 3
    and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
       and p.proname in ('submit_sales_enquiry', 'submit_suggestion', 'public_enquiry_submit')) = 3
    and to_regprocedure('public.submit_sales_enquiry__pre0276(jsonb)') is not null
    and to_regprocedure('public.submit_suggestion__pre0276(jsonb)') is not null
    and to_regprocedure('public.public_enquiry_submit__pre0276(text,jsonb)') is not null
    and position('r24-contact-0271' in (select prosrc from pg_proc where oid = 'public.submit_sales_enquiry__pre0276(jsonb)'::regprocedure)) > 0
    and has_function_privilege('anon', 'public.submit_sales_enquiry(jsonb)', 'execute')
    and has_function_privilege('anon', 'public.public_enquiry_submit(text, jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.submit_suggestion(jsonb)', 'execute'));
  perform pg_temp.res('04 the inner bodies are not reachable from the API',
    not has_function_privilege('anon', 'public.submit_sales_enquiry__pre0276(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.public_enquiry_submit__pre0276(text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.submit_suggestion__pre0276(jsonb)', 'execute'));
  perform pg_temp.res('05 the switch is off by default', not coalesce((select rpc_captcha_required from public.helm_hq_settings where id), false));
exception when others then perform pg_temp.su(); insert into _tp values ('0x shape', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- 1x switch OFF: every form works exactly as before (no captcha field needed)
do $$ declare r jsonb; begin
  perform pg_temp.switch(false);
  perform pg_temp.anon('198.51.100.11');
  r := public.submit_sales_enquiry(pg_temp.form('off1@x.in'));
  perform pg_temp.res('10 switch off: Contact sales without a pass is saved', r ->> 'ok' = 'true', r::text);
  r := public.submit_suggestion('{"message":"Please add a dark mode","category":"idea"}'::jsonb);
  perform pg_temp.res('11 switch off: a visitor suggestion without a pass is saved', r ->> 'ok' = 'true', r::text);
  r := public.submit_sales_enquiry(pg_temp.form('off2@x.in', '{"captcha":"not-a-pass"}'));
  perform pg_temp.res('12 switch off: an old-style token in "captcha" is still accepted', r ->> 'ok' = 'true', r::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _tp values ('1x off', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- 2x switch ON: a signed-out visitor needs a fresh, unused pass for THAT form
do $$ declare r jsonb; p text; p2 text; n0 int; e text; begin
  perform pg_temp.switch(true);
  select count(*) into n0 from public.sales_enquiries;
  perform pg_temp.anon('198.51.100.21');
  r := public.submit_sales_enquiry(pg_temp.form('on1@x.in'));
  perform pg_temp.res('20 switch on: no pass -> a plain "security check" answer', r ->> 'ok' = 'false' and r ->> 'reason' = 'captcha'
    and r ->> 'message' = 'Please complete the security check and send again.', r::text);
  r := public.submit_sales_enquiry(pg_temp.form('on1@x.in', '{"captcha":"tok-from-the-widget"}'));
  perform pg_temp.res('21 a raw Turnstile token (not a pass) is refused', r ->> 'reason' = 'captcha', r::text);
  r := public.submit_sales_enquiry(pg_temp.form('on1@x.in', jsonb_build_object('captcha', gen_random_uuid()::text)));
  perform pg_temp.res('22 a made-up pass id is refused', r ->> 'reason' = 'captcha', r::text);
  perform pg_temp.su();
  perform pg_temp.res('23 nothing was saved for the refused forms', (select count(*) from public.sales_enquiries) = n0);

  p := pg_temp.pass('contact');
  perform pg_temp.anon('198.51.100.22');
  r := public.submit_sales_enquiry(pg_temp.form('on2@x.in', jsonb_build_object('captcha', p)));
  perform pg_temp.res('24 a real pass -> the enquiry is saved', r ->> 'ok' = 'true', r::text);
  r := public.submit_sales_enquiry(pg_temp.form('on3@x.in', jsonb_build_object('captcha', p)));
  perform pg_temp.res('25 the same pass twice -> refused (one form, one pass)', r ->> 'reason' = 'captcha', r::text);
  perform pg_temp.su();
  perform pg_temp.res('26 the pass is marked used; exactly one enquiry kept',
    (select used_at is not null from public.captcha_public_passes where id = p::uuid)
    and (select count(*) from public.sales_enquiries) = n0 + 1);

  p2 := pg_temp.pass('suggest');
  perform pg_temp.anon('198.51.100.23');
  r := public.submit_sales_enquiry(pg_temp.form('on4@x.in', jsonb_build_object('captcha', p2)));
  perform pg_temp.res('27 a pass for another form (suggest) does not open Contact sales', r ->> 'reason' = 'captcha', r::text);
  r := public.submit_suggestion(jsonb_build_object('message', 'Add a Gantt view please', 'captcha', p2));
  perform pg_temp.res('28 ... but does open the Suggestions form', r ->> 'ok' = 'true', r::text);

  p := pg_temp.pass('contact');
  update public.captcha_public_passes set created_at = now() - interval '11 minutes' where id = p::uuid;
  perform pg_temp.anon('198.51.100.24');
  r := public.submit_sales_enquiry(pg_temp.form('on5@x.in', jsonb_build_object('captcha', p)));
  perform pg_temp.res('29 a pass older than 10 minutes is refused', r ->> 'reason' = 'captcha', r::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _tp values ('2x on', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- 3x the enquiry form, signed-in people, Helm's own calls, bad input
do $$ declare r jsonb; p text; e text; begin
  perform pg_temp.switch(true);
  perform pg_temp.anon('198.51.100.31');
  r := public.public_enquiry_submit('no-such-studio-xyz', '{"name":"Anil","phone":"9876543210","consent":true}'::jsonb);
  perform pg_temp.res('30 enquiry form: no pass -> the security check answer (before anything else)', r ->> 'reason' = 'captcha', r::text);
  perform pg_temp.su(); p := pg_temp.pass('enquiry');
  perform pg_temp.anon('198.51.100.32');
  r := public.public_enquiry_submit('no-such-studio-xyz', jsonb_build_object('name', 'Anil', 'phone', '9876543210', 'consent', true, 'captcha', p));
  perform pg_temp.res('31 enquiry form: with a pass the 0269 body answers (unknown studio -> closed)', r ->> 'reason' = 'closed', r::text);
  perform pg_temp.su();
  perform pg_temp.res('32 ... and that pass is used up', (select used_at is not null from public.captcha_public_passes where id = p::uuid));

  perform pg_temp.login('a_admin@a.test');
  r := public.submit_suggestion('{"message":"Signed-in idea, no check needed"}'::jsonb);
  perform pg_temp.res('33 signed in: the app suggestion needs no pass even with the switch on', r ->> 'ok' = 'true', r::text);
  perform pg_temp.su();
  r := public.submit_suggestion('{"message":"From the SQL editor"}'::jsonb);
  perform pg_temp.res('34 no API caller (SQL editor / jobs): not asked', r ->> 'ok' = 'true', r::text);

  perform pg_temp.svc();
  e := pg_temp.try('select public.captcha_public_pass_record(''sales'')');
  perform pg_temp.res('35 a pass for an unknown form is refused (22023)', e like '22023%', e);
  perform pg_temp.anon('198.51.100.33');
  e := pg_temp.try('select public.captcha_public_pass_record(''contact'')');
  perform pg_temp.res('36 a visitor cannot mint a pass (42501)', e like '42501%', e);
  e := pg_temp.try('select count(*) from public.captcha_public_passes');
  perform pg_temp.res('37 a visitor cannot read the passes (42501)', e like '42501%', e);
  r := public.submit_sales_enquiry(pg_temp.form('on6@x.in', '{"captcha": 12345}'));
  perform pg_temp.res('38 a non-text captcha value is refused safely', r ->> 'ok' = 'false', r::text);
  perform pg_temp.su();
  perform pg_temp.switch(false);
exception when others then perform pg_temp.su(); insert into _tp values ('3x more', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- 4x a later re-run of 0271 puts the plain body back: 0276 again wraps the NEWEST body (no stale copy left)
\ir ../../supabase/migrations/0271_contact_sales.sql
do $$ begin
  perform pg_temp.res('40 after re-running 0271 the plain body is back under the public name',
    position('r26-captcha-0276' in (select prosrc from pg_proc where oid = 'public.submit_sales_enquiry(jsonb)'::regprocedure)) = 0);
exception when others then insert into _tp values ('40', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
\ir ../../supabase/migrations/0276_public_captcha.sql
do $$ declare r jsonb; begin
  perform pg_temp.res('41 0276 again: wrapper on top, the inner is the re-run 0271 body, one of each',
    position('r26-captcha-0276' in (select prosrc from pg_proc where oid = 'public.submit_sales_enquiry(jsonb)'::regprocedure)) > 0
    and position('r24-contact-0271' in (select prosrc from pg_proc where oid = 'public.submit_sales_enquiry__pre0276(jsonb)'::regprocedure)) > 0
    and (select count(*) from pg_proc where proname like 'submit_sales_enquiry%') = 2
    and not has_function_privilege('anon', 'public.submit_sales_enquiry__pre0276(jsonb)', 'execute'));
  perform pg_temp.switch(true);
  perform pg_temp.anon('198.51.100.41');
  r := public.submit_sales_enquiry(pg_temp.form('re1@x.in'));
  perform pg_temp.res('42 ... and still asks for the pass', r ->> 'reason' = 'captcha', r::text);
  perform pg_temp.su(); perform pg_temp.switch(false);
exception when others then perform pg_temp.su(); insert into _tp values ('4x rerun', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _tp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R26-CAPTCHA-0276: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R26-CAPTCHA-0276: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _tp;
rollback;
