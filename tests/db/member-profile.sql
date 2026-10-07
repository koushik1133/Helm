-- member-profile.sql — 0041 "Complete your profile": member_profiles + RPCs, staff
-- directory sync, privacy, sign-in gate cutoff, avatar storage policies, backfill and
-- idempotent re-apply. Fixture: a_admin/a_staff (studio A), b_admin/b_staff (studio B).
-- Everything runs inside ONE transaction that is rolled back at the end, so the suites
-- after this one see the fixture exactly as before. Phone numbers are fake test values.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _mp(name text, result text); grant all on _mp to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _mp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return v; exception when others then return 'ERR:'||sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated;
grant execute on function pg_temp.val(text) to anon, authenticated;
grant execute on function pg_temp.uid(text) to anon, authenticated;
create or replace function pg_temp.avatar(p uuid) returns text language sql security definer as $$ select avatar_path from public.member_profiles where user_id = p $$;
grant execute on function pg_temp.avatar(uuid) to anon, authenticated;

-- ---- setup (superuser) ----------------------------------------------------------------
do $$ begin perform pg_temp.su();
  update public.profiles set full_name = null where email in ('a_admin@a.test','a_staff@a.test','b_admin@b.test','b_staff@b.test');
  -- everyone in the fixture joined BEFORE the cutoff unless a test says otherwise
  update public.profiles set created_at = (select gate_cutoff from public.member_profile_settings) - interval '30 days'
   where email in ('a_admin@a.test','a_staff@a.test','b_admin@b.test','b_staff@b.test');
  -- an existing, unlinked staff row in studio A with a_staff's future mobile, written differently
  insert into public.crew_members (id, name, phone, department, role, skills, email, emp_type, day_rate, notes, org_id, active)
    values ('a0000000-0000-4000-8000-0000000c0001', 'Old Staff Name', '090000 01001', 'Kitchen', 'Cook', '["tandoor"]'::jsonb,
            null, 'on_call', 1500, 'keep me', 'a0000000-0000-4000-8000-000000000001', true);
end $$;

-- ---- 1) self: complete + update -------------------------------------------------------
do $$ declare s text; j jsonb; begin
  perform pg_temp.login('a_staff@a.test');
  begin j := public.complete_my_profile('{"full_name":"  Asha   Staff ","phone":"90000 01001","job_title":"Chef","department":"Catering","skills":["Tandoor","biryani","tandoor"],"city":"Hyderabad","emergency_contact_name":"Ravi","emergency_contact_phone":"+91 90000 09999"}'::jsonb); s := '';
  exception when others then s := sqlstate||' '||sqlerrm; end;
  perform pg_temp.res('01 member completes their own profile (name trimmed, phone +91…, whatsapp = mobile, skills deduped)',
    s = '' and j ->> 'full_name' = 'Asha Staff' and j ->> 'phone' = '+919000001001' and j ->> 'whatsapp' = '+919000001001'
      and (j ->> 'complete')::boolean and j ->> 'profile_completed_at' is not null and jsonb_array_length(j -> 'skills') = 2, s||' '||coalesce(j::text,''));
  perform pg_temp.login('a_staff@a.test');
  begin j := public.update_my_profile('{"whatsapp_same":false,"whatsapp":"+91-90000-01002","job_title":"Head chef"}'::jsonb); s := '';
  exception when others then s := sqlstate||' '||sqlerrm; end;
  perform pg_temp.res('02 partial update keeps other fields; separate WhatsApp number', s = '' and j ->> 'whatsapp' = '+919000001002'
    and j ->> 'phone' = '+919000001001' and j ->> 'city' = 'Hyderabad' and j ->> 'job_title' = 'Head chef', s||' '||coalesce(j::text,''));
  perform pg_temp.login('a_staff@a.test');
  j := public.my_profile();
  perform pg_temp.res('03 my_profile returns my own private fields', j ->> 'emergency_contact_phone' = '+919000009999' and j ->> 'email' = 'a_staff@a.test', j::text);
end $$;

-- ---- 2) validation --------------------------------------------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":"12345"}')$q$);
  perform pg_temp.res('04 too-short mobile refused (22023)', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":"5876543210"}')$q$);
  perform pg_temp.res('05 mobile not starting 6-9 refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":"+1 415 555 2671"}')$q$);
  perform pg_temp.res('06 non-Indian mobile refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":"abc9000001001"}')$q$);
  perform pg_temp.res('07 letters in a mobile refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"job_title":"<script>x</script>"}')$q$);
  perform pg_temp.res('08 < > in a text field refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"full_name":"Bad <b>"}')$q$);
  perform pg_temp.res('09 < > in the name refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"skills":["ok","<img>"]}')$q$);
  perform pg_temp.res('10 < > in a skill refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile(jsonb_build_object('skills', (select jsonb_agg('s'||g) from generate_series(1,21) g)))$q$);
  perform pg_temp.res('11 more than 20 skills refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile(jsonb_build_object('city', repeat('x', 81)))$q$);
  perform pg_temp.res('12 over-long text refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":""}')$q$);
  perform pg_temp.res('13 clearing the mobile refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"role":"admin"}')$q$);
  perform pg_temp.res('14 unknown / privileged field (role) refused', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"day_rate":99999}')$q$);
  perform pg_temp.res('15 a member can''t set their own day rate (42501)', s = '42501', s);
  perform pg_temp.login('b_staff@b.test');
  s := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Bea"}')$q$);
  perform pg_temp.res('16 complete_my_profile without a mobile refused', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"full_name":"Ann Admin","phone":"9000001001"}')$q$);
  perform pg_temp.res('17 a mobile already on another member of the studio refused (23505)', s = '23505', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"emergency_contact_phone":"+44 20 7946 0000"}')$q$);
  perform pg_temp.res('18 an international emergency number (with +) is accepted', s = '', s);
end $$;

-- ---- 3) staff sync ---------------------------------------------------------------------
do $$ declare c record; n int; begin perform pg_temp.su();
  select count(*) into n from public.crew_members where org_id = 'a0000000-0000-4000-8000-000000000001'
    and public.helm_norm_phone(phone) = '919000001001';
  select * into c from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c0001';
  perform pg_temp.res('19 completing links the EXISTING staff row by mobile (no duplicate)',
    n = 1 and c.profile_id = pg_temp.uid('a_staff@a.test'), n||' rows, profile_id '||coalesce(c.profile_id::text,'∅'));
  perform pg_temp.res('20 synced: name, email, department, title; phone string kept (same mobile written differently)',
    c.name = 'Asha Staff' and c.email = 'a_staff@a.test' and c.department = 'Catering' and c.role = 'Head chef' and c.phone = '090000 01001',
    c.name||'/'||coalesce(c.email,'∅')||'/'||coalesce(c.department,'∅')||'/'||coalesce(c.role,'∅')||'/'||c.phone);
  perform pg_temp.res('21 day_rate / emp_type / notes untouched; skills added, never dropped',
    c.day_rate = 1500 and c.emp_type = 'on_call' and c.notes = 'keep me' and c.skills = '["tandoor","biryani"]'::jsonb,
    coalesce(c.day_rate::text,'∅')||'/'||coalesce(c.emp_type,'∅')||'/'||coalesce(c.notes,'∅')||'/'||c.skills::text);
end $$;
do $$ declare s text; c record; begin
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":"9000001003","department":"Kitchen","skills":["biryani"]}')$q$);
  perform pg_temp.su(); select * into c from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c0001';
  perform pg_temp.res('22 a new mobile follows to the linked row; admin fields still untouched',
    s = '' and c.phone = '+919000001003' and c.department = 'Kitchen' and c.day_rate = 1500 and c.emp_type = 'on_call' and c.notes = 'keep me'
      and c.skills = '["tandoor","biryani"]'::jsonb, s||' '||c.phone||' '||c.skills::text);
end $$;
do $$ declare s text; n int; c record; begin
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Ann Admin","phone":"9000001004"}')$q$);
  perform pg_temp.su(); select count(*) into n from public.crew_members where profile_id = pg_temp.uid('a_admin@a.test');
  select * into c from public.crew_members where profile_id = pg_temp.uid('a_admin@a.test');
  perform pg_temp.res('23 no matching staff row → one is created and linked (role = account role)',
    s = '' and n = 1 and c.name = 'Ann Admin' and c.phone = '+919000001004' and c.role = 'Admin' and c.active and c.day_rate is null,
    s||' n='||n||' '||coalesce(c.role,'∅'));
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"city":"Pune"}')$q$);
  perform pg_temp.su(); select count(*) into n from public.crew_members where profile_id = pg_temp.uid('a_admin@a.test');
  perform pg_temp.res('24 saving again never creates a second staff row', s = '' and n = 1, s||' n='||n);
end $$;

-- ---- 4) admin edits / refusals ------------------------------------------------------------
do $$ declare s text; j jsonb; c record; begin
  perform pg_temp.login('a_admin@a.test');
  begin j := public.admin_update_member_profile(pg_temp.uid('a_staff@a.test'), '{"job_title":"Sous chef","day_rate":"2200.50","emp_type":"full_time"}'::jsonb); s := '';
  exception when others then s := sqlstate||' '||sqlerrm; end;
  perform pg_temp.su(); select * into c from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c0001';
  perform pg_temp.res('25 studio admin edits a member incl. day rate + employment type (written to the staff row)',
    s = '' and j ->> 'job_title' = 'Sous chef' and c.day_rate = 2200.50 and c.emp_type = 'full_time' and c.notes = 'keep me' and c.role = 'Sous chef',
    s||' '||coalesce(c.day_rate::text,'∅')||' '||coalesce(c.emp_type,'∅'));
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_update_member_profile(pg_temp.uid('a_staff@a.test'), '{"emp_type":"boss"}')$q$);
  perform pg_temp.res('26 bad employment type refused', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_update_member_profile(pg_temp.uid('a_staff@a.test'), '{"day_rate":-5}')$q$);
  perform pg_temp.res('27 negative day rate refused', s = '22023', s);
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try($q$select public.admin_update_member_profile(pg_temp.uid('a_staff@a.test'), '{"job_title":"Hijacked"}')$q$);
  perform pg_temp.res('28 another studio''s admin refused (42501)', s = '42501', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.admin_update_member_profile(pg_temp.uid('a_admin@a.test'), '{"job_title":"Pwned"}')$q$);
  perform pg_temp.res('29 a non-admin can''t edit someone else (42501)', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_update_member_profile(gen_random_uuid(), '{"job_title":"Ghost"}')$q$);
  perform pg_temp.res('30 unknown user id refused', s = '42501', s);
  perform pg_temp.su();
  perform pg_temp.res('31 refused edits changed nothing', (select job_title from public.member_profiles where user_id = pg_temp.uid('a_admin@a.test')) is null
    and (select job_title from public.member_profiles where user_id = pg_temp.uid('a_staff@a.test')) = 'Sous chef', '');
end $$;

-- ---- 5) privacy ------------------------------------------------------------------------------
do $$ declare j jsonb; o jsonb; me jsonb; s text; begin
  perform pg_temp.login('a_staff@a.test');   -- sales: no users-view in the fixture
  j := public.member_profile_list();
  select e into o from jsonb_array_elements(j) e where e ->> 'user_id' = pg_temp.uid('a_admin@a.test')::text;
  select e into me from jsonb_array_elements(j) e where e ->> 'user_id' = pg_temp.uid('a_staff@a.test')::text;
  perform pg_temp.res('32 non-admin member: colleagues'' mobile / WhatsApp / city / emergency / email hidden; name + title shown',
    o ->> 'phone' is null and o ->> 'whatsapp' is null and o ->> 'city' is null and o ->> 'emergency_contact_phone' is null
      and o ->> 'email' is null and o ->> 'full_name' = 'Ann Admin' and o ->> 'day_rate' is null, coalesce(o::text,'∅'));
  perform pg_temp.res('33 …but they see their own private fields', me ->> 'phone' = '+919000001003', coalesce(me::text,'∅'));
  perform pg_temp.res('34 the list never includes another studio',
    not exists (select 1 from jsonb_array_elements(j) e where e ->> 'user_id' in (pg_temp.uid('b_admin@b.test')::text, pg_temp.uid('b_staff@b.test')::text)), '');
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select count(*) from public.member_profiles$q$);
  perform pg_temp.res('35 no direct table read for signed-in users (RPC only)', s = '42501', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$update public.member_profiles set phone = null$q$);
  perform pg_temp.res('36 no direct table write', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  j := public.member_profile_list();
  select e into o from jsonb_array_elements(j) e where e ->> 'user_id' = pg_temp.uid('a_staff@a.test')::text;
  perform pg_temp.res('37 admin sees mobile, emergency contact and staff day rate', o ->> 'phone' = '+919000001003'
    and o ->> 'emergency_contact_phone' = '+442079460000' and (o ->> 'day_rate')::numeric = 2200.50 and o ->> 'email' = 'a_staff@a.test', coalesce(o::text,'∅'));
  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('sales', 'users', true, false, 'a0000000-0000-4000-8000-000000000001', now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  perform pg_temp.login('a_staff@a.test');
  j := public.member_profile_list();
  select e into o from jsonb_array_elements(j) e where e ->> 'user_id' = pg_temp.uid('a_admin@a.test')::text;
  perform pg_temp.res('38 a role with users-view (manager-style) sees mobiles but not day rates', o ->> 'phone' = '+919000001004' and o ->> 'day_rate' is null, coalesce(o::text,'∅'));
  perform pg_temp.su(); delete from public.role_access where role = 'sales' and area = 'users' and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('b_admin@b.test');
  j := public.member_profile_list();
  perform pg_temp.res('39 another studio''s admin sees none of studio A', not exists (select 1 from jsonb_array_elements(j) e
    where e ->> 'user_id' in (pg_temp.uid('a_admin@a.test')::text, pg_temp.uid('a_staff@a.test')::text)), '');
end $$;

-- ---- 6) Staff page guard (direct API writes) -------------------------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$update public.crew_members set name = 'Renamed' where id = 'a0000000-0000-4000-8000-0000000c0001'$q$);
  perform pg_temp.res('40 linked staff row: name can''t be changed from the Staff page (42501)', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$update public.crew_members set phone = '+919000001888' where id = 'a0000000-0000-4000-8000-0000000c0001'$q$);
  perform pg_temp.res('41 linked staff row: phone can''t be changed from the Staff page', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$update public.crew_members set notes = 'admin note', day_rate = 2500 where id = 'a0000000-0000-4000-8000-0000000c0001'$q$);
  perform pg_temp.res('42 linked staff row: notes / day rate still editable on the Staff page',
    s = '' and (select day_rate from public.crew_members where id = 'a0000000-0000-4000-8000-0000000c0001') = 2500, s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$update public.crew_members set profile_id = null where id = 'a0000000-0000-4000-8000-0000000c0001'$q$);
  perform pg_temp.res('43 the account link can''t be cut or set directly', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$insert into public.crew_members (name, phone, department) values ('Dup', '9000001003', 'X')$q$);
  perform pg_temp.res('44 a second staff row with a linked member''s mobile refused (23505)', s = '23505', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$insert into public.crew_members (name, phone, department, profile_id) values ('Dup2', '9000001777', 'X', pg_temp.uid('a_admin@a.test'))$q$);
  perform pg_temp.res('45 a staff row can''t be linked to an account on insert', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$insert into public.crew_members (name, phone, department) values ('Plain Crew', '9000001778', 'X')$q$);
  perform pg_temp.res('46 ordinary staff rows are still added as before', s = '', s);
end $$;

-- ---- 7) gate cutoff --------------------------------------------------------------------------
do $$ declare j jsonb; v_cut timestamptz; begin perform pg_temp.su();
  select gate_cutoff into v_cut from public.member_profile_settings;
  update public.profiles set created_at = v_cut + interval '1 minute' where email = 'b_staff@b.test';
  perform pg_temp.login('b_staff@b.test'); j := public.my_profile_status();
  perform pg_temp.res('47 joined after the cutoff, incomplete → required (full-page step)', (j ->> 'required')::boolean and not (j ->> 'nudge')::boolean, j::text);
  perform pg_temp.su(); update public.profiles set created_at = v_cut - interval '1 day' where email = 'b_staff@b.test';
  perform pg_temp.login('b_staff@b.test'); j := public.my_profile_status();
  perform pg_temp.res('48 joined before the cutoff, incomplete → nudge (banner) only', not (j ->> 'required')::boolean and (j ->> 'nudge')::boolean, j::text);
  perform pg_temp.login('a_staff@a.test'); j := public.my_profile_status();
  perform pg_temp.res('49 complete → neither', (j ->> 'complete')::boolean and not (j ->> 'required')::boolean and not (j ->> 'nudge')::boolean, j::text);
  perform pg_temp.su(); update public.profiles set role = 'client', created_at = v_cut + interval '1 minute' where email = 'b_staff@b.test';
  perform pg_temp.login('b_staff@b.test'); j := public.my_profile_status();
  perform pg_temp.res('50 a client account is never sent to the profile step', not (j ->> 'required')::boolean and not (j ->> 'nudge')::boolean, j::text);
  perform pg_temp.su(); update public.profiles set role = 'sales' where email = 'b_staff@b.test';
  insert into public.platform_admins(email, added_by) values ('b_staff@b.test', 'test') on conflict (email) do nothing;
  perform pg_temp.login('b_staff@b.test'); j := public.my_profile_status();
  perform pg_temp.res('51 an HQ operator is never sent to the profile step', not (j ->> 'required')::boolean and not (j ->> 'nudge')::boolean, j::text);
  perform pg_temp.su(); delete from public.platform_admins where email = 'b_staff@b.test';
end $$;
do $$ declare s text; n int; begin
  perform pg_temp.su(); update public.profiles set role = 'client' where email = 'b_staff@b.test';
  perform pg_temp.login('b_staff@b.test');
  s := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Client Bea","phone":"9000002001"}')$q$);
  perform pg_temp.su(); select count(*) into n from public.crew_members where profile_id = pg_temp.uid('b_staff@b.test');
  perform pg_temp.res('52 a client completing a profile gets no staff row', s = '' and n = 0, s||' n='||n);
  update public.profiles set role = 'sales' where email = 'b_staff@b.test';
end $$;

-- ---- 8) avatars: bucket + storage policies + set_my_avatar -------------------------------------
do $$ declare s text; v_a text := 'a0000000-0000-4000-8000-000000000001'; v_b text := 'b0000000-0000-4000-8000-000000000001';
          v_me text; v_admin text; n int; begin
  perform pg_temp.su();
  v_me := pg_temp.uid('a_staff@a.test')::text; v_admin := pg_temp.uid('a_admin@a.test')::text;
  perform pg_temp.res('53 bucket is private, 2 MB, png/jpeg/webp only',
    exists (select 1 from storage.buckets where id = 'member-avatars' and not public and file_size_limit = 2097152
             and allowed_mime_types @> array['image/png','image/jpeg','image/webp'] and cardinality(allowed_mime_types) = 3), '');
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format($q$insert into storage.objects(bucket_id, name) values ('member-avatars', '%s/%s/11111111-1111-4111-8111-111111111111.png')$q$, v_a, v_me));
  perform pg_temp.res('54 a member uploads into their OWN folder', s = '', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format($q$insert into storage.objects(bucket_id, name) values ('member-avatars', '%s/%s/22222222-2222-4222-8222-222222222222.png')$q$, v_a, v_admin));
  perform pg_temp.res('55 …never into a colleague''s folder', s = '42501', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format($q$insert into storage.objects(bucket_id, name) values ('member-avatars', '%s/%s/33333333-3333-4333-8333-333333333333.png')$q$, v_b, v_me));
  perform pg_temp.res('56 …never into another studio', s = '42501', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format($q$insert into storage.objects(bucket_id, name) values ('member-avatars', '%s/%s/44444444-4444-4444-8444-444444444444.svg')$q$, v_a, v_me));
  perform pg_temp.res('57 …and only .png / .jpg / .webp keys', s = '42501', s);
  perform pg_temp.anon();
  s := pg_temp.try(format($q$insert into storage.objects(bucket_id, name) values ('member-avatars', '%s/%s/55555555-5555-4555-8555-555555555555.png')$q$, v_a, v_me));
  perform pg_temp.res('58 signed-out upload refused', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from storage.objects where bucket_id = 'member-avatars';
  perform pg_temp.res('59 a colleague in the same studio can read (sign) the photo', n = 1, 'n='||n);
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from storage.objects where bucket_id = 'member-avatars';
  perform pg_temp.res('60 another studio can''t read it', n = 0, 'n='||n);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.val($q$with u as (update storage.objects set name = name where bucket_id = 'member-avatars' returning 1) select count(*)::text from u$q$);
  perform pg_temp.res('61 uploaded photos can''t be overwritten or renamed through the API', s in ('0', 'ERR:42501'), s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.val($q$with d as (delete from storage.objects where bucket_id = 'member-avatars' returning 1) select count(*)::text from d$q$);
  perform pg_temp.res('62 …nor deleted', s in ('0', 'ERR:42501'), s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format($q$select public.set_my_avatar('%s/%s/11111111-1111-4111-8111-111111111111.png')$q$, v_a, v_me));
  perform pg_temp.res('63 set_my_avatar with my uploaded file', s = '' and pg_temp.avatar(v_me::uuid) like '%11111111-1111-4111-8111-111111111111.png', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format($q$select public.set_my_avatar('%s/%s/11111111-1111-4111-8111-111111111111.png')$q$, v_a, v_me));
  perform pg_temp.res('64 set_my_avatar refuses someone else''s file', s = '22023', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format($q$select public.set_my_avatar('%s/%s/66666666-6666-4666-8666-666666666666.png')$q$, v_a, v_me));
  perform pg_temp.res('65 set_my_avatar refuses a file that was never uploaded', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('66 chat_directory returns the photo + title for my studio only',
    exists (select 1 from public.chat_directory() d where d.id = v_me::uuid and d.avatar_path like '%.png' and d.job_title = 'Sous chef')
    and not exists (select 1 from public.chat_directory() d where d.id = pg_temp.uid('b_admin@b.test')), '');
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.set_my_avatar(null)$q$);
  perform pg_temp.res('67 remove photo clears the path only (file stays)', s = '' and pg_temp.avatar(v_me::uuid) is null
    and exists (select 1 from storage.objects where bucket_id = 'member-avatars' and name like '%11111111-1111-4111-8111-111111111111.png'), s);
end $$;

-- ---- 9) signed-out callers + pw gate -----------------------------------------------------------
do $$ declare s text; bad text := ''; f text; begin
  foreach f in array array['select public.my_profile()', 'select public.my_profile_status()',
      $q$select public.update_my_profile('{}')$q$, $q$select public.complete_my_profile('{}')$q$,
      $q$select public.admin_update_member_profile(gen_random_uuid(), '{}')$q$, 'select public.member_profile_list()',
      'select public.set_my_avatar(null)', 'select count(*) from public.audit_actor_names()', 'select count(*) from public.chat_directory()'] loop
    perform pg_temp.anon(); s := pg_temp.try(f);
    if s <> '42501' then bad := bad || f || '=' || s || '; '; end if;
  end loop;
  perform pg_temp.res('68 every profile RPC refuses a signed-out caller (42501)', bad = '', bad);
  perform pg_temp.su();
  perform pg_temp.res('69 internals are not callable by API roles',
    not has_function_privilege('authenticated', 'public._mp_apply(uuid,jsonb,text,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._mp_sync_staff(uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.chat_directory__base()', 'execute')
    and not has_function_privilege('anon', 'public.member_avatar_upload_ok(text)', 'execute'), '');
  update public.profiles set must_change_password = true where email = 'a_staff@a.test';
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"city":"Goa"}')$q$);
  perform pg_temp.res('70 temp-password users must set their password first', s = '42501', s);
  perform pg_temp.su(); update public.profiles set must_change_password = false where email = 'a_staff@a.test';
end $$;

-- ---- 10) audit ----------------------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  perform pg_temp.res('71 changes are audit-logged with masked mobiles',
    exists (select 1 from public.audit_log where entity = 'member_profiles' and action = 'profile.complete'
             and entity_id = pg_temp.uid('a_staff@a.test')::text and changed -> 'phone' ->> 'new' = '+91******1001'
             and actor = pg_temp.uid('a_staff@a.test') and org_id = 'a0000000-0000-4000-8000-000000000001')
    and exists (select 1 from public.audit_log where entity = 'member_profiles' and changed ->> 'by' = 'admin'
             and entity_id = pg_temp.uid('a_staff@a.test')::text and actor = pg_temp.uid('a_admin@a.test')), '');
  perform pg_temp.res('72 emergency contact numbers are never written to the audit log',
    not exists (select 1 from public.audit_log where changed::text like '%9000009999%' or changed::text like '%2079460000%'), '');
  perform pg_temp.res('73 member-profile audit rows never carry a full mobile',
    not exists (select 1 from public.audit_log where entity = 'member_profiles' and changed::text ~ '\+91[0-9]{10}'), '');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from public.audit_actor_names() a where a.id = pg_temp.uid('a_staff@a.test') and a.full_name = 'Asha Staff';
  perform pg_temp.res('74 audit page: actor names for my studio', n = 1, 'n='||n);
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.audit_actor_names() a where a.id = pg_temp.uid('a_staff@a.test');
  perform pg_temp.res('75 audit page: never another studio''s names', n = 0, 'n='||n);
end $$;

-- ---- 11) account deletion keeps the staff row (link cleared) ------------------------------------
do $$ declare v uuid; c uuid; begin perform pg_temp.su();
  v := auth.seed_user('a_temp@a.test');
  insert into public.profiles(id, email, role, org_id, created_at) values (v, 'a_temp@a.test', 'crew', 'a0000000-0000-4000-8000-000000000001', now())
    on conflict (id) do update set role = 'crew', org_id = excluded.org_id;
  perform pg_temp.login('a_temp@a.test');
  perform public.complete_my_profile('{"full_name":"Temp Crew","phone":"9000001555"}'::jsonb);
  perform pg_temp.su(); select id into c from public.crew_members where profile_id = v;
  delete from auth.users where id = v;
  perform pg_temp.res('76 deleting an account keeps its staff row (profile_id set to NULL)',
    c is not null and exists (select 1 from public.crew_members where id = c and profile_id is null and name = 'Temp Crew'), coalesce(c::text,'∅'));
end $$;

-- ---- 12) backfill: only fills NULL profile_id; re-apply is idempotent -----------------------------
do $$ declare v_b uuid; begin perform pg_temp.su();
  v_b := 'b0000000-0000-4000-8000-000000000001';
  update public.profiles set full_name = 'Bea Backfill' where email = 'b_staff@b.test';
  insert into public.member_profiles(user_id, phone, whatsapp) values (pg_temp.uid('b_admin@b.test'), '+919000003001', '+919000003001')
    on conflict (user_id) do update set phone = excluded.phone;
  update public.profiles set full_name = 'Bo Admin' where email = 'b_admin@b.test';
  update public.member_profiles set phone = '+919000003002' where user_id = pg_temp.uid('b_staff@b.test');
  -- L: already linked to b_admin, same number as b_staff → must stay b_admin's
  insert into public.crew_members (id, name, phone, org_id, profile_id, notes, day_rate)
    values ('b0000000-0000-4000-8000-0000000c0001', 'Linked Row', '9000003002', v_b, pg_temp.uid('b_admin@b.test'), 'n1', 100);
  -- U: unlinked, b_staff's number → gets linked to b_staff
  insert into public.crew_members (id, name, phone, org_id, notes, day_rate, emp_type)
    values ('b0000000-0000-4000-8000-0000000c0002', 'Unlinked Row', '+91 90000 03002', v_b, 'n2', 200, 'part_time');
  -- X: unlinked, nobody's number → stays unlinked
  insert into public.crew_members (id, name, phone, org_id, notes) values ('b0000000-0000-4000-8000-0000000c0003', 'Other Row', '9000003999', v_b, 'n3');
  create temp table _before as select id, md5((to_jsonb(c) - 'profile_id')::text) h, profile_id from public.crew_members c;
  create temp table _cut as select gate_cutoff from public.member_profile_settings;
end $$;
\i supabase/migrations/0041_member_profile.sql
\i supabase/migrations/0041_member_profile.sql
set client_min_messages = warning;
do $$ declare n_changed int; begin perform pg_temp.su();
  perform pg_temp.res('77 backfill links the unlinked row with the member''s mobile',
    (select profile_id from public.crew_members where id = 'b0000000-0000-4000-8000-0000000c0002') = pg_temp.uid('b_staff@b.test'), '');
  perform pg_temp.res('78 backfill never re-points an already-linked row, never links a stranger''s row',
    (select profile_id from public.crew_members where id = 'b0000000-0000-4000-8000-0000000c0001') = pg_temp.uid('b_admin@b.test')
    and (select profile_id from public.crew_members where id = 'b0000000-0000-4000-8000-0000000c0003') is null, '');
  select count(*) into n_changed from public.crew_members c join _before b on b.id = c.id
   where md5((to_jsonb(c) - 'profile_id')::text) <> b.h or (b.profile_id is not null and c.profile_id is distinct from b.profile_id);
  perform pg_temp.res('79 backfill + re-apply changed NO other staff data (only NULL profile_ids filled)', n_changed = 0, 'changed='||n_changed);
  perform pg_temp.res('80 re-apply keeps the gate cutoff and the single settings row',
    (select gate_cutoff from public.member_profile_settings) = (select gate_cutoff from _cut) and (select count(*) from public.member_profile_settings) = 1, '');
  perform pg_temp.res('81 re-apply keeps profiles + staff links and chat_directory wrapped once',
    (select count(*) from public.member_profiles) >= 3 and to_regprocedure('public.chat_directory__base()') is not null
    and pg_get_function_result('public.chat_directory()'::regprocedure) like '%avatar_path%'
    and (select count(*) from public.crew_members where profile_id = pg_temp.uid('a_staff@a.test')) = 1, '');
end $$;

select name, result from _mp order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 81 then 'MEMBER-PROFILE: ALL PASS (81/81)'
            else 'MEMBER-PROFILE: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/81 ran' end from _mp;
rollback;
