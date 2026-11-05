-- 0335_r126_hq_fixes.sql - CANONICAL forward-only. R126 (owner: "start fixing the hq issues"): the HQ walkthrough list,
-- database half. READ FUNCTIONS ONLY: what HQ shows changes, no stored row changes.
-- REQUIRES 0166 (is_sample_master), 0223 (_td223_zone), 0249 (hq_mfa_readiness), 0272 (hq_metrics), 0277 (HQ roles),
--          0298 (masking), 0330 (current hq_users / hq_studios / hq_studio_detail / hq_reveal / hq_audit / hq_overview).
-- [numbering: 0334 is reserved for another round. This file needs nothing from it and works in either order.]
--
-- In plain words:
--   1  System health said only "Job history isn't readable". hq_metrics now says WHY: pg_cron is not switched on for this
--      database (reason not_installed: nothing runs on a timer here), the job list is there but its run history is not
--      (no_history), or the database refused (no_access + the error code).
--   2  Needs attention showed a trial end from the subscription's day, the studio page from the exact moment in the
--      studio's zone: 7 Nov vs 8 Nov. hq_metrics now sends the same exact moment + the studio's zone as hq_trial_info.
--   3  The Studios tile said 14 and the list had 15: the sample-data master was counted in the list and in Studios by
--      plan status, but not in the tile. It is Helm's own set-up, not a customer: hq_studios and hq_overview now leave it
--      out too. Nothing is hidden for good: it opens by its id as before, and its row is untouched.
--   4  People listed a studio's client logins and showed the HQ Owner as role "client" with no studio. hq_users now leaves
--      out client logins of a studio (the list AND the search, so a search can't tell whether a client has an account),
--      shows HQ staff as "HQ Owner" etc. under "Helm HQ", and a login with no studio as "No studio yet". hq_studio_detail
--      leaves client logins out of a studio's People and team size, hq_studios out of Team. hq_reveal refuses them.
--      This is what makes "never a studio's clients" true. Nobody's login, role or access changes.
--   5  An Owner address showed in two-step readiness and as "HQ operator" in the allowlist but not in the HQ team list: it
--      is someone REMOVED from HQ (hq_staff_list leaves those out). hq_mfa_readiness now leaves them out too, and
--      hq_staff_access says hq_status so the allowlist can say "removed from HQ". Recent changes keep the history.
--   6  The activity log showed ids only. hq_audit now adds the studio's NAME to a row about a studio.
-- ZERO DATA LOSS: no table, column, row, policy or trigger is added, changed or deleted. No e-mail is sent, cancelled or
-- removed. Nine functions re-issued; old bodies kept once as *__pre0335 with NO app privilege. One new private helper.
-- Two-step, fresh-code and role checks are unchanged: every kept body still runs its own gate. Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed), per function F(args):
--   drop function public.F(args); alter function public.F__pre0335(args) rename to F; + re-grant as before
--   then: drop function public._r335_cron_state();

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r330_no_sub(text,text,date)') is null or to_regprocedure('public.hq_studio_detail__pre0330(uuid)') is null then
    raise exception 'STOP 0335: 0330 (R122) is not applied - run APPLY-0330.sql first'; end if;
  if to_regprocedure('public._r57_mask_email(text)') is null then raise exception 'STOP 0335: 0298 (R57 masking) is not applied'; end if;
  if to_regprocedure('public.hq_metrics()') is null or to_regprocedure('public._hq72_orgs()') is null then
    raise exception 'STOP 0335: 0272 (hq_metrics) is not applied'; end if;
  if to_regprocedure('public._td223_zone(uuid)') is null then raise exception 'STOP 0335: 0223 (trial dates) is not applied'; end if;
  if to_regprocedure('public.hq_mfa_readiness()') is null then raise exception 'STOP 0335: 0249 (hq_mfa_readiness) is not applied'; end if;
  if to_regprocedure('public.hq_staff_access()') is null then raise exception 'STOP 0335: 0248 (hq_staff_access) is not applied'; end if;
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regprocedure('public._hq27_role_label(text)') is null then
    raise exception 'STOP 0335: 0277 (HQ roles) is not applied'; end if;
  if not exists (select 1 from pg_attribute a where a.attrelid = 'public.organizations'::regclass and a.attname = 'is_sample_master' and not a.attisdropped) then
    raise exception 'STOP 0335: 0166 (is_sample_master) is not applied'; end if;
end $$;

-- ---- 1) keep the current bodies once (__pre0335, no app privilege) -----------------------------------------------------
do $$
declare
  f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values
      ('hq_metrics', ''),
      ('hq_overview', ''),
      ('hq_users', 'text,integer,integer'),
      ('hq_studios', 'text,text,integer,integer'),
      ('hq_studio_detail', 'uuid'),
      ('hq_reveal', 'text,text,text'),
      ('hq_audit', 'date,date'),
      ('hq_mfa_readiness', ''),
      ('hq_staff_access', '')) x(n, a)
  loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0335(' || f.a || ')');
    if v_pub is not null and v_pre is null
       and position('r126-0335' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0335');
    end if;
    v_pre := to_regprocedure('public.' || f.n || '__pre0335(' || f.a || ')');
    if v_pre is null then raise exception 'STOP 0335: %__pre0335 missing', f.n; end if;
    execute 'revoke all on function ' || v_pre::text || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
  end loop;
end $$;

-- ---- 2) item 1: why the job history can't be shown (read-only, never fails the page) -------------------------------------
create or replace function public._r335_cron_state()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r126-0335: called only when hq_metrics could not read the job history
declare n bigint;
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('readable', false, 'reason', 'not_installed', 'jobs', '[]'::jsonb);
  end if;
  begin
    execute $c$select count(*) from cron.job where jobname like 'helm%'$c$ into n;
    return jsonb_build_object('readable', false, 'reason', 'no_history', 'job_count', n, 'jobs', '[]'::jsonb);
  exception when others then
    return jsonb_build_object('readable', false, 'reason', 'no_access', 'code', sqlstate, 'jobs', '[]'::jsonb);
  end;
end $$;

-- ---- 3) items 1 + 2: hq_metrics ------------------------------------------------------------------------------------------
create or replace function public.hq_metrics()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r126-0335: hq_metrics__pre0335 (gates + logs) + the reason the job history can't be read + each ending trial's exact
-- moment and the studio's zone, the same two values as hq_trial_info
declare r jsonb; v jsonb;
begin
  perform public._hq27_require(public._hq27_read_perm('hq_metrics'), false);   -- refused here first (the kept body checks + logs again)
  r := public.hq_metrics__pre0335();
  if r is null or jsonb_typeof(r) <> 'object' then return r; end if;
  if jsonb_typeof(r #> '{attention,trials_ending}') = 'array' then
    select coalesce(jsonb_agg(x.e || jsonb_build_object(
             'ends_at', coalesce(o.trial_ends_at, (s.trial_ends_at::timestamp at time zone 'UTC'), (x.e ->> 'ends_at')::timestamptz),
             'timezone', public._td223_zone((x.e ->> 'org_id')::uuid)) order by x.n), '[]'::jsonb)
      into v
      from jsonb_array_elements(r #> '{attention,trials_ending}') with ordinality x(e, n)
      left join public.organizations o on o.id = (x.e ->> 'org_id')::uuid
      left join public.studio_subscriptions s on s.org_id = o.id;
    r := jsonb_set(r, '{attention,trials_ending}', v);
  end if;
  if jsonb_typeof(r #> '{health,cron}') = 'object' and not coalesce((r #>> '{health,cron,readable}')::boolean, false) then
    r := jsonb_set(r, '{health,cron}', public._r335_cron_state());
  end if;
  return r;
end $$;

-- ---- 4) item 3: the sample-data master is not counted in Studios by plan status ------------------------------------------
create or replace function public.hq_overview()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r126-0335: hq_overview__pre0335 (gates + logs) with the studio counts of real studios only, the same set as hq_metrics
declare r jsonb;
begin
  perform public._hq27_require(public._hq27_read_perm('hq_overview'), false);   -- refused here first (the kept body checks + logs again)
  r := public.hq_overview__pre0335();
  if r is null or jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'studios') <> 'object' then return r; end if;
  return jsonb_set(r, '{studios}', (r -> 'studios') || jsonb_build_object(
    'total',  (select count(*) from public.organizations o where not o.is_sample_master),
    'new_7d', (select count(*) from public.organizations o where not o.is_sample_master and o.created_at >= now() - interval '7 days'),
    'new_30d',(select count(*) from public.organizations o where not o.is_sample_master and o.created_at >= now() - interval '30 days'),
    'by_status', coalesce((select jsonb_object_agg(t.st_k, t.st_c) from (
        select case when public._r330_no_sub(ss.status, ss.prev_status, ss.current_period_end) then 'none'
                    else coalesce(ss.status, 'none') end st_k, count(*) st_c
          from public.organizations o left join public.studio_subscriptions ss on ss.org_id = o.id
         where not o.is_sample_master group by 1) t), '{}'::jsonb)));
end $$;

-- ---- 5) item 4: People = studio teams + HQ staff + logins with no studio yet --------------------------------------------
create or replace function public.hq_users(p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns table(user_id uuid, email text, studio text, org_id uuid, role text, created_at timestamptz, last_sign_in_at timestamptz,
              email_confirmed boolean, mfa_enabled boolean, total_count bigint)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
-- r126-0335: the 0330 people list (e-mail masked, search rules unchanged; carries the r57-0298 masking and the r122-0330
-- search rule, so a re-run of those files never re-wraps this body) WITHOUT a studio's client logins - not in the list, not
-- in the search, not in the count. HQ staff read "HQ Owner" etc. under Helm HQ; a login with no studio reads No studio yet.
declare s text := nullif(btrim(coalesce(p_search, '')), ''); has_mfa boolean := to_regclass('auth.mfa_factors') is not null;
begin
  perform public._hq27_require('people.read', false);
  perform public._hq_gate('hq_users', left(s, 80));
  return query execute format($q$
    select u.id, public._r57_mask_email(u.email::text),
           coalesce(o.name, case when h.role is not null then 'Helm HQ' end), p.org_id,
           case when h.role is not null then 'HQ ' || public._hq27_role_label(h.role)
                when p.org_id is null then 'No studio yet' else p.role end,
           u.created_at, u.last_sign_in_at, u.email_confirmed_at is not null, %s, count(*) over ()
      from auth.users u
      left join public.profiles p on p.id = u.id
      left join public.organizations o on o.id = p.org_id
      left join lateral (select pa.role from public.platform_admins pa
                          where coalesce(pa.status, '') <> 'removed' and (pa.user_id = u.id or pa.email = lower(u.email::text))
                          order by pa.user_id is not null desc limit 1) h on true
     where not (h.role is null and p.org_id is not null and coalesce(p.role, '') = 'client')
       and ($1 is null
        or (char_length($1) >= 3 and strpos(lower(coalesce(u.email, '')), lower($1)) > 0)
        or strpos(lower(coalesce(o.name, '')), lower($1)) > 0)
     order by u.created_at desc, u.id
     limit $2 offset $3$q$,
    case when has_mfa then 'exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status::text = ''verified'')'
         else 'false' end)
  using s, least(greatest(coalesce(p_limit, 25), 1), 200), greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---- 6) items 3 + 4: the Studios list ---------------------------------------------------------------------------------------
create or replace function public.hq_studios(p_search text default null, p_status text default null, p_limit integer default 25, p_offset integer default 0)
returns table(org_id uuid, name text, slug text, created_at timestamptz, owner_email text, users_count bigint, plan_code text,
              plan_name text, status text, current_period_end date, last_activity timestamptz, total_paid numeric, country text,
              state text, primary_contact_name text, primary_contact_email text, primary_contact_phone text, total_count bigint)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
-- r126-0335: the 0330 studio list (e-mails / phones masked, search rules unchanged; carries the r57-0298 masking and the
-- r122-0330 search rule, so a re-run of those files never re-wraps this body) WITHOUT the sample-data master, and Team
-- counts the studio's own people (no client logins)
declare s text := nullif(btrim(coalesce(p_search, '')), ''); st text := nullif(btrim(coalesce(p_status, '')), '');
begin
  perform public._hq27_require('studios.read', false);
  perform public._hq_gate('hq_studios', left(coalesce(s, '') || '|' || coalesce(st, ''), 80));
  if st is not null and st not in ('trial','active','past_due','suspended','cancelled','none') then
    raise exception 'unknown status filter' using errcode = '22023'; end if;
  return query
    select r.org_id, r.name, r.slug, r.created_at, public._r57_mask_email(r.owner_email),
           (select count(*) from public.profiles p where p.org_id = r.org_id and coalesce(p.role, '') <> 'client'),
           r.plan_code, r.plan_name, r.status,
           r.current_period_end, r.last_activity, r.total_paid, a.country, a.state, a.primary_contact_name,
           public._r57_mask_email(a.primary_contact_email), public._r57_mask_phone(a.primary_contact_phone), count(*) over ()
      from public._hq_studio_rows() r
      join public.organizations o on o.id = r.org_id and not o.is_sample_master
      left join public.studio_account a on a.org_id = r.org_id
     where (st is null or r.status = st)
       and (s is null or strpos(lower(r.name), lower(s)) > 0 or strpos(lower(coalesce(r.slug, '')), lower(s)) > 0
            or (char_length(s) >= 3 and (strpos(lower(coalesce(r.owner_email, '')), lower(s)) > 0
                                        or strpos(lower(coalesce(a.primary_contact_email, '')), lower(s)) > 0)))
     order by r.created_at desc, r.org_id
     limit least(greatest(coalesce(p_limit, 25), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---- 7) item 4: a studio's People + team size --------------------------------------------------------------------------------
create or replace function public.hq_studio_detail(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r126-0335: hq_studio_detail__pre0335 (gates, logs, masks; carries the r57-0298 masking, so a re-run of 0298 never
-- re-wraps this body) without client logins in members and users_count
declare r jsonb; v jsonb;
begin
  perform public._hq27_require('studios.read', false);   -- refused here first (the kept body checks + logs again)
  r := public.hq_studio_detail__pre0335(p_org);
  if r is null or jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'members') <> 'array' then return r; end if;
  select coalesce(jsonb_agg(x.e order by x.n), '[]'::jsonb) into v
    from jsonb_array_elements(r -> 'members') with ordinality x(e, n) where coalesce(x.e ->> 'role', '') <> 'client';
  return r || jsonb_build_object('members', v, 'users_count', jsonb_array_length(v));
end $$;

-- ---- 8) item 4: Show never opens a client login -----------------------------------------------------------------------------
create or replace function public.hq_reveal(p_entity text, p_entity_id text, p_field text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r126-0335: hq_reveal__pre0335 (the role check, the log row and the value in one step); entity 'person' or 'member' is
-- refused for a studio's client login
declare v_e text := lower(btrim(coalesce(p_entity, ''))); v_id text := btrim(coalesce(p_entity_id, ''));
begin
  if v_e in ('person', 'member') and v_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform public._hq27_require(case v_e when 'person' then 'people.read' else 'studios.read' end, false);
    if exists (select 1 from public.profiles p
                where p.id = v_id::uuid and p.org_id is not null and coalesce(p.role, '') = 'client'
                  and not exists (select 1 from public.platform_admins pa left join auth.users u on u.id = p.id
                                   where coalesce(pa.status, '') <> 'removed' and (pa.user_id = p.id or pa.email = lower(u.email::text)))) then
      raise exception 'This is a client login of a studio. HQ does not show those.' using errcode = '22023';
    end if;
  end if;
  return public.hq_reveal__pre0335(p_entity, p_entity_id, p_field);
end $$;

-- ---- 9) item 6: the activity log names the studio --------------------------------------------------------------------------
create or replace function public.hq_audit(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r126-0335: hq_audit__pre0335 (gates, logs, masks) + studio = the studio's name on a row whose entity_id is a studio
declare r jsonb; v jsonb;
begin
  perform public._hq27_require(public._hq27_read_perm('hq_audit'), false);   -- refused here first (the kept body checks + logs again)
  r := public.hq_audit__pre0335(p_from, p_to);
  if r is null or jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'rows') <> 'array' then return r; end if;
  select coalesce(jsonb_agg(x.e || case when o.id is null then '{}'::jsonb else jsonb_build_object('studio', o.name) end order by x.n), '[]'::jsonb)
    into v
    from jsonb_array_elements(r -> 'rows') with ordinality x(e, n)
    left join public.organizations o on o.id::text = x.e ->> 'entity_id';
  return jsonb_set(r, '{rows}', v);
end $$;

-- ---- 10) item 5: someone removed from HQ ---------------------------------------------------------------------------------------
create or replace function public.hq_mfa_readiness()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r126-0335: hq_mfa_readiness__pre0335 (gates + logs) without people removed from HQ, the same set as hq_staff_list
declare r jsonb; v jsonb;
begin
  perform public._hq27_require(public._hq27_read_perm('hq_mfa_readiness'), false);   -- refused here first (the kept body checks + logs again)
  r := public.hq_mfa_readiness__pre0335();
  if r is null or jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'operators') <> 'array' then return r; end if;
  select coalesce(jsonb_agg(x.e order by x.n), '[]'::jsonb) into v
    from jsonb_array_elements(r -> 'operators') with ordinality x(e, n)
   where not exists (select 1 from public.platform_admins pa where lower(pa.email) = lower(x.e ->> 'email') and pa.status = 'removed');
  return r || (select jsonb_build_object('operators', v,
      'operators_without_2step', count(*) filter (where (o.e ->> 'has_login')::boolean and not (o.e ->> 'has_2step')::boolean),
      'operators_never_signed_in', count(*) filter (where not (o.e ->> 'has_login')::boolean),
      'operators_with_2step', count(*) filter (where (o.e ->> 'has_2step')::boolean),
      'safe_to_require', count(*) filter (where (o.e ->> 'has_login')::boolean and not (o.e ->> 'has_2step')::boolean) = 0
                         and count(*) filter (where (o.e ->> 'has_2step')::boolean) > 0)
    from jsonb_array_elements(v) o(e));
end $$;

create or replace function public.hq_staff_access()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r126-0335: hq_staff_access__pre0335 (gates + logs) + hq_status on each allowlist row (active / invited / suspended / removed)
declare r jsonb; v jsonb;
begin
  perform public._hq27_require(public._hq27_read_perm('hq_staff_access'), false);   -- refused here first (the kept body checks + logs again)
  r := public.hq_staff_access__pre0335();
  if r is null or jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'allowlist') <> 'array' then return r; end if;
  select coalesce(jsonb_agg(x.e || jsonb_build_object('hq_status',
           (select pa.status from public.platform_admins pa where lower(pa.email) = lower(x.e ->> 'email') limit 1)) order by x.n), '[]'::jsonb)
    into v from jsonb_array_elements(r -> 'allowlist') with ordinality x(e, n);
  return jsonb_set(r, '{allowlist}', v);
end $$;

-- ---- 11) privileges (each public function keeps exactly the roles it had) -------------------------------------------------------
do $$ declare f text; begin
  execute 'revoke all on function public._r335_cron_state() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r335_cron_state() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r335_cron_state() from authenticated'; end if;
  -- signed-in only (the HQ gates inside decide), as 0272 / 0249 / 0248 left them
  foreach f in array array['public.hq_metrics()', 'public.hq_mfa_readiness()', 'public.hq_staff_access()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- signed-in + service role, as 0330 left them
  foreach f in array array['public.hq_overview()', 'public.hq_users(text, integer, integer)',
      'public.hq_studios(text, text, integer, integer)', 'public.hq_studio_detail(uuid)', 'public.hq_reveal(text, text, text)',
      'public.hq_audit(date, date)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
