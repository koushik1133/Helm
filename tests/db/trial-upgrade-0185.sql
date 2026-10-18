-- trial-upgrade-0185.sql -- 0185: when a free-trial studio upgrades, its admin chooses keep (default) /
-- remove_sample (is_demo rows only) / clean (sample removed, every own record ARCHIVED, never deleted,
-- typed START CLEAN). Restore puts everything back. Control Center "Delete all sample data" removes
-- is_demo rows only. Refused during the trial, for members, for clients, for paid studios that never
-- were a trial, for the sample master. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites re-apply old migrations / grant sweeps; re-apply 0185 inside this rolled-back tx
\ir ../../supabase/migrations/0185_trial_upgrade_choice.sql
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
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- the plan becomes active (what HQ activation / a verified payment does)
create or replace function pg_temp.convert(p_org uuid) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'active', current_period_start = current_date,
         current_period_end = current_date + 30, updated_at = now() where org_id = p_org;
end $$;
-- own records the studio added itself (one per list), as the database owner
create or replace function pg_temp.own(p_org uuid, p_tag text) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  insert into public.leads(org_id, name, status) values (p_org, 'Own lead ' || p_tag, 'new');
  insert into public.vendors(org_id, name, category, active) values (p_org, 'Own vendor ' || p_tag, 'Decor', true);
  insert into public.inventory_items(org_id, name, category, total_qty, unit, active) values (p_org, 'Own chair ' || p_tag, 'Furniture', 10, 'pcs', true);
  insert into public.crew_members(org_id, name, phone, active) values (p_org, 'Own staff ' || p_tag, '+91 00000 0' || lpad((abs(hashtext(p_tag)) % 10000)::text, 4, '0'), true);
  insert into public.venues(org_id, name, seated_capacity, active) values (p_org, 'Own venue ' || p_tag, 100, true);
  insert into public.dish_catalog(org_id, category, name, kind, active) values (p_org, 'Mains', 'Own dish ' || p_tag, 'veg', true);
  insert into public.nurture(org_id, name, status) values (p_org, 'Own follow-up ' || p_tag, 'active');
  -- layouts take the org of the signed-in user (_layouts_stamp_org): insert as that studio's admin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select p.id from public.profiles p where p.org_id = p_org and p.role = 'admin' order by p.created_at limit 1),
                     'role', 'authenticated', 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
  insert into public.layouts(name, data) values ('Own layout ' || p_tag, '{}'::jsonb);
  perform pg_temp.su();
  insert into public.quotes(code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
    values ('OWN-' || p_tag, 'Own event ' || p_tag, 'quote', '{"name":"Own client"}'::jsonb,
            '{"subtotal":1000,"discount":0,"gstPct":18,"total":1180}'::jsonb, 1, 'none', p_org, now(), now());
end $$;
-- every row of the studio in the record tables, sample + own, archived or not (owner view, no RLS)
create or replace function pg_temp.allrows(p_org uuid) returns bigint language sql as $$
  select (select count(*) from public.quotes where org_id = p_org) + (select count(*) from public.leads where org_id = p_org)
       + (select count(*) from public.vendors where org_id = p_org) + (select count(*) from public.inventory_items where org_id = p_org)
       + (select count(*) from public.crew_members where org_id = p_org) + (select count(*) from public.venues where org_id = p_org)
       + (select count(*) from public.dish_catalog where org_id = p_org) + (select count(*) from public.menu_templates where org_id = p_org)
       + (select count(*) from public.nurture where org_id = p_org) + (select count(*) from public.layouts where org_id = p_org);
$$;
create or replace function pg_temp.ownrows(p_org uuid) returns bigint language sql as $$
  select (select count(*) from public.quotes where org_id = p_org and not is_demo) + (select count(*) from public.leads where org_id = p_org and not is_demo)
       + (select count(*) from public.vendors where org_id = p_org and not is_demo) + (select count(*) from public.inventory_items where org_id = p_org and not is_demo)
       + (select count(*) from public.crew_members where org_id = p_org and not is_demo) + (select count(*) from public.venues where org_id = p_org and not is_demo)
       + (select count(*) from public.dish_catalog where org_id = p_org and not is_demo) + (select count(*) from public.menu_templates where org_id = p_org and not is_demo)
       + (select count(*) from public.nurture where org_id = p_org and not is_demo) + (select count(*) from public.layouts where org_id = p_org and not is_demo);
$$;
create or replace function pg_temp.demorows(p_org uuid) returns bigint language sql as $$
  select (select count(*) from public.quotes where org_id = p_org and is_demo) + (select count(*) from public.leads where org_id = p_org and is_demo)
       + (select count(*) from public.vendors where org_id = p_org and is_demo) + (select count(*) from public.inventory_items where org_id = p_org and is_demo)
       + (select count(*) from public.crew_members where org_id = p_org and is_demo) + (select count(*) from public.dish_catalog where org_id = p_org and is_demo)
       + (select count(*) from public.menu_templates where org_id = p_org and is_demo) + (select count(*) from public.nurture where org_id = p_org and is_demo);
$$;
-- a fingerprint of the other studios' rows (cross-tenant: must never change)
create or replace function pg_temp.others(p_skip uuid[]) returns text language sql as $$
  select md5(coalesce(string_agg(x, ',' order by x), '')) from (
    select 'q' || id::text || coalesce(archived_at::text, '') || is_demo::text as x from public.quotes where not (org_id = any(p_skip))
    union all select 'l' || id::text || coalesce(clean_archived_at::text, '') from public.leads where not (org_id = any(p_skip))
    union all select 'v' || id::text || active::text from public.vendors where not (org_id = any(p_skip))
    union all select 'i' || id::text || active::text from public.inventory_items where not (org_id = any(p_skip))) t;
$$;

-- ---- 1) during the trial: nothing can be chosen yet ------------------------------------------------
do $$ declare a uuid; r jsonb; e text; n0 bigint; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true, block_trial_outbound = true where id;
  a := pg_temp.trial('tu_a@t.test'); perform pg_temp.put('A', a::text);
  perform pg_temp.own(a, 'A');
  perform pg_temp.put('OTHERS0', pg_temp.others(array[a]));
  n0 := pg_temp.allrows(a); perform pg_temp.put('A_ALL0', n0::text);
  perform pg_temp.login('tu_a@t.test');
  r := public.my_upgrade_status();
  perform pg_temp.su();
  perform pg_temp.res('01 in trial: status in_trial, not converted, not pending, has sample',
    (r ->> 'in_trial')::boolean and not (r ->> 'converted')::boolean and not (r ->> 'pending')::boolean
    and (r ->> 'has_sample')::boolean and (r ->> 'was_trial')::boolean and (r ->> 'own_total')::int >= 9, r::text);
  perform pg_temp.login('tu_a@t.test');
  e := pg_temp.try($q$select public.upgrade_data_choice('remove_sample')$q$);
  perform pg_temp.su();
  perform pg_temp.res('02 in trial: choice refused (choose a plan first), nothing removed',
    e like '22023%' and pg_temp.allrows(a) = n0, e);
  -- section 10: checkout saves billing details + the Terms before payment, also in the trial
  perform pg_temp.login('tu_a@t.test');
  e := pg_temp.try($q$select public.my_studio_account_update('{"legal_business_name":"TU A Pvt Ltd","state":"Telangana","terms_version_accepted":"2026-10"}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('02b in trial: the admin can save billing details + accept the Terms (checkout)',
    e = '' and exists (select 1 from public.studio_account x where x.org_id = a and x.legal_business_name = 'TU A Pvt Ltd'
                        and x.terms_accepted_at is not null), e);
  perform pg_temp.login('tu_a@t.test');
  e := pg_temp.try($q$select public.set_studio_link_name('tu-a-new-link')$q$);
  perform pg_temp.su();
  perform pg_temp.res('02c in trial: the other 0173 studio-setting guards still refuse', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _uf values ('0x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) access rules ---------------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; m uuid; c uuid; e text; r jsonb; begin
  perform pg_temp.convert(a);
  m := pg_temp.newuser('tu_a_mgr@t.test'); update public.profiles set org_id = a, role = 'manager' where id = m;
  c := pg_temp.newuser('tu_a_cli@t.test'); update public.profiles set org_id = a, role = 'client' where id = c;
  perform pg_temp.login('tu_a_mgr@t.test');
  e := pg_temp.try($q$select public.upgrade_data_choice('keep')$q$);
  perform pg_temp.su();
  perform pg_temp.res('03 a non-admin member cannot choose', e like '42501%', e);
  perform pg_temp.login('tu_a_mgr@t.test');
  r := public.my_upgrade_status();
  e := pg_temp.try($q$select public.delete_all_sample_data()$q$);
  perform pg_temp.su();
  perform pg_temp.res('04 member reads status (no prompt), cannot delete sample data',
    not (r ->> 'pending')::boolean and not (r ->> 'is_admin')::boolean and e like '42501%', e || r::text);
  perform pg_temp.login('tu_a_cli@t.test');
  e := pg_temp.try($q$select public.my_upgrade_status()$q$);
  perform pg_temp.su();
  perform pg_temp.res('05 a client cannot read the status', e like '42501%', e);
  perform pg_temp.login('tu_a_cli@t.test');
  e := pg_temp.try($q$select public.my_studio_account_update('{"legal_business_name":"Client Ltd"}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('05b a client cannot change the billing details', e like '42501%'
    and not exists (select 1 from public.studio_account x where x.org_id = a and x.legal_business_name = 'Client Ltd'), e);
  perform pg_temp.su(); perform set_config('role', 'anon', false);
  e := pg_temp.try($q$select public.upgrade_data_choice('keep')$q$);
  perform pg_temp.su();
  perform pg_temp.res('06 anon cannot call it', e like '42501%', e);
  perform pg_temp.login('tu_a@t.test');
  r := public.my_upgrade_status();
  e := pg_temp.try(format($q$update public.organizations set upgrade_choice = 'keep' where id = %L$q$, a));
  perform pg_temp.su();
  perform pg_temp.res('07 after upgrade the admin gets the prompt', (r ->> 'converted')::boolean and (r ->> 'pending')::boolean
    and r ->> 'confirm_phrase' = 'START CLEAN', r::text);
  perform pg_temp.res('08 the API cannot write the choice column', (select upgrade_choice is null from public.organizations where id = a), e);
  perform pg_temp.login('tu_a@t.test');
  e := pg_temp.try($q$select public.upgrade_data_choice('clean')$q$);
  perform pg_temp.su();
  perform pg_temp.res('09 clean without START CLEAN is refused, nothing changed',
    e like '22023%' and pg_temp.allrows(a) = pg_temp.get('A_ALL0')::bigint
    and (select upgrade_choice is null from public.organizations where id = a), e);
  perform pg_temp.login('tu_a@t.test');
  e := pg_temp.try($q$select public.upgrade_data_choice('wipe', 'START CLEAN')$q$);
  perform pg_temp.su();
  perform pg_temp.res('10 an unknown choice is refused', e like '22023%', e);
exception when others then perform pg_temp.su(); insert into _uf values ('1x access', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) clean: sample removed, own records archived (never deleted), hidden, journaled -----------
do $$ declare a uuid := pg_temp.get('A')::uuid; r jsonb; s jsonb; own0 bigint; n bigint; e text; begin
  perform pg_temp.su();
  own0 := pg_temp.ownrows(a); perform pg_temp.put('A_OWN0', own0::text);
  perform pg_temp.login('tu_a@t.test');
  r := public.upgrade_data_choice('clean', ' start clean ');
  perform pg_temp.su();
  perform pg_temp.put('A_R', r::text);
  perform pg_temp.res('11 clean: ok + choice stored', r ->> 'result' = 'ok' and
    (select upgrade_choice = 'clean' and upgrade_choice_at is not null from public.organizations where id = a), r::text);
  perform pg_temp.res('12 clean: no own row deleted (same count, owner view)', pg_temp.ownrows(a) = own0,
    pg_temp.ownrows(a)::text || ' vs ' || own0::text);
  perform pg_temp.res('13 clean: sample rows gone except masters a real row still uses (switched off)',
    (select count(*) from public.quotes where org_id = a and is_demo) = 0
    and (select count(*) from public.leads where org_id = a and is_demo) = 0
    and (select count(*) from public.inventory_items where org_id = a and is_demo and active) = 0);
  perform pg_temp.res('14 clean: own events on the Archive shelf',
    (select count(*) from public.quotes where org_id = a and not is_demo and archived_at is null and deleted_at is null) = 0
    and (select count(*) from public.quotes where org_id = a and not is_demo and archived_reason = 'manual') >= 1);
  perform pg_temp.res('15 clean: own masters switched off, leads / follow-ups / layouts flagged',
    (select count(*) from public.vendors where org_id = a and active) = 0
    and (select count(*) from public.inventory_items where org_id = a and active) = 0
    and (select count(*) from public.crew_members where org_id = a and active and profile_id is null) = 0
    and (select count(*) from public.venues where org_id = a and active) = 0
    and (select count(*) from public.dish_catalog where org_id = a and active) = 0
    and (select count(*) from public.leads where org_id = a and clean_archived_at is null) = 0
    and (select count(*) from public.nurture where org_id = a and clean_archived_at is null) = 0
    and (select count(*) from public.layouts where org_id = a and clean_archived_at is null) = 0);
  perform pg_temp.res('16 clean: every archived row journaled for this studio only',
    (select count(*) from public.studio_clean_start_items where org_id = a and restored_at is null) = (r -> 'archived' ->> 'total')::int
    and (r -> 'archived' ->> 'total')::int >= 9
    and not exists (select 1 from public.studio_clean_start_items where org_id <> a), r::text);
  perform pg_temp.res('17 clean: other studios untouched (cross-tenant)', pg_temp.others(array[a]) = pg_temp.get('OTHERS0'));
  perform pg_temp.login('tu_a@t.test');
  n := (select count(*) from public.leads) + (select count(*) from public.nurture) + (select count(*) from public.layouts);
  s := public.my_upgrade_status();
  e := pg_temp.try(format($q$insert into public.leads(org_id, name, status, clean_archived_at) values (%L, 'x', 'new', now())$q$, a));
  perform pg_temp.su();
  perform pg_temp.res('18 the app sees an empty studio (archived rows hidden by RLS)',
    n = 0 and (s ->> 'own_total')::int = 0 and (s ->> 'archived')::int > 0 and (s ->> 'can_restore')::boolean
    and not (s ->> 'pending')::boolean, n::text || s::text);
  perform pg_temp.res('19 the app cannot create an archived row', e <> '', e);
  perform pg_temp.login('tu_a@t.test');
  insert into public.leads(org_id, name, status) values (a, 'New real lead', 'new');
  n := (select count(*) from public.leads);
  r := public.upgrade_data_choice('keep');
  perform pg_temp.su();
  perform pg_temp.res('20 the clean studio works normally (new lead visible); a 2nd choice changes nothing',
    n = 1 and r ->> 'result' = 'already' and r ->> 'choice' = 'clean'
    and (select count(*) from public.studio_clean_start_items where org_id = a) = (pg_temp.get('A_R')::jsonb -> 'archived' ->> 'total')::int, r::text);
  perform pg_temp.res('21 audit row written', exists (select 1 from public.audit_log where org_id = a and action = 'trial.upgrade_choice'));
exception when others then perform pg_temp.su(); insert into _uf values ('2x clean', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) restore: everything the clean archived comes back ----------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; r jsonb; r2 jsonb; n bigint; begin
  perform pg_temp.login('tu_a@t.test');
  r := public.restore_clean_start();
  n := (select count(*) from public.leads where name like 'Own lead %');
  r2 := public.restore_clean_start();
  perform pg_temp.su();
  perform pg_temp.res('22 restore: ok, all archived rows back', r ->> 'result' = 'ok' and (r ->> 'skipped')::int = 0
    and (select count(*) from public.quotes where org_id = a and not is_demo and archived_at is not null) = 0
    and (select count(*) from public.vendors where org_id = a and not is_demo and active) >= 1
    and (select count(*) from public.inventory_items where org_id = a and not is_demo and active) >= 1
    and (select count(*) from public.leads where org_id = a and clean_archived_at is not null) = 0
    and (select count(*) from public.layouts where org_id = a and clean_archived_at is not null) = 0, r::text);
  perform pg_temp.res('23 restore: the app sees the lead again; journal stamped; 2nd restore = nothing',
    n = 1 and r2 ->> 'result' = 'nothing'
    and not exists (select 1 from public.studio_clean_start_items where org_id = a and restored_at is null), r2::text);
  perform pg_temp.res('24 restore: audit row', exists (select 1 from public.audit_log where org_id = a and action = 'trial.clean_start_restored'));
exception when others then perform pg_temp.su(); insert into _uf values ('3x restore', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) keep (default): sample untouched and still tagged; later "Delete all sample data" ----------
do $$ declare b uuid; r jsonb; d0 bigint; own0 bigint; s jsonb; begin
  b := pg_temp.trial('tu_b@t.test'); perform pg_temp.put('B', b::text);
  perform pg_temp.own(b, 'B');
  perform pg_temp.convert(b);
  d0 := pg_temp.demorows(b); own0 := pg_temp.ownrows(b);
  perform pg_temp.login('tu_b@t.test');
  r := public.upgrade_data_choice('keep');
  s := public.my_upgrade_status();
  perform pg_temp.su();
  perform pg_temp.res('25 keep: ok, every sample row stays is_demo (badge), own rows untouched',
    r ->> 'result' = 'ok' and pg_temp.demorows(b) = d0 and d0 > 0 and pg_temp.ownrows(b) = own0
    and (select upgrade_choice = 'keep' and demo_choice = 'keep' from public.organizations where id = b), r::text);
  perform pg_temp.res('26 keep: no prompt any more, sample still listed', not (s ->> 'pending')::boolean and (s ->> 'has_sample')::boolean, s::text);
  perform pg_temp.login('tu_b@t.test');
  r := public.delete_all_sample_data();
  s := public.my_upgrade_status();
  perform pg_temp.su();
  perform pg_temp.res('27 delete all sample data: is_demo rows gone, own rows identical',
    r ->> 'result' = 'ok' and pg_temp.ownrows(b) = own0
    and (select count(*) from public.quotes where org_id = b and is_demo) = 0
    and (select count(*) from public.leads where org_id = b and is_demo) = 0
    and not (s ->> 'has_sample')::boolean
    and (select count(*) from public.vendors where org_id = b and not is_demo and active) = 1, r::text || s::text);
  perform pg_temp.res('28 delete all sample data: audit row', exists (select 1 from public.audit_log where org_id = b and action = 'sample.deleted_all'));
exception when others then perform pg_temp.su(); insert into _uf values ('4x keep', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) remove_sample: own rows stay; a sample event you really used is kept as yours -------------
do $$ declare c uuid; r jsonb; own0 bigint; q uuid; begin
  c := pg_temp.trial('tu_c@t.test'); perform pg_temp.put('C', c::text);
  perform pg_temp.own(c, 'C');
  perform pg_temp.convert(c);
  -- an open (not closed) confirmed sample event with the least paid on it
  select x.id into q from public.quotes x where x.org_id = c and x.is_demo and x.status = 'confirmed'
     and not exists (select 1 from public.event_closure ec where ec.quote_id = x.id and ec.closed_at is not null)
   order by (select coalesce(sum(p.amount), 0) from public.quote_payments p where p.quote_id = x.id and p.status = 'paid'), x.code, x.id limit 1;
  perform pg_temp.put('CQ', q::text);
  insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, method, paid_at)
    values (q, c, 'manual', 1000, 'INR', 'paid', 'cash', now());
  own0 := pg_temp.ownrows(c);
  perform pg_temp.login('tu_c@t.test');
  r := public.upgrade_data_choice('remove_sample');
  perform pg_temp.su();
  perform pg_temp.res('29 remove_sample: ok, sample events gone except the one you used',
    r ->> 'result' = 'ok' and (r ->> 'kept_in_use')::int = 1
    and (select count(*) from public.quotes where org_id = c and is_demo) = 0
    and exists (select 1 from public.quotes where id = q and not is_demo), r::text);
  perform pg_temp.res('30 remove_sample: your payment on it is still there',
    exists (select 1 from public.quote_payments where quote_id = q and not is_demo and amount = 1000));
  perform pg_temp.res('31 remove_sample: every own row untouched (+1 adopted event)', pg_temp.ownrows(c) = own0 + 1
    and (select count(*) from public.vendors where org_id = c and not is_demo and active) = 1
    and (select count(*) from public.leads where org_id = c and not is_demo and clean_archived_at is null) >= 1
    and (select count(*) from public.leads where org_id = c and name = 'Own lead C') = 1
    and not exists (select 1 from public.studio_clean_start_items where org_id = c),
    pg_temp.ownrows(c)::text || ' vs ' || own0::text);
exception when others then perform pg_temp.su(); insert into _uf values ('5x remove', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) refusals: paid studio never a trial, ended trial, sample master; team-linked staff kept -----
do $$ declare e text; r jsonb; d uuid; u uuid; qc uuid; begin
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status, current_period_start, current_period_end, updated_at)
    values ('a0000000-0000-4000-8000-000000000001', 'active', current_date, current_date + 30, now())
    on conflict (org_id) do update set status = 'active', trial_ends_at = null, trial_source = null;
  update public.organizations set trial_mode = null where id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('a_admin@a.test');
  r := public.my_upgrade_status();
  e := pg_temp.try($q$select public.upgrade_data_choice('clean', 'START CLEAN')$q$);
  perform pg_temp.su();
  perform pg_temp.res('32 paid studio that never was a trial: no prompt, choice refused, nothing archived',
    not (r ->> 'pending')::boolean and not (r ->> 'was_trial')::boolean and e like '22023%'
    and (select archived_at is null from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01'), e || r::text);
  -- ended trial (read-only, not paid)
  d := pg_temp.trial('tu_d@t.test');
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() - interval '1 day' where id = d;
  update public.studio_subscriptions set status = 'past_due', current_period_end = null, trial_ends_at = current_date - 1 where org_id = d;
  perform pg_temp.login('tu_d@t.test');
  e := pg_temp.try($q$select public.upgrade_data_choice('remove_sample')$q$);
  r := public.my_upgrade_status();
  perform pg_temp.su();
  perform pg_temp.res('33 ended (unpaid) trial: refused, no prompt', e like '22023%' and not (r ->> 'pending')::boolean
    and pg_temp.demorows(d) > 0, e || r::text);
  -- the sample master is never a target
  u := pg_temp.newuser('tu_master@t.test');
  update public.profiles set org_id = 'a5a5a5a5-0166-4000-8000-000000000001', role = 'admin' where id = u;
  perform pg_temp.login('tu_master@t.test');
  e := pg_temp.try($q$select public.delete_all_sample_data()$q$);
  perform pg_temp.su();
  perform pg_temp.res('34 sample master: delete all sample data refused', e like '42501%', e);
  perform pg_temp.login('tu_master@t.test');
  e := pg_temp.try($q$select public.upgrade_data_choice('clean', 'START CLEAN')$q$);
  perform pg_temp.su();
  perform pg_temp.res('35 sample master: choice refused', e like '42501%' or e like '22023%', e);
  -- a staff row linked to a team login is never switched off by clean (studio E)
  d := pg_temp.trial('tu_e@t.test'); perform pg_temp.own(d, 'E');
  u := pg_temp.newuser('tu_e_crew@t.test'); update public.profiles set org_id = d, role = 'manager' where id = u;
  update public.crew_members set profile_id = u where org_id = d and name = 'Own staff E';
  -- the CLOSED sample event gets a photo the studio uploaded: clean adopts it, then archives it (kept)
  select q.id into qc from public.quotes q join public.event_closure c on c.quote_id = q.id
   where q.org_id = d and q.is_demo and c.closed_at is not null limit 1;
  insert into public.event_media(quote_id, org_id, kind, url) values (qc, d, 'photo', 'https://example.com/p.jpg');
  perform pg_temp.convert(d);
  perform pg_temp.login('tu_e@t.test');
  r := public.upgrade_data_choice('clean', 'START CLEAN');
  perform pg_temp.su();
  perform pg_temp.res('36 clean keeps a staff row linked to a team login active',
    r ->> 'result' = 'ok' and (select active from public.crew_members where org_id = d and name = 'Own staff E'), r::text);
  perform pg_temp.res('36b a closed sample event you added a photo to is adopted, archived and kept',
    qc is not null and (r ->> 'kept_in_use')::int = 1
    and exists (select 1 from public.quotes where id = qc and not is_demo and archived_at is not null)
    and exists (select 1 from public.event_media where quote_id = qc), r::text);
  -- a suspended studio is read-only: restore is refused and nothing moves
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'suspended' where org_id = d;
  perform pg_temp.login('tu_e@t.test');
  e := pg_temp.try($q$select public.restore_clean_start()$q$);
  perform pg_temp.su();
  perform pg_temp.res('36c suspended studio: restore refused (read-only), archive unchanged',
    e like '25006%' and exists (select 1 from public.studio_clean_start_items where org_id = d and restored_at is null)
    and exists (select 1 from public.quotes where id = qc and archived_at is not null), e);
exception when others then perform pg_temp.su(); insert into _uf values ('6x refuse', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) structure: privileges, RLS, no destructive SQL in the new code ----------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('37 internal helpers not callable by the app',
    not has_function_privilege('authenticated', 'public._tu185_archive_own(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._tu185_restore_own(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._tu185_adopt_used_samples(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.upgrade_data_choice(text, text)', 'execute')
    and has_function_privilege('authenticated', 'public.upgrade_data_choice(text, text)', 'execute'));
  perform pg_temp.res('38 journal table: RLS on, no app grants, read-only guard',
    (select relrowsecurity from pg_class where oid = 'public.studio_clean_start_items'::regclass)
    and exists (select 1 from pg_trigger where tgrelid = 'public.studio_clean_start_items'::regclass and tgname = 'zzz_studio_read_only')
    and not has_table_privilege('authenticated', 'public.studio_clean_start_items', 'select')
    and not has_table_privilege('anon', 'public.studio_clean_start_items', 'select'));
  perform pg_temp.res('39 restrictive archive policy on leads / nurture / layouts',
    (select count(*) from pg_policies where policyname = 'helm_clean_archive_185' and permissive = 'RESTRICTIVE'
       and tablename in ('leads', 'nurture', 'layouts')) = 3);
  perform pg_temp.res('40 the new functions never DELETE / TRUNCATE themselves',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and (p.proname like '\_tu185\_%' or p.proname in ('my_upgrade_status', 'upgrade_data_choice',
                        'delete_all_sample_data', 'restore_clean_start'))
                   and (p.prosrc ~* '\mdelete\s+from\M' or p.prosrc ~* '\mtruncate\M')));
exception when others then perform pg_temp.su(); insert into _uf values ('7x structure', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-UPGRADE-0185: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-UPGRADE-0185: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
