-- PROD BUNDLE step 16: APPLY-0123.sql (copied unchanged from supabase/APPLY-0123.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- ============================================================================
-- 0123_trial_start_fresh.sql - CANONICAL forward-only. REQUIRES 0097.
-- In plain words: "Start my own studio" shows the trial admin exactly what will be removed
-- (how many sample events, leads, staff ... marked "Demo") before they confirm. This only
-- ADDS a "counts" breakdown to my_demo_status() - it reads, it never changes or deletes
-- anything. Removing the samples still goes through the existing clear_demo_data(), which
-- touches ONLY this studio's rows flagged is_demo.
-- Additive + idempotent: same signature, same keys as before plus "counts". Safe to run twice.
-- ============================================================================
create or replace function public.my_demo_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-start-fresh-0123: 0097 body + per-type counts (read-only)
declare v_org uuid := public.current_org_id(); v_mode text; v_rows int; v_counts jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select o.trial_mode into v_mode from public.organizations o where o.id = v_org;
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
    'is_admin', coalesce(public.is_admin(), false), 'counts', v_counts);
end $$;

revoke all on function public.my_demo_status() from public, anon;
grant execute on function public.my_demo_status() to authenticated, service_role;
