-- r29-referrals-0279.sql -- r29 referral program: personal codes, partner / marketing codes, one code per new studio,
-- attribution (typed beats link, last link 60 days, support within 14 days before the first payment), server-side fraud
-- checks (hard match -> rejected, soft -> review, 3+ -> rejected, velocity, throw-away e-mail), the 14-day hold after the
-- first real payment, refund / chargeback / cancel before and after the hold, monthly (renewal billed 0) + yearly
-- (renewal +1 month) free months, stacking, the 12-in-12-months cap, trial referrer (held, 6 months), referrer cancels
-- (frozen, back within 6 months), 24-month expiry, reversal write-off (never charged, flagged), HQ roles + audit,
-- RLS isolation. Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- re-apply 0279 twice inside the test (later suites may re-apply older bodies; also proves a re-run is safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0279_referral_program.sql
\ir ../../supabase/migrations/0279_referral_program.sql
set client_min_messages = warning;
create temp table _rr(name text, result text); grant all on _rr to anon, authenticated, service_role;
create temp table _rk(k text primary key, v text); grant all on _rk to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text, p_ip text default null) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  if p_ip is not null then perform set_config('request.headers', jsonb_build_object('x-forwarded-for', p_ip)::text, false); end if;
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op(p_email text default 'admin@helm.events', p_aal text default 'aal2') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon(p_ip text default null) returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  if p_ip is not null then perform set_config('request.headers', jsonb_build_object('x-forwarded-for', p_ip)::text, false); end if;
  perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rr values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rk values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rk where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_org uuid default null, p_role text default 'admin') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role, email = p_email;
  return u;
end $$;
-- a new free-trial studio made by p_email
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('R29 ' || split_part(p_email, '@', 1), 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- HQ records a payment + activates the plan (the one path that makes a studio paying, 0244)
create or replace function pg_temp.pay(p_org uuid, p_amt numeric, p_interval text default 'monthly', p_plan text default 'studio') returns jsonb language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.op();
  r := public.hq_activate_plan(p_org, p_plan, p_interval, p_amt, 'upi', current_date, current_date, 'R29-' || p_amt || '-' || left(p_org::text, 8), 'INR', null);
  perform pg_temp.su(); return r;
end $$;
-- a new studio signs up with a code (typed), optionally from a network / device
create or replace function pg_temp.referred(p_email text, p_code text, p_consent boolean default false, p_ip text default null, p_device text default null)
returns uuid language plpgsql as $$
declare o uuid; r jsonb; begin
  o := pg_temp.trial(p_email); perform pg_temp.login(p_email, p_ip);
  r := public.referral_attach(p_code, null, null, p_consent, p_device);
  perform pg_temp.su(); perform pg_temp.put('att:' || p_email, r::text); return o;
end $$;
create or replace function pg_temp.endhold(p_org uuid) returns void language plpgsql as $$
begin perform pg_temp.su(); update public.referrals set hold_until = now() - interval '1 minute' where referred_org = p_org; end $$;
create or replace function pg_temp.tick() returns jsonb language plpgsql as $$
begin perform pg_temp.su(); return public.referral_tick(); end $$;
create or replace function pg_temp.st(p_org uuid) returns text language sql as $$ select status from public.referrals where referred_org = p_org $$;
create or replace function pg_temp.rsn(p_org uuid) returns text language sql as $$ select reason from public.referrals where referred_org = p_org $$;
create or replace function pg_temp.rw(p_studio uuid, p_state text) returns int language sql as $$
  select count(*)::int from public.referral_rewards where studio_id = p_studio and state = p_state $$;
create or replace function pg_temp.pe(p_org uuid) returns date language sql as $$ select current_period_end from public.studio_subscriptions where org_id = p_org $$;
create or replace function pg_temp.code(p_email text) returns text language plpgsql as $$
declare r jsonb; begin perform pg_temp.login(p_email); r := public.my_referral('dev-' || md5(p_email)); perform pg_temp.su(); return r ->> 'code'; end $$;

-- ---- setup ----------------------------------------------------------------------------------------------------------------
do $$ declare a uuid; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'admin@helm.events';
  update public.helm_sample_template set active = true where id;
  update public.referral_settings set program_on = false where id;
  a := pg_temp.trial('ra@r29a.test'); perform pg_temp.put('A', a::text);
end $$;

-- ---- 01 tables + grants --------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01a every referral table has RLS on',
    (select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in
      ('referral_settings','referral_codes','referral_click_days','referral_rate_buckets','referrals','referral_rewards',
       'referral_reward_events','referral_fingerprints','referral_notice_queue')) and
    (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'referral%' and c.relkind = 'r') = 9);
  perform pg_temp.res('01b no API role can write any referral table; anon can read none',
    not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name like 'referral%'
                 and g.grantee in ('anon', 'authenticated') and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
    and not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name like 'referral%' and g.grantee = 'anon'));
  perform pg_temp.res('01c grants: lookup / click public; studio + HQ RPCs signed-in only; tick + helpers nobody',
    has_function_privilege('anon', 'public.referral_lookup(text)', 'execute') and has_function_privilege('anon', 'public.referral_click(text)', 'execute')
    and not has_function_privilege('anon', 'public.my_referral(text)', 'execute')
    and not has_function_privilege('anon', 'public.referral_attach(text,text,timestamptz,boolean,text)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_referrals(text,text,integer,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.referral_tick()', 'execute')
    and not has_function_privilege('anon', 'public.referral_tick()', 'execute')
    and has_function_privilege('service_role', 'public.referral_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public._r29_qualify(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r29_attach(uuid,text,text,boolean,text,timestamptz,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.referral_payment_fingerprint(uuid,text,text)', 'execute'));
  perform pg_temp.res('01d the program starts switched OFF; triggers on payments + subscriptions',
    exists (select 1 from pg_trigger where tgname = 'r29_payment' and tgrelid = 'public.subscription_payments'::regclass)
    and exists (select 1 from pg_trigger where tgname = 'r29_subscription' and tgrelid = 'public.studio_subscriptions'::regclass));
exception when others then perform pg_temp.su(); insert into _rr values ('01x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 02 program off ------------------------------------------------------------------------------------------------------
do $$ declare r jsonb; l jsonb; begin
  perform pg_temp.login('ra@r29a.test'); r := public.my_referral(null);
  perform pg_temp.anon(); l := public.referral_lookup('ANYCODE-1');
  perform pg_temp.su();
  perform pg_temp.res('02 program off: the studio page says off, no code made; look-up says off/unknown',
    r = '{"program_on": false}'::jsonb and not exists (select 1 from public.referral_codes) and l ->> 'ok' = 'false', r::text || l::text);
  update public.referral_settings set program_on = true where id;
exception when others then perform pg_temp.su(); insert into _rr values ('02x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 03 the studio code ---------------------------------------------------------------------------------------------------
do $$ declare r1 jsonb; r2 jsonb; e text; a uuid := pg_temp.get('A')::uuid; begin
  perform pg_temp.login('ra@r29a.test'); r1 := public.my_referral('dev-aaaaaaaa1'); r2 := public.my_referral('dev-aaaaaaaa1');
  perform pg_temp.su(); perform pg_temp.put('codeA', r1 ->> 'code');
  perform pg_temp.newuser('ra_mgr@r29a.test', a, 'manager'); perform pg_temp.login('ra_mgr@r29a.test');
  e := pg_temp.try('select public.my_referral(null)');
  perform pg_temp.su();
  perform pg_temp.res('03a admin gets ONE code: STUDIO-NAME (max 8) + 4 safe characters, the same on every call',
    r1 ->> 'code' ~ '^[A-Z0-9]{2,8}-[2-9A-HJKMNP-Z]{4}$' and r1 ->> 'code' = r2 ->> 'code' and r1 ->> 'link_path' = '/r/' || (r1 ->> 'code')
    and (select count(*) from public.referral_codes where studio_id = a) = 1, r1::text);
  perform pg_temp.res('03b a teammate who is not the admin is refused', e like '42501%', e);
  perform pg_temp.res('03c the referrer''s device is kept hashed only (never the raw value)',
    exists (select 1 from public.referral_fingerprints f where f.studio_id = a and f.kind = 'device')
    and not exists (select 1 from public.referral_fingerprints f where f.hash like '%aaaaaaaa%'));
exception when others then perform pg_temp.su(); insert into _rr values ('03x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 04-06 public look-up, rate limit, clicks -------------------------------------------------------------------------------
do $$ declare l jsonb; u jsonb; s jsonb; i int; v jsonb; c text := pg_temp.get('codeA'); begin
  perform pg_temp.anon('198.51.100.7');
  l := public.referral_lookup(lower(c)); u := public.referral_lookup('NOPE-ZZZZ'); s := public.referral_lookup('a');
  perform pg_temp.su();
  perform pg_temp.res('04a look-up: a valid studio code -> referral + offer, never who owns it',
    l ->> 'ok' = 'true' and l ->> 'kind' = 'referral' and l ->> 'offer' = '1 free month after your first payment'
    and position('R29 ra' in l::text) = 0 and not l ? 'studio_id' and not l ? 'studio', l::text);
  perform pg_temp.res('04b look-up: unknown code / bad shape', u ->> 'reason' = 'unknown' and s ->> 'reason' = 'shape', u::text || s::text);
  perform pg_temp.anon('198.51.100.8');
  for i in 1..61 loop v := public.referral_lookup(c); end loop;
  perform pg_temp.su();
  perform pg_temp.res('05 look-up is rate limited per network (61st in an hour refused)', v ->> 'reason' = 'rate', v::text);
  perform pg_temp.anon('198.51.100.9');
  for i in 1..5 loop perform public.referral_click(c); end loop;
  perform public.referral_click('NOPE-ZZZZ');
  perform pg_temp.su();
  perform pg_temp.res('06 clicks: a number per code per day only, 3 per network per hour counted, unknown codes ignored',
    (select sum(clicks) from public.referral_click_days where code = c) = 3
    and not exists (select 1 from public.referral_click_days where code = 'NOPE-ZZZZ'));
exception when others then perform pg_temp.su(); insert into _rr values ('04x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 07 attach with a typed code + 10 one code per studio + 11 self-referral ------------------------------------------------
do $$ declare b uuid; a uuid := pg_temp.get('A')::uuid; c text := pg_temp.get('codeA'); r jsonb; e jsonb; s jsonb; begin
  b := pg_temp.referred('rb@r29b.test', c, true); perform pg_temp.put('B', b::text);
  r := pg_temp.get('att:rb@r29b.test')::jsonb;
  perform pg_temp.res('07a sign-up with a typed code: attached, on trial, via typed, consent kept, the offer shown',
    r ->> 'ok' = 'true' and pg_temp.st(b) = 'trial' and (select via from public.referrals where referred_org = b) = 'typed'
    and (select consent_name from public.referrals where referred_org = b) and r ->> 'offer' = '1 free month after your first payment', r::text);
  perform pg_temp.res('07b the referrer gets ONE bell notice (admin-only kind) + ONE queued e-mail (dormant); uses counted',
    (select count(*) from public.notifications n where n.org_id = a and n.kind = 'trial_reminder' and n.detail ->> 'source' = 'r29_referral') = 1
    and (select count(*) from public.referral_notice_queue q where q.studio_id = a and q.kind = 'referral_signed_up' and q.status = 'queued') = 1
    and (select uses from public.referral_codes where code = c) = 1);
  perform pg_temp.login('rb@r29b.test'); e := public.referral_attach(c, null, null, false, null); perform pg_temp.su();
  perform pg_temp.res('10 one code per studio: a second attach is refused (duplicate)', e ->> 'reason' = 'duplicate', e::text);
  perform pg_temp.login('ra@r29a.test'); s := public.referral_attach(c, null, null, false, null); perform pg_temp.su();
  perform pg_temp.res('11 self-referral: a studio can never use its own code',
    s ->> 'ok' = 'false' and s ->> 'reason' in ('self_referral', 'code_after') and not exists (select 1 from public.referrals where referred_org = a), s::text);
exception when others then perform pg_temp.su(); insert into _rr values ('07x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 08-09 attribution: typed beats link; a link counts for 60 days ---------------------------------------------------------
do $$ declare o uuid; o2 uuid; o3 uuid; r jsonb; c text := pg_temp.get('codeA'); p jsonb; begin
  perform pg_temp.op(); p := public.hq_partner_code_upsert('{"name":"Attribution test","kind":"campaign","offer_type":"none"}'::jsonb);
  perform pg_temp.su(); perform pg_temp.put('codeP0', p ->> 'code');
  o := pg_temp.trial('rc1@r29c1.test'); perform pg_temp.login('rc1@r29c1.test');
  r := public.referral_attach(c, p ->> 'code', now() - interval '2 days', false, null); perform pg_temp.su();
  perform pg_temp.res('08 a typed code beats a clicked link', (select code || ':' || via from public.referrals where referred_org = o) = c || ':typed', r::text);
  o2 := pg_temp.trial('rc2@r29c2.test'); perform pg_temp.login('rc2@r29c2.test');
  r := public.referral_attach(null, p ->> 'code', now() - interval '61 days', false, null); perform pg_temp.su();
  perform pg_temp.res('09a a link clicked more than 60 days ago does not count', r ->> 'reason' = 'none' and not exists (select 1 from public.referrals where referred_org = o2), r::text);
  o3 := pg_temp.trial('rc3@r29c3.test'); perform pg_temp.login('rc3@r29c3.test');
  r := public.referral_attach('', p ->> 'code', now() - interval '59 days', false, null); perform pg_temp.su();
  perform pg_temp.res('09b the last link within 60 days counts (via link, click time kept)',
    (select via from public.referrals where referred_org = o3) = 'link' and (select link_clicked_at from public.referrals where referred_org = o3) is not null, r::text);
exception when others then perform pg_temp.su(); insert into _rr values ('08x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 12-16 fraud checks ---------------------------------------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; c text := pg_temp.get('codeA'); o uuid; d uuid; x uuid; y uuid; i int; z uuid; v text; begin
  -- 12 hard: the same phone as the referrer -> rejected at once, no bell
  perform pg_temp.su();
  insert into public.studio_account(org_id, primary_contact_phone) values (a, '+919876543210')
    on conflict (org_id) do update set primary_contact_phone = excluded.primary_contact_phone;
  o := pg_temp.trial('rh@r29h.test'); perform pg_temp.su();
  insert into public.studio_account(org_id, primary_contact_phone) values (o, '+919876543210')
    on conflict (org_id) do update set primary_contact_phone = excluded.primary_contact_phone;
  perform pg_temp.login('rh@r29h.test'); perform public.referral_attach(c, null, null, false, null); perform pg_temp.su();
  perform pg_temp.res('12 hard match (same phone) -> not qualified (self-referral) at sign-up, no bell to the referrer, the new studio keeps its trial',
    pg_temp.st(o) = 'not_qualified' and pg_temp.rsn(o) = 'self_referral'
    and (select flags from public.referrals where referred_org = o) ? 'Same phone number'
    and not exists (select 1 from public.referral_notice_queue q join public.referrals r on r.id = q.ref_id where r.referred_org = o)
    and (select status from public.studio_subscriptions where org_id = o) = 'trial', (select flags::text from public.referrals where referred_org = o));
  -- 13 soft: the same device (2 points) -> review; HQ approves -> back on trial
  d := pg_temp.referred('rd@r29d.test', c, false, null, 'dev-aaaaaaaa1'); perform pg_temp.put('D', d::text);
  perform pg_temp.res('13a same device (2 points) -> Needs review', pg_temp.st(d) = 'review' and (select score from public.referrals where referred_org = d) = 2,
    pg_temp.st(d) || ' ' || coalesce((select flags::text from public.referrals where referred_org = d), ''));
  -- 14 device + same network = 3 points -> rejected
  perform pg_temp.login('ra@r29a.test', '203.0.113.50'); perform public.my_referral('dev-' || md5('ra@r29a.test')); perform pg_temp.su();
  x := pg_temp.referred('rx@r29x.test', c, false, '203.0.113.50', 'dev-' || md5('ra@r29a.test'));
  perform pg_temp.res('14 device + network (3 points) -> rejected', pg_temp.st(x) = 'not_qualified' and pg_temp.rsn(x) = 'self_referral'
    and (select score from public.referrals where referred_org = x) = 3);
  -- the rest of this suite: A's sign-ups spread out over past days (one test burst is not a real burst)
  perform pg_temp.su();
  update public.referrals r set signed_up_at = now() - make_interval(days => 2 * q.n::int)
    from (select x.id, row_number() over (order by x.created_at) n from public.referrals x where x.code = c) q where q.id = r.id;
  -- 15 throw-away e-mail -> review
  y := pg_temp.referred('ry@mailinator.com', c);
  perform pg_temp.res('15 throw-away e-mail service (2 points) -> Needs review', pg_temp.st(y) = 'review'
    and (select flags from public.referrals where referred_org = y) ? 'Throw-away e-mail service', coalesce(pg_temp.st(y), 'none') || ' ' || coalesce(pg_temp.get('att:ry@mailinator.com'), ''));
  -- 16 velocity: more than 5 sign-ups on one code in 24 hours -> flagged (a separate referrer V)
  perform pg_temp.trial('rvv@r29vv.test'); v := pg_temp.code('rvv@r29vv.test');
  for i in 1..6 loop z := pg_temp.referred('rv' || i || '@r29v' || i || '.test', v); if i = 5 then perform pg_temp.put('V5', z::text); end if; end loop;
  perform pg_temp.res('16 velocity: the 6th sign-up on one code in 24 hours is flagged for review (the 5th is not)',
    pg_temp.st(z) = 'review' and (select flags::text from public.referrals where referred_org = z) like '%Many sign-ups%'
    and pg_temp.st(pg_temp.get('V5')::uuid) = 'trial',
    (select count(*)::text from public.referrals where code = v) || ' ' || coalesce(pg_temp.st(z), ''));
exception when others then perform pg_temp.su(); insert into _rr values ('12x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 17-18 late codes + existing customers -----------------------------------------------------------------------------------
do $$ declare o uuid; o2 uuid; o3 uuid; o4 uuid; r jsonb; s jsonb; t jsonb; w jsonb; c text := pg_temp.get('codeA'); begin
  o := pg_temp.trial('rl@r29l.test'); perform pg_temp.su();
  update public.organizations set created_at = now() - interval '3 days' where id = o;
  perform pg_temp.login('rl@r29l.test'); r := public.referral_attach(c, null, null, false, null); perform pg_temp.su();
  perform pg_temp.res('17a the studio itself cannot add a code after its first 48 hours', r ->> 'reason' = 'code_after', r::text);
  perform pg_temp.op(); s := public.hq_referral_attach(o, c, 'forgot at sign-up'); perform pg_temp.su();
  perform pg_temp.res('17b support adds it within 14 days of sign-up (via support, audited)',
    s ->> 'ok' = 'true' and (select via from public.referrals where referred_org = o) = 'support'
    and exists (select 1 from public.audit_log l where l.action = 'hq.referral.attach' and l.entity_id = o::text), s::text);
  o2 := pg_temp.trial('rl2@r29l2.test'); perform pg_temp.su(); update public.organizations set created_at = now() - interval '15 days' where id = o2;
  perform pg_temp.op(); t := public.hq_referral_attach(o2, c, null); perform pg_temp.su();
  o3 := pg_temp.trial('rl3@r29l3.test'); perform pg_temp.pay(o3, 4999);
  perform pg_temp.op(); w := public.hq_referral_attach(o3, c, null); perform pg_temp.su();
  perform pg_temp.res('17c support: never after 14 days, never after the first payment',
    t ->> 'reason' = 'code_after' and w ->> 'reason' = 'code_after'
    and not exists (select 1 from public.referrals where referred_org in (o2, o3)), t::text || w::text);
  -- 18 the creator had another free trial in the last 12 months -> existing customer, not qualified
  o4 := pg_temp.trial('re@r29e.test'); perform pg_temp.su();
  insert into public.trial_grants(org_id, user_id, email_hash, source, started_at, recorded_how)
    values (pg_temp.get('A')::uuid, null, public._trial_email_fingerprint('re@r29e.test'), 'trial', now() - interval '3 months', 'trigger')
    on conflict (org_id) do nothing;
  if not exists (select 1 from public.trial_grants g where g.email_hash = public._trial_email_fingerprint('re@r29e.test') and g.org_id <> o4) then
    insert into public.trial_grants(org_id, user_id, email_hash, source, started_at, recorded_how)
      values (pg_temp.get('B')::uuid, null, public._trial_email_fingerprint('re@r29e.test'), 'trial', now() - interval '3 months', 'trigger')
      on conflict (org_id) do update set email_hash = excluded.email_hash;
  end if;
  perform pg_temp.login('re@r29e.test'); perform public.referral_attach(c, null, null, false, null); perform pg_temp.su();
  perform pg_temp.res('18 an earlier Helm customer (another trial in 12 months) -> not qualified (existing)',
    pg_temp.st(o4) = 'not_qualified' and pg_temp.rsn(o4) = 'existing', coalesce(pg_temp.st(o4), 'none'));
exception when others then perform pg_temp.su(); insert into _rr values ('17x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 19-22 first payment -> hold -> refund / cancel / confirmed -----------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; b uuid := pg_temp.get('B')::uuid; c text := pg_temp.get('codeA');
  f uuid; g uuid; t jsonb; v_pay uuid; begin
  -- A pays (monthly) so A is a paying referrer
  perform pg_temp.pay(a, 4999, 'monthly');
  -- B pays: the hold starts
  perform pg_temp.pay(b, 1999, 'monthly', 'starter');
  perform pg_temp.res('19a the first real payment starts the 14-day hold',
    pg_temp.st(b) = 'hold' and (select hold_until from public.referrals where referred_org = b) between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour'
    and (select first_payment_id from public.referrals where referred_org = b) is not null, coalesce(pg_temp.st(b), ''));
  t := pg_temp.tick();
  perform pg_temp.res('19b before the hold ends nothing is confirmed', pg_temp.st(b) = 'hold' and pg_temp.rw(a, 'scheduled') = 0, t::text);
  -- 20 refund before the hold ends
  f := pg_temp.referred('rf@r29f.test', c); perform pg_temp.pay(f, 1999, 'monthly', 'starter');
  select id into v_pay from public.subscription_payments where org_id = f;
  perform pg_temp.op(); perform public.hq_void_payment(v_pay, 'refund requested'); perform pg_temp.su();
  perform pg_temp.endhold(f); perform pg_temp.tick();
  perform pg_temp.res('20 refund (void) before the hold ends -> not qualified (refunded), no reward for anyone',
    pg_temp.st(f) = 'not_qualified' and pg_temp.rsn(f) = 'refunded' and not exists (select 1 from public.referral_rewards x join public.referrals r on r.id = x.referral_id where r.referred_org = f),
    coalesce(pg_temp.st(f), ''));
  -- 21 cancel before the hold ends
  g := pg_temp.referred('rg@r29g.test', c); perform pg_temp.pay(g, 1999, 'monthly', 'starter');
  perform pg_temp.op(); perform public.hq_set_subscription(g, null, 'cancelled', null, null, null, 'test cancel'); perform pg_temp.su();
  perform pg_temp.endhold(g); perform pg_temp.tick();
  perform pg_temp.res('21 cancelled before the hold ends -> not qualified (cancelled)', pg_temp.st(g) = 'not_qualified' and pg_temp.rsn(g) = 'cancelled',
    coalesce(pg_temp.st(g), ''));
  -- 22 B's hold is over -> confirmed: both sides get their month; A's renewal is far away so A's month waits
  perform pg_temp.endhold(b); perform pg_temp.put('peA0', pg_temp.pe(a)::text); t := pg_temp.tick();
  perform pg_temp.res('22a after the hold: qualified; the referrer has 1 upcoming month; the new studio 1 welcome month',
    pg_temp.st(b) = 'qualified' and pg_temp.rw(a, 'scheduled') = 1 and pg_temp.rw(b, 'scheduled') = 1
    and (select side from public.referral_rewards where studio_id = a) = 'referrer', t::text);
  perform pg_temp.res('22b a month is used only when the renewal is due (monthly): far renewal -> not yet',
    pg_temp.pe(a) = pg_temp.get('peA0')::date);
  perform pg_temp.res('22c bells: "you earned a free month" to the referrer, welcome to the new studio (queued e-mails too)',
    exists (select 1 from public.referral_notice_queue q where q.studio_id = a and q.kind = 'referral_qualified')
    and exists (select 1 from public.referral_notice_queue q where q.studio_id = b and q.kind = 'welcome_month')
    and exists (select 1 from public.notifications n where n.org_id = a and n.detail ->> 'label' = 'You earned a free month of Helm'));
exception when others then perform pg_temp.su(); insert into _rr values ('19x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 23-24 monthly: renewal billed 0, stacking ------------------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; c text := pg_temp.get('codeA'); h uuid; v_end date; t jsonb; begin
  -- a second referral confirmed -> 2 upcoming months
  h := pg_temp.referred('rk@r29k.test', c); perform pg_temp.pay(h, 1999, 'monthly', 'starter'); perform pg_temp.endhold(h);
  perform pg_temp.su();
  v_end := current_date + 3;
  update public.studio_subscriptions set current_period_end = v_end where org_id = a;
  insert into public.billing_reminders(org_id, kind, period_end) values (a, 'due_soon', v_end) on conflict do nothing;
  t := pg_temp.tick();
  perform pg_temp.res('23a monthly: the renewal that is due is free - the period moves one month, ONE month used (the next waits)',
    pg_temp.st(h) = 'qualified' and pg_temp.pe(a) = (v_end + interval '1 month')::date and pg_temp.rw(a, 'applied') = 1 and pg_temp.rw(a, 'scheduled') = 1,
    t::text || ' pe=' || pg_temp.pe(a));
  perform pg_temp.res('23b the used month records plan, currency (the studio''s own), value, USD list value, dates',
    exists (select 1 from public.referral_rewards x where x.studio_id = a and x.state = 'applied' and x.plan_code = 'studio' and x.currency = 'INR'
             and x.value_minor = 499900 and x.value_usd = 59 and x.applied_from = v_end + 1 and x.applied_to = (v_end + interval '1 month')::date));
  perform pg_temp.res('23c the "renews soon" reminder for the free renewal is kept as skipped (not sent)',
    (select channel from public.billing_reminders where org_id = a and kind = 'due_soon' and period_end = v_end) = 'skipped');
  t := pg_temp.tick();
  perform pg_temp.res('24a stacking: running the job again uses nothing more until the next renewal is due',
    pg_temp.rw(a, 'applied') = 1 and pg_temp.pe(a) = (v_end + interval '1 month')::date, t::text);
  perform pg_temp.su(); update public.studio_subscriptions set current_period_end = current_date + 2 where org_id = a;
  t := pg_temp.tick();
  perform pg_temp.res('24b stacking: the next renewal is free too (two months in a row), then billing starts again',
    pg_temp.rw(a, 'applied') = 2 and pg_temp.rw(a, 'scheduled') = 0 and pg_temp.pe(a) = (current_date + 2 + interval '1 month')::date, t::text);
  perform pg_temp.su(); update public.studio_subscriptions set current_period_end = current_date + 1 where org_id = h;
  perform pg_temp.put('peH', pg_temp.pe(h)::text); t := pg_temp.tick();
  perform pg_temp.res('24c the new studio''s welcome month: its next renewal is billed 0 too (period +1 month)',
    pg_temp.rw(h, 'applied') = 1 and pg_temp.pe(h) = (pg_temp.get('peH')::date + interval '1 month')::date
    and exists (select 1 from public.referral_rewards x where x.studio_id = h and x.side = 'referred' and x.plan_code = 'starter' and x.value_usd = 24), t::text);
exception when others then perform pg_temp.su(); insert into _rr values ('23x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 25 yearly: renewal date +1 month per reward, at once -----------------------------------------------------------------------
do $$ declare yy uuid; r1 uuid; r2 uuid; c text; v_end date; begin
  yy := pg_temp.trial('ryy@r29yy.test'); perform pg_temp.pay(yy, 49990, 'yearly'); perform pg_temp.put('YY', yy::text);
  c := pg_temp.code('ryy@r29yy.test');
  r1 := pg_temp.referred('ry1@r29y1.test', c); perform pg_temp.pay(r1, 1999, 'monthly', 'starter'); perform pg_temp.endhold(r1);
  r2 := pg_temp.referred('ry2@r29y2.test', c); perform pg_temp.pay(r2, 1999, 'monthly', 'starter'); perform pg_temp.endhold(r2);
  v_end := pg_temp.pe(yy);
  perform pg_temp.tick();
  perform pg_temp.res('25 yearly plan: each free month moves the renewal date one month later, at once (2 rewards = +2 months)',
    pg_temp.rw(yy, 'applied') = 2 and pg_temp.pe(yy) = (v_end + interval '2 months')::date
    and exists (select 1 from public.referral_rewards x where x.studio_id = yy and x.billing_interval = 'yearly' and x.value_minor = round(49990.0 / 12 * 100)),
    pg_temp.pe(yy)::text || ' was ' || v_end);
exception when others then perform pg_temp.su(); insert into _rr values ('25x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 26 the cap: 12 free months in any rolling 12 months -----------------------------------------------------------------------
do $$ declare yy uuid := pg_temp.get('YY')::uuid; r3 uuid; c text; i int; begin
  c := pg_temp.code('ryy@r29yy.test');
  perform pg_temp.su();
  for i in 1..10 loop
    insert into public.referral_rewards(studio_id, side, kind, state, earned_at) values (yy, 'referrer', 'month', 'applied', now() - make_interval(days => i * 20));
  end loop;
  insert into public.referral_rewards(studio_id, side, kind, state, earned_at) values (yy, 'referrer', 'month', 'applied', now() - interval '13 months');
  r3 := pg_temp.referred('ry3@r29y3.test', c); perform pg_temp.pay(r3, 1999, 'monthly', 'starter'); perform pg_temp.endhold(r3);
  perform pg_temp.tick();
  perform pg_temp.res('26 cap: with 12 earned in the last 12 months the next is "capped" - the new studio still gets its month; older than 12 months does not count',
    exists (select 1 from public.referral_rewards x join public.referrals r on r.id = x.referral_id where r.referred_org = r3 and x.studio_id = yy and x.state = 'capped')
    and exists (select 1 from public.referral_rewards x where x.studio_id = r3 and x.side = 'referred' and x.state = 'scheduled')
    and public._r29_earned_12m(yy) = 12, public._r29_earned_12m(yy)::text);
exception when others then perform pg_temp.su(); insert into _rr values ('26x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 27 trial referrer: held until their own first payment (max 6 months) ------------------------------------------------------
do $$ declare tr uuid; t1 uuid; t2 uuid; tr2 uuid; c text; c2 text; begin
  tr := pg_temp.trial('rtr@r29tr.test'); c := pg_temp.code('rtr@r29tr.test');
  t1 := pg_temp.referred('rt1@r29t1.test', c); perform pg_temp.pay(t1, 1999, 'monthly', 'starter'); perform pg_temp.endhold(t1);
  perform pg_temp.tick();
  perform pg_temp.res('27a a referrer still on trial: the earned month is held (6 months)',
    pg_temp.rw(tr, 'held') = 1 and (select held_until from public.referral_rewards where studio_id = tr) > now() + interval '5 months');
  perform pg_temp.pay(tr, 4999, 'monthly');
  perform pg_temp.res('27b the trial referrer pays -> the held month becomes upcoming', pg_temp.rw(tr, 'held') = 0 and pg_temp.rw(tr, 'scheduled') = 1);
  tr2 := pg_temp.trial('rtr2@r29tr2.test'); c2 := pg_temp.code('rtr2@r29tr2.test');
  t2 := pg_temp.referred('rt2@r29t2.test', c2); perform pg_temp.pay(t2, 1999, 'monthly', 'starter'); perform pg_temp.endhold(t2);
  perform pg_temp.tick(); perform pg_temp.su();
  update public.referral_rewards set held_until = now() - interval '1 day' where studio_id = tr2 and state = 'held';
  perform pg_temp.tick();
  perform pg_temp.res('27c held for more than 6 months without paying -> expired', pg_temp.rw(tr2, 'expired') = 1 and pg_temp.rw(tr2, 'held') = 0);
exception when others then perform pg_temp.su(); insert into _rr values ('27x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 28 referrer cancels: frozen, back within 6 months, else expired ----------------------------------------------------------
do $$ declare cz uuid; z1 uuid; z2 uuid; c text; begin
  cz := pg_temp.trial('rcz@r29cz.test'); perform pg_temp.pay(cz, 4999, 'monthly'); c := pg_temp.code('rcz@r29cz.test');
  z1 := pg_temp.referred('rz1@r29z1.test', c); perform pg_temp.pay(z1, 1999, 'monthly', 'starter'); perform pg_temp.endhold(z1);
  z2 := pg_temp.referred('rz2@r29z2.test', c); perform pg_temp.pay(z2, 1999, 'monthly', 'starter'); perform pg_temp.endhold(z2);
  perform pg_temp.tick();
  perform pg_temp.op(); perform public.hq_set_subscription(cz, null, 'cancelled', null, null, null, 'test'); perform pg_temp.su();
  perform pg_temp.res('28a the referrer cancels -> unused months frozen', pg_temp.rw(cz, 'frozen') = 2 and pg_temp.rw(cz, 'scheduled') = 0);
  update public.referral_rewards set frozen_at = now() - interval '7 months'
   where id = (select id from public.referral_rewards where studio_id = cz and state = 'frozen' order by earned_at limit 1);
  perform pg_temp.tick();
  perform pg_temp.op(); perform public.hq_set_subscription(cz, null, 'active', null, null, null, 'came back'); perform pg_temp.su();
  perform pg_temp.res('28b frozen more than 6 months -> expired; the studio comes back -> the other month is upcoming again',
    pg_temp.rw(cz, 'expired') = 1 and pg_temp.rw(cz, 'scheduled') = 1 and pg_temp.rw(cz, 'frozen') = 0);
exception when others then perform pg_temp.su(); insert into _rr values ('28x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 29 expiry after 24 months -------------------------------------------------------------------------------------------------
do $$ declare b uuid := pg_temp.get('B')::uuid; begin
  perform pg_temp.su();
  update public.referral_rewards set expires_at = now() - interval '1 minute' where studio_id = b and state = 'scheduled';
  perform pg_temp.tick();
  perform pg_temp.res('29 an unused month expires 24 months after it was earned', pg_temp.rw(b, 'expired') = 1 and pg_temp.rw(b, 'scheduled') = 0
    and exists (select 1 from public.referral_rewards x where x.state <> 'expired' and x.expires_at::date - x.earned_at::date between 729 and 732));
exception when others then perform pg_temp.su(); insert into _rr values ('29x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 30 refund after the reward was confirmed + used: written off, never charged, flagged --------------------------------------
do $$ declare w uuid; w1 uuid; c text; v_pay uuid; v_end date; begin
  w := pg_temp.trial('rw@r29w.test'); perform pg_temp.pay(w, 4999, 'monthly'); c := pg_temp.code('rw@r29w.test');
  w1 := pg_temp.referred('rw1@r29w1.test', c); perform pg_temp.pay(w1, 1999, 'monthly', 'starter'); perform pg_temp.endhold(w1);
  perform pg_temp.su(); update public.studio_subscriptions set current_period_end = current_date + 1 where org_id = w;
  perform pg_temp.tick();
  v_end := pg_temp.pe(w);
  select id into v_pay from public.subscription_payments where org_id = w1 and voided_at is null order by recorded_at limit 1;
  perform pg_temp.op(); perform public.hq_void_payment(v_pay, 'chargeback'); perform pg_temp.su();
  perform pg_temp.res('30a chargeback after the month was USED -> written off + flagged for HQ, the referrer is not charged (period kept)',
    pg_temp.rw(w, 'written_off') = 1 and (select flagged from public.referral_rewards where studio_id = w) and pg_temp.pe(w) = v_end
    and pg_temp.st(w1) = 'not_qualified' and pg_temp.rsn(w1) = 'refunded');
  perform pg_temp.res('30b the new studio''s unused welcome month is reversed', pg_temp.rw(w1, 'reversed') = 1 and pg_temp.rw(w1, 'scheduled') = 0);
  perform pg_temp.res('30c every state change is in the append-only event log',
    (select count(*) from public.referral_reward_events e join public.referral_rewards x on x.id = e.reward_id where x.studio_id = w) = 3
    and pg_temp.try('update public.referral_reward_events set reason = ''x''') like '42501%'
    and pg_temp.try('delete from public.referral_reward_events') like '42501%');
exception when others then perform pg_temp.su(); insert into _rr values ('30x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 31-35 partner / marketing codes ----------------------------------------------------------------------------------------------
do $$ declare p jsonb; q jsonb; m1 uuid; m2 uuid; s jsonb; l jsonb; e text; ps uuid; pk jsonb; m3 uuid; d jsonb; x uuid; begin
  perform pg_temp.op();
  p := public.hq_partner_code_upsert('{"name":"Priya - Instagram","kind":"influencer","offer_type":"months","offer_months":2,"partner_reward":"tracking","disclosure_ack":true,"terms":"Valid for new studios."}'::jsonb);
  perform pg_temp.su(); perform pg_temp.put('codeP', p ->> 'code');
  perform pg_temp.res('31a "Create marketing link": a blank code is made from the name (PRIYAINS-XXXX), audited',
    p ->> 'code' ~ '^PRIYAINS-[2-9A-HJKMNP-Z]{4}$' and exists (select 1 from public.audit_log l where l.action = 'hq.referral.partner_code'), p::text);
  perform pg_temp.anon(); l := public.referral_lookup(p ->> 'code'); perform pg_temp.su();
  perform pg_temp.res('31b the sign-up page shows the partner offer + terms (not the partner)',
    l ->> 'kind' = 'partner' and l ->> 'offer' = '2 free months after your first payment' and l ->> 'terms' = 'Valid for new studios.'
    and position('Priya' in l::text) = 0, l::text);
  m1 := pg_temp.referred('rm1@r29m1.test', p ->> 'code', true); perform pg_temp.pay(m1, 1999, 'monthly', 'starter'); perform pg_temp.endhold(m1);
  m2 := pg_temp.referred('rm2@r29m2.test', p ->> 'code', false);
  perform pg_temp.tick();
  perform pg_temp.res('31c partner offer: the new studio gets 2 months; tracking-only partner gets nothing',
    pg_temp.rw(m1, 'scheduled') = 2 and not exists (select 1 from public.referral_rewards x join public.referrals r on r.id = x.referral_id
                                                   where r.referred_org = m1 and x.side <> 'referred'));
  perform pg_temp.op(); s := public.hq_partner_signups(p ->> 'code'); perform pg_temp.su();
  perform pg_temp.res('31d who signed up: studio name, date, status, paid yes/no; the partner share = counts + only consenting names',
    jsonb_array_length(s -> 'signups') = 2 and (s #>> '{share,signups}')::int = 2 and (s #>> '{share,paid}')::int = 1
    and jsonb_array_length(s #> '{share,named_studios}') = 1
    and exists (select 1 from jsonb_array_elements(s -> 'signups') el where (el ->> 'paid')::boolean and el ->> 'status' = 'qualified'), s::text);
  -- 32 percent offer -> a discount HQ marks as given
  perform pg_temp.op();
  q := public.hq_partner_code_upsert('{"code":"MKT-DIWALI","name":"Diwali expo","kind":"event","offer_type":"percent","offer_percent":30,"offer_for_months":3,"partner_reward":"none"}'::jsonb);
  perform pg_temp.su();
  m3 := pg_temp.referred('rm3@r29m3.test', 'MKT-DIWALI'); perform pg_temp.pay(m3, 1999, 'monthly', 'starter'); perform pg_temp.endhold(m3);
  perform pg_temp.tick();
  perform pg_temp.put('disc', (select id::text from public.referral_rewards where studio_id = m3 and kind = 'discount'));
  perform pg_temp.op();
  d := public.hq_referral_reward_action(pg_temp.get('disc')::uuid, 'mark_applied', 'Applied on the bill');
  perform pg_temp.su();
  perform pg_temp.res('32 % offer: a 30%-for-3-months discount is scheduled, never auto-applied; HQ marks it given',
    d ->> 'state' = 'applied' and (d ->> 'percent')::int = 30 and (d ->> 'for_months')::int = 3 and pg_temp.pe(m3) = (select current_period_end from public.studio_subscriptions where org_id = m3), d::text);
  -- 33 limits: expired / full / disabled
  perform pg_temp.op();
  perform public.hq_partner_code_upsert('{"code":"EXPO-OLD","name":"Old expo","kind":"event","offer_type":"months","offer_months":1}'::jsonb);
  perform public.hq_partner_code_upsert('{"code":"EXPO-FULL","name":"Full expo","kind":"event","offer_type":"months","offer_months":1,"max_uses":1}'::jsonb);
  perform public.hq_partner_code_set_active('MKT-DIWALI', false);
  perform pg_temp.su(); update public.referral_codes set ends_at = now() - interval '1 day' where code = 'EXPO-OLD';
  x := pg_temp.referred('rq1@r29q1.test', 'EXPO-FULL');
  perform pg_temp.anon();
  perform pg_temp.res('33 a partner code that is expired / full / switched off says so plainly (sign-up still works without it)',
    public.referral_lookup('EXPO-OLD') ->> 'reason' = 'expired' and public.referral_lookup('EXPO-FULL') ->> 'reason' = 'full'
    and public.referral_lookup('MKT-DIWALI') ->> 'reason' = 'inactive');
  perform pg_temp.su();
  -- 34 rules on the form
  perform pg_temp.op();
  e := pg_temp.try($q$select public.hq_partner_code_upsert('{"name":"No promise","kind":"influencer","offer_type":"none"}'::jsonb)$q$);
  perform pg_temp.res('34a an influencer code is not saved without the #ad promise (ASCI)', e like '22023%', e);
  e := pg_temp.try($q$select public.hq_partner_code_upsert('{"name":"Cash","kind":"campaign","partner_reward":"cash"}'::jsonb)$q$);
  perform pg_temp.res('34b never cash for partners', e like '22023%', e);
  e := pg_temp.try(format($q$select public.hq_partner_code_upsert('{"code":"%s","name":"Steal"}'::jsonb)$q$, pg_temp.get('codeA')));
  perform pg_temp.res('34c a studio code can not be taken over as a partner code', e like '23505%', e);
  -- 35 partner that is a Helm studio, "1 free month per paying studio"
  perform pg_temp.su(); ps := pg_temp.trial('rps@r29ps.test'); perform pg_temp.pay(ps, 4999, 'monthly');
  perform pg_temp.op();
  pk := public.hq_partner_code_upsert(jsonb_build_object('code', 'RESELL-ONE', 'name', 'Reseller One', 'kind', 'reseller', 'offer_type', 'months',
          'offer_months', 1, 'partner_reward', 'months', 'partner_studio', ps));
  perform pg_temp.su();
  x := pg_temp.referred('rp1@r29p1.test', 'RESELL-ONE'); perform pg_temp.pay(x, 1999, 'monthly', 'starter'); perform pg_temp.endhold(x);
  perform pg_temp.tick();
  perform pg_temp.res('35 partner studio with "free months": the partner earns 1 month (side partner), the new studio 1',
    exists (select 1 from public.referral_rewards w where w.studio_id = ps and w.side = 'partner' and w.state = 'scheduled')
    and pg_temp.rw(x, 'scheduled') = 1, pk::text);
exception when others then perform pg_temp.su(); insert into _rr values ('31x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 36 never paid within 60 days ----------------------------------------------------------------------------------------------
do $$ declare c text := pg_temp.get('codeA'); n uuid; begin
  n := pg_temp.referred('rn@r29n.test', c); perform pg_temp.su();
  update public.referrals set signed_up_at = now() - interval '61 days' where referred_org = n;
  perform pg_temp.tick();
  perform pg_temp.res('36 no payment within 60 days of sign-up -> not qualified (did not start paying)', pg_temp.st(n) = 'not_qualified' and pg_temp.rsn(n) = 'no_payment');
exception when others then perform pg_temp.su(); insert into _rr values ('36x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 37 RLS isolation + what a referrer sees ----------------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; b uuid := pg_temp.get('B')::uuid; mb jsonb; ma jsonb; n_codes int; n_rw int; e1 text; e2 text; e3 text; begin
  perform pg_temp.login('rb@r29b.test');
  mb := public.my_referral(null);
  select count(*) into n_codes from public.referral_codes;
  select count(*) into n_rw from public.referral_rewards where studio_id <> b;
  e1 := pg_temp.try('select count(*) from public.referrals');
  e2 := pg_temp.try('select count(*) from public.referral_fingerprints');
  e3 := pg_temp.try('insert into public.referral_rewards(studio_id, side, state) values (public.current_org_id(), ''referrer'', ''scheduled'')');
  perform pg_temp.login('ra@r29a.test'); ma := public.my_referral(null);
  perform pg_temp.su();
  perform pg_temp.res('37a RLS: a studio reads only its own code + rewards; referrals / signals tables closed; no direct writes',
    n_codes = 1 and n_rw = 0 and e1 like '42501%' and e2 like '42501%' and e3 like '42501%', n_codes || '/' || n_rw || ' ' || e1 || ' ' || e3);
  perform pg_temp.res('37b B''s page has only B''s own rows (its welcome month), nothing of A',
    jsonb_array_length(mb -> 'referrals') = 0 and not exists (select 1 from jsonb_array_elements(mb -> 'rewards') x where x ->> 'side' <> 'referred'));
  perform pg_temp.res('37c the referrer sees a name ONLY with consent, else the city / "A studio"; never an e-mail',
    exists (select 1 from jsonb_array_elements(ma -> 'referrals') x where x ->> 'label' = 'R29 rb' and x ->> 'masked' = 'false')
    and exists (select 1 from jsonb_array_elements(ma -> 'referrals') x where x ->> 'label' = 'A studio' and x ->> 'masked' = 'true')
    and position('@' in ma::text) = 0 and position('flags' in ma::text) = 0, left(ma::text, 300));
exception when others then perform pg_temp.su(); insert into _rr values ('37x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 38-40 HQ roles, review decisions, audit ----------------------------------------------------------------------------------
do $$ declare d uuid := pg_temp.get('D')::uuid; e text; r jsonb; o jsonb; l jsonb; v jsonb; c text := pg_temp.get('codeA'); begin
  perform pg_temp.su();
  insert into public.platform_admins(email, added_by, role, status) values ('r29sales@helm.events', 'test', 'sales', 'active'),
    ('r29sup@helm.events', 'test', 'support', 'active'), ('r29view@helm.events', 'test', 'viewer', 'active') on conflict (email) do update set role = excluded.role, status = 'active';
  if not exists (select 1 from auth.users where email = 'r29sales@helm.events') then perform auth.seed_user('r29sales@helm.events'); end if;
  if not exists (select 1 from auth.users where email = 'r29sup@helm.events') then perform auth.seed_user('r29sup@helm.events'); end if;
  if not exists (select 1 from auth.users where email = 'r29view@helm.events') then perform auth.seed_user('r29view@helm.events'); end if;
  perform pg_temp.put('refD', (select id::text from public.referrals where referred_org = d));
  perform pg_temp.op('r29sales@helm.events'); e := pg_temp.try('select public.hq_referrals(null, null, 10, 0)');
  perform pg_temp.res('38a Sales can see referrals (inbox.read)', e = '', e);
  e := pg_temp.try($q$select public.hq_partner_code_upsert('{"name":"Sales link","kind":"campaign"}'::jsonb)$q$);
  perform pg_temp.res('38b Sales can create a marketing link (inbox.write)', e = '', e);
  e := pg_temp.try(format('select public.hq_referral_decide(%L, true, null)', pg_temp.get('refD')));
  perform pg_temp.res('38c Sales can NOT approve / reject (billing.write)', e like '42501%HQ_ROLE%', e);
  perform pg_temp.op('r29view@helm.events'); e := pg_temp.try('select public.hq_referral_overview()');
  perform pg_temp.res('38d a Viewer can not open referrals', e like '42501%', e);
  perform pg_temp.op('admin@helm.events', 'aal1'); e := pg_temp.try('select public.hq_referral_overview()');
  perform pg_temp.res('38e HQ without two-step (aal1) is refused', e like '42501%', e);
  perform pg_temp.login('ra@r29a.test'); e := pg_temp.try('select public.hq_referrals(null, null, 10, 0)');
  perform pg_temp.res('38f a studio admin is not HQ', e like '42501%', e);
  perform pg_temp.op('r29sup@helm.events'); e := pg_temp.try('select public.hq_referral_settings_set(''{"program_on": false}''::jsonb)');
  perform pg_temp.res('38g only Owner / Admin change the program settings', e like '42501%', e);
  -- 39 review queue: approve -> back to trial; then reject a confirmed one later (fraud) -> reversed
  perform pg_temp.su();
  perform pg_temp.put('refD', (select id::text from public.referrals where referred_org = d));
  perform pg_temp.op(); r := public.hq_referral_decide(pg_temp.get('refD')::uuid, true, 'Known couple, different studios');
  perform pg_temp.su();
  perform pg_temp.res('39a approve from Needs review: back on trial, approved, who / when / note kept',
    pg_temp.st(d) = 'trial' and (select approved and decided_by is not null and decision_note is not null from public.referrals where referred_org = d), r::text);
  perform pg_temp.pay(d, 1999, 'monthly', 'starter');
  perform pg_temp.res('39b approved earlier: the first payment goes to the hold (not back to review)', pg_temp.st(d) = 'hold');
  perform pg_temp.endhold(d); perform pg_temp.tick();
  perform pg_temp.put('refD', (select id::text from public.referrals where referred_org = d));
  perform pg_temp.op(); r := public.hq_referral_decide(pg_temp.get('refD')::uuid, false, 'fraud found later');
  perform pg_temp.su();
  perform pg_temp.res('39c reject later (fraud): not qualified, every unused reward reversed',
    pg_temp.st(d) = 'not_qualified' and pg_temp.rsn(d) = 'fraud' and pg_temp.rw(d, 'reversed') = 1
    and not exists (select 1 from public.referral_rewards x join public.referrals q on q.id = x.referral_id where q.referred_org = d and x.state = 'scheduled'), r::text);
  perform pg_temp.res('40 every HQ decision is in the audit log (who + when)',
    exists (select 1 from public.audit_log l where l.action = 'hq.referral.approve' and l.actor_email = 'admin@helm.events')
    and exists (select 1 from public.audit_log l where l.action = 'hq.referral.reject')
    and exists (select 1 from public.audit_log l where l.action = 'hq.view' and l.entity = 'hq_referrals'));
  -- 41 HQ lists
  perform pg_temp.op(); o := public.hq_referral_overview(); l := public.hq_referrals('all', null, 500, 0); v := public.hq_referral_rewards('flagged'); perform pg_temp.su();
  perform pg_temp.res('41 HQ: overview numbers (USD list value), all referrals with masked e-mails, flagged write-offs',
    (o ->> 'signups')::int >= 20 and (o ->> 'written_off')::int >= 1 and (o ->> 'usd_applied')::numeric > 0 and not (o -> 'settings') ? 'hash_salt'
    and jsonb_array_length(l) >= 20 and not exists (select 1 from jsonb_array_elements(l) x where x ->> 'referred_email' !~ '^.\*\*\*@' and x ->> 'referred_email' is not null)
    and jsonb_array_length(v) >= 1, left(o::text, 300));
exception when others then perform pg_temp.su(); insert into _rr values ('38x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 42-45 safety -------------------------------------------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; v_pe date; n int; f jsonb; e text; x uuid; y uuid; v_def text; c text := pg_temp.get('codeA'); begin
  v_pe := pg_temp.pe(a); select count(*) into n from public.referral_reward_events;
  perform pg_temp.tick(); perform pg_temp.tick();
  perform pg_temp.res('42 running the job again changes nothing (no double free months)',
    pg_temp.pe(a) = v_pe and (select count(*) from public.referral_reward_events) = n);
  -- 43 a payment always goes through, even when the referral step fails (simulated failure, restored after)
  x := pg_temp.referred('rbk@r29bk.test', c); perform pg_temp.su();
  v_def := pg_get_functiondef('public._r29_on_payment(uuid,uuid)'::regprocedure);
  execute $f$create or replace function public._r29_on_payment(p_org uuid, p_payment uuid) returns void language plpgsql
            security definer set search_path = '' as $b$ begin raise exception 'simulated referral failure'; end $b$ $f$;
  e := pg_temp.try(format('select pg_temp.pay(%L, 1999, ''monthly'', ''starter'')', x));
  perform pg_temp.su(); execute v_def;
  perform pg_temp.res('43 a payment is never blocked by the referral step (the failure is logged, the payment + plan stand)',
    e = '' and exists (select 1 from public.subscription_payments where org_id = x and voided_at is null)
    and (select status from public.studio_subscriptions where org_id = x) = 'active'
    and exists (select 1 from public.audit_log l where l.action = 'referral.error' and l.changed ->> 'error' like '%simulated referral failure%'), e);
  -- 44 program switched off: a referral already on hold keeps its rules
  y := pg_temp.referred('rof@r29of.test', pg_temp.code('rcz@r29cz.test')); perform pg_temp.pay(y, 1999, 'monthly', 'starter');
  perform pg_temp.su(); update public.referral_settings set program_on = false where id;
  perform pg_temp.endhold(y); perform pg_temp.tick();
  perform pg_temp.res('44 the program switched off: a referral already on hold is still confirmed', pg_temp.st(y) = 'qualified', coalesce(pg_temp.st(y), ''));
  update public.referral_settings set program_on = true where id;
  -- 45 forfeit (rule breaking) by HQ; a used month can not be forfeited
  perform pg_temp.put('fy', (select id::text from public.referral_rewards where studio_id = y and state = 'scheduled' limit 1));
  perform pg_temp.put('fa', (select id::text from public.referral_rewards where state = 'applied' limit 1));
  perform pg_temp.op();
  f := public.hq_referral_reward_action(pg_temp.get('fy')::uuid, 'forfeit', 'rules broken');
  e := pg_temp.try(format('select public.hq_referral_reward_action(%L, ''forfeit'', null)', pg_temp.get('fa')));
  perform pg_temp.su();
  perform pg_temp.res('45 HQ forfeits an unused month (rule breaking); a used month can not be forfeited', f ->> 'state' = 'forfeited' and e like '22023%', e);
exception when others then perform pg_temp.su(); insert into _rr values ('42x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 46-48 r29c hardening (R32 review): attach rate limit, no shared look-up counter, old rate counters cleared -------------
do $$ declare o uuid; r jsonb; i int; l jsonb; c text := pg_temp.get('codeA'); begin
  o := pg_temp.trial('rrate@r29rate.test');
  perform pg_temp.login('rrate@r29rate.test');
  for i in 1..11 loop r := public.referral_attach('NOPE-' || i || 'ZZ', null, null, false, null); end loop;
  perform pg_temp.su();
  perform pg_temp.res('46 REF-02 referral_attach: at most 10 tries an hour per person (11th -> rate), nothing attached',
    r ->> 'reason' = 'rate' and not exists (select 1 from public.referrals where referred_org = o), r::text);
  insert into public.referral_rate_buckets(bucket, n, window_start) values ('lk:all', 999999, now())
    on conflict (bucket) do update set n = 999999, window_start = now();
  perform pg_temp.anon('198.51.100.77');
  l := public.referral_lookup(c);
  perform pg_temp.su();
  perform pg_temp.res('47 REF-03 a used-up shared counter no longer blocks the look-up for a new visitor', l ->> 'ok' = 'true', l::text);
  insert into public.referral_rate_buckets(bucket, n, window_start) values ('lk:old-r29c', 5, now() - interval '3 hours'), ('lk:new-r29c', 5, now())
    on conflict (bucket) do nothing;
  r := pg_temp.tick();
  perform pg_temp.res('48 REF-03 the daily job clears rate counters older than 2 hours (fresh ones stay)',
    not exists (select 1 from public.referral_rate_buckets where bucket = 'lk:old-r29c')
    and exists (select 1 from public.referral_rate_buckets where bucket = 'lk:new-r29c') and (r ->> 'rate_buckets_cleared')::int >= 1, r::text);
exception when others then perform pg_temp.su(); insert into _rr values ('46x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 49-53 r29d REF-04: per-network keys - cf-connecting-ip first, IPv6 grouped by its /64, IPv4 unchanged ----------------
create or replace function pg_temp.net(p_h jsonb) returns text language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.headers', coalesce(p_h::text, ''), false); return public._r29_net(); end $$;
create or replace function pg_temp.anonh(p_h jsonb) returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  perform set_config('request.headers', p_h::text, false); perform set_config('role', 'anon', false); end $$;
do $$ declare c text := pg_temp.get('codeA'); i int; v jsonb; w jsonb; n0 int; n1 int; e text; begin
  perform pg_temp.res('49 REF-04 IPv6: two addresses in one /64 give the same key, another /64 a different one',
    pg_temp.net('{"cf-connecting-ip":"2001:db8:4ab:1::5"}') = '2001:db8:4ab:1::/64'
    and pg_temp.net('{"cf-connecting-ip":"2001:db8:4ab:1:ffff:eeee:dddd:9"}') = '2001:db8:4ab:1::/64'
    and pg_temp.net('{"cf-connecting-ip":"2001:DB8:4AB:1:0:0:0:77"}') = '2001:db8:4ab:1::/64'
    and pg_temp.net('{"cf-connecting-ip":"2001:db8:4ab:2::5"}') = '2001:db8:4ab:2::/64',
    coalesce(pg_temp.net('{"cf-connecting-ip":"2001:db8:4ab:1::5"}'), 'null'));
  perform pg_temp.res('50 REF-04 IPv4 keyed by its full address as before (same value the old helper gave); ::ffff:a.b.c.d is not lumped together',
    pg_temp.net('{"cf-connecting-ip":"203.0.113.42"}') = '203.0.113.42'
    and pg_temp.net('{"cf-connecting-ip":"203.0.113.43"}') = '203.0.113.43'
    and pg_temp.net('{"x-forwarded-for":"203.0.113.44"}') = '203.0.113.44'
    and pg_temp.net('{"cf-connecting-ip":"::ffff:203.0.113.42"}') <> pg_temp.net('{"cf-connecting-ip":"::ffff:203.0.113.43"}'),
    coalesce(pg_temp.net('{"cf-connecting-ip":"::ffff:203.0.113.42"}'), 'null'));
  perform pg_temp.res('51 REF-04 cf-connecting-ip beats a typed x-forwarded-for; empty / junk / no headers -> no key',
    pg_temp.net('{"cf-connecting-ip":"198.51.100.21","x-forwarded-for":"10.9.9.9, 198.51.100.21"}') = '198.51.100.21'
    and pg_temp.net('{"cf-connecting-ip":"","x-forwarded-for":"198.51.100.22"}') = '198.51.100.22'
    and pg_temp.net('{"x-real-ip":"198.51.100.23"}') = '198.51.100.23'
    and pg_temp.net('{"cf-connecting-ip":"not-an-ip"}') is null and pg_temp.net('[1,2]') is null and pg_temp.net(null) is null);
  perform pg_temp.su();
  -- 52 one IPv6 machine rotating through its /64: 61 look-ups from 61 addresses -> the 61st is refused; another /64 is fine
  for i in 1..61 loop
    perform pg_temp.anonh(jsonb_build_object('cf-connecting-ip', '2001:db8:52:7:' || to_hex(i) || '::' || to_hex(i * 7)));
    v := public.referral_lookup(c);
  end loop;
  perform pg_temp.anonh('{"cf-connecting-ip":"2001:db8:52:8::1"}'); w := public.referral_lookup(c);
  perform pg_temp.su();
  perform pg_temp.res('52 REF-04 look-up: 61 addresses in one IPv6 /64 share one limit (61st -> rate); the next /64 still works',
    v ->> 'reason' = 'rate' and w ->> 'ok' = 'true', v::text || ' / ' || w::text);
  -- 53 clicks: 10 addresses in one /64 count as one network (3 an hour); the network helper is internal only
  select coalesce(sum(clicks), 0) into n0 from public.referral_click_days where code = c;
  for i in 1..10 loop
    perform pg_temp.anonh(jsonb_build_object('cf-connecting-ip', '2001:db8:53:9::' || to_hex(i))); perform public.referral_click(c);
  end loop;
  perform pg_temp.su(); select coalesce(sum(clicks), 0) into n1 from public.referral_click_days where code = c;
  perform pg_temp.anonh('{"cf-connecting-ip":"2001:db8:53:9::1"}');
  e := pg_temp.try('select public._r29_net()');
  perform pg_temp.su();
  perform pg_temp.res('53 REF-04 clicks: one IPv6 /64 counts 3 an hour, not 10; anon cannot call the network helper',
    n1 - n0 = 3 and e like '42501%' and not has_function_privilege('authenticated', 'public._r29_net()', 'execute'),
    (n1 - n0)::text || ' ' || e);
exception when others then perform pg_temp.su(); insert into _rr values ('49x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 54 r29d zero data loss: deleting a studio / a code never deletes referral history -----------------------------------
do $$ declare a uuid := gen_random_uuid(); c text := 'R29D-KEEP'; nf int; nc int; e1 text; e2 text; begin
  perform pg_temp.su();
  -- a bare studio with only a referral fingerprint (no other rows point at it), so only the referral key can refuse
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at) values (a, 'R29d bare', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now());
  perform public._r29_fp(a, 'email', 'r29d-keep@r29d.test');
  -- a partner code with only click counts (no referral uses it)
  insert into public.referral_codes(code, kind, partner_name) values (c, 'partner', 'R29d keep');
  insert into public.referral_click_days(code, day, clicks) values (c, current_date, 4);
  select count(*) into nf from public.referral_fingerprints where studio_id = a;
  select count(*) into nc from public.referral_click_days where code = c;
  e1 := pg_temp.try(format('delete from public.organizations where id = %L', a));
  e2 := pg_temp.try(format('delete from public.referral_codes where code = %L', c));
  perform pg_temp.res('54 r29d no cascade: a studio / code delete is refused, its fingerprints + click counts stay',
    not exists (select 1 from pg_constraint k join pg_class t on t.oid = k.conrelid where k.contype = 'f' and k.confdeltype = 'c'
                 and t.relnamespace = 'public'::regnamespace and t.relname like 'referral\_%')
    and e1 like '23503%referral_fingerprints%' and e2 like '23503%referral_click_days%' and nf >= 1 and nc >= 1
    and (select count(*) from public.referral_fingerprints where studio_id = a) = nf
    and (select count(*) from public.referral_click_days where code = c) = nc
    and exists (select 1 from public.organizations where id = a), e1 || ' / ' || e2 || ' nf=' || nf || ' nc=' || nc);
exception when others then perform pg_temp.su(); insert into _rr values ('54x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R29-REFERRALS-0279: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R29-REFERRALS-0279: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rr;
rollback;
