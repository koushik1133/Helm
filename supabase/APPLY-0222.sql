-- APPLY-0222.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0237.sql (needs 0077 + 0082 + 0097 + 0167 + 0171 + 0182; on a clean install the MANIFEST order works too).
-- Live QA round 19, L6: a new free trial got 6 "Prices changed - review & re-price" alerts and a chair-rate drift banner
-- on its confirmed sample events. Re-pricing alerts now skip sample data, confirmed events and client-approved / paid
-- quotes; the sample master's open quotes are priced at its own Control Center chair rate (100), the confirmed sample
-- events' sample money follows, and one new sample version is published (NEW trials get it). Existing bell rows are
-- not changed or deleted; existing trials move to the new sample with APPLY-0178-refresh-trials.sql (owner-run).
-- Nothing deleted; paid studios untouched. Safe to run twice (the 2nd run changes nothing). ASCII only.
begin;
-- 0222_trial_seed_r20.sql - CANONICAL forward-only. Live production QA (round 19), L6: a brand-new free trial
-- got 6 "Prices changed - review & re-price" bell alerts (one per sample quote SMP-1001 .. SMP-1006) and the
-- confirmed SMP-1001 sample event showed "Prices changed since this quote was priced - Chair rate . 450 chairs".
-- REQUIRES 0077 + 0082 (_r3_price_change_notify), 0097 (quotes.is_demo), 0167 (sample master,
--          helm_trial_seed_manifest, publish_sample_manifest), 0171 (the sample events), 0182 (chairPrice 100).
--
-- Root cause:
--   a  The sample master's Control Center chair rate is 100 (0182, the owner's "Chair (single)" rate), but five
--      of its sample quotes were still priced at the older 45 / 25 per chair (0167 / 0171; 0182 moved only the
--      Kapoor sangeet). Every trial copies both, so the quotes look stale against the studio's own price list.
--   b  The trial copy writes the studio's price list (app_config 'pricing') AFTER the sample quotes. That save
--      runs the 0077 re-pricing alert, which compares it with the built-in defaults (chair 200), so every
--      future sample quote with chairs got a price_change bell row - even the confirmed, paid ones.
--
-- In plain words:
--   1  Re-pricing alerts (0077 / 0082 _r3_price_change_notify, same signature, grants and every 0082 rule) now
--      also skip sample-data quotes (is_demo), confirmed events and quotes the client already approved or paid
--      (approval_status approved / paid): their price is agreed, so a price-list change is not a to-do for them.
--      Existing bell rows are NOT changed or deleted (people can dismiss them).
--   2  The sample master's five open sample quotes are priced at the sample studio's own chair rate (read from
--      its Control Center, 100 today): SMP-1001 / SMP-1002 (45 -> 100) and SMP-1003 / SMP-1005 / SMP-1006
--      (25 -> 100), each only while it still carries its shipped chair price. The server pricing engine (D8
--      trigger) re-prices the totals. For the two confirmed events (SMP-1001, SMP-1005) the shipped sample money
--      follows the new total exactly like 0182 did for the Kapoor sangeet - 30 % advance (paid, simulated) +
--      70 % balance - only while the milestones and the simulated payment still carry their shipped amounts.
--      SMP-1000 (closed, settled) and SMP-1004 (already 100) are not touched. Sample rows of the master only.
--   3  ONE new sample manifest is published (current + 1, marker 'sample quotes at the studio chair rate (0222)'),
--      so every NEW trial gets quotes that match its Control Center. Existing trial studios are not updated here
--      (no trial row is rewritten); the owner-run APPLY-0178-refresh-trials.sql moves them to the new sample,
--      and from step 1 on their sample quotes never get a new re-pricing alert.
--   Steps 2 + 3 run once (the marker), so a later owner edit of the master is never overwritten by a re-run.
--   No table, column, index, policy or trigger is added or dropped; nothing is deleted; paid studios are not
--   touched. ASCII only. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._r3_price_change_notify(uuid,text,text[],text)') is null or to_regprocedure('public._r3_num(jsonb,text)') is null then
    raise exception '0222 needs 0077 + 0082 (re-pricing alerts) first'; end if;
  if to_regclass('public.helm_trial_seed_manifest') is null or to_regprocedure('public.publish_sample_manifest(text)') is null then
    raise exception '0222 needs 0167 (sample manifest) first'; end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'quotes' and column_name = 'is_demo') then
    raise exception '0222 needs 0097 (quotes.is_demo) first'; end if;
end $$;

-- ---- 1) re-pricing alerts: never for sample data, confirmed events or client-approved / paid quotes ---------
create or replace function public._r3_price_change_notify(p_org uuid, p_source text, p_fields text[], p_package text default null)
returns integer language plpgsql security definer set search_path = '' as $$
-- reprice-alert-0077 + r4-0082: skips soft-deleted / archived quotes
-- trial-seed-0222: skips sample data (is_demo), confirmed events and client-approved / paid quotes
declare n integer := 0;
begin
  if p_org is null or coalesce(array_length(p_fields, 1), 0) = 0 then return 0; end if;
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
  select q.id, 'in_app', 'price_change', 'sent',
         jsonb_build_object('source', p_source, 'fields', to_jsonb(p_fields), 'event_code', q.code,
                            'path', 'flow.html?id=' || q.id::text), p_org
    from public.quotes q
   where q.org_id = p_org and q.deleted_at is null and q.archived_at is null
     and not coalesce(q.is_demo, false)
     and coalesce(q.status, '') not in ('cancelled', 'confirmed')
     and coalesce(q.approval_status, '') not in ('approved', 'paid')
     and coalesce(q.lifecycle_stage, 'quote') not in ('settlement', 'closed')
     and (q.event_date is null or q.event_date >= current_date)
     and coalesce(public._r3_num(q.pricing, 'total'), 0) > 0
     and (
          (p_source = 'menu' and q.pricing ->> '_packageName' = p_package and coalesce(public._r3_num(q.pricing, 'guests'), 0) > 0)
       or (p_source = 'pricing' and (
             ('chairPrice' = any (p_fields) and coalesce(public._r3_num(q.pricing, 'chairs'), 0) > 0)
          or ('platePrice' = any (p_fields) and coalesce(public._r3_num(q.pricing, 'guests'), 0) > 0 and nullif(q.pricing ->> '_packageName', '') is null)
          or (('layoutBase' = any (p_fields) or 'assetPrices' = any (p_fields)) and coalesce(public._r3_num(q.pricing, 'other'), 0) > 0)
          or 'gstPct' = any (p_fields) or 'serviceChargePct' = any (p_fields)))
     )
     and not exists (select 1 from public.notifications x
                      where x.quote_id = q.id and x.kind = 'price_change' and x.org_id = p_org
                        and x.created_at > now() - interval '10 minutes'
                        and x.detail ->> 'source' = p_source and x.detail -> 'fields' = to_jsonb(p_fields))
   order by q.event_date nulls last
   limit 200;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from authenticated'; end if;
end $$;

-- ---- 2 + 3) once: the master's open sample quotes at the studio chair rate, then publish (current + 1) -------
-- the one-time marker (manifest note); a function so the migration, APPLY, VERIFY and test agree
create or replace function public._a222_manifest_note()
returns text language sql immutable set search_path = '' as $$
  select 'sample quotes at the studio chair rate (0222)'::text;
$$;
revoke all on function public._a222_manifest_note() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a222_manifest_note() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._a222_manifest_note() from authenticated'; end if;
end $$;

do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  N constant text := public._a222_manifest_note();
  v_prev text := coalesce(current_setting('helm.maintenance', true), '');
  v_rate numeric; s record; t_old numeric; t_new numeric; a_old numeric; a_new numeric; v_changed integer := 0;
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;
  if exists (select 1 from public.helm_trial_seed_manifest m where m.notes = N) then return; end if;
  -- the sample studio's own Control Center chair rate (100 since 0182); nothing to do without a usable one
  select public._r3_num(c.value, 'chairPrice') into v_rate
    from public.app_config c where c.org_id = M and c.key = 'pricing';
  if v_rate is null or v_rate <= 0 or v_rate > 100000 then return; end if;
  perform set_config('helm.maintenance', 'on', true);          -- maintenance: no bell rows for this change

  for s in select x.id, x.old_price from (values
             ('a5a5a5a5-0167-4000-8000-0000000000a1'::uuid, '45'),   -- SMP-1001 wedding (confirmed, advance paid)
             ('a5a5a5a5-0167-4000-8000-0000000000a2'::uuid, '45'),   -- SMP-1002 reception (quote sent)
             ('a5a5a5a5-0167-4000-8000-0000000000a3'::uuid, '25'),   -- SMP-1003 corporate gala (quote)
             ('a5a5a5a5-0171-4000-8000-0000000000b6'::uuid, '25'),   -- SMP-1005 (confirmed, advance paid)
             ('a5a5a5a5-0171-4000-8000-0000000000b7'::uuid, '25')    -- SMP-1006 (quote)
           ) x(id, old_price) loop
    t_old := null; t_new := null;
    -- only an open sample quote that still carries its shipped chair price (an owner edit is kept)
    select public._r3_num(q.pricing, 'total') into t_old
      from public.quotes q
     where q.id = s.id and q.org_id = M and q.deleted_at is null and jsonb_typeof(q.pricing) = 'object'
       and q.pricing ->> 'chairPrice' = s.old_price
       and coalesce(q.status, '') <> 'cancelled' and coalesce(q.lifecycle_stage, 'quote') not in ('settlement', 'closed');
    if t_old is null or t_old <= 0 then continue; end if;

    update public.quotes q set pricing = q.pricing || jsonb_build_object('chairPrice', v_rate)
     where q.id = s.id and q.org_id = M and q.pricing ->> 'chairPrice' = s.old_price;
    v_changed := v_changed + 1;
    select public._r3_num(q.pricing, 'total') into t_new from public.quotes q where q.id = s.id and q.org_id = M;

    -- the shipped sample money (0171 / 0182 pattern): 30 % advance (paid, simulated) + 70 % balance; follow the new
    -- total only while both milestones and the one simulated advance still carry their shipped amounts
    a_old := round(t_old * 0.3); a_new := round(coalesce(t_new, 0) * 0.3);
    if t_new is not null and t_new > 0 and t_new <> t_old
       and exists (select 1 from public.payment_milestones pm where pm.quote_id = s.id and pm.org_id = M and pm.seq = 1
                     and pm.label = 'Advance (30%)' and pm.amount = a_old and pm.status = 'paid')
       and exists (select 1 from public.payment_milestones pm where pm.quote_id = s.id and pm.org_id = M and pm.seq = 2
                     and pm.label = 'Balance (70%)' and pm.amount = t_old - a_old and pm.status = 'due')
       and (select count(*) from public.payment_milestones pm where pm.quote_id = s.id) = 2
       and (select count(*) from public.quote_payments p where p.quote_id = s.id) = 1
       and exists (select 1 from public.quote_payments p where p.quote_id = s.id and p.org_id = M and p.simulated and p.amount = a_old) then
      update public.payment_milestones set amount = a_new
       where quote_id = s.id and org_id = M and seq = 1 and label = 'Advance (30%)' and amount = a_old and status = 'paid';
      update public.payment_milestones set amount = t_new - a_new
       where quote_id = s.id and org_id = M and seq = 2 and label = 'Balance (70%)' and amount = t_old - a_old and status = 'due';
      update public.quote_payments set amount = a_new
       where quote_id = s.id and org_id = M and simulated and amount = a_old;
    end if;
  end loop;

  -- publish once: NEW trials get quotes priced at their own Control Center chair rate
  if v_changed > 0 and exists (select 1 from public.quotes x where x.org_id = M) then
    perform public.publish_sample_manifest(N);
  end if;
  perform set_config('helm.maintenance', v_prev, true);
end $$;

notify pgrst, 'reload schema';

commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 re-pricing alerts skip sample data, confirmed events and client-approved / paid quotes (0082 rules kept)',
     position('trial-seed-0222' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._r3_price_change_notify(uuid,text,text[],text)')), '')) > 0
     and position('not coalesce(q.is_demo, false)' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._r3_price_change_notify(uuid,text,text[],text)')), '')) > 0
     and position('q.deleted_at is null and q.archived_at is null' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._r3_price_change_notify(uuid,text,text[],text)')), '')) > 0),
  ('02 sample master: every open sample quote is priced at its Control Center chair rate',
     not exists (select 1 from public.quotes q
                  join public.app_config c on c.org_id = q.org_id and c.key = 'pricing'
                  where q.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and q.deleted_at is null
                    and coalesce(q.status, '') <> 'cancelled' and coalesce(q.lifecycle_stage, 'quote') not in ('settlement', 'closed')
                    and coalesce((q.pricing ->> 'chairs'), '0') <> '0'
                    and (q.pricing ->> 'chairPrice') is distinct from (c.value ->> 'chairPrice'))),
  ('03 sample master: confirmed events - milestones add up to the total',
     not exists (select 1 from public.quotes q where q.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and q.status = 'confirmed'
                  and exists (select 1 from public.payment_milestones pm where pm.quote_id = q.id)
                  and (select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = q.id) <> (q.pricing ->> 'total')::numeric)),
  ('04 the 0222 sample version was published once and is current (or a later one)',
     (select count(*) from public.helm_trial_seed_manifest where notes = public._a222_manifest_note()) = 1
     and exists (select 1 from public.helm_trial_seed_manifest c where c.is_current
                   and c.version >= (select m.version from public.helm_trial_seed_manifest m where m.notes = public._a222_manifest_note()))),
  ('05 helpers internal',
     not has_function_privilege('authenticated', 'public._r3_price_change_notify(uuid,text,text[],text)', 'execute')
     and not has_function_privilege('anon', 'public._r3_price_change_notify(uuid,text,text[],text)', 'execute')
     and not has_function_privilege('authenticated', 'public._a222_manifest_note()', 'execute'))
) v(item, ok) order by item;
