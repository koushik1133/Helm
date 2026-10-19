-- 0239_business_area_admin_only.sql - CANONICAL forward-only.
-- REQUIRES phase29 / phase57 (role_access + has_area), 0049 (_a49_default_matrix / _a49_seed_clean_matrix,
--          create_studio seeds the clean matrix), 0072 (_valid_role), 0124 (vendor_payables_summary /
--          business_pnl), 0142 (_vb_event_pnl body).
--
-- In plain words (owner, r20: "By default the Business page should be seen only by the admin, not by anyone
-- else. Insights too - admin only. Later studios can adjust it."):
--   1  A NEW access area 'business' ("Business overview (studio money)" in Control Center -> Roles & access).
--      Until now the Business page was opened by every role with "Budget & finance" (planners, managers), because
--      planners need finance for payments / settlement / closure on their events. Those finance rights are NOT
--      changed here - only the Business page moves to its own switch.
--   2  Every EXISTING studio gets one 'business' row per role: admin = view + edit, every other role = off.
--      INSERT ONLY (on conflict do nothing): no existing role_access row is changed or deleted, nobody gains
--      access. A studio can switch it on for a role later in Control Center (admin_set_role_access, unchanged).
--   3  NEW studios get the same rows: _a49_default_matrix() (the clean matrix create_studio seeds, 0049) lists
--      'business' with no role but admin. Its other 297 rows are exactly the 0049 rows - checked before the
--      replace (a database whose defaults drifted stops here, nothing changed).
--   4  The two Business-page-only RPCs now ALSO need has_area('business', 'view'):
--        vendor_payables_summary()   (owed to vendors / overdue / due in 7 days)
--        business_pnl(from, to)      (net profit by month, top events by profit)
--      Their bodies are kept as *__pre0239 (renamed once, the database's own body, same pattern as 0143 / 0159),
--      not callable by the app; the new wrappers check the studio + 'business' and then call them, so the
--      finance check inside stays as it was. Nothing else calls them (only the Business page).
--      NOT gated (shared with the dashboard, which every finance role still needs): dashboard_money /
--      dashboard_money_for / dashboard_due_today, event_pnl (per-event P&L on Settlement / Closure / Budget),
--      record_vendor_payout and every settlement / payment / closure RPC.
--   5  Insights: unchanged. 'insights' has never been in the default matrix (0076 seeded no rows), so it is
--      already admin only by default; the VERIFY rows below prove it.
--   has_area() is unchanged (admin = always true; others read their studio's row; no row = no access).
-- Additive + idempotent (insert only, on conflict do nothing; rename only once; create or replace). Safe to run
-- twice (the 2nd run changes nothing). No table / column / policy changed, no row updated or deleted. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): give finance roles the page back by switching
-- 'business' on for them in Control Center, or restore the bodies:
--   drop function public.vendor_payables_summary(); alter function public.vendor_payables_summary__pre0239()
--   rename to vendor_payables_summary; (same for business_pnl(date, date)); grant execute ... to authenticated;
--   and re-run 0049's _a49_default_matrix(). The 'business' rows can stay (unused).

do $$ begin
  if to_regclass('public.role_access') is null or to_regprocedure('public.has_area(text,text)') is null then
    raise exception 'STOP: phase29 / phase57 (role_access + has_area) is not applied'; end if;
  if not exists (select 1 from pg_index i where i.indrelid = 'public.role_access'::regclass and i.indisunique
                    and (select array_agg(a.attname::text order by a.attname::text) from pg_attribute a
                          where a.attrelid = i.indrelid and a.attnum = any(i.indkey)) = array['area', 'org_id', 'role']) then
    raise exception 'STOP: role_access has no unique key on (org_id, role, area)'; end if;
  if to_regprocedure('public._valid_role(text)') is null then raise exception 'STOP: 0072 (_valid_role) is not applied'; end if;
  if to_regprocedure('public._a49_default_matrix()') is null or to_regprocedure('public._a49_seed_clean_matrix(uuid)') is null then
    raise exception 'STOP: 0049 (clean default matrix) is not applied'; end if;
  if to_regprocedure('public._vb_event_pnl(uuid,uuid)') is null or to_regclass('public.vendor_bills') is null
     or to_regclass('public.vendor_payouts') is null then
    raise exception 'STOP: 0124 (vendor bills) is not applied'; end if;
  if to_regprocedure('public.vendor_payables_summary()') is null and to_regprocedure('public.vendor_payables_summary__pre0239()') is null then
    raise exception 'STOP: vendor_payables_summary() (0124) is missing'; end if;
  if to_regprocedure('public.business_pnl(date,date)') is null and to_regprocedure('public.business_pnl__pre0239(date,date)') is null then
    raise exception 'STOP: business_pnl(date, date) (0124) is missing'; end if;
  -- the default matrix this file replaces must be exactly the 0049 one (297 rows), apart from 'business'
  if (select md5(string_agg(d.role || ':' || d.area || ':' || d.can_view::text || ':' || d.can_edit::text, ','
                            order by d.role collate "C", d.area collate "C"))
        from public._a49_default_matrix() d where d.area <> 'business') <> '498843f8c0669cf38703f30824776d86' then
    raise exception 'STOP: _a49_default_matrix() is not the 0049 body on this database (defaults drifted) - nothing changed'; end if;
end $$;

-- ---- 1+2) existing studios: one 'business' row per role (admin on, others off), insert only ------------------
do $$ declare n int; begin
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select o.id, r.role, 'business', r.role = 'admin', r.role = 'admin', now()
      from public.organizations o
     cross join (values ('admin'), ('manager'), ('planner'), ('sales'), ('coordinator'), ('supervisor'), ('quality'),
                        ('operations'), ('designer'), ('crew'), ('worker'), ('client')) r(role)
     where public._valid_role(r.role)
  on conflict (org_id, role, area) do nothing;
  get diagnostics n = row_count; raise notice '0239: business access rows added: %', n;
end $$;

-- ---- 3) new studios: the clean default matrix (0049 rows unchanged + 'business' for admin only) ----------------
create or replace function public._a49_default_matrix()
returns table(role text, area text, can_view boolean, can_edit boolean)
language sql immutable set search_path = '' as $$
  -- 0049 NV-08 + r20-business-0239 ('business': admin only)
  with areas(area, v, e) as (values
    -- area,       roles that VIEW,                                                                    roles that EDIT
    ('leads',      '{manager,planner,sales,coordinator}'::text[],                                     '{manager,planner,sales}'::text[]),
    ('crm',        '{manager,planner,sales,coordinator}',                                             '{manager,planner,sales}'),
    ('nurture',    '{manager,planner}',                                                               '{manager,planner}'),
    ('discovery',  '{manager,planner}',                                                               '{manager,planner}'),
    ('proposal',   '{manager,planner}',                                                               '{manager,planner}'),
    ('quotes',     '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner}'),
    ('layouts',    '{manager,planner,coordinator,supervisor,operations,quality}',                     '{planner}'),
    ('design',     '{manager,planner}',                                                               '{manager,planner}'),
    ('staff',      '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,operations}'),
    ('inventory',  '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,operations}'),
    ('vendors',    '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,operations}'),
    ('calendar',   '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator}'),
    ('templates',  '{manager,planner,coordinator,operations,quality}',                                '{manager,planner,coordinator}'),
    ('resources',  '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,operations}'),
    ('runsheet',   '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator}'),
    ('plan',       '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator}'),
    ('logistics',  '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator}'),
    ('ready',      '{manager,planner,coordinator,supervisor,quality}',                                '{manager,planner,coordinator}'),
    ('finance',    '{manager,planner}',                                                               '{manager,planner}'),
    ('settlement', '{manager,planner}',                                                               '{manager,planner}'),
    ('closure',    '{manager,planner}',                                                               '{manager,planner}'),
    ('command',    '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,supervisor,quality}'),
    ('issues',     '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,supervisor,operations,quality}'),
    ('media',      '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,supervisor}'),
    ('controls',   '{manager}',                                                                       '{manager}'),
    ('codes',      '{manager,planner}',                                                               '{manager,planner}'),
    ('users',      '{}',                                                                              '{}'),
    ('business',   '{}',                                                                              '{}')),
  roles(role) as (values ('admin'), ('manager'), ('planner'), ('sales'), ('coordinator'), ('supervisor'),
                         ('quality'), ('operations'), ('crew'), ('worker'), ('client'))
  select r.role, a.area,
         r.role = 'admin' or r.role = any(a.v),
         r.role = 'admin' or (r.role = any(a.e) and r.role = any(a.v))      -- edit implies view
    from roles r cross join areas a;
$$;

-- ---- 4) the Business page RPCs also need the 'business' area -------------------------------------------------
do $$ begin
  if to_regprocedure('public.vendor_payables_summary__pre0239()') is null then
    alter function public.vendor_payables_summary() rename to vendor_payables_summary__pre0239;
  end if;
  if to_regprocedure('public.business_pnl__pre0239(date,date)') is null then
    alter function public.business_pnl(date, date) rename to business_pnl__pre0239;
  end if;
end $$;

create or replace function public.vendor_payables_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r20-business-0239: the Business page only - studio + 'business' area, then the 0124 body (finance check kept)
begin
  if auth.uid() is null or public.current_org_id() is null or not public.has_area('business', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.vendor_payables_summary__pre0239();
end $$;

create or replace function public.business_pnl(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r20-business-0239: the Business page only - studio + 'business' area, then the 0124 body (finance check kept)
begin
  if auth.uid() is null or public.current_org_id() is null or not public.has_area('business', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.business_pnl__pre0239(p_from, p_to);
end $$;

-- ---- privileges ---------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  execute 'revoke all on function public._a49_default_matrix() from public';
  foreach f in array array['public.vendor_payables_summary()', 'public.business_pnl(date, date)',
                           'public.vendor_payables_summary__pre0239()', 'public.business_pnl__pre0239(date, date)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._a49_default_matrix() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._a49_default_matrix() from authenticated';
    -- the kept bodies are reached only through the wrappers
    execute 'revoke all on function public.vendor_payables_summary__pre0239() from authenticated';
    execute 'revoke all on function public.business_pnl__pre0239(date, date) from authenticated';
    execute 'grant execute on function public.vendor_payables_summary() to authenticated';
    execute 'grant execute on function public.business_pnl(date, date) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._a49_default_matrix() to service_role';
    execute 'grant execute on function public.vendor_payables_summary() to service_role';
    execute 'grant execute on function public.business_pnl(date, date) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
