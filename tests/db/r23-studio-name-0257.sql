-- r23-studio-name-0257.sql -- r23 owner decision: the studio NAME and LINK are set once at creation and can never be
-- changed from the app (admin, staff, coordinator, free-trial owner, any RPC path). Creation still sets both; the SQL
-- editor / service_role can (support), old links keep working, audit row written. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.as_hq(p_email text, p_aal text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.org(p_id uuid) returns text language sql as $$ select name || '|' || public_slug from public.organizations where id = p_id $$;
grant execute on function pg_temp.org(uuid) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_role text default 'admin', p_org uuid default null) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = u;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role;
  return u;
end $$;

-- earlier suites in run-all may re-apply older migrations: re-run 0257 (also proves a re-run is safe)
\ir ../../supabase/migrations/0257_studio_name_link.sql

do $$ begin
  perform pg_temp.su();
  update public.organizations set public_slug = 'studio-a', name = 'Studio A' where id = 'a0000000-0000-4000-8000-000000000001';
  update public.organizations set public_slug = 'studio-b', name = 'Studio B' where id = 'b0000000-0000-4000-8000-000000000001';
  delete from public.audit_log where action in ('studio.renamed', 'studio.link_renamed');
  perform pg_temp.newuser('a_coord_r23@a.test', 'coordinator', 'a0000000-0000-4000-8000-000000000001');
  insert into public.platform_admins(email, added_by) values ('hq_r23@helm.events', 'test') on conflict do nothing;
  if not exists (select 1 from auth.users where email = 'hq_r23@helm.events') then perform auth.seed_user('hq_r23@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'hq_r23@helm.events';
exception when others then perform pg_temp.su(); insert into _rs values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) nobody in the app can change name / link of an existing studio ----------------------------------------------
do $$ declare e text; vA uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.as_user('a_admin@a.test');
  e := pg_temp.try('update public.organizations set name = ''Admin Rename'' where id = ''a0000000-0000-4000-8000-000000000001''');
  perform pg_temp.res('01 admin: direct name change refused (studio_identity_locked)', e like '42501%can''t be changed%', e);
  e := pg_temp.try('update public.organizations set public_slug = ''admin-rename'' where id = ''a0000000-0000-4000-8000-000000000001''');
  perform pg_temp.res('02 admin: direct link change refused', e like '42501%can''t be changed%', e);
  e := pg_temp.try('select public.set_studio_link_name(''admin-rpc'')');
  perform pg_temp.res('03 admin: old set_studio_link_name endpoint closed', e like '42501%', e);
  e := pg_temp.try('update public.organizations set business_email = ''hello@studio-a.test'' where id = ''a0000000-0000-4000-8000-000000000001''');
  perform pg_temp.res('04 admin: other studio settings still save (e.g. business e-mail)', e = '', e);
  e := pg_temp.try('update public.organizations set name = ''Studio A'', public_slug = ''studio-a'', currency = currency where id = ''a0000000-0000-4000-8000-000000000001''');
  perform pg_temp.res('05 admin: a save that sends the SAME name / link is fine', e = '', e);
  perform pg_temp.as_user('a_coord_r23@a.test');
  e := pg_temp.try('update public.organizations set name = ''Coord Rename'', public_slug = ''coord-rename'' where id = ''a0000000-0000-4000-8000-000000000001''');
  perform pg_temp.su();
  perform pg_temp.res('06 coordinator: no change (refused or no rights)', pg_temp.org(vA) = 'Studio A|studio-a', e);
  perform pg_temp.as_user('a_staff@a.test');
  e := pg_temp.try('update public.organizations set name = ''Staff Rename'' where id = ''a0000000-0000-4000-8000-000000000001''');
  perform pg_temp.su();
  perform pg_temp.res('07 staff: no change', pg_temp.org(vA) = 'Studio A|studio-a', e);
  perform pg_temp.res('08 nothing changed, nothing audited', pg_temp.org(vA) = 'Studio A|studio-a'
    and not exists (select 1 from public.audit_log where org_id = vA and action in ('studio.renamed', 'studio.link_renamed')));
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) creation still sets name + link; afterwards the trial owner can't change them (welcome included) ------------
do $$ declare r jsonb; o uuid; e text; begin
  perform pg_temp.newuser('r23_trial@t.test', 'admin', null);
  perform pg_temp.as_user('r23_trial@t.test');
  r := public.start_self_serve_trial('Sparkle Events', 'Asia/Kolkata', 'INR', 'demo');
  o := (r ->> 'org_id')::uuid; perform pg_temp.su(); insert into _kv values ('trial', o::text);
  perform pg_temp.res('09 sign-up (free trial): name + link set at creation', pg_temp.org(o) = 'Sparkle Events|sparkle-events', coalesce(pg_temp.org(o), r::text));
  perform pg_temp.as_user('r23_trial@t.test');
  e := pg_temp.try('select public.trial_welcome_save(''S Koushik'', ''Hyderabad'', ''Telangana'', null, ''IN'')');
  perform pg_temp.res('10 trial welcome with a DIFFERENT name: refused', e like '42501%can''t be changed%', e);
  e := pg_temp.try('select public.trial_welcome_save(''Sparkle Events'', ''Hyderabad'', ''Telangana'', null, ''IN'')');
  perform pg_temp.res('11 trial welcome with the SAME name (city / state only): works', e = '', e);
  e := pg_temp.try(format('update public.organizations set public_slug = %L where id = %L', 'sparkle-2', o));
  perform pg_temp.su();
  perform pg_temp.res('12 trial owner: link unchanged after every attempt', pg_temp.org(o) = 'Sparkle Events|sparkle-events', pg_temp.org(o));
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare o uuid; e text; begin
  perform pg_temp.newuser('r23_paid@t.test', 'admin', null);
  perform pg_temp.as_user('r23_paid@t.test');
  o := public.create_studio('Aurora Weddings', null, 'INR', 'Asia/Kolkata');
  perform pg_temp.su();
  perform pg_temp.res('13 sign-up (paid / create_studio): name + link set at creation', pg_temp.org(o) = 'Aurora Weddings|aurora-weddings', coalesce(pg_temp.org(o), 'null'));
  perform pg_temp.as_user('r23_paid@t.test');
  e := pg_temp.try(format('update public.organizations set name = %L where id = %L', 'Aurora Events', o));
  perform pg_temp.su();
  perform pg_temp.res('14 paid admin: rename right after creation refused', e like '42501%can''t be changed%' and pg_temp.org(o) = 'Aurora Weddings|aurora-weddings', e);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) support escape hatch: SQL editor / service role; old links keep working; audited ---------------------------
do $$ declare j jsonb; s text; t uuid; vA uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();                                                     -- SQL editor: no JWT
  update public.organizations set name = 'Aurora Events', public_slug = 'aurora-events' where id = vA;
  perform pg_temp.res('15 SQL editor (support) can change name + link', pg_temp.org(vA) = 'Aurora Events|aurora-events');
  perform pg_temp.res('16 old link kept in org_slug_history', exists (select 1 from public.org_slug_history where org_id = vA and slug = 'studio-a'));
  perform pg_temp.res('17 audit: studio.renamed + studio.link_renamed by helm:support',
    exists (select 1 from public.audit_log where org_id = vA and action = 'studio.renamed' and actor_email = 'helm:support' and changed ->> 'to' = 'Aurora Events')
    and exists (select 1 from public.audit_log where org_id = vA and action = 'studio.link_renamed' and changed ->> 'from' = 'studio-a' and changed ->> 'to' = 'aurora-events'));
  perform pg_temp.as_user('a_admin@a.test');
  j := public.my_studio_route('studio-a');
  perform pg_temp.res('18 app link with the OLD name still opens (-> new name)', (j ->> 'own')::boolean and j ->> 'slug' = 'aurora-events', j::text);
  perform pg_temp.su();
  select approval_token into t from public.quotes where org_id = vA and approval_token is not null limit 1;
  if t is null then update public.quotes set approval_token = gen_random_uuid() where id = (select id from public.quotes where org_id = vA limit 1) returning approval_token into t; end if;
  perform auth.login_anon();
  s := public.public_link_studio('quote', t::text, 'studio-a');
  perform pg_temp.su();
  perform pg_temp.res('19 client quote link with the OLD name still resolves', s = 'aurora-events', coalesce(s, 'null'));
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  update public.organizations set name = 'Aurora Events Co' where id = vA;
  perform pg_temp.su();
  perform pg_temp.res('20 service_role can change it too', pg_temp.org(vA) = 'Aurora Events Co|aurora-events');
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3b) Helm HQ can change it (two-step, reason), studio told, old links kept ---------------------------------------------
do $$ declare e text; r jsonb; vB uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.as_user('b_admin@b.test');
  e := pg_temp.try($q$select public.hq_set_studio_identity('b0000000-0000-4000-8000-000000000001', 'Bloom Decor', 'bloom-decor', 'asked by the owner on a call')$q$);
  perform pg_temp.res('24 studio admin cannot use the HQ call', e like '42501%', e);
  perform pg_temp.as_hq('hq_r23@helm.events', 'aal1');
  e := pg_temp.try($q$select public.hq_set_studio_identity('b0000000-0000-4000-8000-000000000001', 'Bloom Decor', 'bloom-decor', 'asked by the owner on a call')$q$);
  perform pg_temp.res('25 HQ without two-step (aal1) refused', e like '42501%', e);
  perform pg_temp.as_hq('hq_r23@helm.events', 'aal2');
  e := pg_temp.try($q$select public.hq_set_studio_identity('b0000000-0000-4000-8000-000000000001', 'Bloom Decor', 'bloom-decor', 'short')$q$);
  perform pg_temp.res('26 HQ: a reason is required (10+ chars)', e like '22023%reason%', e);
  e := pg_temp.try($q$select public.hq_set_studio_identity('b0000000-0000-4000-8000-000000000001', null, 'aurora-events', 'asked by the owner on a call')$q$);
  perform pg_temp.res('27 HQ: another studio''s link refused', e like '22023%another studio%', e);
  e := pg_temp.try($q$select public.hq_set_studio_identity('b0000000-0000-4000-8000-000000000001', null, 'studio-a', 'asked by the owner on a call')$q$);
  perform pg_temp.res('28 HQ: another studio''s RETIRED link refused (old links keep pointing at them)', e like '22023%another studio%', e);
  e := pg_temp.try($q$select public.hq_set_studio_identity('b0000000-0000-4000-8000-000000000001', null, 'aur0ra-events', 'asked by the owner on a call')$q$);
  perform pg_temp.res('29 HQ: a look-alike of another studio (aur0ra-events) refused', e like '22023%looks like%', e);
  e := pg_temp.try($q$select public.hq_set_studio_identity('b0000000-0000-4000-8000-000000000001', null, 'he1m-support', 'asked by the owner on a call')$q$);
  perform pg_temp.res('30 HQ: a Helm look-alike (he1m-support) refused', e like '22023%reserved%', e);
  r := public.hq_set_studio_identity('b0000000-0000-4000-8000-000000000001', 'Bloom Decor', 'bloom-decor', 'asked by the owner on a call');
  perform pg_temp.su();
  perform pg_temp.res('31 HQ (two-step) changes name + link', (r ->> 'changed')::boolean and pg_temp.org(vB) = 'Bloom Decor|bloom-decor', r::text);
  perform pg_temp.res('32 old link kept; HQ audit with reason; studio.link_renamed by the operator',
    exists (select 1 from public.org_slug_history where org_id = vB and slug = 'studio-b')
    and exists (select 1 from public.audit_log where action = 'hq.studio.identity' and entity_id = vB::text and changed ->> 'reason' = 'asked by the owner on a call')
    and exists (select 1 from public.audit_log where org_id = vB and action = 'studio.link_renamed' and actor_email = 'hq_r23@helm.events'));
  perform pg_temp.res('33 studio told: bell row + queued e-mail',
    exists (select 1 from public.notifications where org_id = vB and kind = 'studio_identity_changed' and detail ->> 'link_to' = 'bloom-decor')
    and exists (select 1 from public.helm_notice_outbox where org_id = vB and kind = 'studio_identity' and payload ->> 'link_from' = 'studio-b'));
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  r := public.helm_notice_outbox_claim(50);
  perform pg_temp.su();
  perform pg_temp.res('34 e-mail goes to the studio''s admins with old -> new',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'kind' = 'studio_identity' and x -> 'to' ? 'b_admin@b.test'
            and x -> 'data' ->> 'link_to' = 'bloom-decor' and x -> 'data' ->> 'name_from' = 'Studio B'), left(r::text, 300));
  perform pg_temp.as_hq('hq_r23@helm.events', 'aal2');
  r := public.hq_studio_link_check(vB, 'studio-b');
  perform pg_temp.res('35 HQ check: the studio''s own old link is available again (previous)', (r ->> 'ok')::boolean and (r ->> 'previous')::boolean, r::text);
  r := public.hq_studio_link_check(vB, 'adm1n');
  perform pg_temp.res('36 HQ check: adm1n reserved', r ->> 'reason' = 'reserved', r::text);
  perform pg_temp.as_user('b_admin@b.test');
  e := pg_temp.try($q$update public.organizations set name = 'Back To B' where id = 'b0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('37 the HQ change does not unlock the studio (admin still refused)', e like '42501%can''t be changed%', e);
  e := pg_temp.try($q$select public.hq_studio_link_check('b0000000-0000-4000-8000-000000000001', 'x-y-z')$q$);
  perform pg_temp.res('38 HQ check is HQ-only', e like '42501%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('4y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3c) sign-up never hands out a look-alike or a Helm word ---------------------------------------------------------------
do $$ declare o uuid; s text; begin
  perform pg_temp.su(); update public.organizations set public_slug = 'bloom-decor' where id = 'b0000000-0000-4000-8000-000000000001' and public_slug <> 'bloom-decor';
  perform pg_temp.newuser('r23_look@t.test', 'admin', null);
  perform pg_temp.as_user('r23_look@t.test');
  o := public.create_studio('Bl00m Decor', null, 'INR', 'Asia/Kolkata');
  perform pg_temp.su(); s := (select public_slug from public.organizations where id = o);
  perform pg_temp.res('39 "Bl00m Decor" next to bloom-decor gets its own non-look-alike link',
    s <> 'bl00m-decor' and public._r23_slug_skeleton(s) <> public._r23_slug_skeleton('bloom-decor'), s);
  perform pg_temp.newuser('r23_brand@t.test', 'admin', null);
  perform pg_temp.as_user('r23_brand@t.test');
  o := public.create_studio('Helm Support', null, 'INR', 'Asia/Kolkata');
  perform pg_temp.su(); s := (select public_slug from public.organizations where id = o);
  perform pg_temp.res('40 "Helm Support" never gets a helm-... link', not public._r23_slug_protected(s) and s not like 'helm%', s);
  perform pg_temp.res('41 skeleton folds look-alikes', public._r23_slug_skeleton('He1m-Ev3nts') = public._r23_slug_skeleton('helmevents')
    and public._r23_slug_skeleton('rnoon') = public._r23_slug_skeleton('moon') and public._r23_slug_protected('supp0rt')
    and public._r23_slug_protected('helm') and public._r23_slug_protected('my-helm') and not public._r23_slug_protected('helmet-events')
    and not public._r23_slug_protected('aurora-events'));
exception when others then perform pg_temp.su(); insert into _rs values ('4z', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) grants / shape -------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('21 set_studio_link_name not callable by the app; trigger functions not callable',
    not has_function_privilege('authenticated', 'public.set_studio_link_name(text)', 'execute')
    and not has_function_privilege('anon', 'public.set_studio_link_name(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.tg_r23_org_identity_lock()', 'execute')
    and not has_function_privilege('authenticated', 'public.tg_r23_org_identity_audit()', 'execute'));
  perform pg_temp.res('22 no studio-side edit RPC exists; HQ calls signed-in only (checks inside); helpers private',
    to_regproc('public.set_studio_identity') is null and to_regproc('public.studio_link_name_check') is null
    and has_function_privilege('authenticated', 'public.hq_set_studio_identity(uuid,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_set_studio_identity(uuid,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_studio_link_check(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_link_check(uuid,text)', 'execute'));
  perform pg_temp.res('23 every studio still has a valid link name', not exists (select 1 from public.organizations where public_slug is null or not public.studio_slug_valid(public_slug)));
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R23-STUDIO-NAME-0257: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R23-STUDIO-NAME-0257: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
