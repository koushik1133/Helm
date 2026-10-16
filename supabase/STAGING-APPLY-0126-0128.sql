-- APPLY 0126 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
begin;
-- 0126_trial_staff_and_expiry.sql - CANONICAL forward-only. REQUIRES 0043 (current_org_id__pre0043),
-- 0116 (_trial_locked), 0028 (mfa_ok).
--
-- In plain words:
--   1) A trial studio can invite its own real staff exactly like a paid studio (nothing to
--      change: invitations / accept_invitation already work per studio). The Staff page now
--      says "Trial: staff access ends when the trial ends on <date>".
--   2) When the 8-day trial ends and the studio has NOT paid (public._trial_locked(org) is
--      true), every member who is NOT the studio owner (organizations.created_by) loses
--      access to that studio. This is done WITHOUT touching memberships: profiles.org_id
--      and profiles.role are left exactly as they are. current_org_id() - the function every
--      RLS policy and studio RPC already uses - simply answers NULL for such a member, the
--      same fail-closed way 0043 handles a member who still has to pass 2FA.
--      The owner keeps a read-only studio (0116 write guard, unchanged): can view + export
--      and pay. The moment the studio pays (subscription active / payment recorded / HQ
--      extends the trial) _trial_locked() turns false and every member's access comes back
--      on its own - no data moved, nothing to restore.
--   3) my_trial_access(): works even for a blocked member (it does not depend on
--      current_org_id()), so the app can show "This studio's trial has ended - ask the owner
--      to subscribe" instead of an empty app, and the Staff-page note for the owner.
--
--   Non-trial studios: organizations.trial_ends_at is null -> _trial_member_blocked() is
--   false on its first check, current_org_id() returns exactly what it did before.
--   Platform operators have no studio; service role (auth.uid() null) is never blocked.
--
--   Changes: 2 functions added, 1 function body replaced (current_org_id, same signature,
--   same OID so every policy keeps pointing at it). No table, column or row is changed or
--   deleted. Additive + idempotent: safe to run twice. ASCII only.

do $do$ begin
  if to_regprocedure('public.current_org_id__pre0043()') is null then
    raise exception '0126: public.current_org_id__pre0043() (0043) is missing on this database';
  end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception '0126: public._trial_locked(uuid) (0116) is missing on this database';
  end if;
  if to_regprocedure('public.mfa_ok()') is null then
    raise exception '0126: public.mfa_ok() (0028) is missing on this database';
  end if;
end $do$;

-- ---- 1) is the signed-in user a non-owner member of an ended, unpaid trial studio? -------------
create or replace function public._trial_member_blocked(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-staff-0126: cheap first test (trial_ends_at in the past) keeps paid studios on the fast path
  select p_org is not null
     and auth.uid() is not null
     and exists (select 1 from public.organizations o
                  where o.id = p_org
                    and o.trial_ends_at is not null and o.trial_ends_at <= now()
                    and o.created_by is not null and o.created_by <> auth.uid())
     and public._trial_locked(p_org);
$$;
revoke all on function public._trial_member_blocked(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._trial_member_blocked(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._trial_member_blocked(uuid) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public._trial_member_blocked(uuid) to service_role'; end if;
end $$;

-- ---- 2) current_org_id(): 0043 body + the trial-staff gate ---------------------------------------
-- Same signature / language / volatility / definer as 0043, so RLS policies (bound by OID) are untouched.
create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = '' as $$
  -- mfa-enforce-0043: an enrolled member at aal1 has no studio until they pass 2FA
  -- trial-staff-0126: a non-owner member of an ended, unpaid trial studio has no studio until it pays
  select case when public.mfa_ok() and not public._trial_member_blocked(x.org) then x.org end
    from (select public.current_org_id__pre0043() as org) x;
$$;

-- ---- 3) my_trial_access(): what the app shows (works while blocked) ------------------------------
create or replace function public.my_trial_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-staff-0126
declare v_org uuid; o public.organizations; v_locked boolean; v_owner boolean;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.mfa_ok() then return jsonb_build_object('is_trial_org', false); end if;
  v_org := public.current_org_id__pre0043();
  if v_org is null then return jsonb_build_object('is_trial_org', false); end if;
  select * into o from public.organizations x where x.id = v_org;
  if o.id is null or o.trial_ends_at is null then return jsonb_build_object('is_trial_org', false); end if;
  v_locked := public._trial_locked(v_org);
  v_owner := o.created_by is not null and o.created_by = auth.uid();
  return jsonb_build_object('is_trial_org', true, 'name', o.name, 'ends_at', o.trial_ends_at,
    'ended', o.trial_ends_at <= now(), 'locked', v_locked, 'is_owner', v_owner,
    'blocked', public._trial_member_blocked(v_org),
    'timezone', coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata'));
end $$;
revoke all on function public.my_trial_access() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.my_trial_access() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.my_trial_access() to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.my_trial_access() to service_role'; end if;
end $$;

-- If anything above failed, run:
--   rollback;
commit;

-- VERIFY 0126 (read-only; expect every ok = true)
select '0126 _trial_member_blocked exists' as item, to_regprocedure('public._trial_member_blocked(uuid)') is not null as ok
union all select '0126 _trial_member_blocked uses _trial_locked', coalesce(pg_get_functiondef(to_regprocedure('public._trial_member_blocked(uuid)')) like '%_trial_locked(p_org)%', false)
union all select '0126 _trial_member_blocked spares the owner', coalesce(pg_get_functiondef(to_regprocedure('public._trial_member_blocked(uuid)')) like '%created_by <> auth.uid()%', false)
union all select '0126 _trial_member_blocked not callable by authenticated', not coalesce(has_function_privilege('authenticated', 'public._trial_member_blocked(uuid)', 'execute'), false)
union all select '0126 current_org_id has trial-staff gate', coalesce(pg_get_functiondef(to_regprocedure('public.current_org_id()')) like '%trial-staff-0126%', false)
union all select '0126 current_org_id keeps 2FA gate', coalesce(pg_get_functiondef(to_regprocedure('public.current_org_id()')) like '%mfa_ok()%', false)
union all select '0126 current_org_id still wraps pre0043 body', coalesce(pg_get_functiondef(to_regprocedure('public.current_org_id()')) like '%current_org_id__pre0043()%', false)
union all select '0126 current_org_id still security definer + stable', coalesce((select prosecdef and provolatile = 's' from pg_proc where oid = to_regprocedure('public.current_org_id()')), false)
union all select '0126 my_trial_access exists', to_regprocedure('public.my_trial_access()') is not null
union all select '0126 my_trial_access callable by authenticated', coalesce(has_function_privilege('authenticated', 'public.my_trial_access()', 'execute'), false)
union all select '0126 my_trial_access not callable by anon', not coalesce(has_function_privilege('anon', 'public.my_trial_access()', 'execute'), false)
union all select '0126 read-only guard (0116) still present', coalesce(pg_get_functiondef(to_regprocedure('public.tg_studio_read_only()')) like '%trial_ended%', false)
union all select '0126 no paid studio is blocked (non-trial studios count with blocked members = 0)', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_member_blocked(o.id));
-- APPLY 0127 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
begin;
-- ============================================================================
-- 0127_trial_fresh_start.sql - CANONICAL forward-only. REQUIRES 0042 (helm_env_settings),
-- 0097 (is_demo, _demo_clear), 0116/0119 (start_self_serve_trial), 0123 (my_demo_status).
--
-- In plain words:
--   1) Every free trial is still its OWN studio ("Demo 1", "Demo 2", ...). Nothing is shared.
--      Each one gets the same built-in sample data (0100 _demo_seed + 0116/0122
--      _trial_seed_extra): inventory, vendors, staff, menu packages (templates), venues,
--      dishes, sample leads and events. Every sample row is is_demo = true and named "Demo \u00b7 ...".
--
--   2) OWNER-REPLACEABLE SAMPLE DATA (marker: helm-0127-trial-seed-config).
--      The owner can add their own trial data later WITHOUT a code change: put a jsonb into
--      helm_env_settings under key 'trial_demo_seed' (service role / SQL editor only). Shape:
--        {"inventory":[{"name":"Chairs","category":"Furniture","qty":100,"unit":"pcs","unit_cost":40}],
--         "vendors":  [{"name":"ABC Tents","category":"Tents","kind":"rental","phone":"","email":""}],
--         "staff":    [{"name":"Ravi","department":"Operations","role":"Manager","emp_type":"full_time","day_rate":3000}],
--         "templates":[{"name":"Gold Veg","tier":"gold","diet":"veg","price_per_plate":900,"dishes":[]}]}
--      When the key is missing (the default) nothing extra happens and trials get exactly
--      today's built-in sample set. When it is set, each NEW trial also gets these rows,
--      tagged is_demo = true and prefixed "Demo \u00b7 " so "Start fresh" can find and remove them.
--      Hooked by an AFTER UPDATE trigger on organizations that fires only at the moment a
--      demo-mode trial starts (trial_ends_at null -> set, trial_mode = 'demo'); a failure is
--      swallowed and can never block the trial. Studios that are not trials never fire it.
--
--   3) CONVERSION CHOICE (marker: helm-0127-demo-choice). After a trial studio subscribes the
--      admin picks "Start fresh" (removes ONLY this studio's is_demo rows through the existing
--      _demo_clear - the same code clear_demo_data uses) or "Keep the sample data". The choice is
--      recorded on the studio (two NEW nullable columns) and in audit_log. Admin only, own studio
--      only, trial studios only (organizations.trial_ends_at not null).
--
--   4) my_demo_status(): 0123 body + two read-only keys: demo_choice, choice_pending.
--
--   Changes: 2 nullable columns added, 3 functions added, 1 function body re-issued, 1 trigger.
--   No table/row is dropped or rewritten. Non-trial studios: no behaviour change.
--   Additive + idempotent: safe to run twice. ASCII only (the dot is written as \u00b7).
-- ============================================================================

alter table public.organizations add column if not exists demo_choice text;
alter table public.organizations add column if not exists demo_choice_at timestamptz;
do $do$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_demo_choice_chk127') then
    alter table public.organizations add constraint organizations_demo_choice_chk127
      check (demo_choice is null or demo_choice in ('fresh','keep'));
  end if;
end $do$;

-- ---- 1) owner-replaceable trial seed --------------------------------------------------------
create or replace function public._trial_seed_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  -- helm-0127-trial-seed-config: edit helm_env_settings key 'trial_demo_seed' to change it
  select coalesce((select s.value from public.helm_env_settings s where s.key = 'trial_demo_seed'), '{}'::jsonb)
$$;
revoke all on function public._trial_seed_config() from public, anon, authenticated;

create or replace function public._trial_seed_custom(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- helm-0127-trial-seed-config: fill-only, every row is_demo + "Demo \u00b7 " prefix, own org only
declare cfg jsonb := public._trial_seed_config(); x jsonb; n text; v_out jsonb := '{}'::jsonb; c int;
  pfx constant text := E'Demo \u00b7 ';
begin
  if p_org is null then return jsonb_build_object('seeded', false, 'reason', 'no_org'); end if;
  if jsonb_typeof(cfg) is distinct from 'object' or cfg = '{}'::jsonb then
    return jsonb_build_object('seeded', false, 'reason', 'no_config'); end if;

  begin c := 0;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(cfg->'inventory') = 'array' then cfg->'inventory' else '[]'::jsonb end) loop
      n := btrim(coalesce(x->>'name', '')); if n = '' then continue; end if;
      if left(n, length(pfx)) <> pfx then n := pfx || n; end if;
      if exists (select 1 from public.inventory_items i where i.org_id = p_org and lower(btrim(i.name)) = lower(n)) then continue; end if;
      insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo)
        values (p_org, left(n, 200), coalesce(nullif(x->>'category', ''), 'General'),
                greatest(coalesce((x->>'qty')::numeric, 1), 0)::int, coalesce(nullif(x->>'unit', ''), 'pcs'),
                coalesce(nullif(x->>'priority', ''), 'B'), greatest(coalesce((x->>'unit_cost')::numeric, 0), 0),
                E'Demo item \u2014 sample data.', true, true);
      c := c + 1;
    end loop;
    v_out := v_out || jsonb_build_object('inventory', c);
  exception when others then v_out := v_out || jsonb_build_object('inventory_error', sqlstate); end;

  begin c := 0;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(cfg->'vendors') = 'array' then cfg->'vendors' else '[]'::jsonb end) loop
      n := btrim(coalesce(x->>'name', '')); if n = '' then continue; end if;
      if left(n, length(pfx)) <> pfx then n := pfx || n; end if;
      if exists (select 1 from public.vendors v where v.org_id = p_org and lower(btrim(v.name)) = lower(n)) then continue; end if;
      insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo)
        values (p_org, left(n, 200), coalesce(nullif(x->>'category', ''), 'General'), coalesce(nullif(x->>'kind', ''), 'vendor'),
                nullif(x->>'phone', ''), nullif(x->>'email', ''), E'Demo vendor \u2014 sample data.', true, true);
      c := c + 1;
    end loop;
    v_out := v_out || jsonb_build_object('vendors', c);
  exception when others then v_out := v_out || jsonb_build_object('vendors_error', sqlstate); end;

  begin c := 0;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(cfg->'staff') = 'array' then cfg->'staff' else '[]'::jsonb end) loop
      n := btrim(coalesce(x->>'name', '')); if n = '' then continue; end if;
      if left(n, length(pfx)) <> pfx then n := pfx || n; end if;
      if exists (select 1 from public.crew_members m where m.org_id = p_org and m.name = n) then continue; end if;
      insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
        values (p_org, left(n, 200), nullif(x->>'phone', ''), nullif(x->>'department', ''), nullif(x->>'role', ''),
                coalesce(nullif(x->>'emp_type', ''), 'full_time'), greatest(coalesce((x->>'day_rate')::numeric, 0), 0),
                E'Demo staff \u2014 sample data.', true, true);
      c := c + 1;
    end loop;
    v_out := v_out || jsonb_build_object('staff', c);
  exception when others then v_out := v_out || jsonb_build_object('staff_error', sqlstate); end;

  begin c := 0;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(cfg->'templates') = 'array' then cfg->'templates' else '[]'::jsonb end) loop
      n := btrim(coalesce(x->>'name', '')); if n = '' then continue; end if;
      if left(n, length(pfx)) <> pfx then n := pfx || n; end if;
      -- a package fills a free tier + diet slot only (same rule as _demo_seed)
      if exists (select 1 from public.menu_templates t where t.org_id = p_org
                  and (lower(btrim(t.name)) = lower(n) or (t.tier = x->>'tier' and t.diet = x->>'diet'))) then continue; end if;
      insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, is_demo)
        values (p_org, x->>'tier', x->>'diet', left(n, 200), greatest(coalesce((x->>'price_per_plate')::numeric, 0), 0),
                case when jsonb_typeof(x->'dishes') = 'array' then x->'dishes' else '[]'::jsonb end,
                true, 950 + c, E'Demo package \u2014 sample data.', true);
      c := c + 1;
    end loop;
    v_out := v_out || jsonb_build_object('templates', c);
  exception when others then v_out := v_out || jsonb_build_object('templates_error', sqlstate); end;

  return jsonb_build_object('seeded', true) || v_out;
end $$;
revoke all on function public._trial_seed_custom(uuid) from public, anon, authenticated;

create or replace function public._tg_trial_seed_custom()
returns trigger language plpgsql security definer set search_path = '' as $$
-- helm-0127-trial-seed-config: fires once, when a demo-mode trial starts; never blocks it
begin
  if old.trial_ends_at is null and new.trial_ends_at is not null and new.trial_mode = 'demo' then
    begin perform public._trial_seed_custom(new.id);
    exception when others then null; end;
  end if;
  return null;
end $$;
revoke all on function public._tg_trial_seed_custom() from public, anon, authenticated;

drop trigger if exists trial_seed_custom_127 on public.organizations;
create trigger trial_seed_custom_127 after update of trial_ends_at, trial_mode on public.organizations
  for each row execute function public._tg_trial_seed_custom();

-- ---- 2) conversion choice: start fresh / keep samples ------------------------------------------
create or replace function public.trial_demo_choice(p_choice text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0127-demo-choice: admin only, own studio only, trial studios only, is_demo rows only
declare v_org uuid := public.current_org_id(); v_choice text := lower(btrim(coalesce(p_choice, '')));
  o public.organizations; r jsonb := null;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_choice not in ('fresh', 'keep') then raise exception 'choose fresh or keep' using errcode = '22023'; end if;
  select * into o from public.organizations x where x.id = v_org for update;
  if o.id is null or o.trial_ends_at is null then
    raise exception 'only a trial studio has sample data to choose about' using errcode = '22023'; end if;
  if v_choice = 'fresh' then
    r := public._demo_clear(v_org);            -- removes ONLY this studio's is_demo rows (0097)
    update public.organizations set trial_mode = 'own' where id = v_org;
  end if;
  update public.organizations set demo_choice = v_choice, demo_choice_at = now() where id = v_org;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'trial.demo_choice',
           'organizations', v_org::text, jsonb_build_object('choice', v_choice, 'cleared', r), v_org, now();
  return jsonb_build_object('result', 'ok', 'choice', v_choice, 'cleared', r);
end $$;
revoke all on function public.trial_demo_choice(text) from public, anon;
grant execute on function public.trial_demo_choice(text) to authenticated, service_role;

-- ---- 3) my_demo_status: 0123 body + demo_choice / choice_pending (read-only) ----------------------
create or replace function public.my_demo_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-start-fresh-0123 helm-0127-demo-choice
declare v_org uuid := public.current_org_id(); v_mode text; v_rows int; v_counts jsonb;
  v_choice text; v_trial boolean;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select o.trial_mode, o.demo_choice, o.trial_ends_at is not null into v_mode, v_choice, v_trial
    from public.organizations o where o.id = v_org;
  v_counts := jsonb_build_object(
    'events',    (select count(*) from public.quotes where org_id = v_org and is_demo),
    'leads',     (select count(*) from public.leads where org_id = v_org and is_demo),
    'staff',     (select count(*) from public.crew_members where org_id = v_org and is_demo and active),
    'vendors',   (select count(*) from public.vendors where org_id = v_org and is_demo and active),
    'inventory', (select count(*) from public.inventory_items where org_id = v_org and is_demo and active),
    'venues',    (select count(*) from public.venues where org_id = v_org and is_demo and active),
    'packages',  (select count(*) from public.menu_templates where org_id = v_org and is_demo and active),
    'dishes',    (select count(*) from public.dish_catalog where org_id = v_org and is_demo and active),
    'layouts',   (select count(*) from public.layouts where org_id = v_org and is_demo));
  select (select count(*) from public.quotes where org_id = v_org and is_demo)
       + (select count(*) from public.leads where org_id = v_org and is_demo)
       + (select count(*) from public.crew_members where org_id = v_org and is_demo)
       + (select count(*) from public.vendors where org_id = v_org and is_demo)
       + (select count(*) from public.inventory_items where org_id = v_org and is_demo)
       + (select count(*) from public.venues where org_id = v_org and is_demo and active)
       + (select count(*) from public.menu_templates where org_id = v_org and is_demo)
       + (select count(*) from public.layouts where org_id = v_org and is_demo)
    into v_rows;
  return jsonb_build_object('trial_mode', v_mode, 'demo_rows', v_rows, 'has_demo', v_rows > 0,
    'is_admin', coalesce(public.is_admin(), false), 'counts', v_counts,
    'demo_choice', v_choice, 'choice_pending', coalesce(v_trial, false) and v_choice is null and v_rows > 0);
end $$;
revoke all on function public.my_demo_status() from public, anon;
grant execute on function public.my_demo_status() to authenticated, service_role;
commit;

-- VERIFY 0127 (read-only; expect every ok = true)
select '0127 organizations.demo_choice exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'demo_choice') as ok
union all select '0127 organizations.demo_choice_at exists', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'demo_choice_at')
union all select '0127 demo_choice check constraint', exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_demo_choice_chk127')
union all select '0127 seed config reader exists', to_regprocedure('public._trial_seed_config()') is not null
union all select '0127 custom seed has marker', coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_custom(uuid)')) like '%helm-0127-trial-seed-config%', false)
union all select '0127 custom seed not callable by users', not coalesce(has_function_privilege('authenticated', 'public._trial_seed_custom(uuid)', 'execute'), true)
union all select '0127 seed trigger attached', exists (select 1 from pg_trigger where tgname = 'trial_seed_custom_127' and tgrelid = 'public.organizations'::regclass and not tgisinternal)
union all select '0127 trial_demo_choice exists + marker', coalesce(pg_get_functiondef(to_regprocedure('public.trial_demo_choice(text)')) like '%helm-0127-demo-choice%', false)
union all select '0127 trial_demo_choice uses _demo_clear only', coalesce(pg_get_functiondef(to_regprocedure('public.trial_demo_choice(text)')) like '%_demo_clear(v_org)%', false)
union all select '0127 trial_demo_choice not callable by anon', not coalesce(has_function_privilege('anon', 'public.trial_demo_choice(text)', 'execute'), true)
union all select '0127 my_demo_status has choice keys', coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) like '%choice_pending%', false)
union all select '0127 my_demo_status keeps counts', coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) like '%''counts''%', false)
union all select '0127 no non-trial studio has a demo choice', not exists (select 1 from public.organizations where trial_ends_at is null and demo_choice is not null);
-- APPLY 0128 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
begin;
-- 0128_trial_test_mode.sql - CANONICAL forward-only. REQUIRES 0026 (quote_otps.code_hash), 0042, 0093 (_otp_canon_phone), 0116 (_trial_locked).
--
-- In plain words:
--   TRIAL TEST MODE. Inside a free-trial studio the owner is testing alone: there is no real
--   client to receive an SMS code. So, ONLY for a studio whose free trial is still running,
--   the client approval page offers "Skip OTP (trial test mode)".
--
--   How the skip works (marker: helm-0128-trial-test):
--     1) trial_test_mode_for_token(token) - true only when the link's studio is an ACTIVE
--        trial (organizations.trial_ends_at set and in the future, not locked). The page uses
--        it only to decide whether to SHOW the skip button.
--     2) trial_test_approve(token, phone, name, terms, consent text, user agent) - checks the
--        SAME thing again on the server (never trusts the page), then writes a one-time code
--        straight into quote_otps (hashed, 10 minutes, no _notify -> no SMS / email / WhatsApp
--        is queued) and calls the normal public.verify_and_consent with it. So the consent row,
--        the quote approval_status flip and every trigger (lifecycle, audit, link expiry,
--        shelf, rate limits) are exactly the real flow. Afterwards the consent is stamped
--        verified_via_otp = false (honest: no SMS was verified) and an audit_log row
--        'approval.trial_test_skip' records that the OTP step was skipped.
--   Non-trial studios: trial_test_approve refuses ('trial_test_unavailable'), and nothing about
--   request_otp / verify_and_consent changes - they still require the OTP exactly as before.
--   Paid / converted / ended trials: refused too (an active subscription or a passed end date).
--
--   Changes: 3 new functions. No table, column, row, existing function or trigger is changed or
--   deleted. Additive + idempotent: safe to run twice. ASCII only.

-- ---- 1) is this org an active trial (internal) -------------------------------------
create or replace function public._trial_test_mode_ok(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0128-trial-test
  select p_org is not null
     and exists (select 1 from public.organizations o
                  where o.id = p_org and o.trial_ends_at is not null and o.trial_ends_at > now())
     and not exists (select 1 from public.studio_subscriptions s
                      where s.org_id = p_org and s.status = 'active')
     and not public._trial_locked(p_org);
$$;
revoke all on function public._trial_test_mode_ok(uuid) from public, anon, authenticated;
grant execute on function public._trial_test_mode_ok(uuid) to service_role;

-- ---- 2) page helper: show the skip button? ------------------------------------------
create or replace function public.trial_test_mode_for_token(p_token uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0128-trial-test
  select coalesce((select public._trial_test_mode_ok(q.org_id) from public.quotes q
                    where p_token is not null and q.approval_token = p_token
                      and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
                    limit 1), false);
$$;
revoke all on function public.trial_test_mode_for_token(uuid) from public;
grant execute on function public.trial_test_mode_for_token(uuid) to anon, authenticated, service_role;

-- ---- 3) the skip itself ------------------------------------------------------------
create or replace function public.trial_test_approve(p_token uuid, p_phone text, p_client_name text,
                                                     p_terms_version text, p_consent_text text,
                                                     p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0128-trial-test: OTP skipped ONLY for an active trial studio; same verify_and_consent path
declare v_q uuid; v_org uuid; v_file text; v_phone text; v_code text; r bigint; v_out jsonb;
begin
  select q.id, q.org_id, coalesce(q.client ->> 'phone', '') into v_q, v_org, v_file
    from public.quotes q
   where p_token is not null and q.approval_token = p_token
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  if not public._trial_test_mode_ok(v_org) then
    return jsonb_build_object('approved', false, 'error', 'trial_test_unavailable',
      'message', 'Skipping the OTP is only available in an active free-trial studio.');
  end if;
  if public.link_age_expired(public.approval_link_age_until(p_token)) or public._a42_quote_shelved(v_q) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if v_phone is null or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 8 then v_phone := nullif(v_file, ''); end if;
  if v_phone is null or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 8 then
    return jsonb_build_object('approved', false, 'error', 'phone_required',
      'message', 'Enter a mobile number (any test number works in trial test mode).');
  end if;
  v_phone := public._otp_canon_phone(p_token, v_phone);
  -- one-time random code, hashed like request_otp; never returned, never sent
  loop
    r := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    exit when r < 4294000000;
  end loop;
  v_code := lpad((r % 1000000)::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (v_q, v_phone, extensions.crypt(v_code, extensions.gen_salt('bf', 8)), now() + interval '10 minutes');
  v_out := public.verify_and_consent(p_token, v_phone, v_code, true, p_terms_version,
                                     p_consent_text, p_client_name, p_user_agent);
  if coalesce((v_out ->> 'approved')::boolean, false) then
    update public.quote_consents c set verified_via_otp = false
     where c.id = (select c2.id from public.quote_consents c2 where c2.quote_id = v_q
                    order by c2.created_at desc, c2.id desc limit 1)
       and c.verified_via_otp;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), null, 'approval.trial_test_skip', 'quotes', v_q::text,
              jsonb_build_object('trial_test', true, 'otp', 'skipped', 'client_name', p_client_name),
              v_org, now());
    v_out := v_out || jsonb_build_object('trial_test', true);
  end if;
  return v_out;
end $$;
revoke all on function public.trial_test_approve(uuid, text, text, text, text, text) from public;
grant execute on function public.trial_test_approve(uuid, text, text, text, text, text) to anon, authenticated, service_role;
commit;

-- VERIFY 0128 (read-only; expect every ok = true)
select '0128 _trial_test_mode_ok exists' as item, to_regprocedure('public._trial_test_mode_ok(uuid)') is not null as ok
union all select '0128 _trial_test_mode_ok not callable by anon', not has_function_privilege('anon', 'public._trial_test_mode_ok(uuid)', 'execute')
union all select '0128 _trial_test_mode_ok not callable by authenticated', not has_function_privilege('authenticated', 'public._trial_test_mode_ok(uuid)', 'execute')
union all select '0128 trial_test_mode_for_token callable by anon', has_function_privilege('anon', 'public.trial_test_mode_for_token(uuid)', 'execute')
union all select '0128 trial_test_approve callable by anon', has_function_privilege('anon', 'public.trial_test_approve(uuid, text, text, text, text, text)', 'execute')
union all select '0128 trial_test_approve security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')), false)
union all select '0128 trial_test_approve gates on active trial', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) like '%_trial_test_mode_ok(v_org)%', false)
union all select '0128 trial_test_approve reuses verify_and_consent', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) like '%public.verify_and_consent(p_token%', false)
union all select '0128 trial_test_approve sends nothing (no _notify)', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) not like '%_notify(%', false)
union all select '0128 no non-trial studio is in trial test mode', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_test_mode_ok(o.id))
union all select '0128 verify_and_consent unchanged (no trial marker)', coalesce(pg_get_functiondef(to_regprocedure('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)')) not like '%helm-0128%', false);
