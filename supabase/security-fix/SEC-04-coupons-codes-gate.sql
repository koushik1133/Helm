-- =====================================================================
-- SEC-04 (LOW, own-org only) — gate coupon writes on the 'codes' area
-- =====================================================================
-- FINDING: coupons is treated as a generic config table — write is gated on
-- has_area('controls','edit') rather than a real 'codes' right, so the 'codes'
-- matrix toggle has no server effect. Own-org only; low severity.
--
-- FIX: gate coupon writes on has_area('codes','edit') OR has_area('controls','edit')
-- (keep controls for backward-compat so existing admins are unaffected); reads stay
-- org-scoped. Idempotent + reversible. Safe to apply after staging smoke.
-- =====================================================================

-- ---- PRECHECK ----
select policyname, cmd, qual, with_check from pg_policies
where schemaname='public' and tablename='coupons' order by cmd, policyname;

-- ---- APPLY (idempotent) ----
alter table public.coupons enable row level security;

drop policy if exists coupons_select on public.coupons;
drop policy if exists coupons_write  on public.coupons;
drop policy if exists coupons_ins on public.coupons;
drop policy if exists coupons_upd on public.coupons;
drop policy if exists coupons_del on public.coupons;

create policy coupons_select on public.coupons for select
  using (org_id = public.current_org_id());
create policy coupons_ins on public.coupons for insert
  with check (org_id = public.current_org_id()
              and (public.has_area('codes','edit') or public.has_area('controls','edit')));
create policy coupons_upd on public.coupons for update
  using (org_id = public.current_org_id()
         and (public.has_area('codes','edit') or public.has_area('controls','edit')))
  with check (org_id = public.current_org_id()
              and (public.has_area('codes','edit') or public.has_area('controls','edit')));
create policy coupons_del on public.coupons for delete
  using (org_id = public.current_org_id()
         and (public.has_area('codes','edit') or public.has_area('controls','edit')));

-- ---- VERIFY ----
select 'coupons writes gated on codes/controls' as check,
       bool_and(with_check like '%has_area%') as writes_gated
from pg_policies where schemaname='public' and tablename='coupons' and cmd in ('INSERT','UPDATE','DELETE');

-- ---- ROLLBACK ----
-- restore prior controls-only gate (see phase57/phase75 for the original definition).
