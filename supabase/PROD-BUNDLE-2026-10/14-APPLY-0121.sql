-- PROD BUNDLE step 14: APPLY-0121.sql (copied unchanged from supabase/APPLY-0121.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- ============================================================================
-- 0121_dashboard_due_today.sql - CANONICAL forward-only. REQUIRES 0108.
-- In plain words: the dashboard "Today" strip can now also show payment milestones due TODAY
-- (in the studio's time zone), not only overdue ones.
--   * NEW read-only dashboard_due_today(): up to 20 milestones due today on confirmed events that
--     are not waived and not fully paid. Same "paid" rule as dashboard_money (0108): ledger first,
--     milestones marked paid only for very old events with no ledger rows.
--   * Studio members with finance VIEW only; own studio only. No table change, no row touched.
-- Additive + idempotent: safe to run twice.
-- ============================================================================
create or replace function public.dashboard_due_today()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- dashboard-due-today-0121
declare
  v_org uuid := public.current_org_id();
  v_tz text; v_cur text; v_today date; v_out jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('finance', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata'),
         case when upper(coalesce(o.currency, '')) ~ '^[A-Z]{3}$' then upper(o.currency) else 'INR' end
    into v_tz, v_cur from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Kolkata'); v_cur := coalesce(v_cur, 'INR');
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;
  v_today := (now() at time zone v_tz)::date;

  with q as (
    select q.id, q.code, q.title, q.client, q.status,
           case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end as cur
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
  ), led as (
    select p.quote_id, sum(p.amount) filter (where p.status = 'paid') as paid from public.quote_payments p
     where p.org_id = v_org group by p.quote_id
  ), y as (
    select m.id, m.quote_id, m.label, m.due_date, m.amount, m.status as mstatus, q.code, q.title, q.client, q.cur,
           coalesce(led.paid, 0) as qpaid, led.quote_id is not null as has_led,
           coalesce(sum(m.amount) over (partition by m.quote_id order by m.seq, m.due_date nulls last, m.created_at, m.id
                                        rows between unbounded preceding and 1 preceding), 0) as prior_amt
      from public.payment_milestones m
      join q on q.id = m.quote_id
      left join led on led.quote_id = m.quote_id
     where m.org_id = v_org
  ), z as (
    select y.*, case when y.has_led then least(greatest(y.qpaid - y.prior_amt, 0), y.amount)
                     when y.mstatus = 'paid' then y.amount else 0 end as mpaid
      from y
  )
  select coalesce(jsonb_agg(jsonb_build_object('quote_id', s.quote_id, 'milestone_id', s.id, 'code', s.code, 'title', s.title,
           'client', nullif(btrim(coalesce(s.client ->> 'name', '')), ''), 'label', s.label, 'due_date', s.due_date,
           'amount', s.amount, 'paid', s.mpaid, 'balance', s.amount - s.mpaid, 'currency', s.cur) order by s.code), '[]'::jsonb)
    into v_out
    from (select * from z
           where z.due_date = v_today and z.mstatus <> 'waived' and z.mpaid < z.amount
           order by z.code limit 20) s;
  return jsonb_build_object('today', v_today, 'currency', v_cur, 'due_today', v_out);
end $$;

do $$ begin
  execute 'revoke all on function public.dashboard_due_today() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.dashboard_due_today() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.dashboard_due_today() to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.dashboard_due_today() to service_role'; end if;
end $$;

notify pgrst, 'reload schema';

-- VERIFY 0121 (read-only; expect every ok = true)
select '0121 dashboard_due_today exists' as item, to_regprocedure('public.dashboard_due_today()') is not null as ok
union all select '0121 is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.dashboard_due_today()')), false)
union all select '0121 authenticated may run', has_function_privilege('authenticated', 'public.dashboard_due_today()', 'execute')
union all select '0121 anon may NOT run', not has_function_privilege('anon', 'public.dashboard_due_today()', 'execute')
union all select '0121 needs finance view', coalesce(pg_get_functiondef(to_regprocedure('public.dashboard_due_today()')) like '%has_area(''finance'', ''view'')%', false)
union all select '0121 own studio only', coalesce(pg_get_functiondef(to_regprocedure('public.dashboard_due_today()')) like '%m.org_id = v_org%', false);
