-- trial-quotes-cap-0238.sql -- 0238: a free-trial studio may again create at most 2 NEW quotes / events (owner r20);
-- the sample events (is_demo) never count; quotes made while 0211 was live are kept and count; reusing my untouched
-- blank quote is never refused; a refused lead conversion leaves the lead as it was; my_trial_limits lists quotes
-- under used again; the trial terms version moved to trial-2026-10-20 (owner asked once more); paid studios unchanged.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- the live state before 0238: 0236 bodies + 0211 (the quotes cap triggers dropped, quotes uncapped)
\ir ../../supabase/migrations/0236_trial_definition_unify.sql
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
create or replace function pg_temp.own(p_org uuid) returns int language sql as $$
  select count(*)::int from public.quotes where org_id = p_org and not is_demo $$;

-- ---- while 0211 is live: a trial made 3 quotes (no cap) ------------------------------------------------------
do $$ declare w uuid; e text := ''; i int; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  w := pg_temp.trial('tc_window@t.test'); perform pg_temp.put('w', w::text);
  perform pg_temp.login('tc_window@t.test');
  for i in 1..3 loop
    e := e || pg_temp.try(format('select public.create_quote(%L, %L, null, ''{"items":[]}''::jsonb, 0)', 'TW-' || i, 'TW quote ' || i));
  end loop;
  perform pg_temp.su();
  perform pg_temp.res('00 setup: under 0211 a trial made 3 own quotes', e = '' and pg_temp.own(w) = 3, e || ' ' || pg_temp.own(w));
exception when others then perform pg_temp.su(); insert into _tq values ('0x window', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 0238, twice (a re-run is safe and changes nothing) ------------------------------------------------------
\ir ../../supabase/migrations/0238_trial_quotes_cap_two.sql
\ir ../../supabase/migrations/0238_trial_quotes_cap_two.sql

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 the three cap triggers are on quotes again, once each',
    (select count(*) from pg_trigger where tgrelid = 'public.quotes'::regclass
       and tgname in ('zzzz_tl173_cap', 'zzzz_tl181_cap', 'zzzz_tl181_cap_log')) = 3);
  perform pg_temp.res('02 same definitions as 0173 / 0181 (before insert check x2, after insert log)',
    exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzz_tl173_cap'
              and tgfoid = 'public._tl173_tg_create_cap()'::regprocedure and pg_get_triggerdef(oid) like '%BEFORE INSERT%FOR EACH ROW%')
    and exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzz_tl181_cap'
              and tgfoid = 'public._tl181_tg_cap_check()'::regprocedure and pg_get_triggerdef(oid) like '%BEFORE INSERT%FOR EACH ROW%')
    and exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzz_tl181_cap_log'
              and tgfoid = 'public._tl181_tg_cap_log()'::regprocedure and pg_get_triggerdef(oid) like '%AFTER INSERT%FOR EACH ROW%'));
  perform pg_temp.res('03 the cap triggers stay on leads, inventory_items, vendors, crew_members, venues (15)',
    (select count(*) from pg_trigger t where t.tgname in ('zzzz_tl173_cap', 'zzzz_tl181_cap', 'zzzz_tl181_cap_log')
       and t.tgrelid in ('public.leads'::regclass, 'public.inventory_items'::regclass, 'public.vendors'::regclass,
                         'public.crew_members'::regclass, 'public.venues'::regclass)) = 15);
  perform pg_temp.res('04 the cap trigger functions are unchanged (0236 bodies)',
    position('trial-unify-0236' in (select prosrc from pg_proc where oid = to_regprocedure('public._tl181_tg_cap_check()'))) > 0
    and position('trial-unify-0236' in (select prosrc from pg_proc where oid = to_regprocedure('public._tl173_tg_create_cap()'))) > 0);
  perform pg_temp.res('05 terms version = public/trial-facts.js VERSION (trial-2026-10-20)', public._trial_terms_version() = 'trial-2026-10-20');
  perform pg_temp.res('06 grants: my_trial_limits signed-in only; version helper not callable by the app',
    has_function_privilege('authenticated', 'public.my_trial_limits()', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_limits()', 'execute')
    and not has_function_privilege('authenticated', 'public._trial_terms_version()', 'execute')
    and not has_function_privilege('anon', 'public._trial_terms_version()', 'execute'));
  perform pg_temp.res('07 my_trial_limits body tagged trial-quotes-cap-0238',
    position('trial-quotes-cap-0238' in (select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_limits()'))) > 0);
  perform pg_temp.res('08 the quotes made while 0211 was live are kept', pg_temp.own(pg_temp.get('w')::uuid) = 3);
exception when others then perform pg_temp.su(); insert into _tq values ('0y schema', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- a new trial: 2 new quotes, the 3rd refused; samples never count -----------------------------------------
do $$ declare o uuid; e text; nd0 int; nd1 int; b1 uuid; b2 uuid; lim jsonb; sq uuid; begin
  perform pg_temp.su();
  o := pg_temp.trial('tc_trial@t.test'); perform pg_temp.put('o', o::text);
  select count(*) into nd0 from public.quotes where org_id = o and is_demo;
  perform pg_temp.res('10 setup: the trial got its sample events (is_demo) and no own quote', nd0 > 0 and pg_temp.own(o) = 0,
    nd0 || ' sample / ' || pg_temp.own(o) || ' own');
  perform pg_temp.login('tc_trial@t.test');
  lim := public.my_trial_limits();
  perform pg_temp.res('11 my_trial_limits: quotes under used = 0 (sample events not counted), no uncapped key',
    (lim ->> 'trial')::boolean and (lim ->> 'cap')::int = 2 and (lim -> 'used' ->> 'quotes')::int = 0 and not lim ? 'uncapped'
    and (lim -> 'used') ?& array['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'], lim::text);
  -- New quote (the flow): start_blank_quote; a second click reuses the same untouched blank quote
  select id into b1 from public.start_blank_quote('TC-B', 'TC-B');
  select id into b2 from public.start_blank_quote('TC-B2', 'TC-B2');
  perform pg_temp.res('12 New quote: 1st blank quote made; a 2nd click reuses it (no new row)', b1 is not null and b1 = b2
    and pg_temp.own(o) = 1, coalesce(b1::text, 'null') || ' / ' || coalesce(b2::text, 'null'));
  perform pg_temp.put('b1', b1::text);
  e := pg_temp.try('select public.create_quote(''TC-2'', ''TC quote 2'', ''Wedding'', ''{"items":[]}''::jsonb, 0)');
  perform pg_temp.res('13 the 2nd new quote is fine', e = '' and pg_temp.own(o) = 2, e);
  e := pg_temp.try('select public.create_quote(''TC-3'', ''TC quote 3'', ''Wedding'', ''{"items":[]}''::jsonb, 0)');
  perform pg_temp.res('14 the 3rd new quote is refused: 42501 Free trial limit reached (2)', e like '42501%Free trial limit reached (2)%'
    and pg_temp.own(o) = 2, e);
  e := pg_temp.try('select public.start_blank_quote(''TC-4'', ''TC-4'')');
  perform pg_temp.res('15 at the cap, New quote still hands back my untouched blank quote (nothing inserted)', e = ''
    and pg_temp.own(o) = 2, e);
  perform pg_temp.su();
  perform pg_temp.res('16 both new quotes are remembered in trial_create_log (deleting one never frees a slot)',
    (select count(*) from public.trial_create_log where org_id = o and entity = 'quotes') = 2);
  -- a direct insert from the app is refused as well (the triggers guard every path)
  perform pg_temp.login('tc_trial@t.test');
  e := pg_temp.try('insert into public.quotes(code, title) values (''TC-5'', ''TC direct'')');
  perform pg_temp.res('17 a direct insert by the app is refused too (or not allowed at all)', e <> '' and pg_temp.own(o) = 2, e);
  -- editing a sample event (no rename) keeps it a sample: it never uses a slot
  perform pg_temp.su(); select id into sq from public.quotes where org_id = o and is_demo order by code limit 1;
  perform pg_temp.login('tc_trial@t.test');
  e := pg_temp.try(format('update public.quotes set event_time = ''18:30''::time where id = %L', sq));
  lim := public.my_trial_limits();
  perform pg_temp.su();
  perform pg_temp.res('18 editing a sample event keeps it a sample (is_demo) and the count stays 2 of 2',
    e = '' and (select is_demo from public.quotes where id = sq) and (lim -> 'used' ->> 'quotes')::int = 2, e || ' ' || lim::text);
  perform pg_temp.res('19 the sample events are all still there', (select count(*) from public.quotes where org_id = o and is_demo) = nd0);
exception when others then perform pg_temp.su(); insert into _tq values ('1x trial cap', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- converting a lead at the cap: refused, the lead is left as it was ---------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; l uuid; e text; before jsonb; after jsonb; begin
  perform pg_temp.su();
  select id into l from public.leads where org_id = o and quote_id is null order by created_at limit 1;
  before := (select to_jsonb(x) from public.leads x where x.id = l);
  perform pg_temp.login('tc_trial@t.test');
  e := pg_temp.try(format('select public.convert_lead_to_quote(%L)', l));
  perform pg_temp.su();
  after := (select to_jsonb(x) from public.leads x where x.id = l);
  perform pg_temp.res('20 convert a lead at 2 of 2: refused (trial cap), the lead row is unchanged, no quote made',
    l is not null and e like '42501%Free trial limit reached (2)%' and before = after and pg_temp.own(o) = 2, coalesce(e, '') || ' ' || coalesce(l::text, 'no lead'));
exception when others then perform pg_temp.su(); insert into _tq values ('2x lead convert', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- the 0211-window trial: its 3 quotes are kept, a 4th is refused -------------------------------------------
do $$ declare w uuid := pg_temp.get('w')::uuid; e text; lim jsonb; begin
  perform pg_temp.login('tc_window@t.test');
  e := pg_temp.try('select public.create_quote(''TW-4'', ''TW quote 4'', null, ''{"items":[]}''::jsonb, 0)');
  lim := public.my_trial_limits();
  perform pg_temp.su();
  perform pg_temp.res('21 a trial that made 3 under 0211: the 4th is refused, the 3 stay, used says 3',
    e like '42501%Free trial limit reached (2)%' and pg_temp.own(w) = 3 and (lim -> 'used' ->> 'quotes')::int = 3, e || ' ' || lim::text);
exception when others then perform pg_temp.su(); insert into _tq values ('3x window', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- terms: the owner who agreed to the 0211 / 0212 wording is asked once more ---------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; u uuid; c jsonb; e text; r jsonb; begin
  u := (select id from auth.users where email = 'tc_trial@t.test');
  perform pg_temp.su(); update public.organizations set trial_welcome_pending = false where id = o;
  insert into public.trial_terms_acceptances(org_id, user_id, version, kind, accepted_at)
    values (o, u, 'trial-2026-10-19', 'agree', now() - interval '1 day') on conflict do nothing;
  perform pg_temp.login('tc_trial@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('30 owner agreed to trial-2026-10-19 only: must_agree again for trial-2026-10-20',
    c ->> 'version' = 'trial-2026-10-20' and (c ->> 'must_agree')::boolean, c::text);
  e := pg_temp.try($q$select public.accept_trial_terms('trial-2026-10-19')$q$);
  perform pg_temp.res('31 a stale page (old version) is refused 22023', e like '22023%', e);
  r := public.accept_trial_terms('trial-2026-10-20');
  c := public.my_trial_terms_status();
  perform pg_temp.res('32 agreeing to the new version clears it', r ->> 'result' = 'ok' and not (c ->> 'must_agree')::boolean, r::text || ' ' || c::text);
  perform pg_temp.su();
  perform pg_temp.res('33 both agreements are kept (consent record per version)',
    (select count(*) from public.trial_terms_acceptances where org_id = o and user_id = u) = 2);
exception when others then perform pg_temp.su(); insert into _tq values ('4x terms', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- paid studios: unchanged ---------------------------------------------------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; e text; begin
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'active' where org_id = o;
  perform pg_temp.login('tc_trial@t.test');
  e := pg_temp.try('select public.create_quote(''TP-1'', ''Paid quote 1'', null, ''{"items":[]}''::jsonb, 0)')
    || pg_temp.try('select public.create_quote(''TP-2'', ''Paid quote 2'', null, ''{"items":[]}''::jsonb, 0)');
  perform pg_temp.res('40 paid: more quotes are fine (no cap)', e = '' and pg_temp.own(o) = 4, e || ' ' || pg_temp.own(o));
  perform pg_temp.res('41 paid: my_trial_limits says not trial', public.my_trial_limits() ->> 'trial' = 'false');
  perform pg_temp.su();
  perform pg_temp.anon();
  e := pg_temp.try('select public.my_trial_limits()');
  perform pg_temp.su();
  perform pg_temp.res('42 signed out: my_trial_limits refused', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _tq values ('5x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _tq order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-QUOTES-CAP-0238: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-QUOTES-CAP-0238: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _tq;
rollback;
