-- rescore2-fixes.sql — 0032 (security re-score #2). Every ATTACK case FAILS on the
-- 0001-0031 schema and passes after 0032; every LEGIT case is something the app
-- really does and must keep working. Attackers: a_staff (studio A 'sales' with
-- quotes/finance edit), a_admin, b_admin (another studio), anon (a link holder).
-- The grant-drift case runs LAST: it re-creates production's drift (anon EXECUTE on
-- internal helpers, invitation_preview missing) and re-applies 0032 to heal it.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _r2; create temp table _r2(name text, result text); grant all on _r2 to anon, authenticated;
drop table if exists _r2_ids; create temp table _r2_ids(k text primary key, v uuid); grant all on _r2_ids to anon, authenticated;

create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform auth.login_anon(); end $$;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.id(p text) returns uuid language sql as $$ select v from _r2_ids where k = p $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r2 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;

-- ---- setup (superuser) --------------------------------------------------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
        qA uuid := 'a0000000-0000-4000-8000-00000000da01'; k text; q uuid; v uuid;
begin
  perform pg_temp.su();
  -- leftovers of an interrupted earlier run (studio A in context for the archive trigger)
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test')); execute 'reset role';
  perform set_config('helm.allow_financial_delete', 'on', true);
  delete from public.event_sites where quote_id in (select id from public.quotes where org_id = orgA and code like 'R2-%');
  delete from public.event_closure where quote_id in (select id from public.quotes where org_id = orgA and code like 'R2-%');
  delete from public.quotes where org_id = orgA and code like 'R2-%';
  delete from public.inventory_items where org_id = orgA and name = 'r2-item';
  delete from public.leads where org_id = orgA and notes = 'r2-lead';
  perform set_config('helm.allow_financial_delete', '', true);
  perform pg_temp.su();
  insert into _r2_ids values ('orgA', orgA), ('orgB', orgB), ('qA', qA);
  insert into _r2_ids select 'staff', id from auth.users where email = 'a_staff@a.test';
  insert into _r2_ids select 'admin', id from auth.users where email = 'a_admin@a.test';
  insert into public.role_access(role,area,can_view,can_edit,org_id,updated_at)
    select 'sales', a, true, true, orgA, now() from unnest(array['settlement','closure','inventory']) a
    on conflict (role,area,org_id) do update set can_view=true, can_edit=true;
  foreach k in array array['refund','price','date','legacy','site','otp','lock'] loop
    insert into public.quotes(code, title, status, client, pricing, current_version, approval_status, org_id,
                              approval_token, approval_token_expires_at, event_date, created_at, updated_at)
      values ('R2-'||upper(k), 'r2 '||k, 'quote', '{"name":"Rita","phone":"+91 98111 22222"}'::jsonb,
              '{"subtotal":100000,"discount":0,"gstPct":18}'::jsonb, 1, 'sent', orgA,
              gen_random_uuid(), now() + interval '30 days', date '2026-12-01', now(), now())
      returning id into q;
    insert into _r2_ids values (k, q);
    insert into _r2_ids select 'tok_'||k, approval_token from public.quotes where id = q;
  end loop;
  -- a LEGACY event dated year 61115 (written with triggers off, as old data was)
  set local session_replication_role = replica;
  update public.quotes set event_date = date '61115-01-01' where id = pg_temp.id('legacy');
  set local session_replication_role = origin;
  -- stock item in studio A (the view must not show it to studio B)
  insert into public.inventory_items(name, org_id, total_qty, active) values ('r2-item', orgA, 7, true) returning id into v;
  insert into _r2_ids values ('item', v);
  -- an invitation site (draft) for the slug test (studio A in context for its org trigger)
  perform auth.login_as(pg_temp.id('admin')); execute 'reset role';
  insert into public.event_sites(quote_id, org_id, slug, title, data)
    values (pg_temp.id('site'), orgA, 'draft-r2'||substr(md5(random()::text),1,10), 'Rita and Ravi', '{"date":"2026-12-01"}'::jsonb)
    returning id into v;
  insert into _r2_ids values ('site_row', v);
  perform pg_temp.su();
  -- dev echo for the OTP flow
  insert into public.app_config(org_id, key, value) values (orgA, 'channels', '{"otp_dev_echo":true}'::jsonb)
    on conflict (org_id, key) do update set value = excluded.value;
  -- 15 wrong attempts already spent on the 'lock' link today (3 codes x 5)
  -- (2 h ago: inside the 24 h window, outside the per-phone hourly limit)
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, attempts, created_at)
    select pg_temp.id('lock'), '+919811122222', 'h', now() - interval '110 minutes', 5, now() - interval '2 hours' from generate_series(1,3);
end $$;

-- ================= 1) refund maker-checker on INSERT ==============================
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.event_refunds(quote_id, kind, amount, reason, status)
          values (pg_temp.id('refund'), 'refund', 500, 'r2-approved', 'approved');
  exception when others then null; end;
  begin insert into public.event_refunds(quote_id, kind, amount, reason, status)
          values (pg_temp.id('refund'), 'refund', 500, 'r2-processed', 'processed');
  exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.event_refunds where reason in ('r2-approved','r2-processed');
  perform pg_temp.res('refund: a maker cannot insert a refund already approved/processed', n = 0, n||' stored');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin insert into public.event_refunds(quote_id, kind, amount, reason, status)
          values (pg_temp.id('refund'), 'refund', 500, 'r2-admin-approved', 'approved');
  exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.event_refunds where reason = 'r2-admin-approved';
  perform pg_temp.res('refund: even an admin inserts as pending (approval is a separate step)', n = 0, n||' stored');
end $$;
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  begin
    insert into public.event_refunds(quote_id, kind, amount, reason) values (pg_temp.id('refund'), 'refund', 500, 'r2-pending');
    update public.event_refunds set status = 'approved' where reason = 'r2-pending';
  exception when others then perform pg_temp.res('refund: insert pending then admin approves still works', false, sqlerrm); return; end;
  perform pg_temp.su(); select status into s from public.event_refunds where reason = 'r2-pending';
  perform pg_temp.res('refund: insert pending then admin approves still works', s = 'approved', 'status '||coalesce(s,'null'));
end $$;

-- ================= 3) inventory_availability view =================================
do $$ declare n int; begin
  perform pg_temp.login('b_admin@b.test');
  begin select count(*) into n from public.inventory_availability where name = 'r2-item';
  exception when others then n := 0; end;
  perform pg_temp.res('view: another studio cannot read your stock through inventory_availability', n = 0, n||' row(s) visible');
end $$;
do $$ declare n int := -1; begin
  perform pg_temp.anon();
  begin select count(*) into n from public.inventory_availability; exception when others then n := -1; end;
  perform pg_temp.res('view: anon cannot read inventory_availability', n = -1, n||' row(s) visible');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin select count(*) into n from public.inventory_availability where name = 'r2-item';
  exception when others then perform pg_temp.res('view: your own studio still sees its stock', false, sqlerrm); return; end;
  perform pg_temp.res('view: your own studio still sees its stock', n = 1, n||' row(s)');
end $$;

-- ================= 4) pricing bounds without gstPct / subtotal / total =============
do $$ declare p text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"guests":100000000000,"platePrice":100000000000}'::jsonb where id = pg_temp.id('price');
  exception when others then null; end;
  perform pg_temp.su(); select pricing::text into p from public.quotes where id = pg_temp.id('price');
  perform pg_temp.res('pricing: guests x platePrice without gstPct/total cannot store an unbounded amount', p not like '%100000000000%', p);
end $$;
do $$ declare p text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"chairs":"NaN","chairPrice":10}'::jsonb where id = pg_temp.id('price');
  exception when others then null; end;
  perform pg_temp.su(); select pricing::text into p from public.quotes where id = pg_temp.id('price');
  perform pg_temp.res('pricing: NaN component without gstPct/total is refused', p not like '%NaN%', p);
end $$;
do $$ declare p text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"other":5,"catering":{"mode":"inhouse","amount":10,"gstPct":500}}'::jsonb where id = pg_temp.id('price');
  exception when others then null; end;
  perform pg_temp.su(); select pricing::text into p from public.quotes where id = pg_temp.id('price');
  perform pg_temp.res('pricing: catering GST above 100% is refused', p not like '%500%', p);
end $$;
do $$ declare ok int := 0; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    update public.quotes set pricing = '{}'::jsonb where id = pg_temp.id('price'); ok := ok + 1;
    update public.quotes set pricing = '{"guests":100,"platePrice":500}'::jsonb where id = pg_temp.id('price'); ok := ok + 1;
    update public.quotes set pricing = '{"chairs":100,"chairPrice":200,"guests":100,"platePrice":500,"other":0,"gstPct":18,"discount":0,"catering":{"mode":"inhouse","amount":0,"gstPct":18}}'::jsonb
     where id = pg_temp.id('price'); ok := ok + 1;
  exception when others then perform pg_temp.res('pricing: drafts ({} / partial) and real UI payloads still save', false, ok||' saved; '||sqlerrm); return; end;
  perform pg_temp.res('pricing: drafts ({} / partial) and real UI payloads still save',
    ok = 3 and (select pricing->>'total' from public.quotes where id = pg_temp.id('price')) = '82600', 'total '||coalesce((select pricing->>'total' from public.quotes where id = pg_temp.id('price')),'null'));
end $$;

-- ================= 5) event date bounds =============================================
do $$ declare d date; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set event_date = date '61115-01-01' where id = pg_temp.id('date'); exception when others then null; end;
  begin update public.quotes set event_date = date '1999-12-31' where id = pg_temp.id('date'); exception when others then null; end;
  perform pg_temp.su(); select event_date into d from public.quotes where id = pg_temp.id('date');
  perform pg_temp.res('dates: an event date outside 2000-2100 is refused on a quote', d = date '2026-12-01', 'event_date '||d);
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin insert into public.leads(name, event_date, notes) values ('r2 lead', date '2200-01-01', 'r2-lead');
  exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.leads where notes = 'r2-lead';
  perform pg_temp.res('dates: a new lead dated 2200 is refused', n = 0, n||' stored');
end $$;
do $$ declare t text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.event_sites set data = '{"date":"61115-01-01"}'::jsonb where id = pg_temp.id('site_row'); exception when others then null; end;
  perform pg_temp.su(); select data->>'date' into t from public.event_sites where id = pg_temp.id('site_row');
  perform pg_temp.res('dates: an invitation dated year 61115 is refused', t = '2026-12-01', 'date '||coalesce(t,'null'));
end $$;
do $$ declare d date; t text; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    update public.quotes set event_date = date '2027-03-04' where id = pg_temp.id('date');
    update public.quotes set title = 'r2 legacy renamed' where id = pg_temp.id('legacy');
  exception when others then perform pg_temp.res('dates: valid dates save, and a LEGACY bad-date row stays and is still editable', false, sqlerrm); return; end;
  perform pg_temp.su();
  select event_date into d from public.quotes where id = pg_temp.id('legacy');
  select title into t from public.quotes where id = pg_temp.id('legacy');
  perform pg_temp.res('dates: valid dates save, and a LEGACY bad-date row stays and is still editable',
    d = date '61115-01-01' and t = 'r2 legacy renamed'
    and (select event_date from public.quotes where id = pg_temp.id('date')) = date '2027-03-04', 'legacy '||d||' / '||t);
end $$;

-- ================= 6) event_closure only through close_event ======================
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.event_closure(quote_id, closed_at) values (pg_temp.id('refund'), now()); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.event_closure where quote_id = pg_temp.id('refund');
  perform pg_temp.res('closure: a direct insert into event_closure is refused', n = 0, n||' row(s)');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.close_event(pg_temp.id('refund'), true);
  exception when others then perform pg_temp.res('closure: close_event still works', false, sqlerrm); return; end;
  perform pg_temp.su(); select count(*) into n from public.event_closure where quote_id = pg_temp.id('refund') and closed_at is not null;
  perform pg_temp.res('closure: close_event still works', n = 1, n||' row(s)');
end $$;

-- ================= 7) temp-password backstop =======================================
do $$ declare t text; seen int; begin
  perform pg_temp.su(); update public.profiles set must_change_password = true where id = pg_temp.id('staff');
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set title = 'r2 temp write' where id = pg_temp.id('price'); exception when others then null; end;
  begin select count(*) into seen from public.quotes where id = pg_temp.id('price'); exception when others then seen := -1; end;
  perform pg_temp.su(); select title into t from public.quotes where id = pg_temp.id('price');
  perform pg_temp.res('temp password: no direct writes until the password is changed (reads still work)', t = 'r2 price' and seen = 1, t||', read '||seen);
end $$;
do $$ declare t text; begin
  perform pg_temp.su(); update public.profiles set must_change_password = false where id = pg_temp.id('staff');
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set title = 'r2 temp write' where id = pg_temp.id('price');
  exception when others then perform pg_temp.res('temp password: writes work again once it is cleared', false, sqlerrm); return; end;
  perform pg_temp.su(); select title into t from public.quotes where id = pg_temp.id('price');
  perform pg_temp.res('temp password: writes work again once it is cleared', t = 'r2 temp write', t);
end $$;

-- ================= 8) mass assignment ================================================
do $$ declare p text; c uuid; begin
  perform pg_temp.login('a_admin@a.test');
  begin update public.organizations set plan = 'enterprise' where id = pg_temp.id('orgA'); exception when others then null; end;
  begin update public.organizations set created_by = pg_temp.id('staff') where id = pg_temp.id('orgA'); exception when others then null; end;
  perform pg_temp.su(); select plan, created_by into p, c from public.organizations where id = pg_temp.id('orgA');
  perform pg_temp.res('mass-assign: a studio admin cannot change the plan or created_by', p = 'pro' and c is distinct from pg_temp.id('staff'), p||' / '||coalesce(c::text,'null'));
end $$;
do $$ declare c text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set code = 'HACK-0001' where id = pg_temp.id('refund'); exception when others then null; end;
  perform pg_temp.su(); select code into c from public.quotes where id = pg_temp.id('refund');
  perform pg_temp.res('mass-assign: the quote code cannot be changed through the API', c = 'R2-REFUND', c);
end $$;
do $$ declare n text; begin
  perform pg_temp.login('a_admin@a.test');
  begin update public.organizations set location = 'Hyderabad' where id = pg_temp.id('orgA');
  exception when others then perform pg_temp.res('mass-assign: normal studio settings still save', false, sqlerrm); return; end;
  perform pg_temp.su(); select location into n from public.organizations where id = pg_temp.id('orgA');
  perform pg_temp.res('mass-assign: normal studio settings still save', n = 'Hyderabad', coalesce(n,'null'));
end $$;

-- ================= 9) upload rate counts uploads, not surviving objects ============
do $$ declare ok boolean; n int; begin
  perform pg_temp.su();
  -- 100 uploads in the last 10 minutes that were deleted again (log only, no objects)
  begin
    execute 'insert into public.storage_upload_log(owner, bucket_id, created_at) select $1, ''invite-media'', now() - interval ''1 minute'' from generate_series(1,100)'
      using pg_temp.id('staff');
  exception when others then null; end;
  perform pg_temp.login('a_staff@a.test');
  ok := public.storage_upload_allowed('invite-media',
          pg_temp.id('orgA')::text || '/' || pg_temp.id('qA')::text || '/' || replace(gen_random_uuid()::text, '-', '') || '.png');
  perform pg_temp.res('uploads: delete + re-upload no longer resets the per-user rate', ok is false, 'allowed '||coalesce(ok::text,'null'));
end $$;
do $$ declare n0 int := 0; n1 int := 0; begin
  perform pg_temp.su();
  begin execute 'select count(*) from public.storage_upload_log' into n0; exception when others then null; end;
  insert into storage.objects(bucket_id, name, owner)
    values ('invite-media', 'a0000000-0000-4000-8000-000000000001/r2/log-test.png', pg_temp.id('admin'));
  begin execute 'select count(*) from public.storage_upload_log' into n1; exception when others then null; end;
  delete from storage.objects where name = 'a0000000-0000-4000-8000-000000000001/r2/log-test.png';
  perform pg_temp.res('uploads: every upload is logged', n1 = n0 + 1, n0||' -> '||n1);
end $$;

-- ================= 10) invitation slug randomness ==================================
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  begin s := (public.publish_event_site(pg_temp.id('site_row'), true)).slug;
  exception when others then perform pg_temp.res('slug: a newly published invitation link has >= 64 random bits', false, sqlerrm); return; end;
  perform pg_temp.res('slug: a newly published invitation link has >= 64 random bits', s ~ '-[0-9a-f]{16}$', s);
end $$;

-- ================= 11) OTP: phone on file + cumulative lockout ======================
do $$ declare r jsonb; n int; begin
  perform pg_temp.anon();
  begin r := public.request_otp(pg_temp.id('tok_otp'), '+919000000001'); exception when others then r := null; end;
  perform pg_temp.su(); select count(*) into n from public.quote_otps where quote_id = pg_temp.id('otp') and phone = '+919000000001';
  perform pg_temp.res('otp: a code is not sent to a number other than the client phone on file', r is null and n = 0, coalesce(r::text,'refused')||' / '||n);
end $$;
do $$ declare r jsonb; v jsonb; begin
  perform pg_temp.anon();
  r := public.request_otp(pg_temp.id('tok_otp'), '+919811122222');
  v := public.verify_and_consent(pg_temp.id('tok_otp'), '+919811122222', r->>'dev_code', true, 'v1', 'I accept', 'Rita', 'ua');
  perform pg_temp.res('otp: the client phone on file still gets a code and approves', v->>'approved' = 'true', r::text||' / '||v::text);
exception when others then perform pg_temp.res('otp: the client phone on file still gets a code and approves', false, sqlerrm);
end $$;
do $$ declare r jsonb; v jsonb; begin
  perform pg_temp.su();   -- a fresh valid code for the locked link (as if requested earlier)
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (pg_temp.id('lock'), '+919811122222', extensions.crypt('135790', extensions.gen_salt('bf')), now() + interval '10 minutes');
  perform pg_temp.anon();
  begin r := public.request_otp(pg_temp.id('tok_lock'), '+919811122222'); exception when others then r := null; end;
  v := public.verify_and_consent(pg_temp.id('tok_lock'), '+919811122222', '135790', true, 'v1', 'I accept', 'Rita', 'ua');
  perform pg_temp.res('otp: 15 wrong codes on a link lock it for 24 h (no new code, right code refused)',
    r is null and coalesce(v->>'approved','') <> 'true', coalesce(r::text,'refused')||' / '||v::text);
exception when others then perform pg_temp.res('otp: 15 wrong codes on a link lock it for 24 h (no new code, right code refused)', false, sqlerrm);
end $$;

-- ================= 2b) helm_total_paid: never for signed-in users =================
do $$ declare v numeric; ok boolean := false; begin
  perform pg_temp.login('b_admin@b.test');
  begin v := public.helm_total_paid(pg_temp.id('qA'), null, null); exception when others then ok := true; end;
  perform pg_temp.res('grants: a signed-in user cannot sum another studio''s payments (helm_total_paid)', ok, 'returned '||coalesce(v::text,'null'));
end $$;

-- ================= 2) grant drift healed (re-creates prod drift, re-applies 0032) ==
do $$ declare f record; begin
  perform pg_temp.su();
  for f in select p.oid::regprocedure::text as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('helm_total_paid','layouts_quarantined_count','invitation_by_token','get_pricing_config',
                                'nurture_due','task_verify_summary','studio_slug_free','studio_slug_pick','has_area',
                                'is_admin','can_edit','can_create','can_delete','current_org_id','user_role')
  loop execute 'grant execute on function '||f.sig||' to public, anon'; end loop;
  drop function if exists public.invitation_preview(text);
end $$;
\i supabase/migrations/0032_rescore2_fixes.sql
-- forward-only order: everything after 0032 is re-applied too (0033 replaces some 0032 wrappers)
\i supabase/migrations/0033_rescore3_fixes.sql
set client_min_messages = warning;
do $$ declare bad text; begin
  perform pg_temp.su();
  select string_agg(p.proname, ', ' order by p.proname) into bad from pg_proc p
   where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'EXECUTE')
     and p.proname in ('helm_total_paid','layouts_quarantined_count','invitation_by_token','get_pricing_config',
                       'nurture_due','task_verify_summary','studio_slug_free','studio_slug_pick','has_area',
                       'is_admin','can_edit','can_create','can_delete','current_org_id','user_role');
  perform pg_temp.res('grants: anon cannot execute internal helpers (prod drift healed)', bad is null, bad);
end $$;
do $$ declare bad text; begin
  perform pg_temp.su();
  select string_agg(x, ', ') into bad from unnest(array[
      'public.public_get_quote(uuid)','public.public_get_portal(uuid)','public.public_get_proposal(uuid)',
      'public.public_event_site(text)','public.request_otp(uuid,text)','public.create_payment(uuid)',
      'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)','public.worker_get_tasks(uuid)',
      'public.worker_respond(uuid,uuid,text)','public.public_link_studio(text,text,text)',
      'public.invite_media_on_published_site(text)','public.invitation_preview(text)']) x
   where to_regprocedure(x) is null or not has_function_privilege('anon', x, 'EXECUTE');
  perform pg_temp.res('grants: every client-link RPC stays callable signed out (invitation_preview re-created)', bad is null, bad);
end $$;
do $$ declare bad text; begin
  perform pg_temp.su();
  select string_agg(x, ', ') into bad from unnest(array[
      'public.has_area(text,text)','public.current_org_id()','public.get_pricing_config()','public.is_admin()',
      'public.can_edit()','public.user_role()','public.nurture_due(integer)','public.task_verify_summary(uuid)']) x
   where to_regprocedure(x) is not null and not has_function_privilege('authenticated', x, 'EXECUTE');
  perform pg_temp.res('grants: signed-in access to app helpers is preserved', bad is null, bad);
  perform pg_temp.res('grants: helm_total_paid is internal-only (not authenticated)',
    not has_function_privilege('authenticated', 'public.helm_total_paid(uuid,uuid,uuid)', 'EXECUTE'), 'authenticated can execute');
end $$;
do $$ declare r jsonb; begin
  perform pg_temp.anon();
  r := public.invitation_preview(repeat('0', 48));
  perform pg_temp.res('grants: the signed-out invite banner (invitation_preview) works', r->>'status' = 'not_found', r::text);
exception when others then perform pg_temp.res('grants: the signed-out invite banner (invitation_preview) works', false, sqlerrm);
end $$;

-- ---- cleanup (superuser; owner maintenance switch for the guarded test events) ----
do $$ declare k text; begin
  perform pg_temp.su();
  perform auth.login_as(pg_temp.id('admin')); execute 'reset role';
  perform set_config('helm.allow_financial_delete', 'on', true);
  begin execute 'delete from public.storage_upload_log where owner = $1' using pg_temp.id('staff'); exception when others then null; end;
  delete from public.leads where notes = 'r2-lead';
  delete from public.event_sites where id = pg_temp.id('site_row');
  delete from public.event_closure where quote_id = pg_temp.id('refund');
  delete from public.quote_consents where quote_id = pg_temp.id('otp');
  foreach k in array array['refund','price','date','legacy','site','otp','lock'] loop
    delete from public.quotes where id = pg_temp.id(k);
  end loop;
  delete from public.inventory_items where id = pg_temp.id('item');
  delete from public.app_config where org_id = pg_temp.id('orgA') and key = 'channels';
  update public.organizations set location = null where id = pg_temp.id('orgA');
  delete from public.role_access where role = 'sales' and area in ('settlement','closure','inventory') and org_id = pg_temp.id('orgA');
end $$;
select name, result from _r2 order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 33 then 'RESCORE2-FIXES: ALL PASS (33/33)'
            else 'RESCORE2-FIXES: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/33 ran' end from _r2;
