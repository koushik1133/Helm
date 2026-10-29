-- trial-seed-0222.sql -- 0222 (live QA round 19, L6): re-pricing alerts skip sample data, confirmed events and
-- client-approved / paid quotes; the sample master's open quotes are priced at its own Control Center chair rate
-- (the confirmed events' sample money follows), one new manifest; a NEW trial gets no price_change alert and no
-- stale chair rate; existing bell rows are never touched. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
select set_config('helm.maintenance', 'off', false);
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
create or replace function pg_temp.pc(p_org uuid) returns integer language sql as $$
  select count(*)::int from public.notifications where org_id = p_org and kind = 'price_change' $$;
create or replace function pg_temp.pcq(p_code text) returns integer language sql as $$
  select count(*)::int from public.notifications n join public.quotes q on q.id = n.quote_id
   where q.code = p_code and n.kind = 'price_change' $$;

-- earlier suites re-apply 0077 / 0082 (the alert body): re-run 0222 (its once-step is a no-op by its marker)
\ir ../../supabase/migrations/0222_trial_seed_r20.sql

-- ---- the alert function ---------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 alert body carries the 0222 marker + keeps the 0082 rules; security definer, empty search_path',
    position('trial-seed-0222' in p.prosrc) > 0 and position('r4-0082' in p.prosrc) > 0 and position('deleted_at is null' in p.prosrc) > 0
    and p.prosecdef and 'search_path=""' = any(p.proconfig))
    from pg_proc p where p.oid = 'public._r3_price_change_notify(uuid,text,text[],text)'::regprocedure;
  perform pg_temp.res('02 helpers internal (no anon / authenticated execute)',
    not has_function_privilege('authenticated', 'public._r3_price_change_notify(uuid,text,text[],text)', 'execute')
    and not has_function_privilege('anon', 'public._r3_price_change_notify(uuid,text,text[],text)', 'execute')
    and not has_function_privilege('authenticated', 'public._a222_manifest_note()', 'execute')
    and not has_function_privilege('anon', 'public._a222_manifest_note()', 'execute'));
end $$;

-- ---- the sample master ------------------------------------------------------------------------------------------
do $$ declare M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; r numeric; begin
  perform pg_temp.su();
  select (value ->> 'chairPrice')::numeric into r from public.app_config where org_id = M and key = 'pricing';
  perform pg_temp.res('03 master: every open sample quote is priced at the studio chair rate (100)',
    r = 100 and not exists (select 1 from public.quotes q where q.org_id = M and q.deleted_at is null
                              and coalesce(q.lifecycle_stage, '') not in ('settlement', 'closed')
                              and (q.pricing ->> 'chairPrice')::numeric is distinct from r),
    (select string_agg(code || '=' || coalesce(pricing ->> 'chairPrice', '-'), ',' order by code) from public.quotes where org_id = M));
  perform pg_temp.res('04 master: the closed SMP-1000 keeps its settled price (45 / 399725)',
    (select pricing ->> 'chairPrice' || '/' || (pricing ->> 'total') from public.quotes where org_id = M and code = 'SMP-1000') = '45/399725');
  perform pg_temp.res('05 master: D8 totals at chair 100 (SMP-1001 817150, SMP-1002 409460, SMP-1003 283200, SMP-1005 424800, SMP-1006 150450)',
    (select string_agg(code || '=' || (pricing ->> 'total'), ',' order by code) from public.quotes
      where org_id = M and code in ('SMP-1001', 'SMP-1002', 'SMP-1003', 'SMP-1005', 'SMP-1006'))
      = 'SMP-1001=817150,SMP-1002=409460,SMP-1003=283200,SMP-1005=424800,SMP-1006=150450',
    (select string_agg(code || '=' || (pricing ->> 'total'), ',' order by code) from public.quotes where org_id = M));
  perform pg_temp.res('06 master: confirmed events - milestones add up to the total, 30 % advance paid = the simulated payment',
    not exists (select 1 from public.quotes q where q.org_id = M and q.status = 'confirmed'
                  and ((select sum(amount) from public.payment_milestones pm where pm.quote_id = q.id) <> (q.pricing ->> 'total')::numeric
                    or (select amount from public.payment_milestones pm where pm.quote_id = q.id and pm.seq = 1 and pm.status = 'paid')
                       <> round((q.pricing ->> 'total')::numeric * 0.3)
                    or (select sum(amount) from public.quote_payments p where p.quote_id = q.id and p.simulated and p.amount = round((q.pricing ->> 'total')::numeric * 0.3)) is null)
                  and q.code <> 'SMP-1000'));
  -- (earlier suites may leave their own price_change rows on the master; 0222 never writes app_config)
  perform pg_temp.res('07 master: never consent-stale, no "client must approve again" bell row from the re-price',
    not exists (select 1 from public.quotes where org_id = M and coalesce(consent_stale, false))
    and not exists (select 1 from public.notifications where org_id = M and kind = 'reapproval_required'));
  perform pg_temp.res('08 the 0222 manifest was published once and is current (or a later one), quotes at chair 100',
    (select count(*) from public.helm_trial_seed_manifest where notes = public._a222_manifest_note()) = 1
    and exists (select 1 from public.helm_trial_seed_manifest c where c.is_current
                  and c.version >= (select m.version from public.helm_trial_seed_manifest m where m.notes = public._a222_manifest_note())
                  and (select count(*) from jsonb_array_elements(c.payload #> '{tables,quotes}') e(j)
                        where e.j ->> 'code' in ('SMP-1001', 'SMP-1002', 'SMP-1003', 'SMP-1005', 'SMP-1006')
                          and e.j #>> '{pricing,chairPrice}' = '100') = 5));
exception when others then perform pg_temp.su(); insert into _uf values ('0x master', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- re-run: nothing changes (marker), no second manifest ---------------------------------------------------------
do $$ declare n0 int; t0 text; begin
  perform pg_temp.su();
  select count(*) into n0 from public.helm_trial_seed_manifest;
  select string_agg(code || '=' || (pricing ->> 'total'), ',' order by code) into t0 from public.quotes where org_id = 'a5a5a5a5-0166-4000-8000-000000000001';
  perform pg_temp.put('n0', n0::text); perform pg_temp.put('t0', t0);
end $$;
\ir ../../supabase/migrations/0222_trial_seed_r20.sql
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('09 re-run: no new manifest, master quotes unchanged',
    (select count(*) from public.helm_trial_seed_manifest)::text = pg_temp.get('n0')
    and (select string_agg(code || '=' || (pricing ->> 'total'), ',' order by code) from public.quotes
          where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = pg_temp.get('t0'));
end $$;

-- ---- a NEW trial: no re-pricing alert, no stale chair rate ----------------------------------------------------
do $$ declare t uuid; r numeric; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  t := pg_temp.trial('ts222_new@t.test'); perform pg_temp.put('T', t::text);
  perform pg_temp.res('10 new trial: the sample was copied (7 sample events)',
    (select count(*) from public.quotes where org_id = t and is_demo) = 7);
  perform pg_temp.res('11 new trial: NO price_change bell row (was one per sample quote SMP-1001 .. SMP-1006)',
    pg_temp.pc(t) = 0, pg_temp.pc(t)::text);
  select public._r3_num(value, 'chairPrice') into r from public.app_config where org_id = t and key = 'pricing';
  perform pg_temp.res('12 new trial: every open sample quote is priced at the trial''s own chair rate (no "Chair rate" drift)',
    r = 100 and not exists (select 1 from public.quotes q where q.org_id = t and q.is_demo
                              and coalesce(q.lifecycle_stage, '') not in ('settlement', 'closed')
                              and public._r3_num(q.pricing, 'chairPrice') is distinct from r),
    (select string_agg(code || '=' || coalesce(pricing ->> 'chairPrice', '-'), ',' order by code) from public.quotes where org_id = t));
  -- the owner changes the Control Center chair rate in the trial: the sample quotes stay quiet
  perform pg_temp.login('ts222_new@t.test');
  -- r59 (0300): the pricing row is changed through set_pricing_config (a direct API write is refused)
  perform public.set_pricing_config((select value from public.app_config where key = 'pricing' and org_id = t) || '{"chairPrice":130}'::jsonb);
  perform pg_temp.su();
  perform pg_temp.res('13 new trial: a chair-rate change alerts no sample quote',
    pg_temp.pc(t) = 0, pg_temp.pc(t)::text);
exception when others then perform pg_temp.su(); insert into _uf values ('1x new trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- a paid studio: open quotes still alerted; confirmed / approved / paid ones are not --------------------------
do $$ declare a constant uuid := 'a0000000-0000-4000-8000-000000000001'; old_id uuid; begin
  perform pg_temp.su();
  insert into public.app_config(org_id, key, value) values (a, 'pricing', '{"chairPrice":200,"platePrice":500,"gstPct":18,"serviceChargePct":0}')
    on conflict (org_id, key) do update set value = excluded.value;
  insert into public.quotes(code, title, status, lifecycle_stage, event_date, pricing, org_id, approval_status) values
    ('R22-OPEN', 'open', 'quote', 'quote', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a, 'none'),
    ('R22-SENT', 'sent', 'quote', 'quote', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a, 'sent'),
    ('R22-APPR', 'approved', 'quote', 'quote', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a, 'approved'),
    ('R22-CONF', 'confirmed', 'confirmed', 'planning', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a, 'paid'),
    ('R22-PAID', 'paid not confirmed', 'quote', 'quote', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a, 'paid'),
    ('R22-PKG', 'package open', 'quote', 'quote', current_date + 40, '{"guests":50,"platePrice":900,"_packageName":"Gold R22","subtotal":45000,"discount":0,"gstPct":18,"total":53100}', a, 'none'),
    ('R22-PKGC', 'package confirmed', 'confirmed', 'planning', current_date + 40, '{"guests":50,"platePrice":900,"_packageName":"Gold R22","subtotal":45000,"discount":0,"gstPct":18,"total":53100}', a, 'paid');
  insert into public.menu_templates(tier, diet, name, price_per_plate, org_id) values ('gold', 'veg', 'Gold R22', 900, a);
  -- an older alert on the confirmed quote (from before 0222): it must stay
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    select id, 'in_app', 'price_change', 'sent', '{"source":"pricing","fields":["gstPct"]}'::jsonb, a from public.quotes where code = 'R22-CONF'
    returning id into old_id;
  perform pg_temp.put('old', old_id::text);
  update public.app_config set value = value || '{"chairPrice":250}'::jsonb where org_id = a and key = 'pricing';
  perform pg_temp.res('14 paid studio: an open quote (and a sent, not yet approved one) is still alerted',
    pg_temp.pcq('R22-OPEN') = 1 and pg_temp.pcq('R22-SENT') = 1, pg_temp.pcq('R22-OPEN') || '/' || pg_temp.pcq('R22-SENT'));
  perform pg_temp.res('15 paid studio: a client-approved, a paid and a confirmed quote get no new alert (the confirmed one keeps only its older row)',
    pg_temp.pcq('R22-APPR') = 0 and pg_temp.pcq('R22-PAID') = 0 and pg_temp.pcq('R22-CONF') = 1,
    pg_temp.pcq('R22-APPR') || '/' || pg_temp.pcq('R22-PAID') || '/' || pg_temp.pcq('R22-CONF'));
  update public.menu_templates set price_per_plate = 950 where org_id = a and name = 'Gold R22';
  perform pg_temp.res('16 menu package price change: the open package quote is alerted, the confirmed one is not',
    pg_temp.pcq('R22-PKG') = 1 and pg_temp.pcq('R22-PKGC') = 0, pg_temp.pcq('R22-PKG') || '/' || pg_temp.pcq('R22-PKGC'));
  perform pg_temp.res('17 an existing alert is never changed or deleted',
    exists (select 1 from public.notifications where id = pg_temp.get('old')::uuid and kind = 'price_change'
              and detail = '{"source":"pricing","fields":["gstPct"]}'::jsonb));
  perform pg_temp.res('18 the quote prices themselves are never changed by an alert',
    (select pricing ->> 'chairPrice' from public.quotes where code = 'R22-OPEN') = '200'
    and (select pricing ->> 'total' from public.quotes where code = 'R22-CONF') = '23600');
exception when others then perform pg_temp.su(); insert into _uf values ('1x paid studio', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-SEED-0222: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-SEED-0222: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
