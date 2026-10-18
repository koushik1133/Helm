-- photo-render-0095.sql -- 0095: photo renders (settings, quota, rate limit, tenant scope, booklet copy).
-- Fixture studios A + B. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _pr(name text, result text); grant all on _pr to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _pr values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

do $$ declare qa text := 'a0000000-0000-4000-8000-00000000da01'; r jsonb; e text; n int; rid uuid; oa uuid;
  jpg bytea := '\xffd8ffe000104a464946'::bytea;
begin
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = null where id = qa::uuid;
  set local session_replication_role = origin;
  select org_id into oa from public.quotes where id = qa::uuid;
  -- 0173: renders are refused for a FREE-TRIAL studio. This suite tests the paid path, so studio A is
  -- pinned to a paid subscription for the run (rolled back); #21 below asserts the trial block.
  update public.studio_subscriptions set status = 'active' where org_id = oa and status = 'trial';
  update public.role_access set can_edit = false where role = 'sales' and area = 'controls' and org_id = oa;

  -- sales has quotes EDIT in the fixture but no photo_render area yet
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.photo_render_begin(%L, 1, ''high'', ''1536x1024'', ''gpt-image-2'', 0.2)', qa));
  perform pg_temp.res('01 no photo_render area -> refused', e like '42501%', e);

  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'photo_render', true, true, oa, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
  perform pg_temp.login('a_staff@a.test');
  r := public.photo_render_begin(qa::uuid, 2, 'high', '1536x1024', 'gpt-image-2', 0.4);
  perform pg_temp.res('02 editor with area reserves a pending usage row', (r ->> 'usage_id') is not null and (r ->> 'used')::int = 2, r::text);

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.photo_render_begin(%L, 5, ''high'', ''1536x1024'', ''gpt-image-2'', 0)', qa))
    || pg_temp.try(format('select public.photo_render_begin(%L, 1, ''ultra'', ''1536x1024'', ''gpt-image-2'', 0)', qa))
    || pg_temp.try(format('select public.photo_render_begin(%L, 1, ''high'', ''big'', ''gpt-image-2'', 0)', qa));
  perform pg_temp.res('03 bad n / quality / size refused', e like '22023%22023%22023%', e);

  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.photo_render_begin(%L, 1, ''high'', ''1536x1024'', ''gpt-image-2'', 0)', qa));
  perform pg_temp.res('04 other studio cannot render this event', e like '42501%' or e like 'P0002%', e);

  -- quota: admin sets 3 / month -> 2 used, asking 2 more is refused
  perform pg_temp.login('a_admin@a.test');
  r := public.photo_render_settings_set(true, 3, 20);
  perform pg_temp.res('05 admin sets quota', (r ->> 'monthly_quota')::int = 3 and (r ->> 'used_this_month')::int = 2, r::text);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.photo_render_begin(%L, 2, ''medium'', ''1536x1024'', ''gpt-image-2'', 0)', qa));
  perform pg_temp.res('06 monthly quota enforced', e like 'P0001%quota%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select public.photo_render_settings_set(true, 100, 20)');
  perform pg_temp.res('07 non-admin cannot change settings', e like '42501%', e);

  -- switched off
  perform pg_temp.login('a_admin@a.test');
  r := public.photo_render_settings_set(false, 100, 20);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.photo_render_begin(%L, 1, ''high'', ''1536x1024'', ''gpt-image-2'', 0)', qa));
  perform pg_temp.res('08 switched off -> refused', e like 'P0001%switched off%', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.photo_render_settings_set(true, 100, 20);

  -- service role stores a picture (as the edge function does)
  perform pg_temp.su();
  insert into public.photo_renders(org_id, quote_id, usage_id, style, camera, mime, bytes, data, model, size)
    values (oa, qa::uuid, (select u.id from public.photo_render_usage u where u.quote_id = qa::uuid order by u.created_at limit 1),
            'golden', 'hero', 'image/jpeg', octet_length(jpg), jpg, 'gpt-image-2', '1536x1024') returning id into rid;
  perform pg_temp.login('a_staff@a.test');
  r := public.photo_render_list(qa::uuid);
  perform pg_temp.res('09 list shows the render, no bytes', jsonb_array_length(r) = 1 and r::text not like '%/9j%' and not (r -> 0 ? 'data'), r::text);
  perform pg_temp.login('a_staff@a.test');
  r := public.photo_render_image(rid);
  perform pg_temp.res('10 image returns base64', decode(r ->> 'data', 'base64') = jpg and r ->> 'mime' = 'image/jpeg', r::text);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.photo_render_image(%L)', rid)) || pg_temp.try(format('select public.photo_render_list(%L)', qa))
    || pg_temp.try(format('select public.photo_render_use_in_booklet(%L)', rid));
  perform pg_temp.res('11 other studio cannot read / list / attach', e like '%42501%' or e like '%P0002%', e);
  perform pg_temp.login('a_staff@a.test');
  r := public.photo_render_use_in_booklet(rid);
  perform pg_temp.su();
  select count(*) into n from public.client_booklet_images where quote_id = qa::uuid and kind = 'photo' and variant = 'plain';
  perform pg_temp.res('12 use in booklet copies to its own kind photo (not 3d)', (r ->> 'ok')::boolean and r ->> 'kind' = 'photo' and n = 1
    and not exists (select 1 from public.client_booklet_images where quote_id = qa::uuid and kind = '3d'), r::text || ' n=' || n);
  -- the automatic 3D re-capture writes 3d/plain and never touches the photo
  perform pg_temp.login('a_staff@a.test');
  perform public.booklet_put_image(qa::uuid, '3d', 'plain', 'image/jpeg', encode(jpg, 'base64'));
  perform pg_temp.su();
  perform pg_temp.res('17 3D re-capture keeps the booklet photo', (select count(*) from public.client_booklet_images where quote_id = qa::uuid and kind = 'photo') = 1
    and (select count(*) from public.client_booklet_images where quote_id = qa::uuid and kind = '3d') = 1);
  perform set_config('pr.usage', (select usage_id::text from public.photo_renders where id = rid), false);
  perform pg_temp.login('a_staff@a.test');
  r := public.photo_render_job(current_setting('pr.usage')::uuid);
  perform pg_temp.res('18 job status lists the photo of that request', r ->> 'status' = 'pending' and r -> 'renders' @> to_jsonb(array[rid::text]), r::text);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.photo_render_job(%L)', current_setting('pr.usage')::uuid));
  perform pg_temp.res('19 job status: other studio refused', e like '42501%' or e like 'P0002%', e);
  perform pg_temp.res('20 photo kind allowed, signed-out photo reader: labels variant / bad token -> null',
    public.public_get_booklet_image(gen_random_uuid(), 'photo', 'plain') is null and public.public_get_booklet_image(gen_random_uuid(), 'photo', 'labels') is null
    and has_function_privilege('anon', 'public.public_get_booklet_image(uuid,text,text)', 'execute') and has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute'));
  perform pg_temp.login('a_staff@a.test');

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select count(*) from public.photo_renders') || pg_temp.try('select count(*) from public.photo_render_usage')
    || pg_temp.try('select count(*) from public.photo_render_settings');
  perform pg_temp.res('13 no direct table access (authenticated)', e like '42501%42501%42501%', e);
  perform pg_temp.anon();
  e := pg_temp.try('select public.photo_render_settings_get()') || pg_temp.try(format('select public.photo_render_list(%L)', qa));
  perform pg_temp.res('14 anon cannot call', e like '42501%42501%', e);

  perform pg_temp.res('15 definer + empty search_path', (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p where p.oid in
      ('public.photo_render_begin(uuid,integer,text,text,text,numeric)'::regprocedure, 'public.photo_render_list(uuid)'::regprocedure,
       'public.photo_render_image(uuid)'::regprocedure, 'public.photo_render_use_in_booklet(uuid)'::regprocedure,
       'public.photo_render_settings_get()'::regprocedure, 'public.photo_render_settings_set(boolean,integer,integer)'::regprocedure)));
  perform pg_temp.login('a_staff@a.test');
  r := public.photo_render_settings_get();
  perform pg_temp.res('16 settings_get for staff: can_render, not can_manage', (r ->> 'can_render')::boolean and not (r ->> 'can_manage')::boolean, r::text);

  -- 0173: the same studio in its free trial cannot start a render (paid path above is unchanged)
  perform pg_temp.su();
  if exists (select 1 from public.studio_subscriptions where org_id = oa) then
    update public.studio_subscriptions set status = 'trial' where org_id = oa;
  else
    insert into public.studio_subscriptions(org_id, status, trial_ends_at, updated_at) values (oa, 'trial', now() + interval '7 days', now());
  end if;
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.photo_render_begin(%L, 1, ''high'', ''1536x1024'', ''gpt-image-2'', 0.2)', qa));
  perform pg_temp.res('21 trial studio: photo render refused (0173 trial lock)', e like '42501%free trial%', e);
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'active' where org_id = oa;
end $$;

select name, result from _pr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'PHOTO-RENDER-0095: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'PHOTO-RENDER-0095: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _pr;
rollback;
