-- pretty-urls.sql - 0067 studio-scoped pretty URLs. Requires 0020 + 0065 + 0067 + fixtures.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _pu; create temp table _pu(name text, result text); grant all on _pu to anon, authenticated;
begin;
do $$ begin
  perform auth.logout(); execute 'reset role';
  delete from public.org_slug_history where org_id in ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001');
  update public.role_access set can_edit = false where role = 'sales' and area = 'controls' and org_id = 'a0000000-0000-4000-8000-000000000001';
  update public.organizations set public_slug = 'studio-a' where id = 'a0000000-0000-4000-8000-000000000001';
  update public.organizations set public_slug = 'studio-b' where id = 'b0000000-0000-4000-8000-000000000001';
  insert into public.org_slug_history(slug, org_id) values ('old-a', 'a0000000-0000-4000-8000-000000000001') on conflict do nothing;
  update public.quotes set code = 'EVT-0912' where id = (select id from public.quotes where org_id='a0000000-0000-4000-8000-000000000001' and code='A-0001');
  update public.quotes set code = 'EVT-0912' where id = (select id from public.quotes where org_id='b0000000-0000-4000-8000-000000000001' and code='B-0001');
  set local session_replication_role = replica;
  insert into public.leads(id, name, status, org_id) values ('cafe1234-0000-4000-8000-0000000000a1', 'Priya Sharma', 'new', 'a0000000-0000-4000-8000-000000000001') on conflict (id) do nothing;
  insert into public.leads(id, name, status, org_id) values ('beef5678-0000-4000-8000-0000000000b1', 'Bob Lead', 'new', 'b0000000-0000-4000-8000-000000000001') on conflict (id) do nothing;
  set local session_replication_role = origin;
  insert into public.client_booklets(quote_id, org_id, token, expires_at)
    select id, org_id, 'a0000000-0000-4000-8000-00000000b0c1', now() + interval '30 days' from public.quotes where org_id='a0000000-0000-4000-8000-000000000001' and code='EVT-0912'
    on conflict do nothing;
end $$;

create or replace function pg_temp.res(n text, ok boolean, d text default '') returns void language sql as
$$ insert into _pu values (n, case when ok then 'PASS' else 'FAIL: ' || coalesce(d, '') end) $$;
create or replace function pg_temp.as_user(e text) returns void language plpgsql as
$$ begin perform auth.logout(); execute 'reset role'; perform auth.login_as((select id from auth.users where email = e)); end $$;

do $$ declare j jsonb; begin
  perform pg_temp.as_user('a_staff@a.test');
  j := public.my_studio_route('studio-a');   perform pg_temp.res('01 own slug -> own', (j->>'own')::boolean and j->>'slug'='studio-a', j::text);
  j := public.my_studio_route('Studio-A ');  perform pg_temp.res('02 slug normalised', (j->>'own')::boolean, j::text);
  j := public.my_studio_route('old-a');      perform pg_temp.res('03 retired own slug -> own + current', (j->>'own')::boolean and j->>'slug'='studio-a', j::text);
  j := public.my_studio_route('studio-b');   perform pg_temp.res('04 other studio slug -> not own', not (j->>'own')::boolean and j->>'slug'='studio-a', j::text);
  j := public.my_studio_route('nope-nope');  perform pg_temp.res('05 unknown slug looks identical to other studio', not (j->>'own')::boolean and j->>'slug'='studio-a', j::text);
  perform pg_temp.res('06 no other-studio fields leak', (select count(*) from jsonb_object_keys(j)) = 2, j::text);
  j := public.resolve_event_ref('EVT-0912'); perform pg_temp.res('07 event number -> own event', j->>'id' = (select id::text from public.quotes where org_id='a0000000-0000-4000-8000-000000000001' and code='EVT-0912'), coalesce(j::text,'null'));
  j := public.resolve_event_ref('evt-0912'); perform pg_temp.res('08 event number case-insensitive', j is not null, 'null');
  j := public.resolve_event_ref((select id::text from public.quotes where org_id='b0000000-0000-4000-8000-000000000001' limit 1));
  perform pg_temp.res('09 other studio event id -> null', j is null, coalesce(j::text,''));
  j := public.resolve_event_ref((select id::text from public.quotes where org_id='a0000000-0000-4000-8000-000000000001' and code='EVT-0912'));
  perform pg_temp.res('10 own event uuid -> code', j->>'code' = 'EVT-0912', coalesce(j::text,'null'));
  j := public.resolve_event_ref('NOPE-1'); perform pg_temp.res('11 unknown number -> null', j is null);
  j := public.resolve_event_ref(repeat('x', 200)); perform pg_temp.res('12 oversized ref -> null', j is null);
  j := public.resolve_event_ref(''' or 1=1 --'); perform pg_temp.res('13 injection text -> null', j is null);
end $$;

do $$ declare j jsonb; begin
  perform pg_temp.as_user('b_admin@b.test');
  j := public.resolve_event_ref('EVT-0912');
  perform pg_temp.res('14 same number in B resolves to B event only', j->>'id' = (select id::text from public.quotes where org_id='b0000000-0000-4000-8000-000000000001' and code='EVT-0912'), coalesce(j::text,'null'));
  j := public.resolve_client_ref('priya-sharma-cafe1234'); perform pg_temp.res('15 B cannot resolve A lead slug', j is null, coalesce(j::text,''));
  j := public.resolve_client_ref('cafe1234-0000-4000-8000-0000000000a1'); perform pg_temp.res('16 B cannot resolve A lead uuid', j is null, coalesce(j::text,''));
  j := public.my_studio_route('studio-a'); perform pg_temp.res('17 B visiting A slug -> not own', not (j->>'own')::boolean and j->>'slug'='studio-b', j::text);
end $$;

do $$ declare j jsonb; begin
  perform pg_temp.as_user('a_admin@a.test');
  j := public.resolve_client_ref('priya-sharma-cafe1234'); perform pg_temp.res('18 lead slug -> lead', j->>'kind'='lead' and j->>'id'='cafe1234-0000-4000-8000-0000000000a1', coalesce(j::text,'null'));
  j := public.resolve_client_ref('cafe1234');              perform pg_temp.res('19 bare 8-hex -> lead', j->>'kind'='lead', coalesce(j::text,'null'));
  j := public.resolve_client_ref('EVT-0912');              perform pg_temp.res('20 event number -> event client', j->>'kind'='event', coalesce(j::text,'null'));
  j := public.resolve_client_ref('beef5678');              perform pg_temp.res('21 other studio lead hex -> null', j is null, coalesce(j::text,''));
end $$;

-- has_area gate: sales without quotes view cannot resolve events
do $$ declare j jsonb; begin
  perform auth.logout(); execute 'reset role';
  update public.role_access set can_view = false, can_edit = false where role='sales' and area='quotes' and org_id='a0000000-0000-4000-8000-000000000001';
  perform pg_temp.as_user('a_staff@a.test');
  j := public.resolve_event_ref('EVT-0912'); perform pg_temp.res('22 no quotes view -> null', j is null, coalesce(j::text,''));
  perform auth.logout(); execute 'reset role';
  update public.role_access set can_view = true, can_edit = true where role='sales' and area='quotes' and org_id='a0000000-0000-4000-8000-000000000001';
end $$;

-- anon
do $$ declare s text; j jsonb; begin
  perform auth.logout(); execute 'reset role'; set local role anon;
  s := public.public_booklet_studio('a0000000-0000-4000-8000-00000000b0c1', 'studio-a'); perform pg_temp.res('23 booklet token + own slug -> slug', s='studio-a', coalesce(s,'null'));
  s := public.public_booklet_studio('a0000000-0000-4000-8000-00000000b0c1', 'old-a');    perform pg_temp.res('24 booklet retired slug -> current', s='studio-a', coalesce(s,'null'));
  s := public.public_booklet_studio('a0000000-0000-4000-8000-00000000b0c1', 'studio-b'); perform pg_temp.res('25 booklet wrong studio -> null', s is null, s);
  s := public.public_booklet_studio('a0000000-0000-4000-8000-00000000ffff', 'studio-a'); perform pg_temp.res('26 unknown token -> null', s is null, s);
  s := public.public_booklet_studio('not-a-token', 'studio-a');                       perform pg_temp.res('27 malformed token -> null', s is null, s);
  begin j := public.resolve_event_ref('EVT-0912'); perform pg_temp.res('28 anon cannot resolve events', false, 'allowed');
  exception when others then perform pg_temp.res('28 anon cannot resolve events', true); end;
  begin j := public.my_studio_route('studio-a'); perform pg_temp.res('29 anon cannot probe studios', false, 'allowed');
  exception when others then perform pg_temp.res('29 anon cannot probe studios', true); end;
  begin j := public.resolve_client_ref('cafe1234'); perform pg_temp.res('30 anon cannot resolve clients', false, 'allowed');
  exception when others then perform pg_temp.res('30 anon cannot resolve clients', true); end;
  reset role;
end $$;

-- reserved words + admin rename still works
do $$ declare bad text; ok int := 0; r text; begin
  perform pg_temp.as_user('a_admin@a.test');
  foreach bad in array array['hq','booklet','events','clients','settings','client','manual','checkout','tasks','floor-plan','login','api','i','assets','static','portal','approve'] loop
    begin perform public.set_studio_link_name(bad); exception when others then ok := ok + 1; end;
  end loop;
  perform pg_temp.res('31 reserved route words rejected (17)', ok = 17, ok::text);
  r := public.set_studio_link_name('sharma-events');
  perform pg_temp.res('32 admin rename to sharma-events', r = 'sharma-events', r);
  perform pg_temp.res('33 renamed: old slug still own', (public.my_studio_route('studio-a')->>'own')::boolean);
  perform pg_temp.as_user('a_staff@a.test');
  begin perform public.set_studio_link_name('staff-pick'); perform pg_temp.res('34 non-admin rename denied', false, 'allowed');
  exception when others then perform pg_temp.res('34 non-admin rename denied', true); end;
  perform auth.logout(); execute 'reset role';
  perform pg_temp.res('35 new studios get a valid slug', public.studio_slug_valid(public.studio_slug_pick('HQ', gen_random_uuid())));
end $$;

select name, result from _pu order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'PRETTY-URLS: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'PRETTY-URLS: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _pu;
rollback;
