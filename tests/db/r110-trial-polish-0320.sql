-- r110-trial-polish-0320.sql - 0320: (1) leads Helm makes from a trial quote's client do not use the 2 trial lead
-- slots (the owner can still add 2 own leads; the 3rd is refused); (2) Helm's billing currency follows the billing
-- country while a studio has never paid (India -> INR), never for a paying studio; trial_welcome_save fills the
-- account country; the one-time USD -> INR fix; (3) chat_directory shows the sign-up name when the profile has none.
-- Re-applies itself twice. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = error;
-- earlier suites re-apply 0210 / 0236 / 0273 / 0300 over the 0320 bodies: put the 0236 + 0210 + 0300 ones back first
\ir ../../supabase/migrations/0236_trial_definition_unify.sql
\ir ../../supabase/migrations/0238_trial_quotes_cap_two.sql
\ir ../../supabase/migrations/0320_r110_trial_polish.sql
\ir ../../supabase/migrations/0320_r110_trial_polish.sql
set client_min_messages = warning;
begin;
create temp table _t320(name text, result text); grant all on _t320 to anon, authenticated, service_role;
create temp table _t320kv(k text primary key, v text); grant all on _t320kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t320 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || coalesce(h, '') || ' | ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text, p_tz text default 'Asia/Kolkata') returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, p_tz, 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- a quote with a client, made the app's way (create_quote, then the client saved on it -> sync_quote_to_lead)
create or replace function pg_temp.quote_with_client(p_email text, p_client text) returns text language plpgsql as $$
declare q public.quotes; e text; begin
  perform pg_temp.login(p_email);
  begin
    q := public.create_quote(null, 'R320 ' || p_client, 'Wedding', '{"items":[]}'::jsonb, 0);
    update public.quotes set client = jsonb_build_object('name', p_client, 'email', lower(replace(p_client, ' ', '.')) || '@client.test')
     where id = q.id;
    e := '';
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.su(); return e;
end $$;
create or replace function pg_temp.used(p_email text, p_k text) returns int language plpgsql as $$
declare j jsonb; begin perform pg_temp.login(p_email); j := public.my_trial_limits(); perform pg_temp.su(); return (j -> 'used' ->> p_k)::int; end $$;

-- ---- 0) shape -----------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('00 cap bodies carry the 0320 marker and keep the 0236 one',
    (select bool_and(position('r110-trial-polish-0320' in p.prosrc) > 0 and position('0236' in p.prosrc) > 0) from pg_proc p
      where p.oid in ('public._tl181_used(uuid,text)'::regprocedure, 'public._tl181_tg_cap_check()'::regprocedure,
                      'public._tl181_tg_cap_log()'::regprocedure, 'public._tl173_tg_create_cap()'::regprocedure)), '');
  perform pg_temp.res('01 helpers + kept welcome body not callable by the app; live welcome / chat_directory are',
    not has_function_privilege('authenticated', 'public._r320_quote_lead(uuid,uuid,text,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r320_never_paid(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r320_signup_name(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r320_welcome_save(text,text,text,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_welcome_save__pre0320(text,text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.trial_welcome_save(text,text,text,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.trial_welcome_save(text,text,text,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.chat_directory()', 'execute')
    and not has_function_privilege('anon', 'public.chat_directory()', 'execute'), '');
  perform pg_temp.res('02 the currency trigger is on studio_account once',
    (select count(*) from pg_trigger where tgrelid = 'public.studio_account'::regclass and tgname = 'zzzz_r320_currency_country') = 1, '');
exception when others then perform pg_temp.su(); insert into _t320 values ('0x shape', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) trial leads ------------------------------------------------------------------------------------------------
do $$ declare o uuid; e text; n int; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  o := pg_temp.trial('r320_lead@t.test'); insert into _t320kv values ('o', o::text);
  e := pg_temp.quote_with_client('r320_lead@t.test', 'Asha Rao') || pg_temp.quote_with_client('r320_lead@t.test', 'Vikram Shah');
  select count(*) into n from public.leads where org_id = o and not is_demo and source = 'quote' and quote_id is not null;
  perform pg_temp.res('10 two trial quotes with clients made two leads (source quote)', e = '' and n = 2, e || ' n=' || n);
  perform pg_temp.res('11 my_trial_limits: those leads use no lead slot (used.leads = 0), quotes = 2',
    pg_temp.used('r320_lead@t.test', 'leads') = 0 and pg_temp.used('r320_lead@t.test', 'quotes') = 2,
    pg_temp.used('r320_lead@t.test', 'leads') || '/' || pg_temp.used('r320_lead@t.test', 'quotes'));
  perform pg_temp.res('12 they are not in trial_create_log',
    not exists (select 1 from public.trial_create_log l join public.leads x on x.id::text = l.row_id
                 where l.org_id = o and l.entity = 'leads' and x.source = 'quote'), '');
  perform pg_temp.login('r320_lead@t.test');
  e := pg_temp.try('insert into public.leads(name, source) values (''R320 own 1'', ''manual'')')
    || pg_temp.try('insert into public.leads(name, source) values (''R320 own 2'', ''manual'')');
  perform pg_temp.su();
  perform pg_temp.res('13 the owner still adds 2 own leads', e = '' and pg_temp.used('r320_lead@t.test', 'leads') = 2, e);
  perform pg_temp.login('r320_lead@t.test');
  e := pg_temp.try('insert into public.leads(name, source) values (''R320 own 3'', ''manual'')');
  perform pg_temp.su();
  perform pg_temp.res('14 the 3rd own lead is refused (trial_cap)', e like '42501 trial_cap%', e);
  -- a lead that only CLAIMS to come from a quote: same quote already has its lead -> counts like any lead (refused)
  perform pg_temp.login('r320_lead@t.test');
  e := pg_temp.try(format('insert into public.leads(name, source, quote_id) values (''R320 fake'', ''quote'', %L)',
                          (select quote_id from public.leads where org_id = o and source = 'quote' and quote_id is not null limit 1)));
  perform pg_temp.su();
  perform pg_temp.res('15 a 2nd "quote" lead on the same quote is a normal lead (refused at the cap)', e like '42501 trial_cap%', e);
  perform pg_temp.login('r320_lead@t.test');
  e := pg_temp.try(format('insert into public.leads(name, source, quote_id) values (''R320 sample'', ''quote'', %L)',
                          (select id from public.quotes where org_id = o and is_demo limit 1)));
  perform pg_temp.su();
  perform pg_temp.res('16 a "quote" lead on a SAMPLE quote is a normal lead (refused at the cap)', e like '42501 trial_cap%', e);
exception when others then perform pg_temp.su(); insert into _t320 values ('1x leads', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare o uuid; e text; begin
  -- a lead typed in first, then a quote for the same client links it: it keeps counting (source not quote)
  o := pg_temp.trial('r320_lead2@t.test');
  perform pg_temp.login('r320_lead2@t.test');
  e := pg_temp.try('insert into public.leads(name, email, source) values (''Meera Iyer'', ''meera.iyer@client.test'', ''manual'')');
  perform pg_temp.su();
  e := e || pg_temp.quote_with_client('r320_lead2@t.test', 'Meera Iyer');
  perform pg_temp.res('17 own lead later linked to a quote still counts (1), no extra lead made',
    e = '' and pg_temp.used('r320_lead2@t.test', 'leads') = 1
    and (select count(*) from public.leads where org_id = o and not is_demo) = 1
    and (select quote_id from public.leads where org_id = o and not is_demo) is not null, e);
exception when others then perform pg_temp.su(); insert into _t320 values ('1y leads', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare o uuid; e text; i int; begin
  -- paid studios: no cap at all (unchanged)
  o := pg_temp.trial('r320_paid@t.test');
  update public.studio_subscriptions set status = 'active', current_period_end = now() + interval '30 days' where org_id = o;
  update public.organizations set trial_ends_at = null where id = o;
  perform pg_temp.login('r320_paid@t.test'); e := '';
  for i in 1..3 loop e := e || pg_temp.try(format('insert into public.leads(name) values (%L)', 'R320 paid ' || i)); end loop;
  perform pg_temp.su();
  perform pg_temp.res('18 a paying studio adds leads freely (unchanged)', e = '', e);
exception when others then perform pg_temp.su(); insert into _t320 values ('1z paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) billing currency -------------------------------------------------------------------------------------------
do $$ declare o uuid; e text; r jsonb; cur text; begin
  -- a trial owner on a US browser: USD at sign-up (0273), then the welcome says India
  o := pg_temp.trial('r320_cur@t.test', 'America/Chicago');
  insert into _t320kv values ('c', o::text);
  perform pg_temp.login('r320_cur@t.test');
  r := public.my_billing_currency_init('America/Chicago');
  perform pg_temp.su();
  select billing_currency into cur from public.studio_account where org_id = o;
  perform pg_temp.res('20 setup: US browser time zone -> USD (0273 rule)', cur = 'USD', coalesce(cur, 'null'));
  perform pg_temp.login('r320_cur@t.test');
  e := pg_temp.try($q$select public.trial_welcome_save('T r320_cur@t.test', 'Hyderabad', 'Telangana', null, 'IN')$q$);
  perform pg_temp.su();
  perform pg_temp.res('21 trial_welcome_save fills the account country IN and the currency becomes INR',
    e = '' and (select country from public.studio_account where org_id = o) = 'IN'
    and (select billing_currency from public.studio_account where org_id = o) = 'INR', e || ' ' ||
    coalesce((select country || '/' || billing_currency from public.studio_account where org_id = o), 'none'));
  perform pg_temp.res('22 the welcome itself still saved (brand.billing city / state)',
    (select brand -> 'billing' ->> 'state' from public.organizations where id = o) = 'Telangana', '');
  r := public._checkout_quote(o, 'studio', 'monthly');   -- the server's checkout price (my_checkout_options / preview use it)
  perform pg_temp.res('23 checkout quotes the India studio in INR (GST on rupees)', r ->> 'currency' = 'INR', r::text);
exception when others then perform pg_temp.su(); insert into _t320 values ('2x currency', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare o uuid; e text; begin
  -- country set / changed directly (Studio setup / Settings) while never paid
  o := (select v::uuid from _t320kv where k = 'c');
  perform pg_temp.su();
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'r320_cur@t.test'), 'role', 'authenticated')::text, true);
  e := pg_temp.try(format('update public.studio_account set country = ''US'' where org_id = %L', o));
  perform pg_temp.su();
  perform pg_temp.res('24 never paid: country US -> USD', e = '' and (select billing_currency from public.studio_account where org_id = o) = 'USD', e);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'r320_cur@t.test'), 'role', 'authenticated')::text, true);
  e := pg_temp.try(format('update public.studio_account set city = ''Austin'' where org_id = %L', o));
  perform pg_temp.su();
  perform pg_temp.res('25 another field changed: currency left alone', e = '' and (select billing_currency from public.studio_account where org_id = o) = 'USD', e);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'r320_cur@t.test'), 'role', 'authenticated')::text, true);
  e := pg_temp.try(format('update public.studio_account set billing_currency = ''INR'' where org_id = %L', o));
  perform pg_temp.su();
  perform pg_temp.res('26 the studio still cannot set the currency itself (0273 lock)', e like '42501 billing_currency_fixed%', e);
  -- paying: never changed
  update public.studio_account set country = 'IN' where org_id = o;
  update public.studio_subscriptions set status = 'active', current_period_end = now() + interval '30 days' where org_id = o;
  update public.studio_account set billing_currency = 'USD' where org_id = o;
  update public.studio_account set country = 'US' where org_id = o;
  update public.studio_account set country = 'IN' where org_id = o;
  perform pg_temp.res('27 a paying studio keeps its currency when the country changes',
    (select billing_currency from public.studio_account where org_id = o) = 'USD', '');
exception when others then perform pg_temp.su(); insert into _t320 values ('2y currency', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid; b uuid; c uuid; begin
  -- the one-time fix: never-paid India studio on USD -> INR (audited); paying / non-India studios untouched
  a := pg_temp.trial('r320_fix_a@t.test'); b := pg_temp.trial('r320_fix_b@t.test'); c := pg_temp.trial('r320_fix_c@t.test');
  perform pg_temp.su();
  alter table public.studio_account disable trigger zzzz_r320_currency_country;
  insert into public.studio_account(org_id, billing_currency) values (a, 'USD'), (b, 'USD'), (c, 'USD')
    on conflict (org_id) do update set billing_currency = 'USD', country = null;
  alter table public.studio_account enable trigger zzzz_r320_currency_country;
  update public.organizations set brand = jsonb_build_object('billing', jsonb_build_object('country', 'IN')) where id in (a, b);
  update public.studio_subscriptions set status = 'active', current_period_end = now() + interval '30 days' where org_id = b;
  insert into _t320kv values ('fa', a::text), ('fb', b::text), ('fc', c::text);
end $$;
\ir ../../supabase/migrations/0320_r110_trial_polish.sql
do $$ declare a uuid := (select v::uuid from _t320kv where k = 'fa'); b uuid := (select v::uuid from _t320kv where k = 'fb');
  c uuid := (select v::uuid from _t320kv where k = 'fc'); begin
  perform pg_temp.res('28 one-time fix: never-paid India studio on USD -> INR, with an audit row',
    (select billing_currency from public.studio_account where org_id = a) = 'INR'
    and exists (select 1 from public.audit_log where org_id = a and action = 'studio_account.billing_currency' and changed ->> 'from' = 'USD'), '');
  perform pg_temp.res('29 one-time fix: a paying India studio and a studio with no India country are untouched',
    (select billing_currency from public.studio_account where org_id = b) = 'USD'
    and (select billing_currency from public.studio_account where org_id = c) = 'USD', '');
exception when others then perform pg_temp.su(); insert into _t320 values ('2z fix', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) chat directory ---------------------------------------------------------------------------------------------
do $$ declare o uuid; u uuid; u2 uuid; nm text; nm2 text; begin
  o := pg_temp.trial('r320_chat@t.test');
  u := (select id from auth.users where email = 'r320_chat@t.test');
  update auth.users set raw_user_meta_data = jsonb_build_object('full_name', 'Kiran <b>Kumar</b>') where id = u;
  update public.profiles set full_name = null where id = u;
  u2 := pg_temp.newuser('r320_chat_two@t.test');
  update public.profiles set org_id = o, role = 'coordinator', full_name = 'Profile Name' where id = u2;
  update auth.users set raw_user_meta_data = jsonb_build_object('full_name', 'Meta Name') where id = u2;
  perform pg_temp.login('r320_chat@t.test');
  select d.full_name into nm from public.chat_directory() d where d.id = u;
  select d.full_name into nm2 from public.chat_directory() d where d.id = u2;
  perform pg_temp.su();
  perform pg_temp.res('30 no profile name: the sign-up name shows (tags stripped), not the e-mail prefix',
    nm = 'Kiran b Kumar /b', coalesce(nm, 'null'));
  perform pg_temp.res('31 a profile full name still wins', nm2 = 'Profile Name', coalesce(nm2, 'null'));
exception when others then perform pg_temp.su(); insert into _t320 values ('3x chat', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _t320 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R110-TRIAL-POLISH-0320: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R110-TRIAL-POLISH-0320: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t320;
rollback;
