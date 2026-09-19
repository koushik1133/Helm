-- ============================================================================
-- Phase 47 — Audit log (who changed what, when)
-- ---------------------------------------------------------------------------
-- A generic AFTER trigger captures inserts/updates/deletes on the high-value
-- tables (access matrix, pricing, money, resources, config) into audit_log,
-- stamping the actor from auth.uid(). Trigger-based so it catches EVERY change
-- path without touching existing RPCs. Reads are admin / Control-Center only.
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- 1) the log ------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor       uuid,
  actor_email text,
  action      text not null,   -- insert | update | delete
  entity      text not null,   -- table name
  entity_id   text,
  quote_id    uuid,            -- event scope, when the row has one
  changed     jsonb,           -- update: {field:[old,new]} ; insert/delete: row snapshot
  at          timestamptz not null default now()
);
create index if not exists audit_at_idx     on public.audit_log(at desc);
create index if not exists audit_entity_idx  on public.audit_log(entity, at desc);
create index if not exists audit_quote_idx   on public.audit_log(quote_id, at desc) where quote_id is not null;
create index if not exists audit_actor_idx   on public.audit_log(actor, at desc) where actor is not null;

-- 2) RLS: only admins / Control-Center viewers can read; no direct writes ------
alter table public.audit_log enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='audit_log'
  loop execute format('drop policy if exists %I on public.audit_log', p.policyname); end loop;
end $$;
create policy "audit read" on public.audit_log for select to authenticated
  using ( public.is_admin() or public.has_area('controls','view') );
-- writes happen only through the SECURITY DEFINER trigger below (no write policy)

-- 3) the generic capture trigger ---------------------------------------------
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_id text;
  v_quote uuid;
  v_changed jsonb;
  o jsonb; n jsonb;
begin
  if v_actor is not null then select email into v_email from auth.users where id = v_actor; end if;
  if tg_op = 'DELETE' then n := to_jsonb(OLD); else n := to_jsonb(NEW); end if;
  if tg_op = 'UPDATE' then o := to_jsonb(OLD); end if;

  v_id := coalesce(n->>'id', n->>'quote_id');
  if tg_table_name = 'quotes' then v_quote := (n->>'id')::uuid;
  elsif n ? 'quote_id' then v_quote := nullif(n->>'quote_id','')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(o->key, n->key))
      into v_changed
      from jsonb_object_keys(n) as key
      where (o->key) is distinct from (n->key)
        and key not in ('updated_at','confirmed_at');
    if v_changed is null then return null; end if;   -- nothing meaningful changed
  else
    v_changed := n;                                    -- insert / delete snapshot
  end if;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed)
    values (v_actor, v_email, lower(tg_op), tg_table_name, v_id, v_quote, v_changed);
  return null;
end $$;

-- 4) attach it to the tables worth auditing (config / money / access / resources)
do $$
declare t text;
  tbls text[] := array[
    'quotes','role_access','profiles','app_config','plate_types','chair_types','coupons',
    'vendors','crew_members','inventory_items','inventory_checkouts','event_costs',
    'quote_payments','change_requests','expense_claims','payment_milestones'
  ];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('drop trigger if exists audit_trg on public.%I', t);
    execute format('create trigger audit_trg after insert or update or delete on public.%I for each row execute function public.tg_audit()', t);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- verify
select 'audit_log rows' k, count(*)::text v from public.audit_log
union all select 'audit triggers', count(*)::text from pg_trigger where tgname='audit_trg';
