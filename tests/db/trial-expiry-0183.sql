-- trial-expiry-0183.sql -- 0183: an ended, unpaid free trial is READ-ONLY for everyone (owner + invited members).
-- Reads allowed; inserts / updates / deletes refused (25006 trial_ended, owner's text); own profile / personal
-- rows / bell / billing details still allowed; members are no longer blocked; extension + payment unlock;
-- paid / converted studios unaffected. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _te(name text, result text); grant all on _te to anon, authenticated, service_role;
create temp table _tkv(k text primary key, v text); grant all on _tkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _te values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
-- '' on success, else "<sqlstate> <hint> | <message>"
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || coalesce(h, '') || ' | ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _tkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _tkv where k = p_k $$;
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
  r := public.start_self_serve_trial('TE ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- the trial ends (both dates in the past), exactly like 8 days later
create or replace function pg_temp.expire(p_org uuid) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() - interval '1 hour' where id = p_org;
  update public.studio_subscriptions set trial_ends_at = current_date - 1 where org_id = p_org;
end $$;
-- the owner's text, as the database raises it
create or replace function pg_temp.ro(p_e text) returns boolean language sql as $$
  select p_e like '25006 trial_ended | Your trial has ended. Your data is preserved and available in read-only mode. Upgrade now to continue creating and editing records.%'
$$;
grant execute on function pg_temp.ro(text) to anon, authenticated, service_role;

-- earlier suites in run-all re-apply older migrations (0116 / 0120 / 0126 / 0159) over these bodies: re-run 0183
-- (also proves a re-run is safe)
\ir ../../supabase/migrations/0183_trial_expiry_read_only.sql

-- ---- during the trial: everything writable, nothing read-only -------------------------------------------
do $$ declare o uuid; m uuid; e text; j jsonb; begin
  o := pg_temp.trial('te_owner@t.test'); perform pg_temp.put('o', o::text);
  m := pg_temp.newuser('te_member@t.test');
  update public.profiles set org_id = o, role = 'manager' where id = m;
  perform pg_temp.put('m', m::text);
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('manager', 'leads', true, true, o, now()) on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
  perform pg_temp.res('01 trial studio is in its trial (status trial)', public._is_trial_org(o) and not public._trial_locked(o));
  perform pg_temp.login('te_owner@t.test');
  e := pg_temp.try('insert into public.leads(name) values (''TE owner lead'')');
  perform pg_temp.res('02 trial: owner adds a lead', e = '', e);
  j := public.my_trial_org();
  perform pg_temp.res('03 trial: my_trial_org not read-only', j ->> 'is_trial_org' = 'true' and j ->> 'read_only' = 'false'
    and j ->> 'ended' = 'false', j::text);
  perform pg_temp.login('te_member@t.test');
  e := pg_temp.try('insert into public.leads(name) values (''TE member lead'')');
  perform pg_temp.res('04 trial: invited member adds a lead', e = '', e);
  perform pg_temp.login('te_owner@t.test');
  e := pg_temp.try('select public.create_invitation(''te_late@t.test'', ''sales'')');
  perform pg_temp.res('05 trial: owner invites a 3rd person', e = '', e);
  perform pg_temp.su();
  perform pg_temp.put('lead', (select id::text from public.leads where org_id = o and name = 'TE owner lead'));
exception when others then perform pg_temp.su(); insert into _te values ('0x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- the trial ends: read-only for the owner ----------------------------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; lead uuid := pg_temp.get('lead')::uuid; e text; n int; j jsonb; begin
  perform pg_temp.expire(o);
  perform pg_temp.res('10 ended trial is read-only (_trial_locked)', public._trial_locked(o) and public._trial_effective_end(o) <= now());
  select count(*) into n from public.leads where org_id = o;
  perform pg_temp.login('te_owner@t.test');
  perform pg_temp.res('11 owner still reads everything', (select count(*) from public.leads) = n and n >= 2, n::text);
  e := pg_temp.try('insert into public.leads(name) values (''TE late lead'')');
  perform pg_temp.res('12 owner: add refused with the owner''s text (25006 trial_ended)', pg_temp.ro(e), e);
  e := pg_temp.try(format('update public.leads set notes = ''x'' where id = %L', lead));
  perform pg_temp.res('13 owner: edit refused', pg_temp.ro(e), e);
  e := pg_temp.try(format('delete from public.leads where id = %L', lead));
  perform pg_temp.res('14 owner: delete refused', pg_temp.ro(e), e);
  e := pg_temp.try('insert into public.vendors(name) values (''TE late vendor'')');
  perform pg_temp.res('15 owner: other studio tables refused too (vendors)', pg_temp.ro(e), e);
  j := public.my_trial_org();
  perform pg_temp.res('16 my_trial_org: ended + read_only + locked', j ->> 'is_trial_org' = 'true' and j ->> 'read_only' = 'true'
    and j ->> 'locked' = 'true' and j ->> 'ended' = 'true' and j ->> 'is_admin' = 'true', j::text);
  e := pg_temp.try('select public.set_my_display_name(''TE Owner'')');
  perform pg_temp.res('17 owner: own profile (display name) still editable', e = '', e);
  e := pg_temp.try(format('select public.admin_set_display_name(%L, ''Hacked'')', pg_temp.get('m')));
  perform pg_temp.su();
  perform pg_temp.res('18 owner: another member''s profile is not changed', e <> ''
    and (select coalesce(full_name, '') from public.profiles where id = pg_temp.get('m')::uuid) <> 'Hacked', e);
  perform pg_temp.login('te_owner@t.test');
  e := pg_temp.try(format('update public.studio_account set city = ''Hyderabad'' where org_id = %L', o));
  perform pg_temp.res('19 owner: billing details (studio_account) not refused by the read-only guard', e not like '25006%', e);
  e := pg_temp.try(format('insert into public.user_recent_records(user_id, org_id, href, title, kind, opened_at) values (auth.uid(), %L, ''/x'', ''x'', ''page'', now())', o));
  perform pg_temp.res('20 owner: own recent-records row still written', e not like '25006%', e);
  perform pg_temp.su();
  perform pg_temp.res('21 nothing changed in the studio data', (select count(*) from public.leads where org_id = o) = n
    and (select notes is distinct from 'x' from public.leads where id = lead));
exception when others then perform pg_temp.su(); insert into _te values ('1x owner', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- invited members keep READ-ONLY access (no longer blocked) -----------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; m uuid := pg_temp.get('m')::uuid; lead uuid := pg_temp.get('lead')::uuid;
  e text; n int; j jsonb; cv uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  select count(*) into n from public.leads where org_id = o;
  insert into public.chat_conversations(id, org_id, kind, title, created_by) values (cv, o, 'group', 'TE group', m);
  insert into public.chat_members(conversation_id, user_id, org_id, member_role) values (cv, m, o, 'member');
  perform pg_temp.login('te_member@t.test');
  perform pg_temp.res('30 member is not blocked: current_org_id = the studio', public.current_org_id() = o);
  perform pg_temp.res('31 member reads the studio data', (select count(*) from public.leads) = n and n >= 2, n::text);
  e := pg_temp.try('insert into public.leads(name) values (''TE member late lead'')');
  perform pg_temp.res('32 member: add refused with the owner''s text', pg_temp.ro(e), e);
  e := pg_temp.try(format('update public.leads set notes = ''m'' where id = %L', lead));
  perform pg_temp.res('33 member: edit refused', pg_temp.ro(e), e);
  e := pg_temp.try(format('delete from public.leads where id = %L', lead));
  perform pg_temp.res('34 member: delete refused', pg_temp.ro(e), e);
  j := public.my_trial_access();
  perform pg_temp.res('35 my_trial_access: not blocked, read_only, not owner', j ->> 'blocked' = 'false' and j ->> 'read_only' = 'true'
    and j ->> 'is_owner' = 'false' and j ->> 'is_trial_org' = 'true', j::text);
  j := public.my_trial_org();
  perform pg_temp.res('36 my_trial_org for a member: read_only, not admin', j ->> 'read_only' = 'true' and j ->> 'is_admin' = 'false', j::text);
  e := pg_temp.try(format('select public.chat_mark_read(%L)', cv));
  perform pg_temp.su();
  perform pg_temp.res('37 member: marking chat as read still works', e = ''
    and (select last_read_at is not null from public.chat_members where conversation_id = cv and user_id = m), e);
  perform pg_temp.login('te_member@t.test');
  e := pg_temp.try(format('update public.chat_members set member_role = ''admin'' where conversation_id = %L and user_id = auth.uid()', cv));
  perform pg_temp.res('38 member: own chat role change refused', e like '25006%' or e like '42501%', e);
  e := pg_temp.try(format('insert into public.chat_messages(conversation_id, org_id, sender_id, body) values (%L, %L, auth.uid(), ''hi'')', cv, o));
  perform pg_temp.res('39 member: new chat message refused', e <> '', e);
  perform pg_temp.res('40 uploads: refused for a read-only studio member, own avatar allowed',
    not public.trial_storage_write_ok('event-docs') and not public.trial_storage_write_ok('chat-media')
    and public.trial_storage_write_ok('member-avatars'));
  perform pg_temp.login('te_owner@t.test');
  e := pg_temp.try('select public.create_invitation(''te_later@t.test'', ''sales'')');
  perform pg_temp.res('43 owner: new invitation refused while read-only', pg_temp.ro(e), e);
  perform pg_temp.newuser('te_late@t.test'); perform pg_temp.login('te_late@t.test');
  e := pg_temp.try(format('select public.accept_invitation(%L)', (select token from public.invitations where org_id = o and email = 'te_late@t.test')));
  perform pg_temp.su();
  perform pg_temp.res('44 an invitation sent during the trial cannot be accepted while read-only (nothing changed)', e <> ''
    and (select org_id is null from public.profiles where email = 'te_late@t.test')
    and (select status from public.invitations where org_id = o and email = 'te_late@t.test') is distinct from 'accepted', e);
  perform pg_temp.res('41 memberships untouched (role + studio kept)', (select org_id = o and role = 'manager' from public.profiles where id = m));
  perform pg_temp.res('42 the old member gate is gone', not public._trial_member_blocked(o));
exception when others then perform pg_temp.su(); insert into _te values ('3x member', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- after the nightly job moved it to past_due: still read-only; anon storage untouched -------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; e text; begin
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'past_due' where org_id = o;     -- what _trial_refresh() does
  perform pg_temp.res('45 lapsed to past_due (never paid): still read-only', public._trial_locked(o) and not public._is_trial_org(o));
  perform pg_temp.login('te_member@t.test');
  e := pg_temp.try('insert into public.leads(name) values (''TE past_due lead'')');
  perform pg_temp.res('46 past_due trial: member add refused', pg_temp.ro(e), e);
  perform pg_temp.su(); perform auth.login_anon();
  perform pg_temp.res('47 anon (worker links) storage check unchanged', public.trial_storage_write_ok('task-proof'));
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'cancelled' where org_id = o;
  perform pg_temp.res('48 cancelled without ever paying: still read-only', public._trial_locked(o));
  update public.studio_subscriptions set status = 'trial' where org_id = o;
exception when others then perform pg_temp.su(); insert into _te values ('4x lapsed', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- an approved extension unlocks; ending it locks again --------------------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; e text; j jsonb; begin
  perform pg_temp.su();
  update public.studio_subscriptions set trial_ends_at = current_date + 7, status = 'trial' where org_id = o;  -- HQ extension (subscription date)
  perform pg_temp.res('50 extension on the subscription date: writable again', not public._trial_locked(o)
    and public._trial_effective_end(o) > now() + interval '6 days');
  perform pg_temp.login('te_member@t.test');
  e := pg_temp.try('insert into public.vendors(name) values (''TE ext vendor'')');
  perform pg_temp.res('51 extension: member writes again', e = '', e);
  j := public.my_trial_org();
  perform pg_temp.res('52 extension: banner shows days left, not read-only', j ->> 'read_only' = 'false' and j ->> 'ended' = 'false'
    and (j ->> 'days_left')::int between 7 and 8, j::text);
  perform pg_temp.su();
  update public.studio_subscriptions set trial_ends_at = current_date - 1 where org_id = o;
  update public.organizations set trial_ends_at = now() + interval '3 days' where id = o;                     -- extension on the studio date
  perform pg_temp.res('53 extension on the studio date: writable', not public._trial_locked(o));
  update public.organizations set trial_ends_at = now() - interval '1 minute' where id = o;
  perform pg_temp.res('54 extension over: read-only again', public._trial_locked(o));
exception when others then perform pg_temp.su(); insert into _te values ('5x extension', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- paying unlocks at once; a converted studio is never treated as a trial --------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; e text; j jsonb; begin
  perform pg_temp.su();
  insert into public.subscription_payments(org_id, amount, currency, paid_on, period_start, period_end, method, reference)
    values (o, 1999, 'INR', current_date, current_date, current_date + 30, 'upi', 'TE-0183');
  update public.studio_subscriptions set status = 'active', current_period_start = current_date, current_period_end = current_date + 30 where org_id = o;
  perform pg_temp.res('60 paid: not read-only', not public._trial_locked(o));
  perform pg_temp.login('te_member@t.test');
  e := pg_temp.try('insert into public.leads(name) values (''TE paid lead'')');
  perform pg_temp.res('61 paid: member writes again (nobody re-invited)', e = '', e);
  j := public.my_trial_org();
  perform pg_temp.res('62 converted studio: no trial strip (is_trial_org false) despite the old trial date', j ->> 'is_trial_org' = 'false'
    and j ->> 'read_only' = 'false', j::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _te values ('6x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- an ex-trial that paid once and then lapsed (past_due) is a billing matter, never a trial lock -----------
do $$ declare o2 uuid; e text; begin
  o2 := pg_temp.trial('te_lapsed@t.test');
  perform pg_temp.expire(o2);
  insert into public.subscription_payments(org_id, amount, currency, paid_on, period_start, period_end, method, reference)
    values (o2, 1999, 'INR', current_date - 60, current_date - 60, current_date - 31, 'upi', 'TE-0183-L');
  update public.studio_subscriptions set status = 'past_due', current_period_start = current_date - 60, current_period_end = current_date - 31
   where org_id = o2;
  perform pg_temp.res('63 paid-then-lapsed ex-trial: not trial-locked (the 0116 rule locked it)', not public._trial_locked(o2)
    and not public._trial_paid(o2));
  perform pg_temp.login('te_lapsed@t.test');
  e := pg_temp.try('insert into public.leads(name) values (''TE lapsed lead'')');
  perform pg_temp.res('64 paid-then-lapsed: not refused as an ended trial', e not like '25006 trial_ended%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _te values ('6y lapsed paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- paid fixture studio: unchanged ------------------------------------------------------------------------
do $$ declare e text; A uuid := 'a0000000-0000-4000-8000-000000000001'; j jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('70 paid fixture studio never trial-locked', not public._trial_locked(A));
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('insert into public.leads(name) values (''A 0183 lead'')');
  perform pg_temp.res('71 paid studio: add works', e = '', e);
  e := pg_temp.try('update public.leads set notes = ''ok'' where name = ''A 0183 lead''');
  perform pg_temp.res('72 paid studio: edit works', e = '', e);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('73 paid studio: uploads not trial-blocked', public.trial_storage_write_ok('event-docs'));
  j := public.my_trial_org();
  perform pg_temp.res('74 paid studio: my_trial_org not a trial', j ->> 'is_trial_org' = 'false' and j ->> 'read_only' = 'false', j::text);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('delete from public.leads where name = ''A 0183 lead''');
  perform pg_temp.res('75 paid studio: admin delete works', e = '', e);
  perform pg_temp.su();
  -- a stale trial date on a paid (no subscription row) studio: still not locked
  update public.organizations set trial_ends_at = now() - interval '30 days' where id = A;
  perform pg_temp.res('76 paid studio with a stale trial date: not locked', not public._trial_locked(A));
  update public.organizations set trial_ends_at = null where id = A;
  -- the sample master is never locked
  perform pg_temp.res('77 sample master never locked', not exists (select 1 from public.organizations x where x.is_sample_master and public._trial_locked(x.id)));
exception when others then perform pg_temp.su(); insert into _te values ('7x paid fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- suspended + payment-pending branches still there --------------------------------------------------------
do $$ declare e text; B uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status, updated_at) values (B, 'suspended', now())
    on conflict (org_id) do update set status = 'suspended';
  perform pg_temp.login('b_staff@b.test');
  e := pg_temp.try('insert into public.leads(name) values (''B 0183 lead'')');
  perform pg_temp.res('80 suspended studio still refused (studio_suspended)', e like '25006 studio_suspended%', e);
  perform pg_temp.su();
  perform pg_temp.res('81 guard keeps the payment_pending branch', position('payment_pending' in pg_get_functiondef('public.tg_studio_read_only()'::regprocedure)) > 0);
exception when others then perform pg_temp.su(); insert into _te values ('8x other branches', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- shape --------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('90 helpers not callable by the app', not has_function_privilege('authenticated', 'public._trial_locked(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._trial_effective_end(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._trial_member_blocked(uuid)', 'execute'));
  perform pg_temp.res('91 my_trial_org / my_trial_access: members only (not anon)', has_function_privilege('authenticated', 'public.my_trial_org()', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_org()', 'execute')
    and has_function_privilege('authenticated', 'public.my_trial_access()', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_access()', 'execute'));
  perform pg_temp.res('92 storage policies are RESTRICTIVE (insert / update / delete)', (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and permissive = 'RESTRICTIVE'
      and policyname in ('trial_ro_storage_insert', 'trial_ro_storage_update', 'trial_ro_storage_delete')) = 3);
  perform pg_temp.res('93 WhatsApp proposal tables guarded', (select count(*) from pg_trigger where tgname = 'zzz_studio_read_only'
    and tgrelid in (to_regclass('public.wa_proposal_optins'), to_regclass('public.wa_proposal_audit'))) = 2);
  perform pg_temp.res('94 current_org_id keeps its 0043 + 0126 shape', position('_trial_member_blocked' in pg_get_functiondef('public.current_org_id()'::regprocedure)) > 0
    and position('mfa_ok' in pg_get_functiondef('public.current_org_id()'::regprocedure)) > 0);
end $$;

select name, result from _te order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-EXPIRY-0183: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-EXPIRY-0183: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _te;
rollback;
