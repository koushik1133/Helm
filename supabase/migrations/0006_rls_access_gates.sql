-- ============================================================================
-- 0006_rls_access_gates.sql — CANONICAL forward-only (SEC-02 + SEC-03 + SEC-04).
-- Logic re-authored (not copied) from the SEC files, wired into the canonical path.
--   SEC-02 layouts: add the has_area('quotes') gate (base was org-only → any in-org
--                   role could read/write layouts).
--   SEC-03 profiles: a member could read EVERY colleague's email+role (org-only OR).
--                   Now: self OR (org AND has_area('users','view')).
--   SEC-04 coupons/codes: writes require has_area('codes'|'controls','edit').
-- Idempotent (drop-all-then-create per table). Forward-only.
-- ============================================================================

-- ---- SEC-02 layouts --------------------------------------------------------
alter table public.layouts enable row level security;
do $$ declare p text; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='layouts'
  loop execute format('drop policy if exists %I on public.layouts', p); end loop;
end $$;
create policy layouts_select on public.layouts for select
  using (org_id = public.current_org_id() and public.has_area('quotes','view'));
create policy layouts_ins on public.layouts for insert
  with check (org_id = public.current_org_id() and public.has_area('quotes','edit'));
create policy layouts_upd on public.layouts for update
  using (org_id = public.current_org_id() and public.has_area('quotes','edit'))
  with check (org_id = public.current_org_id() and public.has_area('quotes','edit'));
create policy layouts_del on public.layouts for delete
  using (org_id = public.current_org_id() and public.has_area('quotes','edit'));

-- ---- SEC-03 profiles -------------------------------------------------------
alter table public.profiles enable row level security;
do $$ declare p text; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='profiles'
  loop execute format('drop policy if exists %I on public.profiles', p); end loop;
end $$;
-- read: always your own row; colleagues only with the users-view capability
create policy profiles_select on public.profiles for select
  using ( id = auth.uid()
          or (org_id = public.current_org_id() and public.has_area('users','view')) );
-- write stays admin-only (user management RPCs are DEFINER + is_admin gated)
create policy profiles_self_update on public.profiles for update
  using ( id = auth.uid() ) with check ( id = auth.uid() );

-- ---- SEC-04 coupons (+ codes if present) -----------------------------------
alter table public.coupons enable row level security;
do $$ declare p text; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='coupons'
  loop execute format('drop policy if exists %I on public.coupons', p); end loop;
end $$;
create policy coupons_select on public.coupons for select using (org_id = public.current_org_id());
create policy coupons_ins on public.coupons for insert
  with check (org_id = public.current_org_id() and (public.has_area('codes','edit') or public.has_area('controls','edit')));
create policy coupons_upd on public.coupons for update
  using (org_id = public.current_org_id() and (public.has_area('codes','edit') or public.has_area('controls','edit')))
  with check (org_id = public.current_org_id() and (public.has_area('codes','edit') or public.has_area('controls','edit')));
create policy coupons_del on public.coupons for delete
  using (org_id = public.current_org_id() and (public.has_area('codes','edit') or public.has_area('controls','edit')));

do $$ begin
  if to_regclass('public.codes') is not null then
    execute 'alter table public.codes enable row level security';
    execute $f$ do $i$ declare p text; begin
      for p in select policyname from pg_policies where schemaname='public' and tablename='codes'
      loop execute format('drop policy if exists %I on public.codes', p); end loop; end $i$ $f$;
    execute $p$create policy codes_select on public.codes for select using (org_id = public.current_org_id())$p$;
    execute $p$create policy codes_write on public.codes for all
      using (org_id = public.current_org_id() and (public.has_area('codes','edit') or public.has_area('controls','edit')))
      with check (org_id = public.current_org_id() and (public.has_area('codes','edit') or public.has_area('controls','edit')))$p$;
  end if;
end $$;

-- ---- VERIFY: all layouts/profiles/coupons write policies reference has_area --
-- select tablename, bool_and(coalesce(qual,'')||coalesce(with_check,'') like '%has_area%')
--   from pg_policies where schemaname='public' and tablename in ('layouts','coupons') and cmd<>'SELECT' group by 1;
