-- trial-quotes-0211.sql -- 0211: a free-trial studio creates as many quotes / events as it likes (no cap), the
-- 2-new cap stays for leads / inventory / vendors / staff / venues; my_trial_limits says quotes are uncapped;
-- the trial terms version moved to trial-2026-10-19 (owner asked once more); clear_menu_template ("No package /
-- decide later") clears the plan's package + plate price, keeps the dishes, same checks as apply_menu_template.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites in run-all re-apply 0173 / 0181 / 0207 / 0236 (the 0173 / 0181 trigger blocks add the quotes
-- triggers back): re-apply 0211 here, twice (also proves a re-run is safe)
\ir ../../supabase/migrations/0236_trial_definition_unify.sql
\ir ../../supabase/migrations/0211_trial_quotes_uncapped.sql
\ir ../../supabase/migrations/0211_trial_quotes_uncapped.sql
create temp table _tq(name text, result text); grant all on _tq to anon, authenticated, service_role;
create temp table _tqkv(k text primary key, v text); grant all on _tqkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tq values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _tqkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _tqkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;

-- ---- schema: triggers, grants, version ----------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 no trial cap trigger on quotes any more (0173 + 0181 + the 0181 log)',
    not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass
                 and tgname in ('zzzz_tl173_cap', 'zzzz_tl181_cap', 'zzzz_tl181_cap_log')));
  perform pg_temp.res('02 the cap triggers stay on leads, inventory_items, vendors, crew_members, venues',
    (select count(*) from pg_trigger t where t.tgname in ('zzzz_tl173_cap', 'zzzz_tl181_cap', 'zzzz_tl181_cap_log')
       and t.tgrelid in ('public.leads'::regclass, 'public.inventory_items'::regclass, 'public.vendors'::regclass,
                         'public.crew_members'::regclass, 'public.venues'::regclass)) = 15);
  perform pg_temp.res('03 the cap trigger functions are kept (0236 bodies)',
    position('trial-unify-0236' in (select prosrc from pg_proc where oid = to_regprocedure('public._tl181_tg_cap_check()'))) > 0
    and position('trial-unify-0236' in (select prosrc from pg_proc where oid = to_regprocedure('public._tl173_tg_create_cap()'))) > 0);
  perform pg_temp.res('04 terms version = public/trial-facts.js VERSION (trial-2026-10-19)', public._trial_terms_version() = 'trial-2026-10-19');
  perform pg_temp.res('05 grants: my_trial_limits + clear_menu_template signed-in only; version helper not callable by the app',
    has_function_privilege('authenticated', 'public.my_trial_limits()', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_limits()', 'execute')
    and has_function_privilege('authenticated', 'public.clear_menu_template(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.clear_menu_template(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._trial_terms_version()', 'execute')
    and not has_function_privilege('anon', 'public._trial_terms_version()', 'execute'));
  perform pg_temp.res('06 bodies tagged trial-quotes-0211',
    position('trial-quotes-0211' in (select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_limits()'))) > 0
    and position('trial-quotes-0211' in (select prosrc from pg_proc where oid = to_regprocedure('public.clear_menu_template(uuid)'))) > 0);
exception when others then perform pg_temp.su(); insert into _tq values ('0x schema', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- trial: quotes unlimited, the other lists still capped ---------------------------------------------------
do $$ declare o uuid; e text := ''; i int; n0 int; n1 int; lim jsonb; b1 uuid; b2 uuid; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  o := pg_temp.trial('tq_trial@t.test'); perform pg_temp.put('o', o::text);
  select count(*) into n0 from public.quotes where org_id = o and not is_demo;
  perform pg_temp.login('tq_trial@t.test');
  for i in 1..5 loop
    e := e || pg_temp.try(format('select public.create_quote(%L, %L, null, ''{"items":[]}''::jsonb, 0)', 'TQ-' || i, 'TQ quote ' || i));
  end loop;
  perform pg_temp.su(); select count(*) into n1 from public.quotes where org_id = o and not is_demo;
  perform pg_temp.res('10 trial: 5 new quotes are created (no cap)', e = '' and n1 = n0 + 5, e || ' ' || n0 || '->' || n1);
  perform pg_temp.login('tq_trial@t.test');
  e := '';
  for i in 6..12 loop
    e := e || pg_temp.try(format('select public.create_quote(%L, %L, ''Wedding'', ''{"items":[]}''::jsonb, 0)', 'TQ-' || i, 'TQ quote ' || i));
  end loop;
  perform pg_temp.su(); select count(*) into n1 from public.quotes where org_id = o and not is_demo;
  perform pg_temp.res('11 trial: 12 new quotes in all, none refused', e = '' and n1 = n0 + 12, e || ' ' || n0 || '->' || n1);
  perform pg_temp.res('12 trial: no new trial_create_log rows for quotes', not exists (
    select 1 from public.trial_create_log l where l.org_id = o and l.entity = 'quotes'));
  perform pg_temp.login('tq_trial@t.test');
  lim := public.my_trial_limits();
  perform pg_temp.res('13 my_trial_limits: trial, cap 2, quotes uncapped and not under used',
    (lim ->> 'trial')::boolean and (lim ->> 'cap')::int = 2 and lim -> 'uncapped' = '["quotes"]'::jsonb
    and not (lim -> 'used') ? 'quotes'
    and (lim -> 'used') ?& array['leads', 'inventory_items', 'vendors', 'crew_members', 'venues'], lim::text);
  e := pg_temp.try('insert into public.leads(name) values (''TQ lead 1'')') || pg_temp.try('insert into public.leads(name) values (''TQ lead 2'')');
  perform pg_temp.res('14 trial: 2 new leads are fine', e = '', e);
  e := pg_temp.try('insert into public.leads(name) values (''TQ lead 3'')');
  perform pg_temp.res('15 trial: the 3rd lead is still refused (cap 2 kept)', e like '42501%Free trial limit reached (2)%', e);
  e := pg_temp.try('insert into public.vendors(name) values (''TQ vendor 1'')') || pg_temp.try('insert into public.vendors(name) values (''TQ vendor 2'')');
  e := pg_temp.try('insert into public.vendors(name) values (''TQ vendor 3'')');
  perform pg_temp.res('16 trial: the 3rd vendor is still refused (cap 2 kept)', e like '42501%Free trial limit reached (2)%', e);
  -- "New quote" opens the flow directly: start_blank_quote reuses my untouched blank quote (no empty pile-up)
  select id into b1 from public.start_blank_quote('TQ-B', 'TQ-B');
  select id into b2 from public.start_blank_quote('TQ-B2', 'TQ-B2');
  perform pg_temp.res('17 New quote twice (no dialog): the same untouched blank quote comes back', b1 is not null and b1 = b2,
    coalesce(b1::text, 'null') || ' / ' || coalesce(b2::text, 'null'));
  perform pg_temp.put('qb', b1::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _tq values ('1x trial quotes', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- terms: the owner who agreed to the old wording is asked once more --------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; u uuid; c jsonb; e text; r jsonb; begin
  u := (select id from auth.users where email = 'tq_trial@t.test');
  perform pg_temp.su(); update public.organizations set trial_welcome_pending = false where id = o;
  insert into public.trial_terms_acceptances(org_id, user_id, version, kind, accepted_at)
    values (o, u, 'trial-2026-10-18', 'agree', now() - interval '1 day') on conflict do nothing;
  perform pg_temp.login('tq_trial@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('20 owner agreed to trial-2026-10-18 only: must_agree again for trial-2026-10-19',
    c ->> 'version' = 'trial-2026-10-19' and (c ->> 'must_agree')::boolean, c::text);
  e := pg_temp.try($q$select public.accept_trial_terms('trial-2026-10-18')$q$);
  perform pg_temp.res('21 a stale page (old version) is refused 22023', e like '22023%', e);
  r := public.accept_trial_terms('trial-2026-10-19');
  c := public.my_trial_terms_status();
  perform pg_temp.res('22 agreeing to the new version clears it', r ->> 'result' = 'ok' and not (c ->> 'must_agree')::boolean, r::text || ' ' || c::text);
  perform pg_temp.su();
  perform pg_temp.res('23 both agreements are kept (consent record per version)',
    (select count(*) from public.trial_terms_acceptances where org_id = o and user_id = u) = 2);
exception when others then perform pg_temp.su(); insert into _tq values ('2x terms', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- clear_menu_template: "No package / decide later" -------------------------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; q uuid := pg_temp.get('qb')::uuid; mt uuid; nd0 int; nd1 int; p public.event_plan; r jsonb; e text; other uuid; begin
  perform pg_temp.su();
  select id into mt from public.menu_templates where org_id = o and jsonb_array_length(coalesce(dishes, '[]'::jsonb)) > 0 order by seq limit 1;
  perform pg_temp.login('tq_trial@t.test');
  e := pg_temp.try(format('select public.apply_menu_template(%L, %L)', q, mt));
  perform pg_temp.su();
  select * into p from public.event_plan where quote_id = q;
  select count(*) into nd0 from public.event_menu_items where quote_id = q;
  perform pg_temp.res('30 setup: a package applied (plan names it, plate price set, dishes copied)',
    e = '' and mt is not null and p.menu_template is not null and p.menu_plate_price is not null and nd0 > 0, e || ' ' || coalesce(nd0, -1));
  perform pg_temp.login('tq_trial@t.test');
  r := public.clear_menu_template(q);
  perform pg_temp.su();
  select * into p from public.event_plan where quote_id = q;
  select count(*) into nd1 from public.event_menu_items where quote_id = q;
  perform pg_temp.res('31 cleared: package, menu_template and menu_plate_price are null', (r ->> 'cleared')::boolean
    and p.package is null and p.menu_template is null and p.menu_plate_price is null, r::text);
  perform pg_temp.res('32 the dishes are kept (nothing deleted)', nd1 = nd0, nd0 || '->' || nd1);
  perform pg_temp.login('tq_trial@t.test');
  r := public.clear_menu_template(q);
  perform pg_temp.res('33 a second clear changes nothing', not (r ->> 'cleared')::boolean, r::text);
  e := pg_temp.try(format('select public.apply_menu_template(%L, %L)', q, mt));
  perform pg_temp.res('34 a package can be picked again afterwards', e = '', e);
  perform pg_temp.su(); update public.event_plan set menu_locked = true where quote_id = q;
  perform pg_temp.login('tq_trial@t.test');
  e := pg_temp.try(format('select public.clear_menu_template(%L)', q));
  perform pg_temp.su(); select * into p from public.event_plan where quote_id = q;
  perform pg_temp.res('35 menu locked: refused, package kept', e like '42501%menu is locked%' and p.menu_template is not null, e);
  update public.event_plan set menu_locked = false where quote_id = q;
  -- another studio's quote: refused
  other := pg_temp.trial('tq_other@t.test');
  perform pg_temp.login('tq_other@t.test');
  e := pg_temp.try(format('select public.clear_menu_template(%L)', q));
  perform pg_temp.su(); select * into p from public.event_plan where quote_id = q;
  perform pg_temp.res('36 another studio cannot clear it', e <> '' and p.menu_template is not null, e);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.clear_menu_template(%L)', q));
  perform pg_temp.su();
  perform pg_temp.res('37 signed out: refused', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _tq values ('3x clear package', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- paid studios: unchanged ---------------------------------------------------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; begin
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'active' where org_id = o;
  perform pg_temp.login('tq_trial@t.test');
  perform pg_temp.res('40 paid: my_trial_limits says not trial', public.my_trial_limits() ->> 'trial' = 'false');
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _tq values ('4x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _tq order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-QUOTES-0211: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-QUOTES-0211: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _tq;
rollback;
