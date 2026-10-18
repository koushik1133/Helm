-- APPLY-0196.sql - paste into the Supabase SQL editor (staging first, then production).
-- Additive + idempotent: 4 nullable budget-planning columns on event_costs + unique (quote_id, requirement_key) index + same-studio vendor guard. No row changed. Safe to run twice.
begin;
-- 0196_budget_from_requirements.sql - CANONICAL forward-only.
-- REQUIRES base event_costs / vendors / quotes (org_id + tg_org_from_quote), 0026 (money CHECK naming).
--
-- In plain words:
--   BUDGET FROM REQUIREMENTS. The event's Budget & margin page now builds its cost lines from the
--   client's requirements (quote step 3: Must-have / Nice-to-have / Optional) plus standard lines
--   most events need (venue, catering, chairs, decor, sound & lights, staff, logistics, contingency).
--   The page itself does the matching; the database only needs four new, NULLABLE columns on the
--   existing cost line table (public.event_costs):
--     requirement_key  which requirement / standard line a row came from ('req:<name>' or 'std:<id>')
--     priority         that requirement's priority when the row was made (mandatory / nice / optional)
--     quoted           what the client is quoted for this line (prefilled from the quote's own lines)
--     vendor_id        the vendor chosen for this line (a vendor of the SAME studio only)
--   * One unique index on (quote_id, requirement_key): pulling requirements again (reload, two tabs)
--     can never create a second row for the same requirement. Rows without a key (every existing
--     row, and lines typed by hand) are NULL and never collide, so nothing existing is affected.
--   * A trigger refuses a vendor_id that belongs to another studio (cross-tenant guard).
--   * Money: quoted is NULL or finite, >= 0 and < 1e12 (same rule as estimated / actual, 0026).
--   Nothing is updated or deleted: no existing row changes, totals / P&L are unchanged (they read
--   estimated / actual only). Not a trial cap table (0173 caps leads / quotes / inventory /
--   vendors / staff / venues only), so budget lines work in a free trial.
--   Additive + idempotent: add column if not exists, constraints / indexes by name if missing,
--   create or replace, drop trigger if exists + create. No DROP of data, DELETE or TRUNCATE. ASCII only.
-- ============================================================================

do $$ begin
  if to_regclass('public.event_costs') is null then raise exception '0196: public.event_costs is missing'; end if;
  if to_regclass('public.vendors') is null then raise exception '0196: public.vendors is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'event_costs' and column_name = 'org_id') then
    raise exception '0196: event_costs.org_id is missing (multitenant base)'; end if;
end $$;

alter table public.event_costs add column if not exists requirement_key text;
alter table public.event_costs add column if not exists priority text;
alter table public.event_costs add column if not exists quoted numeric;
alter table public.event_costs add column if not exists vendor_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_costs_requirement_key_0196_chk'
                  and conrelid = 'public.event_costs'::regclass) then
    alter table public.event_costs add constraint event_costs_requirement_key_0196_chk
      check (requirement_key is null or (length(requirement_key) between 5 and 300 and requirement_key ~ '^(req|std):')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_costs_priority_0196_chk'
                  and conrelid = 'public.event_costs'::regclass) then
    alter table public.event_costs add constraint event_costs_priority_0196_chk
      check (priority is null or priority in ('mandatory', 'nice', 'optional')) not valid;
  end if;
  -- same name pattern as 0026 (<table>_<column>_finite_chk); NULL passes
  if not exists (select 1 from pg_constraint where conname = 'event_costs_quoted_finite_chk'
                  and conrelid = 'public.event_costs'::regclass) then
    alter table public.event_costs add constraint event_costs_quoted_finite_chk
      check (quoted >= 0 and quoted < 1e12) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_costs_vendor_id_0196_fkey'
                  and conrelid = 'public.event_costs'::regclass) then
    alter table public.event_costs add constraint event_costs_vendor_id_0196_fkey
      foreign key (vendor_id) references public.vendors(id) on delete set null;
  end if;
end $$;

-- one row per requirement / standard line per event (NULL keys = hand-typed lines, never collide)
create unique index if not exists event_costs_req_key_0196_uq on public.event_costs (quote_id, requirement_key);
create index if not exists event_costs_vendor_0196_idx on public.event_costs (vendor_id) where vendor_id is not null;

-- a cost line may only name a vendor of its own studio (runs after org_from_quote set org_id)
create or replace function public.tg_event_costs_vendor_org_0196()
returns trigger language plpgsql security definer set search_path = '' as $$
-- budget-plan-0196
begin
  if new.vendor_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.vendor_id is not distinct from old.vendor_id and new.org_id is not distinct from old.org_id then
    return new;
  end if;
  if not exists (select 1 from public.vendors v where v.id = new.vendor_id and v.org_id = new.org_id) then
    raise exception 'That vendor is not in this studio.' using errcode = '42501', hint = 'vendor_other_studio';
  end if;
  return new;
end $$;
revoke all on function public.tg_event_costs_vendor_org_0196() from public, anon, authenticated;

drop trigger if exists zz_event_costs_vendor_org_0196 on public.event_costs;
create trigger zz_event_costs_vendor_org_0196 before insert or update of vendor_id, org_id on public.event_costs
  for each row execute function public.tg_event_costs_vendor_org_0196();

comment on column public.event_costs.requirement_key is '0196: req:<requirement name, folded> or std:<standard line id>; unique per event';
comment on column public.event_costs.priority is '0196: requirement priority when the line was made (mandatory / nice / optional)';
comment on column public.event_costs.quoted is '0196: amount quoted to the client for this line (planning only; revenue is the quote total)';
comment on column public.event_costs.vendor_id is '0196: vendor for this line (same studio only)';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 four new nullable columns on event_costs', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'event_costs'
      and column_name in ('requirement_key', 'priority', 'quoted', 'vendor_id') and is_nullable = 'YES') = 4),
  ('02 unique (quote_id, requirement_key) index', exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'event_costs'
      and indexname = 'event_costs_req_key_0196_uq' and indexdef like 'CREATE UNIQUE INDEX%(quote_id, requirement_key)%')),
  ('03 priority / key / quoted checks', (select count(*) from pg_constraint where conrelid = 'public.event_costs'::regclass
      and conname in ('event_costs_requirement_key_0196_chk', 'event_costs_priority_0196_chk', 'event_costs_quoted_finite_chk')) = 3),
  ('04 vendor FK (on delete set null)', exists (select 1 from pg_constraint where conrelid = 'public.event_costs'::regclass
      and conname = 'event_costs_vendor_id_0196_fkey' and confdeltype = 'n')),
  ('05 same-studio vendor trigger', exists (select 1 from pg_trigger where tgrelid = 'public.event_costs'::regclass
      and tgname = 'zz_event_costs_vendor_org_0196' and not tgisinternal)),
  ('06 trigger function not callable by the app', not has_function_privilege('authenticated', 'public.tg_event_costs_vendor_org_0196()', 'execute')
      and not has_function_privilege('anon', 'public.tg_event_costs_vendor_org_0196()', 'execute')),
  ('07 not a trial-capped table', not exists (select 1 from pg_trigger where tgrelid = 'public.event_costs'::regclass and tgname like 'zzzz_tl173%'))
) v(item, ok) order by item;
