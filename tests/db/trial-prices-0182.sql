-- trial-prices-0182.sql -- 0182: trial builder prices = owner inventory rates (I-11) + sample catalog rows stay demo when edited in a trial (I-14).
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text, p_tz text default 'Asia/Kolkata', p_cur text default 'INR') returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, p_tz, p_cur, 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
create or replace function pg_temp.d(p text) returns text language sql as $$ select E'Demo \u00b7 ' || p $$;

-- ---- A) master + manifest + new trial -------------------------------------------------------------
do $$ declare M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; q5 constant uuid := 'a5a5a5a5-0171-4000-8000-0000000000b5';
  AP jsonb := public._a182_owner_asset_prices(); N text := public._a182_manifest_note();
  a uuid; p uuid; bad text; pv jsonb; t numeric; qa uuid;
begin
  perform pg_temp.su();
  pv := (select value from public.app_config where org_id = M and key = 'pricing');
  perform pg_temp.res('01 master pricing: assetPrices = owner list (Round Table 500, LED Wall 5000, Stage Barrier 1000, Monitor 1200, Urli 1200, Plinth 500), chairPrice 100',
    pv -> 'assetPrices' @> AP and (AP ->> 'table')::int = 500 and (AP ->> 'led')::int = 5000 and (AP ->> 'stagebarrier')::int = 1000
    and (AP ->> 'monitor')::int = 1200 and (AP ->> 'urli')::int = 1200 and (AP ->> 'plinth')::int = 500 and (pv ->> 'chairPrice')::int = 100
    and pv ? 'termsText' and pv ? 'advancePct', left(coalesce(pv::text, 'null'), 200));
  -- builder price = inventory rate for the owner's items in the sample inventory (0171)
  select string_agg(x.n || ' inv=' || coalesce(i.unit_cost::text, 'none') || ' builder=' || coalesce(AP ->> x.t, 'none'), '; ') into bad
    from (values ('Round Table','table'), ('LED Wall','led'), ('Stage Barrier','stagebarrier'), ('Stage Monitor','monitor'),
                 ('Flower Urli','urli'), ('LED Video Wall','videowall'), ('Uplight','uplight'), ('Line Array','linearray'),
                 ('Generator','generator'), ('Chandelier','chandelier'), ('Lounge Set','lounge'), ('Mic Stand','micstand'),
                 ('Chair (single)','chiavari'), ('Display Plinth','plinth'), ('Main Stage','stage'), ('Decor Mandap','mandap')) x(n, t)
    left join public.inventory_items i on i.org_id = M and i.name = pg_temp.d(x.n)
   where i.unit_cost is null or i.unit_cost <> (AP ->> x.t)::numeric;
  perform pg_temp.res('02 builder rate = sample inventory rate (16 owner items)', bad is null, bad);
  perform pg_temp.res('03 the 0182 manifest is current (= previous + 1), published once, carries assetPrices + chairPrice',
    (select count(*) from public.helm_trial_seed_manifest m where m.notes = N) = 1
    and exists (select 1 from public.helm_trial_seed_manifest m where m.is_current and m.notes = N
                  and m.version = (select max(x.version) from public.helm_trial_seed_manifest x where x.notes <> N) + 1
                  and m.payload #> '{studio,pricing,assetPrices}' @> AP and (m.payload #>> '{studio,pricing,chairPrice}')::int = 100
                  and m.payload #> '{studio,pricing}' ? 'termsText'));
  t := (select (pricing ->> 'total')::numeric from public.quotes where id = q5);
  perform pg_temp.res('04 Kapoor Sangeet: chairPrice 100, D8 total 472000, 30 % advance 141600 paid (simulated) + 70 % balance 330400',
    (select pricing ->> 'chairPrice' from public.quotes where id = q5) = '100' and t = 472000
    and (select string_agg(seq || '=' || amount::bigint || '/' || status, ',' order by seq) from public.payment_milestones where quote_id = q5) = '1=141600/paid,2=330400/due'
    and (select amount from public.quote_payments where quote_id = q5 and simulated) = 141600,
    coalesce(t::text, 'null'));
  perform pg_temp.res('05 every builder item type has an owner rate (142), all numbers >= 0',
    (select count(*) from jsonb_each(AP)) = 142
    and not exists (select 1 from jsonb_each(AP) e where jsonb_typeof(e.value) <> 'number' or (e.value)::text::numeric < 0));

  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('tp182_a@t.test');
  p := pg_temp.trial('tp182_p@t.test');
  pv := (select value from public.app_config where org_id = a and key = 'pricing');
  select id into qa from public.quotes where org_id = a and code = 'SMP-1004';
  perform pg_temp.res('06 new trial: assetPrices = owner list, chairPrice 100, payment terms kept; its Kapoor event priced at 100 per chair',
    pv -> 'assetPrices' = AP and (pv ->> 'chairPrice')::int = 100 and pv ? 'advancePct'
    and (select pricing ->> 'chairPrice' from public.quotes where id = qa) = '100'
    and (select (pricing ->> 'total')::numeric from public.quotes where id = qa) = 472000
    and (select sum(amount) from public.payment_milestones where quote_id = qa) = 472000,
    left(coalesce(pv::text, 'null'), 200));
  perform pg_temp.put('a', a::text); perform pg_temp.put('p', p::text);
  -- p converts to paid
  update public.studio_subscriptions set status = 'active' where org_id = p;
exception when others then perform pg_temp.su(); insert into _uf values ('zz exception A', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- B) I-14: a trial member edits sample rows -> they stay demo; paid studio -> adopted (0097) ----
do $$ declare a uuid := pg_temp.get('a')::uuid; p uuid := pg_temp.get('p')::uuid; da uuid; ma uuid; ia uuid; dp uuid; la uuid; begin
  perform pg_temp.su();
  select id into da from public.dish_catalog where org_id = a and is_demo and active order by name limit 1;
  select id into ma from public.menu_templates where org_id = a and is_demo and active order by name limit 1;
  select id into ia from public.inventory_items where org_id = a and is_demo and active and name = pg_temp.d('Round Table');
  select id into dp from public.dish_catalog where org_id = p and is_demo order by name limit 1;
  select id into la from public.leads where org_id = a and is_demo order by name limit 1;
  perform pg_temp.put('da', da::text); perform pg_temp.put('ma', ma::text); perform pg_temp.put('ia', ia::text);
  perform pg_temp.put('dp', dp::text); perform pg_temp.put('la', la::text);
  perform pg_temp.res('07 fixtures: sample dish / package / inventory / lead cloned as demo (names without the Demo prefix for dish + package)',
    da is not null and ma is not null and ia is not null and dp is not null and la is not null
    and (select name from public.dish_catalog where id = da) not like E'Demo \u00b7%'
    and (select name from public.menu_templates where id = ma) not like E'Demo \u00b7%');
end $$;
select pg_temp.login('tp182_a@t.test');
select pg_temp.put('e1', pg_temp.try($q$update public.dish_catalog set category = 'My category' where id = '$q$ || pg_temp.get('da') || $q$'$q$));
select pg_temp.put('e2', pg_temp.try($q$update public.menu_templates set price_per_plate = price_per_plate + 50 where id = '$q$ || pg_temp.get('ma') || $q$'$q$));
select pg_temp.put('e3', pg_temp.try($q$update public.inventory_items set name = 'Round Table 8-seater', unit_cost = 550 where id = '$q$ || pg_temp.get('ia') || $q$'$q$));
select pg_temp.put('e4', pg_temp.try($q$update public.leads set name = 'My Lead' where id = '$q$ || pg_temp.get('la') || $q$'$q$));
select pg_temp.put('e5', pg_temp.try($q$update public.dish_catalog set is_demo = false where id = '$q$ || pg_temp.get('da') || $q$'$q$));
select pg_temp.put('lim', (public.my_trial_limits())::text);
select pg_temp.put('k1', public._a182_keep_demo('dish_catalog', pg_temp.get('a')::uuid)::text);
select pg_temp.put('k2', public._a182_keep_demo('dish_catalog', pg_temp.get('p')::uuid)::text);
select pg_temp.put('k3', public._a182_keep_demo('leads', pg_temp.get('a')::uuid)::text);
select pg_temp.login('tp182_p@t.test');
select pg_temp.put('e6', pg_temp.try($q$update public.dish_catalog set category = 'Paid category' where id = '$q$ || pg_temp.get('dp') || $q$'$q$));
select pg_temp.put('k4', public._a182_keep_demo('dish_catalog', pg_temp.get('p')::uuid)::text);
do $$ declare lim jsonb := pg_temp.get('lim')::jsonb; begin
  perform pg_temp.su();
  -- with 0181 (trial guards) a trial cannot change a dish at all (dish_catalog has no price column):
  -- the edit is refused and the sample dish stays as it was, still is_demo
  perform pg_temp.res('08 trial: edited sample dish keeps is_demo (0181: edit refused, row unchanged)',
    case when to_regprocedure('public._tl181_tg_catalog_edit()') is not null
      then pg_temp.get('e1') like '42501%'
           and exists (select 1 from public.dish_catalog where id = pg_temp.get('da')::uuid and category is distinct from 'My category' and is_demo)
      else exists (select 1 from public.dish_catalog where id = pg_temp.get('da')::uuid and category = 'My category' and is_demo) end, pg_temp.get('e1'));
  perform pg_temp.res('09 trial: sample package price edited, keeps is_demo',
    pg_temp.get('e2') = '' and exists (select 1 from public.menu_templates where id = pg_temp.get('ma')::uuid and is_demo), pg_temp.get('e2'));
  perform pg_temp.res('10 trial: renamed sample inventory item keeps is_demo and does not count toward the cap',
    exists (select 1 from public.inventory_items where id = pg_temp.get('ia')::uuid and name = 'Round Table 8-seater' and unit_cost = 550 and is_demo)
    and (lim ->> 'trial')::boolean and (lim #>> '{used,inventory_items}')::int = 0, pg_temp.get('e3') || ' ' || coalesce(lim::text, 'null'));
  perform pg_temp.res('11 trial: other tables keep the 0097 adopt rule (renamed lead -> own row)',
    exists (select 1 from public.leads where id = pg_temp.get('la')::uuid and name = 'My Lead' and not is_demo), pg_temp.get('e4'));
  perform pg_temp.res('12 trial: the app still cannot set is_demo itself', pg_temp.get('e5') like '42501%'
    and exists (select 1 from public.dish_catalog where id = pg_temp.get('da')::uuid and is_demo), pg_temp.get('e5'));
  perform pg_temp.res('13 paid studio: edited demo dish adopted (unchanged 0097 rule)',
    exists (select 1 from public.dish_catalog where id = pg_temp.get('dp')::uuid and category = 'Paid category' and not is_demo), pg_temp.get('e6'));
  perform pg_temp.res('14 keep-demo rule: own trial studio + catalog table only (not another studio, not leads, not paid)',
    pg_temp.get('k1') = 'true' and pg_temp.get('k2') = 'false' and pg_temp.get('k3') = 'false' and pg_temp.get('k4') = 'false',
    concat_ws(',', pg_temp.get('k1'), pg_temp.get('k2'), pg_temp.get('k3'), pg_temp.get('k4')));
exception when others then perform pg_temp.su(); insert into _uf values ('zz exception B', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
select pg_temp.login('tp182_a@t.test');
select pg_temp.put('e7', pg_temp.try('select public.clear_sample_data()'));
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('15 Clear demo data removes (or switches off) the edited sample dish, package and inventory item; the adopted lead stays',
    pg_temp.get('e7') = ''
    and not exists (select 1 from public.dish_catalog where id = pg_temp.get('da')::uuid and active)
    and not exists (select 1 from public.menu_templates where id = pg_temp.get('ma')::uuid and active)
    and not exists (select 1 from public.inventory_items where id = pg_temp.get('ia')::uuid and active)
    and exists (select 1 from public.leads where id = pg_temp.get('la')::uuid and not is_demo), pg_temp.get('e7'));
exception when others then perform pg_temp.su(); insert into _uf values ('zz exception C', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- C) existing trials + re-run: own keys kept, missing filled, paid untouched, master edits kept ----
do $$ declare b uuid; c uuid; p uuid := pg_temp.get('p')::uuid; M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  b := pg_temp.trial('tp182_b@t.test'); c := pg_temp.trial('tp182_c@t.test');
  -- b looks like a trial cloned before 0182 (no builder rates); c set its own rates
  update public.app_config set value = value - 'assetPrices' - 'chairPrice' where org_id = b and key = 'pricing';
  update public.app_config set value = value || '{"assetPrices":{"table":777},"chairPrice":150}'::jsonb where org_id = c and key = 'pricing';
  update public.app_config set value = value - 'assetPrices' - 'chairPrice' where org_id = p and key = 'pricing';
  -- the owner edits the master in the app after 0182
  update public.app_config set value = jsonb_set(value || '{"chairPrice":120}'::jsonb, '{assetPrices,table}', '999') where org_id = M and key = 'pricing';
  perform pg_temp.put('b', b::text); perform pg_temp.put('c', c::text);
  perform pg_temp.put('nb', (select count(*) from public.notifications where org_id = b)::text);
  perform pg_temp.put('mt', coalesce(current_setting('helm.maintenance', true), ''));
end $$;
\i supabase/migrations/0182_trial_builder_prices.sql
\i supabase/migrations/0182_trial_builder_prices.sql
do $$ declare AP jsonb := public._a182_owner_asset_prices(); M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  q5 constant uuid := 'a5a5a5a5-0171-4000-8000-0000000000b5'; pb jsonb; pc jsonb; begin
  perform pg_temp.su();
  pb := (select value from public.app_config where org_id = pg_temp.get('b')::uuid and key = 'pricing');
  pc := (select value from public.app_config where org_id = pg_temp.get('c')::uuid and key = 'pricing');
  perform pg_temp.res('16 existing trial without rates gets the owner list + chair 100, keeps its other keys',
    pb -> 'assetPrices' = AP and (pb ->> 'chairPrice')::int = 100 and pb ? 'termsText', left(coalesce(pb::text, 'null'), 200));
  perform pg_temp.res('17 existing trial keeps its own rates and chair price',
    pc -> 'assetPrices' = '{"table":777}'::jsonb and (pc ->> 'chairPrice')::int = 150, left(coalesce(pc::text, 'null'), 200));
  perform pg_temp.res('18 paid studio untouched',
    not ((select value from public.app_config where org_id = pg_temp.get('p')::uuid and key = 'pricing') ? 'assetPrices')
    and not ((select value from public.app_config where org_id = pg_temp.get('p')::uuid and key = 'pricing') ? 'chairPrice'));
  perform pg_temp.res('19 re-run: no extra manifest, the owner''s later master edits kept, Kapoor money unchanged',
    (select count(*) from public.helm_trial_seed_manifest where notes = public._a182_manifest_note()) = 1
    and (select value #>> '{assetPrices,table}' from public.app_config where org_id = M and key = 'pricing') = '999'
    and (select value ->> 'chairPrice' from public.app_config where org_id = M and key = 'pricing') = '120'
    and (select (pricing ->> 'total')::numeric from public.quotes where id = q5) = 472000
    and (select string_agg(amount::bigint::text, ',' order by seq) from public.payment_milestones where quote_id = q5) = '141600,330400');
  perform pg_temp.res('20 re-run: the guard is patched once, the maintenance flag is restored, no bell rows for the filled trial',
    (select (length(prosrc) - length(replace(prosrc, '/* a182 */', ''))) / length('/* a182 */') from pg_proc where oid = 'public._a97_tg_demo_flag_guard()'::regprocedure) = 1
    and coalesce(current_setting('helm.maintenance', true), '') = pg_temp.get('mt')
    and (select count(*) from public.notifications where org_id = pg_temp.get('b')::uuid)::text = pg_temp.get('nb'));
  perform pg_temp.res('21 grants: keep-demo check for signed-in members only; rates / note / snapshot settings not callable from the app',
    has_function_privilege('authenticated', 'public._a182_keep_demo(text, uuid)', 'execute')
    and not has_function_privilege('anon', 'public._a182_keep_demo(text, uuid)', 'execute')
    and not has_function_privilege('anon', 'public._a182_owner_asset_prices()', 'execute')
    and not has_function_privilege('authenticated', 'public._a182_owner_asset_prices()', 'execute')
    and not has_function_privilege('authenticated', 'public._a182_manifest_note()', 'execute')
    and not has_function_privilege('authenticated', 'public._sample_studio_settings(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._sample_studio_settings(uuid)', 'execute'));
exception when others then perform pg_temp.su(); insert into _uf values ('zz exception D', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-PRICES-0182: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-PRICES-0182: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
