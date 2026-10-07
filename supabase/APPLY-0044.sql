-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0044 undo the 0042 matrix seed (one paste)                         (2026-10-07)
--   0042 added "view + edit" Control Center matrix rows for planner / sales / operations
--   (Settlement, Closure, Quotes) and manager (Finance) in studios that had no row. A
--   missing row used to mean "no access", so those roles GAINED access. This paste sets
--   exactly those added rows back to "no access" and stops the seed from ever running
--   again. Rows an admin changed afterwards, and every other row, are left alone.
-- REQUIRES 0042 on this database — the preflight stops if not. STAGING first, then PROD.
-- WHAT IT TOUCHES: role_access (UPDATE only, the seeded rows), a new private log table
--   helm_audit_0044_reverted listing each row it changed. Nothing is deleted.
--   If the seeded rows can't be identified with certainty, NOTHING changes and a NOTICE
--   says why. SAFE TO RE-RUN. If anything fails, the whole paste rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regprocedure('public._a42_seed_matrix_defaults()') is null then
    raise exception 'STOP: 0042 not installed — paste APPLY-0042.sql first'; end if;
  if to_regclass('public.role_access') is null then raise exception 'STOP: public.role_access is missing'; end if;
  raise notice 'Preflight OK — applying 0044…';
end $$;

-- ============================================================================
-- 0044_revert_matrix_seed.sql — CANONICAL forward-only. REQUIRES 0042.
-- Owner decision D2: the role_access matrix is the SINGLE authority and nobody GAINS
-- access. 0042's _a42_seed_matrix_defaults() inserted can_view = can_edit = true rows for
-- (planner|sales|operations × settlement|closure|quotes) + (manager, finance) wherever a
-- studio had no row — before 0042 a missing row meant no access, so that widened RLS.
-- This migration:
--   1. turns the seeder into a no-op (re-pasting 0042 never seeds again);
--   2. sets ONLY the rows that one INSERT created back to can_view = can_edit = false
--      (= the pre-0042 effective access). They share one transaction timestamp T0.
--      T0 must be the single updated_at value (>= 2026-10-07 00:00 Asia/Kolkata) whose
--      rows are ALL in the 10 seeded (role, area) pairs with view+edit true, and that no
--      other role_access row shares. Zero or several candidates → nothing changes and a
--      NOTICE explains why. Rows an admin saved later (other updated_at) are untouched.
--   3. records each reverted row in public.helm_audit_0044_reverted; once that table has
--      rows the revert is a no-op (safe to re-run). UPDATE only — nothing is deleted.
-- ============================================================================
create or replace function public._a42_seed_matrix_defaults()
returns integer language plpgsql volatile security definer set search_path = '' as $$
begin
  return 0;  -- a44-noop
end $$;
revoke all on function public._a42_seed_matrix_defaults() from public, anon, authenticated;
grant execute on function public._a42_seed_matrix_defaults() to service_role;

create table if not exists public.helm_audit_0044_reverted (
  org_id uuid not null,
  role text not null,
  area text not null,
  old_updated_at timestamptz not null,
  reverted_at timestamptz not null default now(),
  primary key (org_id, role, area)
);
alter table public.helm_audit_0044_reverted enable row level security;
revoke all on table public.helm_audit_0044_reverted from public, anon, authenticated;

create or replace function public._a44_revert_matrix_seed()
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_cands timestamptz[]; v_t0 timestamptz; n int;
begin
  if exists (select 1 from public.helm_audit_0044_reverted) then
    raise notice '0044: revert already recorded — nothing to do'; return 0; end if;
  with pairs(role, area) as (values ('planner','settlement'), ('sales','settlement'), ('operations','settlement'),
                                    ('planner','closure'),    ('sales','closure'),    ('operations','closure'),
                                    ('planner','quotes'),     ('sales','quotes'),     ('operations','quotes'),
                                    ('manager','finance'))
  select coalesce(array_agg(t order by t), '{}') into v_cands from (
    select ra.updated_at t from public.role_access ra
     where ra.updated_at >= timestamptz '2026-10-07 00:00:00+05:30'
     group by ra.updated_at
    having bool_and((ra.role, ra.area) in (select p.role, p.area from pairs p) and ra.can_view and ra.can_edit)) c;
  if cardinality(v_cands) <> 1 then
    raise notice '0044: % candidate seed timestamp(s) % — expected exactly 1; nothing reverted',
      cardinality(v_cands), v_cands;
    return 0; end if;
  v_t0 := v_cands[1];
  with pairs(role, area) as (values ('planner','settlement'), ('sales','settlement'), ('operations','settlement'),
                                    ('planner','closure'),    ('sales','closure'),    ('operations','closure'),
                                    ('planner','quotes'),     ('sales','quotes'),     ('operations','quotes'),
                                    ('manager','finance')),
  rec as (insert into public.helm_audit_0044_reverted(org_id, role, area, old_updated_at)
          select ra.org_id, ra.role, ra.area, ra.updated_at from public.role_access ra
           where ra.updated_at = v_t0 and ra.can_view and ra.can_edit
             and (ra.role, ra.area) in (select p.role, p.area from pairs p)
          returning org_id, role, area)
  update public.role_access ra set can_view = false, can_edit = false
    from rec where ra.org_id = rec.org_id and ra.role = rec.role and ra.area = rec.area
      and ra.updated_at = v_t0;
  get diagnostics n = row_count;
  raise notice '0044: reverted % seeded matrix row(s) from %', n, v_t0;
  return n;
end $$;
revoke all on function public._a44_revert_matrix_seed() from public, anon, authenticated;
grant execute on function public._a44_revert_matrix_seed() to service_role;
select public._a44_revert_matrix_seed();

-- VERIFY — every row must say ok = true
select item, ok from (values
  ('the 0042 matrix seed is a no-op (adds nothing on re-paste)',
     pg_get_functiondef('public._a42_seed_matrix_defaults()'::regprocedure) like '%a44-noop%'
     and not has_function_privilege('authenticated', 'public._a42_seed_matrix_defaults()', 'execute')),
  ('revert log table is private (RLS on, no anon / authenticated access)',
     (select relrowsecurity from pg_class where oid = 'public.helm_audit_0044_reverted'::regclass)
     and not has_table_privilege('anon', 'public.helm_audit_0044_reverted', 'select')
     and not has_table_privilege('authenticated', 'public.helm_audit_0044_reverted', 'select')
     and not has_function_privilege('authenticated', 'public._a44_revert_matrix_seed()', 'execute')),
  ('every logged seeded row now has no access',
     not exists (select 1 from public.helm_audit_0044_reverted l join public.role_access ra
                   on ra.org_id = l.org_id and ra.role = l.role and ra.area = l.area
                  where ra.updated_at = l.old_updated_at and (ra.can_view or ra.can_edit)))
) v(item, ok);
-- informational: how many seeded rows were set back to "no access"
select count(*) as reverted_rows from public.helm_audit_0044_reverted;
