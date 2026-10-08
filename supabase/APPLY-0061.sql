-- ============================================================================
-- HELM - 0061 universal studio search (one paste) (2026-10-08)
--   * studio_search(p_q, p_limit): signed-in studio member - search the caller's
--     OWN studio for leads, events, staff, team, vendors, stock items and payment
--     receipts. Only the kinds the caller's role may VIEW in the access matrix.
--   * Clients, signed-out callers and members with two-step sign-in pending are
--     refused. No phone numbers or e-mail addresses are searched or returned.
-- REQUIRES the base schema (has_area, current_org_id) - the preflight stops if not.
-- Order note: 0060 (profile menu) is separate; apply 0060, then 0061.
-- WHAT IT TOUCHES: 1 new read-only RPC. NO table or row is created, deleted or changed.
-- SAFE TO RE-RUN. Plain ASCII on purpose (the SQL editor mangles fancy characters).
-- ============================================================================
-- ============================================================================
-- 0061_studio_search.sql - CANONICAL forward-only. Universal studio search
-- (top-bar search + Cmd/Ctrl+K palette in public/studio-search.js).
-- Independent of 0060 (profile menu); 0060 lands above it in the MANIFEST.
--
-- In plain words:
--   * studio_search(p_q, p_limit) - signed-in studio member only. Looks up the
--     search words in the caller's OWN studio and returns, per kind of record, a
--     short list of matches: id, title, subtitle and the page to open.
--       leads      leads area      lead name / event type        -> Leads page
--       events     quotes area     event code / title / client   -> Event hub
--       staff      staff area      crew name / role / department -> Staff page
--       team       users area      team member name              -> Control Center
--       vendors    vendors area    partner name / category       -> Vendors page
--       inventory  inventory area  item name / category          -> Inventory page
--       payments   finance area    receipt number                -> Settlement
--     A kind only appears when the caller's role may VIEW that area in the studio's
--     access matrix (has_area; admins see every kind). No phone numbers or e-mail
--     addresses are searched or returned.
--   * Refused (42501): signed-out callers, clients, people with no studio, and
--     members whose two-step sign-in is still pending (current_org_id() is empty
--     for them since 0043).
--   * Fewer than 2 characters -> empty answer. Longer than 80 -> cut to 80.
--     % and _ are matched literally. p_limit is clamped to 1..10 per kind.
--
-- Additive + idempotent: 1 new read-only function. NO table, NO row is changed.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0061: has_area() is not installed'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception '0061: current_org_id() is not installed'; end if;
end $$;

create or replace function public.studio_search(p_q text, p_limit integer default 5)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_role text; v_q text; v_like text; v_pre text; v_lim int; v_out jsonb := '{}'::jsonb; v_rows jsonb;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = v_me and p.org_id = v_org;
  if not found or v_role is null or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;

  v_q := left(btrim(regexp_replace(coalesce(p_q, ''), '\s+', ' ', 'g')), 80);
  if char_length(v_q) < 2 then return v_out; end if;
  v_lim := greatest(1, least(10, coalesce(p_limit, 5)));
  -- literal match: escape the escape char first, then the two wildcards
  v_pre := replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_');
  v_like := '%' || v_pre || '%';
  v_pre := v_pre || '%';

  if public.has_area('leads', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', l.id, 'title', l.name,
               'subtitle', concat_ws(' / ', nullif(l.status, ''), nullif(l.event_type, ''), to_char(l.event_date, 'YYYY-MM-DD')),
               'link', 'leads.html?hs=') as j,
             case when lower(l.name) like v_pre escape '\' then 0 else 1 end as rk, lower(l.name) as t
        from public.leads l
       where l.org_id = v_org
         and (lower(l.name) like v_like escape '\' or lower(coalesce(l.event_type, '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('leads', v_rows);
  end if;

  if public.has_area('quotes', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', q.id, 'title', q.title,
               'subtitle', concat_ws(' / ', q.code, nullif(q.client ->> 'name', ''), nullif(coalesce(q.lifecycle_stage, q.status), ''), to_char(q.event_date, 'YYYY-MM-DD')),
               'link', 'event.html?id=' || q.id::text) as j,
             case when lower(q.code) like v_pre escape '\' or lower(q.title) like v_pre escape '\' then 0 else 1 end as rk,
             lower(q.title) as t
        from public.quotes q
       where q.org_id = v_org
         and (lower(q.title) like v_like escape '\' or lower(q.code) like v_like escape '\'
              or lower(coalesce(q.client ->> 'name', '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('events', v_rows);
  end if;

  if public.has_area('staff', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', c.id, 'title', c.name,
               'subtitle', concat_ws(' / ', nullif(c.role, ''), nullif(c.department, '')),
               'link', 'staff.html?hs=') as j,
             case when lower(c.name) like v_pre escape '\' then 0 else 1 end as rk, lower(c.name) as t
        from public.crew_members c
       where c.org_id = v_org and c.active
         and (lower(c.name) like v_like escape '\' or lower(coalesce(c.role, '')) like v_like escape '\'
              or lower(coalesce(c.department, '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('staff', v_rows);
  end if;

  if public.has_area('users', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', p.id, 'title', p.full_name, 'subtitle', p.role, 'link', 'control.html#users') as j,
             case when lower(p.full_name) like v_pre escape '\' then 0 else 1 end as rk, lower(p.full_name) as t
        from public.profiles p
       where p.org_id = v_org and p.role is distinct from 'client'
         and nullif(btrim(coalesce(p.full_name, '')), '') is not null
         and lower(p.full_name) like v_like escape '\'
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('team', v_rows);
  end if;

  if public.has_area('vendors', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', v.id, 'title', v.name,
               'subtitle', concat_ws(' / ', nullif(v.category, ''), nullif(v.kind, '')),
               'link', 'vendors.html?hs=') as j,
             case when lower(v.name) like v_pre escape '\' then 0 else 1 end as rk, lower(v.name) as t
        from public.vendors v
       where v.org_id = v_org and v.active
         and (lower(v.name) like v_like escape '\' or lower(coalesce(v.category, '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('vendors', v_rows);
  end if;

  if public.has_area('inventory', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', i.id, 'title', i.name,
               'subtitle', concat_ws(' / ', nullif(i.category, ''), trim(to_char(i.total_qty, 'FM999999990.##') || ' ' || coalesce(i.unit, ''))),
               'link', 'inventory.html?hs=') as j,
             case when lower(i.name) like v_pre escape '\' then 0 else 1 end as rk, lower(i.name) as t
        from public.inventory_items i
       where i.org_id = v_org and i.active
         and (lower(i.name) like v_like escape '\' or lower(coalesce(i.category, '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('inventory', v_rows);
  end if;

  if public.has_area('finance', 'view') then
    select coalesce(jsonb_agg(x.j order by x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', pm.id, 'title', pm.receipt_no,
               'subtitle', concat_ws(' / ', q.code, pm.currency || ' ' || to_char(pm.amount, 'FM999999999990.00'), pm.status),
               'link', 'settlement.html?quote=' || pm.quote_id::text) as j,
             lower(pm.receipt_no) as t
        from public.quote_payments pm
        join public.quotes q on q.id = pm.quote_id and q.org_id = v_org
       where pm.org_id = v_org and pm.receipt_no is not null
         and lower(pm.receipt_no) like v_like escape '\'
       order by 2 limit v_lim) x;
    v_out := v_out || jsonb_build_object('payments', v_rows);
  end if;

  return v_out;
end $$;
revoke all on function public.studio_search(text, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.studio_search(text, integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.studio_search(text, integer) to authenticated'; end if;
end $$;

-- ---- verify (every row should say ok = true) -----------------------------------------------
select item, ok from (values
  ('search RPC exists', to_regprocedure('public.studio_search(text,integer)') is not null),
  ('search RPC for members', has_function_privilege('authenticated', 'public.studio_search(text,integer)', 'execute')),
  ('search RPC not for anon', not has_function_privilege('anon', 'public.studio_search(text,integer)', 'execute')),
  ('search RPC is security definer', (select prosecdef from pg_proc where oid = 'public.studio_search(text,integer)'::regprocedure)),
  ('search RPC has empty search_path', (select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.studio_search(text,integer)'::regprocedure)),
  ('search RPC is read-only (stable)', (select provolatile = 's' from pg_proc where oid = 'public.studio_search(text,integer)'::regprocedure))
) v(item, ok);
