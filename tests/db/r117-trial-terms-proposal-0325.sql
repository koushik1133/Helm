-- r117-trial-terms-proposal-0325.sql - 0325 (R117): the agreed free-trial terms say "nothing is sent to clients" (new
-- version trial-2026-11-01, re-acceptance) + public_trial_simulation_for_proposal(token) for the client proposal page.
-- Proves:
--   (1) terms: _trial_terms_version() = 'trial-2026-11-01' (= public/trial-facts.js VERSION); a trial owner who agreed to
--       trial-2026-10-20 gets must_agree again (the one-time window - nobody is locked out: every other trial call works);
--       a stale page (old version) is refused 22023; agreeing to the new version clears it; both agreements are kept;
--       a paid studio is never asked;
--   (2) proposal: trial -> {simulation:true}; paid -> {simulation:false}; unknown / malformed / unpublished / expired /
--       archived / cancelled / deleted -> null; nothing but the one key; reading writes nothing;
--   (3) structure: anon can execute; stable; security definer; empty search_path; version helper still app-closed.
-- Re-applies 0325 twice. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0325_r117_trial_terms_proposal.sql
\ir ../../supabase/migrations/0325_r117_trial_terms_proposal.sql
set client_min_messages = warning;
begin;
create temp table _t325(name text, result text); grant all on _t325 to anon, authenticated, service_role;
create temp table _t325kv(k text primary key, v text); grant all on _t325kv to anon, authenticated, service_role;

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
begin insert into _t325 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _t325kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _t325kv where k = p_k $$;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
-- the proposal answer as anon (text; '<null>' for null; 'err:..' on an error)
create or replace function pg_temp.prop(p_tok text) returns text language plpgsql as $$
declare v text; begin
  perform pg_temp.anon();
  v := coalesce(public.public_trial_simulation_for_proposal(p_tok)::text, '<null>');
  perform pg_temp.su(); return v;
exception when others then perform pg_temp.su(); return 'err:' || sqlstate || ':' || sqlerrm;
end $$;

-- ---- (1) terms ---------------------------------------------------------------------------------------------------
do $$ declare o uuid; u uuid; c jsonb; e text; r jsonb; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  u := pg_temp.newuser('r117_owner@t.test'); perform pg_temp.login('r117_owner@t.test');
  r := public.start_self_serve_trial('T r117', 'Asia/Kolkata', 'INR', 'demo');
  o := (r ->> 'org_id')::uuid; perform pg_temp.put('o', o::text);
  perform pg_temp.su();
  perform pg_temp.res('01 terms version = public/trial-facts.js VERSION (trial-2026-11-01)', public._trial_terms_version() = 'trial-2026-11-01');
  update public.organizations set trial_welcome_pending = false where id = o;
  insert into public.trial_terms_acceptances(org_id, user_id, version, kind, accepted_at)
    values (o, u, 'trial-2026-10-20', 'agree', now() - interval '1 day') on conflict do nothing;
  perform pg_temp.login('r117_owner@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('02 owner agreed to trial-2026-10-20 only: must_agree again for trial-2026-11-01 (re-acceptance window)',
    c ->> 'version' = 'trial-2026-11-01' and (c ->> 'must_agree')::boolean and (c ->> 'trial')::boolean, c::text);
  e := pg_temp.try('select public.my_trial_limits()') || pg_temp.try('select public.my_trial_org()');
  perform pg_temp.res('03 not locked out: the other trial calls still answer while the new terms are not agreed yet', e = '', e);
  e := pg_temp.try($q$select public.accept_trial_terms('trial-2026-10-20')$q$);
  perform pg_temp.res('04 a stale page (old version) is refused 22023', e like '22023%', e);
  r := public.accept_trial_terms('trial-2026-11-01');
  c := public.my_trial_terms_status();
  perform pg_temp.res('05 agreeing to the new version clears it', r ->> 'result' = 'ok' and not (c ->> 'must_agree')::boolean, r::text || ' ' || c::text);
  perform pg_temp.su();
  perform pg_temp.res('06 both agreements are kept (consent record per version)',
    (select count(*) from public.trial_terms_acceptances where org_id = o and user_id = u) = 2
    and exists (select 1 from public.trial_terms_acceptances where org_id = o and user_id = u and version = 'trial-2026-10-20'));
  update public.studio_subscriptions set status = 'active' where org_id = o;
  perform pg_temp.login('r117_owner@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.su();
  perform pg_temp.res('07 paid studio: never asked (must_agree false, notice false)',
    not (c ->> 'must_agree')::boolean and not (c ->> 'notice')::boolean, c::text);
exception when others then perform pg_temp.su(); insert into _t325 values ('0x terms', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- (2) proposal page answer --------------------------------------------------------------------------------------
do $$ declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; b_org uuid := 'b0000000-0000-4000-8000-000000000001';
  tok text := 'b0000000-0000-4000-8000-0000000325aa'; r text; n0 int; n1 int; begin
  perform pg_temp.su();
  update public.quotes set deleted_at = null, archived_at = null, status = 'quote', event_date = current_date + 30 where id = q;
  insert into public.event_proposal(quote_id, org_id, share_token, published) values (q, b_org, tok::uuid, true)
    on conflict (quote_id) do update set share_token = excluded.share_token, published = true;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (b_org, 'trial', current_date + 10)
    on conflict (org_id) do update set status = excluded.status, trial_ends_at = excluded.trial_ends_at;
  select (select count(*) from public.audit_log) + (select count(*) from public.event_proposal) into n0;
  r := pg_temp.prop(tok);
  perform pg_temp.res('10 trial studio: {"simulation": true} and nothing else', r = '{"simulation": true}', r);
  select (select count(*) from public.audit_log) + (select count(*) from public.event_proposal) into n1;
  perform pg_temp.res('11 reading writes nothing', n0 = n1, n0 || ' -> ' || n1);
  perform pg_temp.res('12 an upper-case / padded token is read the same', pg_temp.prop('  ' || upper(tok) || ' ') = '{"simulation": true}');
  update public.studio_subscriptions set status = 'active' where org_id = b_org;
  r := pg_temp.prop(tok);
  perform pg_temp.res('13 PAID studio: {"simulation": false} only', r = '{"simulation": false}', r);
  update public.studio_subscriptions set status = 'trial' where org_id = b_org;
  r := pg_temp.prop('b0000000-0000-4000-8000-0000000325ff') || '/' || pg_temp.prop('nope') || '/' || pg_temp.prop('') || '/'
       || pg_temp.prop(null) || '/' || pg_temp.prop(repeat('a', 300));
  perform pg_temp.res('14 unknown / malformed / empty / null / too long -> null', r = '<null>/<null>/<null>/<null>/<null>', r);
  update public.event_proposal set published = false where quote_id = q;
  r := pg_temp.prop(tok);
  perform pg_temp.res('15 unpublished proposal -> null', r = '<null>', r);
  update public.event_proposal set published = true where quote_id = q;
  update public.quotes set event_date = current_date - 30 where id = q;
  r := pg_temp.prop(tok);
  perform pg_temp.res('16 expired link (event + 7 days passed) -> null', r = '<null>', r);
  update public.quotes set event_date = current_date + 30, archived_at = now() where id = q;
  r := pg_temp.prop(tok);
  perform pg_temp.res('17 archived (shelved) quote -> null', r = '<null>', r);
  update public.quotes set archived_at = null, status = 'cancelled' where id = q;
  r := pg_temp.prop(tok);
  perform pg_temp.res('18 cancelled event -> null', r = '<null>', r);
  update public.quotes set status = 'quote', deleted_at = now() where id = q;
  r := pg_temp.prop(tok);
  perform pg_temp.res('19 deleted quote -> null', r = '<null>', r);
  update public.quotes set deleted_at = null where id = q;
  perform pg_temp.res('20 back to live: answers again', pg_temp.prop(tok) = '{"simulation": true}');
exception when others then perform pg_temp.su(); insert into _t325 values ('1x proposal', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- (3) structure -------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('21 anon / authenticated can execute; stable; security definer; empty search_path',
    has_function_privilege('anon', 'public.public_trial_simulation_for_proposal(text)', 'execute')
    and has_function_privilege('authenticated', 'public.public_trial_simulation_for_proposal(text)', 'execute')
    and (select p.provolatile = 's' and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%'
           from pg_proc p where p.oid = 'public.public_trial_simulation_for_proposal(text)'::regprocedure));
  perform pg_temp.res('22 version helper still closed to the app (anon / authenticated)',
    not has_function_privilege('anon', 'public._trial_terms_version()', 'execute')
    and not has_function_privilege('authenticated', 'public._trial_terms_version()', 'execute')
    and has_function_privilege('service_role', 'public._trial_terms_version()', 'execute'));
  perform pg_temp.res('23 0323 public_trial_simulation untouched (still the 0323 body)',
    position('r114-trial-sim-0323' in pg_get_functiondef('public.public_trial_simulation(text,text)'::regprocedure)) > 0);
exception when others then perform pg_temp.su(); insert into _t325 values ('2x structure', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _t325 where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R117-TRIAL-TERMS-PROPOSAL-0325: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R117-TRIAL-TERMS-PROPOSAL-0325: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t325;
rollback;
