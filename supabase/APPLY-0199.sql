-- APPLY-0199.sql - paste into the Supabase SQL editor (staging first, then production).
-- Budget + guests single source: the quote is the source of an event's budget and guests; the linked
-- CRM lead now follows the quote (Leads card, lead detail, CRM table), and Discovery mirrors it.
-- Additive + idempotent: 1 function replaced + 2 small helpers; the one-time fill only fills EMPTY
-- values (never overwrites). No table changed, nothing deleted. Safe to run twice.
--
-- PREVIEW (read-only, optional - run this block alone first to see how many blanks will be filled):
--   select
--     (select count(*) from public.quotes q left join public.event_discovery d on d.quote_id = q.id and d.org_id = q.org_id
--       where q.deleted_at is null and not exists (select 1 from public.organizations o where o.id = q.org_id and o.is_sample_master) and nullif(btrim(coalesce(q.client ->> 'budget', '')), '') is null
--         and (coalesce(d.budget_max, d.budget_min) is not null
--              or exists (select 1 from public.leads l where l.quote_id = q.id and l.org_id = q.org_id and l.budget is not null))) as quote_budget_to_fill,
--     (select count(*) from public.quotes q where q.deleted_at is null and not exists (select 1 from public.organizations o where o.id = q.org_id and o.is_sample_master) and nullif(btrim(coalesce(q.client ->> 'guests', '')), '') is null
--         and exists (select 1 from public.leads l where l.quote_id = q.id and l.org_id = q.org_id and l.guest_count is not null)) as quote_guests_to_fill,
--     (select count(*) from public.event_discovery d join public.quotes q on q.id = d.quote_id and q.org_id = d.org_id
--       where q.deleted_at is null and not exists (select 1 from public.organizations o where o.id = q.org_id and o.is_sample_master) and d.budget_min is null and d.budget_max is null
--         and btrim(coalesce(q.client ->> 'budget', '')) ~ '^[0-9]+(\.[0-9]+)?$') as discovery_budget_to_fill,
--     (select count(*) from public.leads l join public.quotes q on q.id = l.quote_id and q.org_id = l.org_id
--       where q.deleted_at is null and not exists (select 1 from public.organizations o where o.id = q.org_id and o.is_sample_master)
--         and ((l.budget is null and btrim(coalesce(q.client ->> 'budget', '')) ~ '^[0-9]+(\.[0-9]+)?$')
--           or (l.guest_count is null and btrim(coalesce(q.client ->> 'guests', '')) ~ '^[0-9]+$'))) as lead_to_fill,
--     (select count(*) from public.leads l join public.quotes q on q.id = l.quote_id and q.org_id = l.org_id
--       where q.deleted_at is null and not exists (select 1 from public.organizations o where o.id = q.org_id and o.is_sample_master) and l.budget is not null and btrim(coalesce(q.client ->> 'budget', '')) ~ '^[0-9]+(\.[0-9]+)?$'
--         and l.budget <> (btrim(q.client ->> 'budget'))::numeric) as conflicts_left_as_is;
--   (the trial sample master is skipped; conflicts = lead and quote both set but different - reported only, never changed)
begin;
-- 0199_budget_single_source.sql - CANONICAL forward-only.
-- REQUIRES base (quotes.client jsonb, leads.budget / guest_count, event_discovery.budget_min / budget_max,
--          sync_quote_to_lead() + quotes_sync_lead_ins / quotes_sync_lead_upd triggers),
--          0026 (leads_budget_finite_chk), 0149 (leads_guest_count_range_chk), 0166 (organizations.is_sample_master).
--
-- In plain words:
--   One event had its budget (and guests) in up to three places that drifted apart:
--     * the quote's client record (quotes.client ->> 'budget' / 'guests') - the quote flow step 1,
--     * the Discovery record (event_discovery.budget_max, an old budget_min),
--     * the CRM lead (leads.budget / guest_count) - the Leads board card, lead detail and CRM table.
--   The quote -> lead sync trigger copied name / phone / email / type / date but NEVER the budget or
--   guests, so a lead made from a quote showed an empty Budget and Guests in the CRM even though the
--   quote said Rs 2 crore and 60,000 guests.
--   From now on the QUOTE is the single source for an event's budget and guests:
--     1) sync_quote_to_lead() also copies the quote's budget and guests onto the linked lead whenever
--        the quote is created or its budget / guests change (a cleared value never blanks the lead;
--        other quote edits never touch the lead's budget / guests). The lead archive trigger keeps a
--        snapshot of every lead change, so the previous value stays in the CRM history.
--     2) A one-time fill of BLANKS only (never overwrites a value that is already there):
--        a) quote budget empty  -> Discovery budget (max, else an old min), else the linked lead's budget
--        b) quote guests empty  -> the linked lead's guest count
--        c) Discovery budget empty (both min and max) -> the quote budget
--        d) lead budget / guests empty -> the linked quote's budget / guests
--        Deleted quotes and the trial sample master are left alone. While a) and b) run, the
--        quote -> lead sync trigger is paused inside this same statement (so filling the quote does not
--        re-sync anything else on the lead) and switched back on before the statement ends.
--   Additive + idempotent: create or replace one function; updates only fill NULL / empty values.
--   No DROP of data, DELETE or TRUNCATE. Safe to run twice (the second run finds no blanks to fill).
-- ============================================================================

do $$ begin
  if to_regclass('public.event_discovery') is null then raise exception '0199: event_discovery is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'leads' and column_name = 'guest_count') then
    raise exception '0199: leads.guest_count is missing'; end if;
  if to_regprocedure('public.sync_quote_to_lead()') is null then raise exception '0199: sync_quote_to_lead() is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'organizations' and column_name = 'is_sample_master') then
    raise exception '0199: organizations.is_sample_master (0166) is missing'; end if;
end $$;

-- helper: a clean money / count value out of the client JSON, or null (text, '', junk, out of range)
create or replace function public._b199_amount(p text) returns numeric
language sql immutable set search_path = public as $$
  select case when btrim(coalesce(p, '')) ~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'
              and btrim(p)::numeric < 1e12 then trim_scale(round(btrim(p)::numeric, 2)) end;
$$;
create or replace function public._b199_guests(p text) returns integer
language sql immutable set search_path = public as $$
  select case when btrim(coalesce(p, '')) ~ '^[0-9]{1,6}(\.0+)?$'
              and btrim(p)::numeric <= 100000 then btrim(p)::numeric::integer end;
$$;
do $$ declare f text; begin
  foreach f in array array['public._b199_amount(text)', 'public._b199_guests(text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
end $$;

create or replace function public.sync_quote_to_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name  text := nullif(btrim(NEW.client->>'name'), '');
  v_email text := nullif(btrim(NEW.client->>'email'), '');
  v_phone text := nullif(btrim(NEW.client->>'phone'), '');
  -- 0199: the quote is the single source of the event's budget + guests
  v_budget numeric := public._b199_amount(NEW.client->>'budget');
  v_guests integer := public._b199_guests(NEW.client->>'guests');
  v_bchg boolean := true;
  v_gchg boolean := true;
  v_status text;
  v_lead public.leads;
begin
  if v_name is null then return NEW; end if;
  if TG_OP = 'UPDATE' then
    v_bchg := (OLD.client->>'budget') is distinct from (NEW.client->>'budget');
    v_gchg := (OLD.client->>'guests') is distinct from (NEW.client->>'guests');
  end if;
  v_status := case
    when NEW.status = 'cancelled'                          then 'lost'
    when NEW.approval_status = 'paid'
      or NEW.status = 'confirmed'
      or NEW.lifecycle_stage in ('planning','event','settlement','closed') then 'won'
    when NEW.lifecycle_stage = 'discovery'                 then 'discovery'
    else 'quoted' end;
  select * into v_lead from public.leads where quote_id = NEW.id and org_id = NEW.org_id limit 1;
  if v_lead.id is null then
    select * into v_lead from public.leads
     where org_id = NEW.org_id and quote_id is null
       and ( (v_email is not null and lower(coalesce(email,'')) = lower(v_email))
          or (v_email is null and lower(coalesce(name,'')) = lower(v_name)) )
     order by updated_at desc limit 1;
  end if;
  if v_lead.id is not null then
    update public.leads set
      name       = v_name,
      email      = coalesce(v_email, email),
      phone      = coalesce(v_phone, phone),
      event_type = coalesce(NEW.event_type, event_type),
      event_date = coalesce(NEW.event_date, event_date),
      -- 0199: only when the quote's budget / guests were set or changed; a cleared value keeps the lead's
      budget      = case when v_bchg and v_budget is not null then v_budget else budget end,
      guest_count = case when v_gchg and v_guests is not null then v_guests else guest_count end,
      status     = case when status in ('won','lost') and v_status in ('quoted','discovery')
                        then status else v_status end,
      quote_id   = NEW.id,
      updated_at = now()
     where id = v_lead.id;
  else
    insert into public.leads (org_id, name, phone, email, source, event_type, event_date, budget, guest_count, status, quote_id)
      values (NEW.org_id, v_name, v_phone, v_email, 'quote', NEW.event_type, NEW.event_date, v_budget, v_guests, v_status, NEW.id);
  end if;
  return NEW;
end; $function$;

-- ---- one-time fill of blanks (never overwrites) ----------------------------
do $$
declare
  v_state "char"; v_paused boolean := false; n int;
begin
  select t.tgenabled into v_state from pg_trigger t
   where t.tgrelid = 'public.quotes'::regclass and t.tgname = 'quotes_sync_lead_upd' and not t.tgisinternal;
  if v_state = 'O' then
    begin
      execute 'alter table public.quotes disable trigger quotes_sync_lead_upd';
      v_paused := true;
    exception when insufficient_privilege then
      raise notice '0199: cannot pause quotes_sync_lead_upd (%) - quote fill a) b) skipped, c) d) still run', sqlerrm;
    end;
  end if;

  if v_paused or v_state is null or v_state = 'D' then
    -- a) quote budget empty -> Discovery budget (max, else min), else the linked lead's budget
    update public.quotes q
       set client = jsonb_set(coalesce(q.client, '{}'::jsonb), '{budget}', to_jsonb(s.v), true)
      from (
        select q2.id,
               coalesce(public._b199_amount(d.budget_max::text), public._b199_amount(d.budget_min::text),
                        (select public._b199_amount(l.budget::text) from public.leads l
                          where l.quote_id = q2.id and l.org_id = q2.org_id and l.budget is not null
                          order by l.updated_at desc limit 1)) as v
          from public.quotes q2
          left join public.event_discovery d on d.quote_id = q2.id and d.org_id = q2.org_id
         where q2.deleted_at is null
           and (q2.client is null or jsonb_typeof(q2.client) = 'object')
           and nullif(btrim(coalesce(q2.client ->> 'budget', '')), '') is null
           and not exists (select 1 from public.organizations o where o.id = q2.org_id and coalesce(o.is_sample_master, false))
      ) s
     where q.id = s.id and s.v is not null;
    get diagnostics n = row_count; raise notice '0199 a) quote budget filled: %', n;

    -- b) quote guests empty -> the linked lead's guest count
    update public.quotes q
       set client = jsonb_set(coalesce(q.client, '{}'::jsonb), '{guests}', to_jsonb(s.v), true)
      from (
        select q2.id,
               (select l.guest_count from public.leads l
                 where l.quote_id = q2.id and l.org_id = q2.org_id and l.guest_count is not null
                   and l.guest_count between 0 and 100000
                 order by l.updated_at desc limit 1) as v
          from public.quotes q2
         where q2.deleted_at is null
           and (q2.client is null or jsonb_typeof(q2.client) = 'object')
           and nullif(btrim(coalesce(q2.client ->> 'guests', '')), '') is null
           and not exists (select 1 from public.organizations o where o.id = q2.org_id and coalesce(o.is_sample_master, false))
      ) s
     where q.id = s.id and s.v is not null;
    get diagnostics n = row_count; raise notice '0199 b) quote guests filled: %', n;
  end if;

  if v_paused then execute 'alter table public.quotes enable trigger quotes_sync_lead_upd'; end if;

  -- c) Discovery budget empty (min and max) -> the quote budget
  update public.event_discovery d
     set budget_max = public._b199_amount(q.client ->> 'budget')
    from public.quotes q
   where q.id = d.quote_id and q.org_id = d.org_id and q.deleted_at is null
     and d.budget_min is null and d.budget_max is null
     and public._b199_amount(q.client ->> 'budget') is not null
     and not exists (select 1 from public.organizations o where o.id = q.org_id and coalesce(o.is_sample_master, false));
  get diagnostics n = row_count; raise notice '0199 c) discovery budget filled: %', n;

  -- d) lead budget / guests empty -> the linked quote's budget / guests
  update public.leads l
     set budget      = coalesce(l.budget, public._b199_amount(q.client ->> 'budget')),
         guest_count = coalesce(l.guest_count, public._b199_guests(q.client ->> 'guests'))
    from public.quotes q
   where q.id = l.quote_id and q.org_id = l.org_id and q.deleted_at is null
     and ( (l.budget is null and public._b199_amount(q.client ->> 'budget') is not null)
        or (l.guest_count is null and public._b199_guests(q.client ->> 'guests') is not null) )
     and not exists (select 1 from public.organizations o where o.id = q.org_id and coalesce(o.is_sample_master, false));
  get diagnostics n = row_count; raise notice '0199 d) lead budget / guests filled: %', n;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 sync_quote_to_lead copies budget + guests', coalesce((select prosrc like '%v_budget%' and prosrc like '%guest_count = case when v_gchg%' from pg_proc where oid = to_regprocedure('public.sync_quote_to_lead()')), false)),
  ('02 sync_quote_to_lead is SECURITY DEFINER', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.sync_quote_to_lead()')), false)),
  ('03 quote -> lead sync triggers enabled', (select count(*) from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname in ('quotes_sync_lead_ins', 'quotes_sync_lead_upd') and tgenabled = 'O') = 2),
  ('04 helpers not callable by app roles', not has_function_privilege('authenticated', 'public._b199_amount(text)', 'execute') and not has_function_privilege('anon', 'public._b199_guests(text)', 'execute')),
  ('05 no linked lead left with an empty budget the quote has', not exists (select 1 from public.leads l join public.quotes q on q.id = l.quote_id and q.org_id = l.org_id
       join public.organizations o on o.id = q.org_id and not coalesce(o.is_sample_master, false)
      where q.deleted_at is null and l.budget is null and public._b199_amount(q.client ->> 'budget') is not null)),
  ('06 no linked lead left with empty guests the quote has', not exists (select 1 from public.leads l join public.quotes q on q.id = l.quote_id and q.org_id = l.org_id
       join public.organizations o on o.id = q.org_id and not coalesce(o.is_sample_master, false)
      where q.deleted_at is null and l.guest_count is null and public._b199_guests(q.client ->> 'guests') is not null))
) v(item, ok) order by item;
