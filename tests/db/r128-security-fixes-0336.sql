-- r128-security-fixes-0336.sql - R128: the open items from the security list.
-- Proves: (1) structure - kept bodies have no app privilege, grants as intended; (2) the crew link limit counts the address the
-- platform saw, not a typed x-forwarded-for value, and the per-link limit still counts; (3) the purge clears expired counters and
-- nothing else; (4) a contact change cancels an unapproved link, a new send makes a working link, a name change or an approved
-- quote is left alone; (5) approval_check_shown; (6) a trial preview without quotes access has no client details;
-- (7) a trial studio's booklet token never reaches the snapshot body, a paid studio's does; (8) re-run safe.
-- Re-applies 0336 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0336_r128_security_fixes.sql
\ir ../../supabase/migrations/0336_r128_security_fixes.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare n bigint;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql; get diagnostics n = row_count;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || n;
exception when others then
  perform auth.logout(); execute 'reset role';
  return sqlstate || ' ' || sqlerrm;
end $$;
create or replace function pg_temp.reset_q(q uuid, p_tok uuid, p_status text) returns void language plpgsql as $$
begin
  update public.quotes set approval_token = p_tok, approval_token_revoked_at = null, approval_token_expires_at = now() + interval '7 days',
         approval_status = p_status, client = client || '{"phone":"+919800000336","email":"r128@x.test","name":"R128 Client"}'::jsonb,
         pricing = jsonb_build_object('total', 118000, 'subtotal', 118000), deleted_at = null, archived_at = null where id = q;
end $$;

-- ---- 1) structure -------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public.auth_rate_hits_purge__pre0336(integer)', 'public.trial_preview_bundle__pre0336(text,uuid,jsonb)',
                           'public.booklet_snapshot_path__pre0336(uuid,text)'] loop
    perform pg_temp.t('1 kept body exists and is private: ' || f, to_regprocedure(f) is not null
      and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute'), f);
  end loop;
  perform pg_temp.t('1 the cancel trigger exists and is private', exists (select 1 from pg_trigger where tgname = 'zzzzz_r128_contact_cancels_link')
    and not has_function_privilege('authenticated', 'public.tg_r128_contact_cancels_link()', 'execute'));
  perform pg_temp.t('1 anon may ask the shown-total check', has_function_privilege('anon', 'public.approval_check_shown(uuid,numeric)', 'execute'));
  perform pg_temp.t('1 only the server may purge', not has_function_privilege('anon', 'public.auth_rate_hits_purge(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.auth_rate_hits_purge(integer)', 'execute')
    and has_function_privilege('service_role', 'public.auth_rate_hits_purge(integer)', 'execute'));
  perform pg_temp.t('1 only the server may read a snapshot path', not has_function_privilege('anon', 'public.booklet_snapshot_path(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.booklet_snapshot_path(uuid,text)', 'execute')
    and has_function_privilege('service_role', 'public.booklet_snapshot_path(uuid,text)', 'execute'));
  perform pg_temp.t('1 members keep the preview, anon does not', has_function_privilege('authenticated', 'public.trial_preview_bundle(text,uuid,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.trial_preview_bundle(text,uuid,jsonb)', 'execute'));
  perform pg_temp.t('1 no function reads the first x-forwarded-for value for the crew limit', not exists (select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and position($x$split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for'$x$ in p.prosrc) > 0));
end $$;

-- ---- 2) crew link limit --------------------------------------------------------------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; o uuid := 'a0000000-0000-4000-8000-000000000001';
  tok uuid := 'a0000000-0000-4000-8000-000000336001'; r text; begin
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values (tok, q, '+919800000337', 'R128 Crew', o);
  delete from public.a154_link_hits;
  perform set_config('request.headers', '{"cf-connecting-ip":"203.0.113.9","x-forwarded-for":"1.2.3.4, 203.0.113.9"}', true);
  begin perform public._work_token_live(tok); r := 'ok'; exception when others then r := sqlerrm; end;
  perform pg_temp.t('2 a live link still opens', r = 'ok', r);
  perform pg_temp.t('2 counted under the address the platform saw', exists (select 1 from public.a154_link_hits where k = 'ip:203.0.113.9'), '');
  perform pg_temp.t('2 the typed address is ignored', not exists (select 1 from public.a154_link_hits where k = 'ip:1.2.3.4'), '');
  perform pg_temp.t('2 the per-link limit still counts', exists (select 1 from public.a154_link_hits where k = 't:' || tok::text), '');
  delete from public.a154_link_hits;
  perform set_config('request.headers', '{"x-forwarded-for":"9.9.9.9, 198.51.100.7"}', true);
  begin perform public._work_token_live(tok); r := 'ok'; exception when others then r := sqlerrm; end;
  perform pg_temp.t('2 without Cloudflare: the last hop, not the first', exists (select 1 from public.a154_link_hits where k = 'ip:198.51.100.7')
    and not exists (select 1 from public.a154_link_hits where k = 'ip:9.9.9.9'), r);
  perform set_config('request.headers', '', true);
end $$;

-- ---- 3) purge -------------------------------------------------------------------------------------------------------
do $$ declare n integer; begin
  delete from public.a154_link_hits;
  insert into public.a154_link_hits(k, window_start, hits) values ('r128:old', now() - interval '3 days', 5), ('r128:new', now() - interval '1 day', 5);
  n := public.auth_rate_hits_purge();
  perform pg_temp.t('3 an expired counter goes', not exists (select 1 from public.a154_link_hits where k = 'r128:old'), '');
  perform pg_temp.t('3 a recent counter stays', exists (select 1 from public.a154_link_hits where k = 'r128:new'), '');
  perform pg_temp.t('3 the purge still answers a count', n >= 1, n::text);
end $$;

-- ---- 4) contact change ----------------------------------------------------------------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; tok uuid := 'a0000000-0000-4000-8000-000000336002'; v_new uuid; r text; j jsonb; begin
  perform pg_temp.reset_q(q, tok, 'sent');
  r := pg_temp.as_try('a_staff@a.test', format($s$update public.quotes set client = client || '{"name":"R128 Renamed"}'::jsonb where id = %L$s$, q));
  perform pg_temp.t('4 a name change is saved', r = 'ok:1', r);
  perform pg_temp.t('4 a name change leaves the link alone', (select approval_token_revoked_at is null from public.quotes where id = q), '');
  r := pg_temp.as_try('a_staff@a.test', format($s$update public.quotes set client = client || '{"email":"staff-own@x.test"}'::jsonb where id = %L$s$, q));
  perform pg_temp.t('4 a contact change is saved', r = 'ok:1', r);
  perform pg_temp.t('4 a contact change cancels the unapproved link', (select approval_token_revoked_at is not null from public.quotes where id = q), '');
  perform pg_temp.t('4 the audit row says so', exists (select 1 from public.audit_log where action = 'client_contact_change' and quote_id = q
    and (changed ->> 'link_cancelled')::boolean), '');
  begin j := public.public_get_quote(tok); exception when others then j := null; end;
  perform pg_temp.t('4 the old link no longer opens', j is null, coalesce(j::text, ''));
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  v_new := public.generate_approval_token(q);
  perform auth.logout(); execute 'reset role';
  perform pg_temp.t('4 sending again makes a new link', v_new is distinct from tok and v_new is not null, coalesce(v_new::text, 'null'));
  perform pg_temp.t('4 the new link is live', (select approval_token = v_new and approval_token_revoked_at is null from public.quotes where id = q), '');
  begin j := public.public_get_quote(v_new); exception when others then j := null; end;
  perform pg_temp.t('4 the new link opens', j is not null, '');
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  update public.quotes set client = client || '{"phone":"+919800000340"}'::jsonb where id = q;
  perform pg_temp.t('4 a second save after the cancel works', (select client ->> 'phone' from public.quotes where id = q) = '+919800000340', '');
  perform auth.logout(); execute 'reset role';

  perform pg_temp.reset_q(q, tok, 'approved');
  r := pg_temp.as_try('a_staff@a.test', format($s$update public.quotes set client = client || '{"phone":"+919800000338"}'::jsonb where id = %L$s$, q));
  perform pg_temp.t('4 an approved quote keeps its link (it is the portal too)', r = 'ok:1' and (select approval_token_revoked_at is null from public.quotes where id = q), r);
  perform pg_temp.t('4 an approved quote still records the change', exists (select 1 from public.audit_log where action = 'client_contact_change' and quote_id = q
    and not (changed ->> 'link_cancelled')::boolean), '');
  perform pg_temp.reset_q(q, tok, 'sent');
  update public.quotes set client = client || '{"phone":"+919800000339"}'::jsonb where id = q;
  perform pg_temp.t('4 a system change does not cancel', (select approval_token_revoked_at is null from public.quotes where id = q), '');
end $$;

-- ---- 5) shown total -------------------------------------------------------------------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; tok uuid := 'a0000000-0000-4000-8000-000000336003'; v numeric; j jsonb; begin
  perform pg_temp.reset_q(q, tok, 'sent');
  j := public.public_get_quote(tok);
  v := (j -> 'pricing' ->> 'total')::numeric;       -- what the page really shows (the server stamps the total)
  perform pg_temp.t('5 the page total agrees with the check', (public.approval_check_shown(tok, v) ->> 'ok')::boolean, v::text);
  perform pg_temp.t('5 rounding noise: ok', (public.approval_check_shown(tok, v + 0.001) ->> 'ok')::boolean, '');
  perform pg_temp.t('5 a different total: refused', public.approval_check_shown(tok, 100000) ->> 'error' = 'price_changed', '');
  perform pg_temp.t('5 the refusal explains itself', public.approval_check_shown(tok, 100000) ->> 'message' like '%reload the page%', '');
  perform pg_temp.t('5 no total shown: ok', (public.approval_check_shown(tok, null) ->> 'ok')::boolean, '');
  perform pg_temp.t('5 a link that does not exist answers ok (no oracle)', (public.approval_check_shown(gen_random_uuid(), 1) ->> 'ok')::boolean, '');
  perform pg_temp.t('5 anon can ask', pg_temp.as_try('anon', format('select public.approval_check_shown(%L, 100000)', tok)) = 'ok:1', '');
end $$;

-- ---- 6) preview hint (the kept body is replaced by a stub inside this rolled-back transaction) -------------------------
create or replace function public.trial_preview_bundle__pre0336(p_kind text, p_quote uuid default null, p_opts jsonb default '{}'::jsonb)
returns jsonb language sql as $$ select '{"hint":{"client_name":"N","client_email":"e@x.test","client_phone":"+91","total":"1","title":"T","venue":"V"},"studio":"S"}'::jsonb $$;
grant execute on function public.trial_preview_bundle__pre0336(text, uuid, jsonb) to authenticated;
do $$ declare o uuid := 'a0000000-0000-4000-8000-000000000001'; j jsonb; begin
  insert into public.role_access(role, area, can_view, can_edit, org_id) values ('sales', 'quotes', true, true, o)
    on conflict (org_id, role, area) do update set can_view = true, can_edit = true;
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  j := public.trial_preview_bundle('approval', null, '{}'::jsonb);
  perform auth.logout(); execute 'reset role';
  perform pg_temp.t('6 quotes access keeps the client details', j #>> '{hint,client_email}' = 'e@x.test' and j #>> '{hint,total}' = '1', j::text);
  update public.role_access set can_view = false, can_edit = false where org_id = o and role = 'sales' and area in ('quotes', 'proposal');
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  j := public.trial_preview_bundle('crew', null, '{}'::jsonb);
  perform auth.logout(); execute 'reset role';
  perform pg_temp.t('6 no quotes access: no name, e-mail, phone or total', not (j -> 'hint' ?| array['client_name', 'client_email', 'client_phone', 'total']), j::text);
  perform pg_temp.t('6 no quotes access: the rest of the hint stays', j #>> '{hint,title}' = 'T' and j #>> '{hint,venue}' = 'V' and j ->> 'studio' = 'S', j::text);
  update public.role_access set can_view = true, can_edit = true where org_id = o and role = 'sales' and area = 'quotes';
end $$;

-- ---- 7) booklet snapshot (kept body stubbed the same way) --------------------------------------------------------------
create or replace function public.booklet_snapshot_path__pre0336(p_token uuid, p_kind text)
returns text language sql as $$ select 'path-for:' || p_token::text $$;
do $$ declare o uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01';
  tok uuid := 'a0000000-0000-4000-8000-000000336004'; r text; begin
  insert into public.client_booklets(org_id, quote_id, token) values (o, q, tok);
  delete from public.studio_subscriptions where org_id = o;
  perform set_config('helm.r125_gate', 'on', true);
  perform pg_temp.t('7 a paid studio token reaches the body', public.booklet_snapshot_path(tok, '2d') = 'path-for:' || tok::text, '');
  insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (o, 'trial', current_date + 10);
  r := public.booklet_snapshot_path(tok, '2d');
  perform pg_temp.t('7 a trial studio token never does', r = 'path-for:00000000-0000-0000-0000-000000000000', r);
  perform set_config('helm.r125_gate', 'off', true);
end $$;

-- ---- 8) re-run safe ---------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.t('8 only one kept copy of each', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
    and proname like '%\_\_pre0336\_\_pre0336') = 0, '');
end $$;

select name, result from _rs where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R128-SECURITY-FIXES-0336: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R128-SECURITY-FIXES-0336: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
