-- APPLY-0105.sql - paste into the Supabase SQL editor (prod or staging). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains 0105_checkout_shortage_nurture.sql:
--   * Equipment check-out: when there is not enough stock the app now gets a structured answer
--     (who has it, due back when, substitutes) instead of an error, can check out only what is
--     available, and stock can never go negative (server-enforced, item row locked).
--   * Leads: optional birthday / anniversary dates (new nullable columns, nothing else changes).
--   * Nurture: 12 new greeting occasions per studio (birthday / anniversary only if missing), FILL-ONLY - templates a studio already has
--     (including edited ones) are never touched.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

do $$ begin
  if to_regprocedure('public.checkout_equipment(uuid,uuid,numeric,text,uuid,text)') is null
     or to_regprocedure('public.cancel_checkout(uuid,text)') is null then
    raise exception 'APPLY-0105 needs 0073 (checkout_equipment / cancel_checkout) first';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'nurture_templates_org_pkey') then
    raise exception 'APPLY-0105 needs the nurture_templates (org_id, occasion_type) primary key (phase59) first';
  end if;
end $$;

alter table public.leads add column if not exists birthday date;
alter table public.leads add column if not exists anniversary date;

-- ---- 1) check-out availability ------------------------------------------------------------------
create or replace function public._checkout_free(p_item uuid, p_date date, p_quote uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_org uuid := public.current_org_id(); v_total numeric; v_out numeric; v_res numeric;
begin
  select coalesce(total_qty, 0) into v_total from public.inventory_items where id = p_item and org_id = v_org;
  if not found then return 0; end if;
  select coalesce(sum(greatest(c.qty_out - coalesce(c.qty_in, 0), 0)), 0) into v_out
    from public.inventory_checkouts c
   where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial');
  v_res := 0;
  if p_date is not null then
    -- other live events on the same date: reserved minus what they already took out (counted above)
    select coalesce(sum(greatest(r.res - coalesce(o.out_qty, 0), 0)), 0) into v_res
      from (select r0.quote_id, sum(r0.qty) as res from public.inventory_reservations r0
             where r0.item_id = p_item and r0.status in ('reserved', 'allocated') group by r0.quote_id) r
      join public.quotes q on q.id = r.quote_id
      left join (select c0.quote_id, sum(greatest(c0.qty_out - coalesce(c0.qty_in, 0), 0)) as out_qty
                   from public.inventory_checkouts c0
                  where c0.item_id = p_item and c0.org_id = v_org and c0.status in ('out', 'partial') group by c0.quote_id) o
        on o.quote_id = r.quote_id
     where q.org_id = v_org and q.event_date = p_date and q.id is distinct from p_quote
       and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled'
       and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed');
  end if;
  return greatest(v_total - v_out - v_res, 0);
end $$;
revoke all on function public._checkout_free(uuid, date, uuid) from public, anon, authenticated;

create or replace function public.checkout_availability(p_item uuid, p_quote uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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

  select coalesce(sum(greatest(c.qty_out - coalesce(c.qty_in, 0), 0)), 0) into v_out
    from public.inventory_checkouts c where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial');
  v_free := public._checkout_free(p_item, v_date, p_quote);

  -- open check-outs holding this item: which event, how many, when due back (day after the event)
  select coalesce(jsonb_agg(x order by x->>'due_back' nulls last), '[]'::jsonb) into v_blocking from (
    select jsonb_build_object('checkout_id', c.id, 'quote_id', c.quote_id,
             'event', coalesce(q.title, 'No event'), 'event_date', q.event_date,
             'due_back', case when q.event_date is not null then q.event_date + 1 end,
             'qty', greatest(c.qty_out - coalesce(c.qty_in, 0), 0), 'issued_to', c.issued_to,
             'overdue', (q.event_date is not null and q.event_date + 1 < current_date)) as x
      from public.inventory_checkouts c left join public.quotes q on q.id = c.quote_id
     where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial')
       and c.qty_out - coalesce(c.qty_in, 0) > 0) s;
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
end $$;
revoke all on function public.checkout_availability(uuid, uuid) from public, anon;
grant execute on function public.checkout_availability(uuid, uuid) to authenticated;

create or replace function public.checkout_equipment_smart(
  p_item uuid, p_quote uuid, p_qty numeric, p_issued_to text, p_issued_to_id uuid default null,
  p_note text default null, p_partial boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_org uuid := public.current_org_id(); v_date date; v_free numeric; v_take numeric; v_note text; v_id uuid;
begin
  if not public.has_area('inventory', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_quote is not null then perform public.assert_quote_org(p_quote); end if;
  if p_qty is null or p_qty <= 0 then raise exception 'quantity must be > 0' using errcode = '22023'; end if;
  if coalesce(btrim(p_issued_to), '') = '' then raise exception 'who is it issued to?' using errcode = '22023'; end if;
  -- lock the item row: concurrent check-outs of the same item queue up here
  perform 1 from public.inventory_items where id = p_item and org_id = v_org for update;
  if not found then raise exception 'item not found' using errcode = '42501'; end if;
  if p_quote is not null then select event_date into v_date from public.quotes where id = p_quote; end if;

  v_free := public._checkout_free(p_item, v_date, p_quote);
  if p_qty <= v_free then
    v_take := p_qty; v_note := nullif(btrim(coalesce(p_note, '')), '');
  elsif coalesce(p_partial, false) and v_free > 0 then
    v_take := v_free;
    v_note := left(concat_ws(' | ', nullif(btrim(coalesce(p_note, '')), ''),
                'Short by ' || (p_qty - v_free)::text || ' (asked ' || p_qty::text || ', ' || v_free::text || ' available)'), 2000);
  else
    return jsonb_build_object('ok', false, 'code', 'shortage', 'requested', p_qty)
           || public.checkout_availability(p_item, p_quote);
  end if;

  insert into public.inventory_checkouts (item_id, quote_id, qty_out, issued_to, issued_to_id, issued_by, note, org_id)
    values (p_item, p_quote, v_take, btrim(p_issued_to), p_issued_to_id, auth.uid(), v_note, v_org)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'checkout_id', v_id, 'qty_out', v_take, 'requested', p_qty,
    'partial', v_take < p_qty, 'shortfall', p_qty - v_take, 'available_after', v_free - v_take);
end $$;
revoke all on function public.checkout_equipment_smart(uuid, uuid, numeric, text, uuid, text, boolean) from public, anon;
grant execute on function public.checkout_equipment_smart(uuid, uuid, numeric, text, uuid, text, boolean) to authenticated;

-- ---- 3) nurture templates: new occasions, fill-only for every studio ----------------------------
-- Text mirrors public/nurture-templates.js (test/nurture-templates.test.mjs checks parity).
insert into public.nurture_templates (org_id, occasion_type, subject, body)
select o.id, v.occasion_type, v.subject, v.body
  from public.organizations o
 cross join (values
    ($t$birthday$t$, $t$Happy birthday, {{name}}!$t$, $t$Hi {{name}},

Happy birthday from everyone at {{studio}}! We still smile when we think of {{last_event}}, and we hope this year brings you plenty to celebrate.

Have a lovely day.

Warm wishes,
{{studio}}$t$),
    ($t$anniversary$t$, $t$Happy anniversary, {{name}}!$t$, $t$Hi {{name}},

Happy {{years}}-year anniversary! It was a privilege to be part of {{last_event}}, and we hope the years since have been full of joy.

If you ever plan a celebration, we would be glad to help.

With love,
{{studio}}$t$),
    ($t$corporate_annual_day$t$, $t$Planning this year's annual day, {{name}}?$t$, $t$Hi {{name}},

Your annual day is around the corner again. We enjoyed working on {{last_event}}, and we would be happy to help plan this year's edition - fresh themes, a smooth run of show and less work for your team.

Shall we set up a short call to discuss dates and ideas?

Best regards,
{{studio}}$t$),
    ($t$annual_day_wishes$t$, $t$Happy annual day, {{name}}!$t$, $t$Hi {{name}} team,

Warm wishes on your annual day! Here's to another year of growth and good work together.

Best regards,
{{studio}}$t$),
    ($t$client_anniversary$t$, $t${{years}} years together - thank you, {{name}}$t$, $t$Hi {{name}},

Today marks {{years}} years since we first worked together. Thank you for trusting us with your events - it has been a pleasure every time.

We look forward to many more.

Warm regards,
{{studio}}$t$),
    ($t$new_year$t$, $t$Happy New Year, {{name}}!$t$, $t$Hi {{name}},

Happy New Year from all of us at {{studio}}! Thank you for being part of our year. We wish you health, happiness and many good reasons to celebrate.

Warm wishes,
{{studio}}$t$),
    ($t$diwali$t$, $t$Happy Diwali, {{name}}!$t$, $t$Hi {{name}},

Wishing you and your family a very happy Diwali! May the festival of lights fill your home with joy, warmth and prosperity.

Warm wishes,
{{studio}}$t$),
    ($t$holi$t$, $t$Happy Holi, {{name}}!$t$, $t$Hi {{name}},

Happy Holi! May this festival of colours bring you and your loved ones plenty of joy.

Warm wishes,
{{studio}}$t$),
    ($t$raksha_bandhan$t$, $t$Happy Raksha Bandhan, {{name}}!$t$, $t$Hi {{name}},

Warm wishes on Raksha Bandhan to you and your family. May the bond you share keep growing stronger.

Warm wishes,
{{studio}}$t$),
    ($t$dussehra$t$, $t$Happy Dussehra, {{name}}!$t$, $t$Hi {{name}},

Happy Dussehra! May this festival bring you success and happiness in everything you do.

Warm wishes,
{{studio}}$t$),
    ($t$ramadan$t$, $t$Ramadan Kareem, {{name}}$t$, $t$Hi {{name}},

Ramadan Kareem! Wishing you and your family a peaceful, blessed month.

Warm regards,
{{studio}}$t$),
    ($t$eid$t$, $t$Eid Mubarak, {{name}}!$t$, $t$Hi {{name}},

Eid Mubarak! May this special day bring you and your family happiness, peace and togetherness.

Warm wishes,
{{studio}}$t$),
    ($t$christmas$t$, $t$Merry Christmas, {{name}}!$t$, $t$Hi {{name}},

Merry Christmas from all of us at {{studio}}! Wishing you a warm, happy holiday season with the people you love.

Warm wishes,
{{studio}}$t$),
    ($t$uae_national_day$t$, $t$Happy UAE National Day, {{name}}!$t$, $t$Hi {{name}},

Happy UAE National Day! Warm wishes to you and your family as the nation celebrates.

Best regards,
{{studio}}$t$)
 ) as v(occasion_type, subject, body)
on conflict (org_id, occasion_type) do nothing;

commit;

-- =================================================================================================
-- verify (read-only)
-- =================================================================================================
select item, ok from (values
  ('0105 01 leads.birthday + leads.anniversary exist (nullable date)',
     (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'leads'
        and column_name in ('birthday', 'anniversary') and data_type = 'date' and is_nullable = 'YES') = 2),
  ('0105 02 check-out functions installed',
     to_regprocedure('public._checkout_free(uuid,date,uuid)') is not null
     and to_regprocedure('public.checkout_availability(uuid,uuid)') is not null
     and to_regprocedure('public.checkout_equipment_smart(uuid,uuid,numeric,text,uuid,text,boolean)') is not null),
  ('0105 03 definer + empty search_path',
     not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
       and p.proname in ('_checkout_free', 'checkout_availability', 'checkout_equipment_smart')
       and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))),
  ('0105 04 grants: app yes, anon no, helper internal',
     has_function_privilege('authenticated', 'public.checkout_equipment_smart(uuid,uuid,numeric,text,uuid,text,boolean)', 'execute')
     and not has_function_privilege('anon', 'public.checkout_equipment_smart(uuid,uuid,numeric,text,uuid,text,boolean)', 'execute')
     and has_function_privilege('authenticated', 'public.checkout_availability(uuid,uuid)', 'execute')
     and not has_function_privilege('anon', 'public.checkout_availability(uuid,uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._checkout_free(uuid,date,uuid)', 'execute')),
  ('0105 05 every studio has the 12 new nurture occasions',
     not exists (select 1 from public.organizations o where (select count(*) from public.nurture_templates t
       where t.org_id = o.id and t.occasion_type in ('corporate_annual_day','annual_day_wishes','client_anniversary','new_year','diwali',
         'holi','raksha_bandhan','dussehra','ramadan','eid','christmas','uae_national_day')) < 12)),
  ('0105 06 no template left with an unfillable placeholder',
     not exists (select 1 from public.nurture_templates where (subject || body) ~ '\{\{\s*(event_date|planner_name|phone)\s*\}\}'))
) v(item, ok)
order by item;
