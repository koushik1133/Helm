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
