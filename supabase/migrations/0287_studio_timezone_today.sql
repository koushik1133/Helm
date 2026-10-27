-- 0287_studio_timezone_today.sql - CANONICAL forward-only.
-- REQUIRES 0045 (studio_subscriptions), 0058/0120 (_trial_refresh), 0124/0239 (vendor_payables_summary__pre0239),
--          0181 (payment_reminder_send_now__pre0181), 0069 (_pkg_lock_reason), 0268 (checkout_availability).
--
-- In plain words (owner, r37: "the studios are in India (UAE planned) but I and some staff work from the US -
-- show and calculate everything in the STUDIO's time zone"):
--   The database clock runs in UTC. For an Indian studio the new day starts at 18:30 UTC, so a plain
--   "current_date" is still YESTERDAY for the first 5.5 hours of every Indian day (4 hours in Dubai).
--   1  NEW public.studio_timezone(org): the studio's own zone (organizations.timezone). A blank or unknown zone
--      falls back to the studio's country (IN -> Asia/Kolkata, AE -> Asia/Dubai), then Asia/Kolkata.
--   2  NEW public.studio_today(org [, at]): the calendar day in that zone ((now() at time zone <zone>)::date).
--      Both are internal (no API grant).
--   3  The server checks where "today" is visible to people now use the studio's day instead of UTC:
--        - payment reminder sent from the event ("overdue" / "due today" / "due soon" in the message);
--        - vendor payables card on the Business page (overdue / due in 7 days);
--        - the client's package choice lock ("too close to the event" N days before the event);
--        - inventory "overdue" (not back the day after the event) on the check-out screen;
--        - paid-plan trials: the trial ends, and the 7 / 3 / 1 day and "trial ended" reminders, on the studio's day.
--      Each function keeps its name, arguments, answers and grants; only "current_date" is replaced.
--   No table, column, row or policy is changed; nothing deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): re-run the previous bodies (0181, 0239, 0069, 0268, 0120); the two new
--   helpers can stay (nothing else depends on them).

-- ---- 1) the studio's zone + day --------------------------------------------------------------------------------------
create or replace function public.studio_timezone(p_org uuid)
returns text language plpgsql stable security definer set search_path to '' as $$
-- helm-0287-studio-tz
declare v_tz text; v_cc text;
begin
  select nullif(btrim(o.timezone), ''), upper(nullif(btrim(coalesce(o.country, o.brand #>> '{billing,country}', '')), ''))
    into v_tz, v_cc from public.organizations o where o.id = p_org;
  if v_tz is not null then
    begin
      perform now() at time zone v_tz;   -- an unknown zone name raises here
      return v_tz;
    exception when others then null;
    end;
  end if;
  return case v_cc when 'AE' then 'Asia/Dubai' else 'Asia/Kolkata' end;
end $$;

create or replace function public.studio_today(p_org uuid, p_at timestamptz default now())
returns date language sql stable security definer set search_path to '' as $$
  -- helm-0287-studio-tz
  select (coalesce(p_at, now()) at time zone public.studio_timezone(p_org))::date
$$;

do $$ declare f text; begin
  foreach f in array array['public.studio_timezone(uuid)', 'public.studio_today(uuid, timestamptz)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- 2) the server checks that showed / used "today": same bodies, the studio's day instead of UTC ---------------------
CREATE OR REPLACE FUNCTION public.payment_reminder_send_now__pre0181(p_milestone uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); m public.payment_milestones; q public.quotes; v_n integer;
  v_cfg jsonb; v_due text; v_today date := public.studio_today(public.current_org_id());   -- r37: the studio's day
begin
  if v_me is null or v_org is null or not (public.has_area('finance', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into m from public.payment_milestones x where x.id = p_milestone and x.org_id = v_org;
  if m.id is null then raise exception 'milestone not found' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = m.quote_id and x.org_id = v_org;
  if q.id is null then raise exception 'milestone not found' using errcode = '42501'; end if;
  if m.status not in ('due', 'invoiced') then raise exception 'this milestone is already settled' using errcode = '22023'; end if;
  if coalesce(m.amount, 0) <= 0 then raise exception 'this milestone has no amount' using errcode = '22023'; end if;
  v_cfg := public._comms_cfg(v_org);
  if cardinality(public._comms_channels(v_cfg, 'pay_channels')) = 0 then
    raise exception 'choose a reminder channel in Control Center first' using errcode = '22023'; end if;
  if not exists (select 1 from unnest(public._comms_channels(v_cfg, 'pay_channels')) c where public._comms_client_to(q.client, c, v_org) is not null) then
    raise exception 'add the client''s e-mail or WhatsApp number to the event first' using errcode = '22023'; end if;
  v_due := case when m.due_date is null then 'due' when m.due_date < v_today then 'overdue' when m.due_date = v_today then 'due today' else 'due soon' end;
  v_n := public._comms_queue_pay(m.id, 'manual', v_due, true, v_me);
  if v_n > 0 then
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, 'payment_reminder.queued', 'payment_milestones', m.id::text, q.id, jsonb_build_object('rows', v_n), v_org);
  end if;
  return jsonb_build_object('queued', v_n, 'already_queued', v_n = 0);
end $function$;

CREATE OR REPLACE FUNCTION public.vendor_payables_summary__pre0239()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- vendor-bills-0124: read-only
declare v_org uuid := public.current_org_id(); r jsonb; v_today date := public.studio_today(public.current_org_id());   -- r37: the studio's day
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  with b as (
    select vb.id, vb.amount, vb.due_date, vb.currency,
           coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = vb.id), 0) as paid
      from public.vendor_bills vb where vb.org_id = v_org and vb.status <> 'void')
  select jsonb_build_object(
    'billed', coalesce(sum(amount), 0), 'paid', coalesce(sum(paid), 0),
    'outstanding', coalesce(sum(amount - paid), 0),
    'overdue', coalesce(sum(amount - paid) filter (where due_date < v_today and amount > paid), 0),
    'due_7d', coalesce(sum(amount - paid) filter (where due_date between v_today and v_today + 7 and amount > paid), 0),
    'open_bills', count(*) filter (where amount > paid),
    'overdue_bills', count(*) filter (where due_date < v_today and amount > paid),
    'currencies', coalesce(jsonb_agg(distinct currency), '[]'::jsonb))
    into r from b;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public._pkg_lock_reason(p_quote uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare q public.quotes; v_days int; v_closed boolean := false; v_menu boolean := false;
begin
  select * into q from public.quotes x where x.id = p_quote;
  if q.id is null or q.deleted_at is not null or q.archived_at is not null then return 'unavailable'; end if;
  if not public._studio_writable(q.org_id) then return 'suspended'; end if;
  if to_regclass('public.event_closure') is not null then
    select exists (select 1 from public.event_closure c where c.quote_id = q.id and c.closed_at is not null) into v_closed;
  end if;
  if v_closed or q.lifecycle_stage in ('settlement', 'closed') then return 'frozen'; end if;   -- D6: closed event money is frozen
  if q.confirmed_at is not null or q.status = 'confirmed'
     or q.lifecycle_stage in ('planning', 'resources', 'ready', 'event_day') then return 'confirmed'; end if;
  select coalesce(ep.menu_locked, false) into v_menu from public.event_plan ep where ep.quote_id = q.id;
  if coalesce(v_menu, false) then return 'menu_locked'; end if;
  v_days := coalesce((public._pkg_settings(q.org_id) ->> 'pkg_lock_days')::int, 0);
  if q.event_date is not null and public.studio_today(q.org_id) > q.event_date - v_days then return 'too_close'; end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.checkout_availability(p_item uuid, p_quote uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id(); v_it record; v_date date; v_out numeric; v_free numeric;
  v_blocking jsonb; v_overdue jsonb; v_subs jsonb; v_resother jsonb;
begin
  if not (public.has_area('inventory', 'view') or public.has_area('inventory', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select id, name, category, unit, coalesce(total_qty, 0) as total into v_it
    from public.inventory_items where id = p_item and org_id = v_org;
  if not found then raise exception 'item not found' using errcode = '42501'; end if;
  if p_quote is not null then
    perform public.assert_quote_org(p_quote);
    select event_date into v_date from public.quotes where id = p_quote;
  end if;

  select coalesce(sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)), 0) into v_out
    from public.inventory_checkouts c where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial');
  v_free := public._checkout_free(p_item, v_date, p_quote);

  -- open check-outs holding this item: which event, how many, when due back (day after the event)
  select coalesce(jsonb_agg(x order by x->>'due_back' nulls last), '[]'::jsonb) into v_blocking from (
    select jsonb_build_object('checkout_id', c.id, 'quote_id', c.quote_id,
             'event', coalesce(q.title, 'No event'), 'event_date', q.event_date,
             'due_back', case when q.event_date is not null then q.event_date + 1 end,
             'qty', public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged), 'issued_to', c.issued_to,
             'overdue', (q.event_date is not null and q.event_date + 1 < public.studio_today(v_org))) as x
      from public.inventory_checkouts c left join public.quotes q on q.id = c.quote_id
     where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial')
       and public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged) > 0) s;
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_overdue
    from jsonb_array_elements(v_blocking) e where (e->>'overdue')::boolean;

  -- other events on the same date holding a reservation
  select coalesce(jsonb_agg(jsonb_build_object('quote_id', q.id, 'event', q.title, 'event_date', q.event_date, 'qty', r.qty)), '[]'::jsonb)
    into v_resother
    from (select quote_id, sum(qty) as qty from public.inventory_reservations
           where item_id = p_item and status in ('reserved', 'allocated') group by quote_id) r
    join public.quotes q on q.id = r.quote_id
   where v_date is not null and q.org_id = v_org and q.event_date = v_date and q.id is distinct from p_quote
     and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled';

  -- substitutes: same category, active, something free on that date
  select coalesce(jsonb_agg(s order by (s->>'available')::numeric desc), '[]'::jsonb) into v_subs from (
    select jsonb_build_object('item_id', i.id, 'name', i.name, 'unit', i.unit,
             'available', public._checkout_free(i.id, v_date, p_quote)) as s
      from public.inventory_items i
     where i.org_id = v_org and i.id <> p_item and coalesce(i.active, true)
       and v_it.category is not null and i.category = v_it.category
     limit 20) t
   where (s->>'available')::numeric > 0;

  return jsonb_build_object('item_id', v_it.id, 'item', v_it.name, 'category', v_it.category, 'unit', v_it.unit,
    'total', v_it.total, 'out_now', v_out, 'reserved_other', greatest(v_it.total - v_out - v_free, 0),
    'in_repair', 0, 'available', v_free, 'event_date', v_date,
    'blocking', v_blocking, 'overdue', v_overdue, 'reserved_by', v_resother,
    'substitutes', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_subs) e limit 5) z));
end $function$;

CREATE OR REPLACE FUNCTION public._trial_refresh()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- trial-reminders-0058 trial-reminders-0120
declare n_pd int := 0; n_rem int := 0; rec record; v_kind text; v_id uuid;
begin
  for rec in
    select s.org_id, s.trial_ends_at from public.studio_subscriptions s
     where s.status = 'trial' and s.trial_ends_at is not null and s.trial_ends_at < public.studio_today(s.org_id)
       and not public._trial_paid(s.org_id)
     for update of s
  loop
    update public.studio_subscriptions set status = 'past_due', updated_at = now()
     where org_id = rec.org_id and status = 'trial';
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'billing.trial_ended_past_due', 'studio_subscriptions', rec.org_id::text,
              jsonb_build_object('trial_ends_at', rec.trial_ends_at), rec.org_id, now());
    n_pd := n_pd + 1;
  end loop;

  for rec in
    select s.org_id, s.status, s.trial_ends_at, (s.trial_ends_at - public.studio_today(s.org_id)) as d
      from public.studio_subscriptions s
     where s.trial_ends_at is not null and not public._trial_paid(s.org_id)
       and not exists (select 1 from public.organizations o where o.id = s.org_id and o.trial_ends_at is not null)
       and ((s.status = 'trial' and s.trial_ends_at between public.studio_today(s.org_id) and public.studio_today(s.org_id) + 7)
         or (s.status = 'past_due' and s.current_period_end is null
             and s.trial_ends_at < public.studio_today(s.org_id) and s.trial_ends_at >= public.studio_today(s.org_id) - 14))
  loop
    v_kind := case when rec.status = 'past_due' then 'trial_ended'
                   when rec.d <= 1 then 'trial_1d' when rec.d <= 3 then 'trial_3d' else 'trial_7d' end;
    v_id := null;
    insert into public.billing_reminders(org_id, kind, period_end) values (rec.org_id, v_kind, rec.trial_ends_at)
      on conflict (org_id, kind, period_end) do nothing
      returning id into v_id;
    if v_id is not null then
      n_rem := n_rem + 1;
      begin
        insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
          values (null, 'in_app', 'trial_reminder', 'simulated',
                  jsonb_build_object('trial', v_kind, 'label', public._trial_label(v_kind),
                                     'days_left', greatest(rec.d, 0), 'ends_at', rec.trial_ends_at),
                  rec.org_id);
      exception when others then null;
      end;
    end if;
  end loop;
  return jsonb_build_object('trial_past_due_set', n_pd, 'trial_reminders_queued', n_rem);
end $function$;
