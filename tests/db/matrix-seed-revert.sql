-- matrix-seed-revert.sql — 0044 undoes the 0042 matrix seed (owner decision D2: the
-- matrix is the single authority; nobody GAINS access). Simulates 0042's seed INSERT
-- (one shared transaction timestamp T0) on studios A and B that lacked those rows, then
-- re-runs 0044's revert. ONE transaction, rolled back at the end.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ar(n serial, name text, result text); grant all on _ar to anon, authenticated;
grant usage on sequence _ar_n_seq to anon, authenticated;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _ar(name, result) values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- what a signed-in user sees: has_area(quotes, view) + how many quotes of each studio
create or replace function pg_temp.sees(p_email text) returns text language plpgsql as $$
declare h boolean; a int; b int; begin
  perform pg_temp.login(p_email);
  h := public.has_area('quotes', 'view');
  select count(*) filter (where org_id = 'a0000000-0000-4000-8000-000000000001'),
         count(*) filter (where org_id = 'b0000000-0000-4000-8000-000000000001') into a, b from public.quotes;
  perform pg_temp.su();
  return h::text || ' A=' || a || ' B=' || b;
end $$;
grant execute on function pg_temp.sees(text) to anon, authenticated;
create temp table _snap as select * from public.role_access where false;

do $$ declare t0 timestamptz := '2026-10-07 12:00:00+05:30'; t1 timestamptz := '2026-10-07 15:00:00+05:30';
  t2 timestamptz := '2026-10-07 18:00:00+05:30'; n int; s text; seeded int;
  orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
begin perform pg_temp.su();
  truncate public.helm_audit_0044_reverted;
  update public.profiles set role = 'planner' where email in ('a_staff@a.test', 'b_staff@b.test');
  s := pg_temp.sees('a_staff@a.test');
  perform pg_temp.res('MSR-00 baseline: a planner with no matrix row sees no quotes', s = 'false A=0 B=0', s);
  perform pg_temp.res('MSR-01 seeder is retired: re-pasting 0042 adds nothing', public._a42_seed_matrix_defaults() = 0, '');
  -- simulate the original 0042 seed (one INSERT → one timestamp), only where no row existed
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
  select o.id, x.role, x.area, true, true, t0 from public.organizations o
    cross join (values ('planner','settlement'), ('sales','settlement'), ('operations','settlement'),
                       ('planner','closure'), ('sales','closure'), ('operations','closure'),
                       ('planner','quotes'), ('sales','quotes'), ('operations','quotes'), ('manager','finance')) x(role, area)
   where o.id in (orgA, orgB)
     and not exists (select 1 from public.role_access ra where ra.org_id = o.id and ra.role = x.role and ra.area = x.area);
  get diagnostics seeded = row_count;
  s := pg_temp.sees('a_staff@a.test');
  perform pg_temp.res('MSR-02 regression reproduced: after the seed the Org A planner sees Org A quotes', s like 'true A=%' and s not like '%A=0%' and s like '%B=0', s);
  -- an admin later saves the matrix in Org B (planner closure kept on + another area) at t1
  update public.role_access set updated_at = t1 where org_id = orgB and role = 'planner' and area = 'closure';
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values (orgB, 'planner', 'inventory', true, false, t1)
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false, updated_at = t1;
  -- ambiguity guard: a second clean in-pattern cluster → nothing is reverted
  update public.role_access set updated_at = t2 where org_id = orgA and role = 'planner' and area = 'settlement';
  insert into _snap select * from public.role_access;
  n := public._a44_revert_matrix_seed();
  perform pg_temp.res('MSR-03 two candidate seed timestamps → nothing reverted (no guessing)',
    n = 0 and not exists (select 1 from public.helm_audit_0044_reverted)
    and not exists (select * from _snap except select * from public.role_access), n::text);
  update public.role_access set updated_at = t0 where org_id = orgA and role = 'planner' and area = 'settlement';
  truncate _snap; insert into _snap select * from public.role_access;
  n := public._a44_revert_matrix_seed();
  perform pg_temp.res('MSR-04 exactly the seeded rows (minus the 1 an admin re-saved) are reverted',
    seeded >= 10 and n = seeded - 1 and (select count(*) from public.helm_audit_0044_reverted) = n, n::text || ' of ' || seeded);
  s := pg_temp.sees('a_staff@a.test');
  perform pg_temp.res('MSR-05 Org A planner denied again (own studio)', s = 'false A=0 B=0', s);
  s := pg_temp.sees('b_staff@b.test');
  perform pg_temp.res('MSR-06 Org B planner denied again', s = 'false A=0 B=0', s);
  perform pg_temp.res('MSR-07 the admin-edited row (different timestamp) is untouched',
    (select can_view and can_edit and updated_at = t1 from public.role_access where org_id = orgB and role = 'planner' and area = 'closure')
    and (select can_view and updated_at = t1 from public.role_access where org_id = orgB and role = 'planner' and area = 'inventory'), '');
  perform pg_temp.res('MSR-08 pre-existing true rows (fixture sales/quotes + sales/finance) are untouched',
    (select count(*) from public.role_access ra join _snap s on (s.org_id, s.role, s.area) = (ra.org_id, ra.role, ra.area)
      where ra.role = 'sales' and ra.area in ('quotes', 'finance') and ra.can_view and ra.can_edit and ra.updated_at = s.updated_at) = 4, '');
  perform pg_temp.res('MSR-09 only seeded rows changed; nothing was deleted',
    (select count(*) from public.role_access) = (select count(*) from _snap)
    and (select count(*) from (select * from _snap except select * from public.role_access) d) = seeded - 1, '');
  truncate _snap; insert into _snap select * from public.role_access;
  n := public._a44_revert_matrix_seed();
  perform pg_temp.res('MSR-10 re-applying 0044 changes nothing',
    n = 0 and not exists (select * from _snap except select * from public.role_access)
    and (select count(*) from public.helm_audit_0044_reverted) = seeded - 1, n::text);
  s := pg_temp.sees('a_admin@a.test');
  perform pg_temp.res('MSR-11 admin still has full access (own studio only)', s like 'true A=%' and s not like '%A=0%' and s like '%B=0', s);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('MSR-12 the revert log is private (authenticated can''t read it or run the revert)',
    not has_table_privilege('authenticated', 'public.helm_audit_0044_reverted', 'select')
    and not has_function_privilege('authenticated', 'public._a44_revert_matrix_seed()', 'execute'), '');
end $$;

select name, result from _ar order by n;
select case when count(*) filter (where result <> 'PASS') = 0 and count(*) = 13
  then 'MATRIX-SEED-REVERT: ALL PASS (' || count(*) || '/' || count(*) || ')'
  else 'MATRIX-SEED-REVERT: FAILURES ' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) end as summary from _ar;
rollback;
