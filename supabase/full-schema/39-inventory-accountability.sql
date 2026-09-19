-- =========================================================================
-- Phase 33 — Cluster B: inventory accountability (the walkie-talkie problem)
--
-- WHAT
--   B1  Priority class A/B/C + unit cost on every stock item.
--       (A = expensive/critical e.g. walkie-talkies; C = cheap e.g. plastic chairs.)
--   B2  chair_types — a small catalog of chair options with per-type prices,
--       managed in the Control Center.
--   B3  inventory_checkouts — issue equipment to a person for an event (qty out,
--       who, when), then check it back in with a returned count + a sign-off. The
--       system computes what's MISSING so nothing walks off unaccounted for.
--       checkout_equipment() / checkin_equipment() stamp who did it. A write-off
--       option permanently reduces stock by the missing count.
--
-- RUN AFTER phase29 (uses has_area). Idempotent. No photos (per the meeting).
-- =========================================================================

-- B1) priority + unit cost on stock items ---------------------------------
alter table public.inventory_items add column if not exists priority  text not null default 'C';
alter table public.inventory_items drop constraint if exists inventory_items_priority_check;
alter table public.inventory_items add constraint inventory_items_priority_check check (priority in ('A','B','C'));
alter table public.inventory_items add column if not exists unit_cost numeric not null default 0;

-- B2) chair-types catalog (Control Center) --------------------------------
create table if not exists public.chair_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  price      numeric not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.chair_types (name, price) values
  ('Plastic chair', 450), ('Cushioned chair', 1000), ('Chiavari chair', 1500)
on conflict (name) do nothing;

alter table public.chair_types enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='chair_types'
  loop execute format('drop policy if exists %I on public.chair_types', p.policyname); end loop;
end $$;
-- prices aren't sensitive → any signed-in user may read; only Control-Center editors write
create policy "ct read"  on public.chair_types for select to authenticated using ( true );
create policy "ct write" on public.chair_types for all to authenticated
  using ( public.has_area('controls','edit') ) with check ( public.has_area('controls','edit') );

-- B3) check-out / check-in ledger -----------------------------------------
create table if not exists public.inventory_checkouts (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.inventory_items(id) on delete cascade,
  quote_id      uuid references public.quotes(id) on delete set null,   -- event it went out for
  qty_out       numeric not null check (qty_out > 0),
  issued_to     text not null,                                          -- crew / coordinator name
  issued_to_id  uuid references public.crew_members(id) on delete set null,
  issued_by     uuid references auth.users(id) default auth.uid(),      -- who logged it out
  checked_out_at timestamptz not null default now(),
  qty_in        numeric,                                                -- returned count (null until checked in)
  returned_by   text,                                                   -- who handed it back
  confirmed_by  uuid references auth.users(id),                         -- the staff member who signed off
  checked_in_at timestamptz,
  status        text not null default 'out' check (status in ('out','returned','partial')),
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists inv_chk_item_idx   on public.inventory_checkouts(item_id);
create index if not exists inv_chk_open_idx    on public.inventory_checkouts(status) where status in ('out','partial');
create index if not exists inv_chk_quote_idx   on public.inventory_checkouts(quote_id);

alter table public.inventory_checkouts enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='inventory_checkouts'
  loop execute format('drop policy if exists %I on public.inventory_checkouts', p.policyname); end loop;
end $$;
create policy "ck view" on public.inventory_checkouts for select to authenticated using ( public.has_area('inventory','view') );
create policy "ck ins"  on public.inventory_checkouts for insert to authenticated with check ( public.has_area('inventory','edit') );
create policy "ck upd"  on public.inventory_checkouts for update to authenticated using ( public.has_area('inventory','edit') ) with check ( public.has_area('inventory','edit') );
create policy "ck del"  on public.inventory_checkouts for delete to authenticated using ( public.has_area('inventory','edit') );

-- issue equipment out (stamps who logged it) ------------------------------
create or replace function public.checkout_equipment(
  p_item uuid, p_quote uuid, p_qty numeric, p_issued_to text, p_issued_to_id uuid, p_note text)
  returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if coalesce(p_qty,0) <= 0 then raise exception 'quantity must be > 0'; end if;
  if coalesce(btrim(p_issued_to),'') = '' then raise exception 'who is it issued to?'; end if;
  insert into public.inventory_checkouts (item_id, quote_id, qty_out, issued_to, issued_to_id, issued_by, note)
    values (p_item, p_quote, p_qty, btrim(p_issued_to), p_issued_to_id, auth.uid(), nullif(btrim(coalesce(p_note,'')),''))
  returning * into row;
  return row;
end; $$;
revoke all on function public.checkout_equipment(uuid,uuid,numeric,text,uuid,text) from anon;
grant execute on function public.checkout_equipment(uuid,uuid,numeric,text,uuid,text) to authenticated;

-- check equipment back in (records returned count + who signed off; computes missing) --
create or replace function public.checkin_equipment(
  p_id uuid, p_qty_in numeric, p_returned_by text, p_writeoff boolean default false)
  returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts; v_missing numeric;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into row from public.inventory_checkouts where id = p_id;
  if not found then raise exception 'checkout not found'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  v_missing := greatest(row.qty_out - coalesce(p_qty_in,0), 0);
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = nullif(btrim(coalesce(p_returned_by,'')),''),
         confirmed_by = auth.uid(),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= row.qty_out then 'returned' else 'partial' end
   where id = p_id
   returning * into row;
  -- optional: permanently reduce stock by whatever is missing (a real loss)
  if p_writeoff and v_missing > 0 then
    update public.inventory_items set total_qty = greatest(0, coalesce(total_qty,0) - v_missing) where id = row.item_id;
  end if;
  return row;
end; $$;
revoke all on function public.checkin_equipment(uuid,numeric,text,boolean) from anon;
grant execute on function public.checkin_equipment(uuid,numeric,text,boolean) to authenticated;

-- reload
notify pgrst, 'reload schema';
