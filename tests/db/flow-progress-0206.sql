-- flow-progress-0206.sql - behavioral proof for 0206 ("Continue where you left off" kept on the server).
-- quote_flow_progress is written only through mark_flow_step / mark_flow_resume_dismissed (own row, own
-- studio, quotes edit for steps); my_unfinished_quotes lists only unfinished quotes (not sent, no saved
-- quotation version, not shelved / discarded / confirmed / sample data, some content), 'mine' vs 'studio',
-- Dismiss until the next step, 60-day window, steps done = flow.html stepDone; an opened but empty draft
-- is still tidied away by 0141. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _fp(name text, result text); grant all on _fp to anon, authenticated;
-- earlier suites in run-all re-apply older migrations (0141): re-run 0206 (also proves a re-run is safe)
\i supabase/migrations/0206_flow_progress.sql

do $$ declare a_admin uuid; a_staff uuid; b_admin uuid;
  org uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  qB uuid := 'b0000000-0000-4000-8000-00000000da01';
  qF uuid := gen_random_uuid(); qC uuid := gen_random_uuid(); qS uuid := gen_random_uuid(); qSent uuid := gen_random_uuid();
  qConf uuid := gen_random_uuid(); qArch uuid := gen_random_uuid(); qDemo uuid := gen_random_uuid(); qOld uuid := gen_random_uuid();
  qEmpty uuid := gen_random_uuid(); qBlank uuid := gen_random_uuid(); qDisc uuid := gen_random_uuid();
  j jsonb; e text; n int; ids text[]; r jsonb; ts timestamptz; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into b_admin from auth.users where email='b_admin@b.test';
  update public.profiles set full_name = 'Priya Staff' where id = a_staff;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, event_type, event_date, created_at, updated_at) values
    (qF, 'FP-F', 'Flow F', 'quote', '{"name":"Asha","phone":"+919800000001","eventDate":"2027-02-01","venue":"Lawn"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, 'Wedding', '2027-02-01', now(), now()),
    (qC, 'FP-C', 'Flow C', 'quote', '{"name":"Ravi"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now()),
    (qS, 'FP-S', 'Flow S', 'quote', '{"name":"Saved"}', '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}', 1, 'none', org, null, null, now(), now()),
    (qSent, 'FP-SENT', 'Flow Sent', 'quote', '{"name":"Sent"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'sent', org, null, null, now(), now()),
    (qConf, 'FP-CONF', 'Flow Conf', 'confirmed', '{"name":"Conf"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now()),
    (qArch, 'FP-ARCH', 'Flow Arch', 'quote', '{"name":"Arch"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now()),
    (qDemo, 'FP-DEMO', 'Demo - Flow', 'quote', '{"name":"Demo"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now()),
    (qOld, 'FP-OLD', 'Flow Old', 'quote', '{"name":"Old"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now() - interval '200 days', now() - interval '200 days'),
    (qEmpty, 'FP-EMPTY', 'FP-EMPTY', 'quote', '{}', '{}', 1, 'none', org, null, null, now() - interval '3 days', now() - interval '3 days'),
    (qBlank, 'FP-BLANK', 'FP-BLANK', 'quote', '{}', '{}', 1, 'none', org, null, null, now(), now()),
    (qDisc, 'FP-DISC', 'Flow Disc', 'quote', '{"name":"Disc"}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, null, null, now(), now());
  update public.quotes set archived_at = now() where id = qArch;
  update public.quotes set auto_discarded_at = now(), deleted_at = now(), deleted_reason = 'manual' where id = qDisc;
  update public.quotes set is_demo = true where id = qDemo;
  insert into public.quote_versions(quote_id, version_no, data, object_count, created_by, org_id)
    select x, 1, '{"items":[]}'::jsonb, 0, a_admin, org from unnest(array[qF, qC, qS, qSent, qConf, qArch, qDemo, qOld, qEmpty, qBlank, qDisc]) x;
  insert into public.quotation_versions(quote_id, label, pricing, total, org_id, created_by) values (qS, 'Q1', '{"total":5000}', 5000, org, a_admin);
  insert into public.event_discovery(quote_id, mode, org_id) values (qF, 'call', org);
  insert into public.event_requirements(quote_id, service, priority, qty, org_id) values (qF, 'Decor', 'mandatory', 1, org);
  -- back-date two quotes (the updated_at trigger would stamp now(); disabled only inside this rolled-back test)
  execute 'alter table public.quotes disable trigger quotes_set_updated';
  update public.quotes set updated_at = now() - interval '200 days' where id = qOld;
  update public.quotes set updated_at = now() - interval '3 days' where id = qEmpty;
  execute 'alter table public.quotes enable trigger quotes_set_updated';

  -- ---- 0) shape ----
  insert into _fp values ('00 table has RLS on, app may only SELECT', case when (select relrowsecurity from pg_class where oid = 'public.quote_flow_progress'::regclass)
    and has_table_privilege('authenticated', 'public.quote_flow_progress', 'select')
    and not has_table_privilege('authenticated', 'public.quote_flow_progress', 'insert')
    and not has_table_privilege('authenticated', 'public.quote_flow_progress', 'update')
    and not has_table_privilege('authenticated', 'public.quote_flow_progress', 'delete')
    and not has_table_privilege('anon', 'public.quote_flow_progress', 'select') then 'PASS' else 'FAIL' end);
  insert into _fp values ('01 the three functions are SECURITY DEFINER with an empty search_path', case when (select count(*) from pg_proc
    where proname in ('mark_flow_step', 'mark_flow_resume_dismissed', 'my_unfinished_quotes', '_flow_steps_done') and pronamespace = 'public'::regnamespace
      and prosecdef and 'search_path=""' = any(proconfig)) = 4 then 'PASS' else 'FAIL' end);
  insert into _fp values ('02 anon cannot call them; the helper is internal', case when not has_function_privilege('anon', 'public.mark_flow_step(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.my_unfinished_quotes(text,integer,integer,uuid,integer)', 'execute')
    and not has_function_privilege('anon', 'public.mark_flow_resume_dismissed(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._flow_steps_done(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.mark_flow_step(uuid,text)', 'execute') then 'PASS' else 'FAIL' end);
  insert into _fp values ('03 read-only guard trigger on the table', case when exists (select 1 from pg_trigger where tgrelid = 'public.quote_flow_progress'::regclass
    and tgname = 'zzz_studio_read_only' and not tgisinternal) then 'PASS' else 'FAIL' end);
  insert into _fp values ('03b quote <-> studio integrity trigger on the table', case when exists (select 1 from pg_trigger where tgrelid = 'public.quote_flow_progress'::regclass
    and tgname = 'zz_quote_org_match' and not tgisinternal) then 'PASS' else 'FAIL' end);
  insert into _fp values ('04 steps done copy stepDone (client + discovery + reqs + venue)', case when public._flow_steps_done(qF) = array['client','discovery','reqs','venue']::text[]
    then 'PASS' else 'FAIL: ' || coalesce(public._flow_steps_done(qF)::text, 'null') end);
  insert into _fp values ('05 a blank quote has no steps done', case when public._flow_steps_done(qBlank) = '{}'::text[] then 'PASS' else 'FAIL' end);

  -- ---- 1) save a step ----
  select updated_at into ts from public.quotes where id = qF;
  perform auth.login_as(a_admin);
  j := public.mark_flow_step(qF, 'venue');
  insert into _fp values ('10 mark_flow_step saves my step', case when j ->> 'ok' = 'true' and (select last_step from public.quote_flow_progress where quote_id = qF and user_id = a_admin) = 'venue'
    then 'PASS' else 'FAIL: ' || coalesce(j::text, 'null') end);
  e := ''; begin perform public.mark_flow_step(qF, 'drop table'); exception when others then e := sqlstate; end;
  insert into _fp values ('11 a step not on the list is refused', case when e = '22023' then 'PASS' else 'FAIL: ' || e end);
  e := ''; begin perform public.mark_flow_step(qB, 'client'); exception when others then e := sqlstate; end;
  insert into _fp values ('12 another studio''s quote is refused', case when e = '42501' then 'PASS' else 'FAIL: ' || e end);
  e := ''; begin insert into public.quote_flow_progress(quote_id, user_id, org_id, last_step, last_step_at) values (qC, a_admin, org, 'client', now()); exception when others then e := sqlstate; end;
  insert into _fp values ('13 a direct insert by the app is refused', case when e = '42501' then 'PASS' else 'FAIL: ' || e end);
  e := ''; begin update public.quote_flow_progress set last_step = 'quote' where quote_id = qF; get diagnostics n = row_count; if n = 0 then e := 'no-rows'; end if; exception when others then e := sqlstate; end;
  insert into _fp values ('14 a direct update by the app is refused', case when e in ('42501', 'no-rows') then 'PASS' else 'FAIL: ' || e end);
  insert into _fp values ('15 mark_flow_step never touches quotes.updated_at', case when (select updated_at from public.quotes where id = qF) = ts then 'PASS' else 'FAIL' end);

  -- ---- 2) what is listed ----
  j := public.my_unfinished_quotes('studio', 100, 0, null, null);
  select array_agg(x ->> 'code' order by x ->> 'code') into ids from jsonb_array_elements(j -> 'rows') x where x ->> 'code' like 'FP-%';
  insert into _fp values ('20 studio list = unfinished with content only', case when ids = array['FP-C','FP-F','FP-OLD']::text[] then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  insert into _fp values ('21 saved quotation / sent / confirmed / archived / discarded / sample / blank are left out',
    case when not (ids && array['FP-S','FP-SENT','FP-CONF','FP-ARCH','FP-DISC','FP-DEMO','FP-BLANK','FP-EMPTY']::text[]) then 'PASS' else 'FAIL' end);
  select x into r from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'FP-F';
  insert into _fp values ('22 row carries step, progress and who', case when r ->> 'last_step' = 'venue' and r ->> 'my_step' = 'venue' and (r ->> 'last_by_me')::boolean
    and jsonb_array_length(r -> 'steps_done') = 4 and (r ->> 'steps_total')::int = 8 and r -> 'client' ->> 'name' = 'Asha' and not (r -> 'client' ? 'phone')
    then 'PASS' else 'FAIL: ' || coalesce(r::text, 'null') end);
  insert into _fp values ('23 most recent first', case when (j -> 'rows' -> 0 ->> 'code') = 'FP-F' then 'PASS' else 'FAIL: ' || (j -> 'rows' -> 0 ->> 'code') end);
  j := public.my_unfinished_quotes('mine', 100, 0, null, 60);
  select array_agg(x ->> 'code' order by x ->> 'code') into ids from jsonb_array_elements(j -> 'rows') x where x ->> 'code' like 'FP-%';
  insert into _fp values ('24 mine (60 days): worked on + created by me, old one hidden', case when ids = array['FP-C','FP-F']::text[] then 'PASS' else 'FAIL: ' || coalesce(ids::text, 'null') end);
  j := public.my_unfinished_quotes('mine', 100, 0, null, null);
  insert into _fp values ('25 mine without the window still lists the old draft', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'FP-OLD') then 'PASS' else 'FAIL' end);
  j := public.my_unfinished_quotes('studio', 1, 0, qF, null);
  insert into _fp values ('26 one quote (workspace banner)', case when (j ->> 'total')::int = 1 and j -> 'rows' -> 0 ->> 'code' = 'FP-F' then 'PASS' else 'FAIL: ' || j::text end);
  j := public.my_unfinished_quotes('studio', 1, 0, qS, null);
  insert into _fp values ('27 a quote with a saved quotation is finished', case when (j ->> 'total')::int = 0 then 'PASS' else 'FAIL' end);
  e := ''; begin perform public.my_unfinished_quotes('everyone', 10, 0, null, null); exception when others then e := sqlstate; end;
  insert into _fp values ('28 unknown scope refused', case when e = '22023' then 'PASS' else 'FAIL: ' || e end);
  j := public.my_unfinished_quotes('studio', 2, 0, null, null);
  insert into _fp values ('29 total counts all, rows are paged', case when jsonb_array_length(j -> 'rows') = 2 and (j ->> 'total')::int >= 3 and (j ->> 'can_edit')::boolean then 'PASS' else 'FAIL: ' || j::text end);

  -- ---- 3) Dismiss ----
  perform public.mark_flow_resume_dismissed(qF);
  j := public.my_unfinished_quotes('mine', 100, 0, null, null);
  insert into _fp values ('30 dismissed: gone from my card', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'FP-F') then 'PASS' else 'FAIL' end);
  j := public.my_unfinished_quotes('studio', 100, 0, null, null);
  insert into _fp values ('31 dismissed: still in the In progress tab', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'FP-F') then 'PASS' else 'FAIL' end);
  perform public.mark_flow_step(qF, 'menu');
  j := public.my_unfinished_quotes('mine', 100, 0, null, null);
  insert into _fp values ('32 working on it again brings it back', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'FP-F' and x ->> 'my_step' = 'menu') then 'PASS' else 'FAIL' end);
  perform public.mark_flow_resume_dismissed(qC);
  j := public.my_unfinished_quotes('mine', 100, 0, null, null);
  insert into _fp values ('33 dismissing a quote I only created hides it too', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'FP-C') then 'PASS' else 'FAIL' end);
  j := public.my_unfinished_quotes('studio', 100, 0, qC, null);
  insert into _fp values ('34 a dismiss-only row does not invent a step', case when (j ->> 'total')::int = 1 and not (j -> 'rows' -> 0 ? 'last_step') then 'PASS' else 'FAIL: ' || j::text end);
  perform auth.logout(); execute 'reset role';

  -- ---- 4) a teammate + view-only role ----
  perform auth.login_as(a_staff);
  j := public.my_unfinished_quotes('mine', 100, 0, null, null);
  insert into _fp values ('40 a teammate''s card does not show my quotes', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' like 'FP-%') then 'PASS' else 'FAIL' end);
  perform public.mark_flow_step(qF, 'proposal');
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(a_admin);
  j := public.my_unfinished_quotes('studio', 1, 0, qF, null);
  insert into _fp values ('41 studio row names the last person', case when j -> 'rows' -> 0 ->> 'last_user_name' = 'Priya Staff' and j -> 'rows' -> 0 ->> 'last_step' = 'proposal'
    and not (j -> 'rows' -> 0 ->> 'last_by_me')::boolean and j -> 'rows' -> 0 ->> 'my_step' = 'menu' then 'PASS' else 'FAIL: ' || j::text end);
  perform auth.logout(); execute 'reset role';
  update public.role_access set can_edit = false where role = 'sales' and area = 'quotes' and org_id = org;
  perform auth.login_as(a_staff);
  e := ''; begin perform public.mark_flow_step(qF, 'client'); exception when others then e := sqlstate; end;
  insert into _fp values ('42 view-only role cannot save steps', case when e = '42501' then 'PASS' else 'FAIL: ' || e end);
  j := public.my_unfinished_quotes('studio', 100, 0, null, null);
  insert into _fp values ('43 view-only role still sees the In progress list (no edit)', case when exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' = 'FP-F')
    and not (j ->> 'can_edit')::boolean then 'PASS' else 'FAIL: ' || left(j::text, 200) end);
  select count(*) into n from public.quote_flow_progress where quote_id = qF;
  insert into _fp values ('44 studio members can read their studio''s progress rows', case when n = 2 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout(); execute 'reset role';

  -- ---- 5) another studio ----
  perform auth.login_as(b_admin);
  e := ''; begin perform public.mark_flow_step(qF, 'client'); exception when others then e := sqlstate; end;
  insert into _fp values ('50 studio B cannot save a step on studio A''s quote', case when e = '42501' then 'PASS' else 'FAIL: ' || e end);
  e := ''; begin perform public.mark_flow_resume_dismissed(qF); exception when others then e := sqlstate; end;
  insert into _fp values ('51 studio B cannot dismiss studio A''s quote', case when e = '42501' then 'PASS' else 'FAIL: ' || e end);
  j := public.my_unfinished_quotes('studio', 100, 0, null, null);
  insert into _fp values ('52 studio B never lists studio A''s quotes', case when not exists (select 1 from jsonb_array_elements(j -> 'rows') x where x ->> 'code' like 'FP-%') then 'PASS' else 'FAIL' end);
  j := public.my_unfinished_quotes('studio', 1, 0, qF, null);
  insert into _fp values ('53 studio B asking for studio A''s quote gets nothing', case when (j ->> 'total')::int = 0 then 'PASS' else 'FAIL' end);
  select count(*) into n from public.quote_flow_progress where quote_id = qF;
  insert into _fp values ('54 studio B reads none of studio A''s progress rows', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout(); execute 'reset role';

  -- ---- 6) signed out ----
  e := ''; begin execute 'set local role anon'; perform public.my_unfinished_quotes('mine', 10, 0, null, null); exception when others then e := sqlstate; end; execute 'reset role';
  insert into _fp values ('60 anon cannot list', case when e = '42501' then 'PASS' else 'FAIL: ' || e end);

  -- ---- 7) 0141 still tidies an opened but empty draft ----
  perform auth.login_as(a_admin);
  perform public.mark_flow_step(qEmpty, 'client');
  perform auth.logout(); execute 'reset role';
  insert into _fp values ('70 opening an empty draft keeps it "empty" for 0141', case when public._empty_draft_reason(qEmpty) is null then 'PASS' else 'FAIL: ' || coalesce(public._empty_draft_reason(qEmpty), 'null') end);
  insert into _fp values ('71 a filled quote is still not empty', case when public._empty_draft_reason(qF) is not null then 'PASS' else 'FAIL' end);
  -- (0141's own soft move to Deleted is not exercised here: the 0040 quotes_deleted_reason_chk check does
  --  not list 'auto_empty_draft' - reported separately; 0206 only changes which tables count as content)
  insert into _fp values ('72 the ignore list names quote_flow_progress', case when position('quote_flow_progress' in
    pg_get_functiondef('public._empty_draft_reason(uuid)'::regprocedure)) > 0 then 'PASS' else 'FAIL' end);
  update public.quotes set deleted_at = now(), deleted_reason = 'manual' where id = qEmpty;
  perform auth.login_as(a_admin);
  j := public.my_unfinished_quotes('studio', 1, 0, qEmpty, null);
  insert into _fp values ('73 a quote moved to Deleted leaves the list', case when (j ->> 'total')::int = 0 then 'PASS' else 'FAIL' end);
  perform auth.logout(); execute 'reset role';
  update public.quotes set deleted_at = null, deleted_reason = null where id = qEmpty;
  perform auth.login_as(a_admin);
  j := public.my_unfinished_quotes('studio', 1, 0, qEmpty, null);
  insert into _fp values ('74 restored, an opened draft shows again (a step was opened)', case when (j ->> 'total')::int = 1 then 'PASS' else 'FAIL' end);
  perform auth.logout(); execute 'reset role';

  -- ---- 8) read-only studio ----
  insert into public.studio_subscriptions(org_id, status, updated_at) values (org, 'suspended', now())
    on conflict (org_id) do update set status = 'suspended';
  perform auth.login_as(a_admin);
  j := public.mark_flow_step(qF, 'quote');
  insert into _fp values ('80 read-only studio: the step save is quietly refused', case when j ->> 'ok' = 'false' and (j ->> 'read_only')::boolean
    and (select last_step from public.quote_flow_progress where quote_id = qF and user_id = a_admin) = 'menu' then 'PASS' else 'FAIL: ' || coalesce(j::text, 'null') end);
  j := public.my_unfinished_quotes('mine', 10, 0, null, null);
  insert into _fp values ('81 read-only studio: list says editing is blocked', case when not (j ->> 'can_edit')::boolean and (j ->> 'read_only')::boolean then 'PASS' else 'FAIL: ' || left(j::text, 200) end);
  perform auth.logout(); execute 'reset role';
exception when others then execute 'reset role'; insert into _fp values ('xx setup', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

select name, result from _fp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'FLOW-PROGRESS-0206: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'FLOW-PROGRESS-0206: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _fp;
rollback;
