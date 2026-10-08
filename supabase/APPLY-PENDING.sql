-- ════════════════════════════════════════════════════════════════════════════
-- HELM — EVERYTHING PENDING (one paste) — Supabase SQL Editor           (v15, 2026-10-07)
--   0049 DB gates (close balance/equipment gate, quotes write lockdown, clean matrix, timeouts, quotas)
--   0050 auth limits (server-side MFA lockout, durable edge rate limits)
--   0051 upload verification + quarantine
-- REQUIRES 0048 on this database. Each part has its own transaction + preflight.
-- SAFE TO RE-RUN. If a part fails, that part rolls back.
-- USE: SQL Editor → paste ALL → Run. The editor shows only the LAST result grid (0051 verify);
--      to see the 0049/0050 verify rows too, run APPLY-0049/0050/0051 separately.
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════ PART 0049 ═══════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0049 DB gates (one paste)                                           (2026-10-07)
--   * Closing an event is REFUSED while the client still owes money on the payment ledger
--     or equipment checkouts are still out; the error lists what is outstanding. A studio
--     admin can close anyway with a written reason — recorded in event_close_overrides +
--     audit_log.  >> Deploy closure.html + store-api.js v115 together with this. <<
--   * quotes: no direct INSERT from the API (DELETE stays Deleted-shelf-only as in 0042);
--     direct UPDATE only on title,
--     event_type, client, pricing, event_date, event_time, manager_id (everything else is
--     RPC-only). RLS is unchanged.
--   * NV-08: a NEW studio gets a clean default access matrix (not the template's).
--     Existing studios are not touched.
--   * statement_timeout anon 8s / authenticated 15s (only tightened, never loosened);
--     per-studio storage quota (default 2 GB) + 200 uploads / hour, configurable per plan
--     (helm_plans) or per studio (studio_subscriptions.storage_quota_bytes / uploads_per_hour).
-- REQUIRES 0042, 0045, 0048 — the preflight stops if not. STAGING first.
-- RUN AS the default SQL-editor role (postgres) — needed for ALTER ROLE; if not allowed,
--   that one step is skipped with a NOTICE and everything else still applies.
-- WHAT IT TOUCHES: close_event + create_studio wrapped (old bodies kept as *__pre0049),
--   1 new table, 2+2 new columns, new functions, 1 new RESTRICTIVE storage policy,
--   privileges on public.quotes. NO app row is changed or deleted. SAFE TO RE-RUN.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regprocedure('public.close_event__pre0042(uuid, boolean)') is null then raise exception 'STOP: 0042 not installed'; end if;
  if to_regclass('public.studio_subscriptions') is null then raise exception 'STOP: 0045 not installed'; end if;
  if to_regprocedure('public.storage_object_name_ok(text,text)') is null then raise exception 'STOP: 0048 not installed'; end if;
  raise notice 'Preflight OK — applying 0049…';
end $$;
-- ---- 0) keep this database's own bodies (rename once) --------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['close_event',   'uuid, boolean'],
    ['create_studio', 'text, text, text, text']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0049', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        raise exception '0049: public.%(%) is missing on this database', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0049');
    end if;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0049', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1] || '__pre0049', f[2]);
  end loop;
end $$;

-- ---- 1) CLOSE GATE -----------------------------------------------------------------
create table if not exists public.event_close_overrides (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete restrict,
  quote_id       uuid not null,
  actor          uuid,
  actor_email    text,
  reason         text not null check (length(btrim(reason)) between 5 and 1000),
  balance_owed   numeric not null default 0,
  open_checkouts integer not null default 0,
  blockers       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists event_close_overrides_quote_idx on public.event_close_overrides(org_id, quote_id);
alter table public.event_close_overrides enable row level security;
revoke all on public.event_close_overrides from public, anon, authenticated;
grant select on public.event_close_overrides to authenticated;
grant all on public.event_close_overrides to service_role;
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null then                  -- G4: row's studio = quote's studio
    drop trigger if exists zz_quote_org_match on public.event_close_overrides;
    create trigger zz_quote_org_match before insert or update on public.event_close_overrides
      for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null then                 -- 0045: suspended studio = read-only
    drop trigger if exists zzz_studio_read_only on public.event_close_overrides;
    create trigger zzz_studio_read_only before insert or update or delete on public.event_close_overrides
      for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;
drop policy if exists "a49 close overrides read" on public.event_close_overrides;
create policy "a49 close overrides read" on public.event_close_overrides for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('closure', 'view'));

-- what still blocks closing (ledger balance + open checkouts); no auth here — callers check
create or replace function public._a49_close_blockers(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_total numeric; v_paid numeric; v_owed numeric; v_items jsonb; v_n int;
begin
  select coalesce(nullif(q.pricing ->> 'total', '')::numeric, 0) into v_total
    from public.quotes q where q.id = p_quote;
  v_paid := coalesce(public.helm_total_paid(p_quote, null, null), 0);    -- ledger: paid quote_payments
  v_owed := greatest(coalesce(v_total, 0) - v_paid, 0);
  if v_owed <= 0.5 then v_owed := 0; end if;                              -- same tolerance as the overpayment guard
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item', coalesce(i.name, 'item'), 'qty', c.qty_out, 'issued_to', c.issued_to)
           order by c.checked_out_at), '[]'::jsonb)
    into v_n, v_items
    from public.inventory_checkouts c left join public.inventory_items i on i.id = c.item_id
   where c.quote_id = p_quote and c.status = 'out';
  return jsonb_build_object('total', coalesce(v_total, 0), 'paid', v_paid, 'balance_owed', v_owed,
                            'open_checkouts', v_n, 'checkouts', v_items,
                            'blocked', (v_owed > 0 or v_n > 0));
end $$;

create or replace function public._a49_blocker_text(b jsonb)
returns text language sql immutable set search_path = '' as $$
  select concat_ws('; ',
    case when (b ->> 'balance_owed')::numeric > 0
         then 'client balance still owed: ' || to_char((b ->> 'balance_owed')::numeric, 'FM999999999990.00') end,
    case when (b ->> 'open_checkouts')::int > 0
         then (b ->> 'open_checkouts') || ' equipment checkout(s) still out: '
              || (select string_agg(x ->> 'item' || ' x' || (x ->> 'qty'), ', ')
                    from (select x from jsonb_array_elements(b -> 'checkouts') x limit 8) s) end);
$$;

do $$ declare f text; begin
  foreach f in array array['_a49_close_blockers(uuid)', '_a49_blocker_text(jsonb)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- read-only: what would block closing this event (own studio, closure view)
create or replace function public.close_event_blockers(p_quote_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_area('closure', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  return public._a49_close_blockers(p_quote_id);
end $$;

-- the shared gate: lock the quote (serialises with payments), then check
create or replace function public._a49_close_gate(p_quote uuid, p_reason text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare b jsonb; v_org uuid := public.current_org_id(); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  perform 1 from public.quotes q where q.id = p_quote for update;
  b := public._a49_close_blockers(p_quote);
  if not (b ->> 'blocked')::boolean then return; end if;
  if v_reason is null then
    raise exception 'Can''t close this event yet — %.', public._a49_blocker_text(b)
      using errcode = 'P0001', detail = b::text,
            hint = 'Collect the balance / return the equipment, or an admin can close with an override reason.';
  end if;
  if coalesce(public.user_role(), '') <> 'admin' then
    raise exception 'Only an admin can close an event with something outstanding (%).', public._a49_blocker_text(b)
      using errcode = '42501';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 1000 then
    raise exception 'override reason must be 5 to 1000 characters' using errcode = '22023';
  end if;
  insert into public.event_close_overrides(org_id, quote_id, actor, actor_email, reason, balance_owed, open_checkouts, blockers)
    values (v_org, p_quote, auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), v_reason,
            (b ->> 'balance_owed')::numeric, (b ->> 'open_checkouts')::int, b);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'close_override', 'event_closure',
            p_quote::text, p_quote, jsonb_build_object('reason', v_reason, 'blockers', b), v_org);
end $$;
revoke all on function public._a49_close_gate(uuid, text) from public, anon, authenticated;
grant execute on function public._a49_close_gate(uuid, text) to service_role;

create or replace function public.close_event(p_quote_id uuid, p_closed boolean)
returns public.event_closure language plpgsql volatile security definer set search_path = '' as $$
-- a49: closing is refused while money is owed on the ledger or equipment is still out
begin
  if not public.has_area('closure', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_closed then perform public._a49_close_gate(p_quote_id, null); end if;
  return public.close_event__pre0049(p_quote_id, p_closed);
end $$;

-- admin override: same gate, but an admin may close with a recorded reason
create or replace function public.close_event(p_quote_id uuid, p_closed boolean, p_override_reason text)
returns public.event_closure language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('closure', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_closed then perform public._a49_close_gate(p_quote_id, p_override_reason); end if;
  return public.close_event__pre0049(p_quote_id, p_closed);
end $$;

revoke all on function public.close_event(uuid, boolean) from public, anon;
revoke all on function public.close_event(uuid, boolean, text) from public, anon;
revoke all on function public.close_event_blockers(uuid) from public, anon;
grant execute on function public.close_event(uuid, boolean) to authenticated, service_role;
grant execute on function public.close_event(uuid, boolean, text) to authenticated, service_role;
grant execute on function public.close_event_blockers(uuid) to authenticated, service_role;

-- ---- 2) QUOTES WRITE LOCKDOWN ------------------------------------------------------
-- (revoking table-level UPDATE also clears column grants; the allow-list is re-granted)
-- DELETE stays granted: it is already limited to the Deleted shelf by can_delete() roles
-- (0042 RESTRICTIVE policy) plus the 0026 paid-quote guard; the app itself only shelves.
revoke insert, update, truncate, references, trigger on public.quotes from public, anon, authenticated;
revoke delete on public.quotes from public, anon;
do $$ declare c text; begin
  foreach c in array array['title', 'event_type', 'client', 'pricing', 'event_date', 'event_time', 'manager_id'] loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'quotes' and column_name = c) then
      execute format('grant update (%I) on public.quotes to authenticated', c);
    else
      raise notice '0049: quotes.% not on this database — not granted', c;
    end if;
  end loop;
end $$;

-- ---- 3) NV-08: clean default matrix for a NEW studio -----------------------------
create or replace function public._a49_default_matrix()
returns table(role text, area text, can_view boolean, can_edit boolean)
language sql immutable set search_path = '' as $$
  with areas(area, v, e) as (values
    -- area,       roles that VIEW,                                                                    roles that EDIT
    ('leads',      '{manager,planner,sales,coordinator}'::text[],                                     '{manager,planner,sales}'::text[]),
    ('crm',        '{manager,planner,sales,coordinator}',                                             '{manager,planner,sales}'),
    ('nurture',    '{manager,planner}',                                                               '{manager,planner}'),
    ('discovery',  '{manager,planner}',                                                               '{manager,planner}'),
    ('proposal',   '{manager,planner}',                                                               '{manager,planner}'),
    ('quotes',     '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner}'),
    ('layouts',    '{manager,planner,coordinator,supervisor,operations,quality}',                     '{planner}'),
    ('design',     '{manager,planner}',                                                               '{manager,planner}'),
    ('staff',      '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,operations}'),
    ('inventory',  '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,operations}'),
    ('vendors',    '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,operations}'),
    ('calendar',   '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator}'),
    ('templates',  '{manager,planner,coordinator,operations,quality}',                                '{manager,planner,coordinator}'),
    ('resources',  '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,operations}'),
    ('runsheet',   '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator}'),
    ('plan',       '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator}'),
    ('logistics',  '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator}'),
    ('ready',      '{manager,planner,coordinator,supervisor,quality}',                                '{manager,planner,coordinator}'),
    ('finance',    '{manager,planner}',                                                               '{manager,planner}'),
    ('settlement', '{manager,planner}',                                                               '{manager,planner}'),
    ('closure',    '{manager,planner}',                                                               '{manager,planner}'),
    ('command',    '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,supervisor,quality}'),
    ('issues',     '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,supervisor,operations,quality}'),
    ('media',      '{manager,planner,coordinator,supervisor,operations,quality}',                     '{manager,planner,coordinator,supervisor}'),
    ('controls',   '{manager}',                                                                       '{manager}'),
    ('codes',      '{manager,planner}',                                                               '{manager,planner}'),
    ('users',      '{}',                                                                              '{}')),
  roles(role) as (values ('admin'), ('manager'), ('planner'), ('sales'), ('coordinator'), ('supervisor'),
                         ('quality'), ('operations'), ('crew'), ('worker'), ('client'))
  select r.role, a.area,
         r.role = 'admin' or r.role = any(a.v),
         r.role = 'admin' or (r.role = any(a.e) and r.role = any(a.v))      -- edit implies view
    from roles r cross join areas a;
$$;
revoke all on function public._a49_default_matrix() from public, anon, authenticated;
grant execute on function public._a49_default_matrix() to service_role;

-- set (never delete) the matrix of one studio to the defaults; rows outside the defaults
-- are switched off for non-admins
create or replace function public._a49_seed_clean_matrix(p_org uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select p_org, d.role, d.area, d.can_view, d.can_edit, now() from public._a49_default_matrix() d
  on conflict (org_id, role, area) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now();
  get diagnostics n = row_count;
  update public.role_access ra set can_view = (ra.role = 'admin'), can_edit = (ra.role = 'admin'), updated_at = now()
   where ra.org_id = p_org
     and not exists (select 1 from public._a49_default_matrix() d where d.role = ra.role and d.area = ra.area)
     and (ra.can_view is distinct from (ra.role = 'admin') or ra.can_edit is distinct from (ra.role = 'admin'));
  return n;
end $$;
revoke all on function public._a49_seed_clean_matrix(uuid) from public, anon, authenticated;
grant execute on function public._a49_seed_clean_matrix(uuid) to service_role;

create or replace function public.create_studio(p_name text, p_email text default null,
                                                p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- a49 (NV-08): a NEW studio gets the clean default access matrix, not the template's
declare v_had uuid; v_org uuid;
begin
  select p.org_id into v_had from public.profiles p where p.id = auth.uid();
  v_org := public.create_studio__pre0049(p_name, p_email, p_currency, p_timezone);
  if v_had is null and v_org is not null then
    perform public._a49_seed_clean_matrix(v_org);
  end if;
  return v_org;
end $$;
revoke all on function public.create_studio(text, text, text, text) from public, anon;
grant execute on function public.create_studio(text, text, text, text) to authenticated, service_role;

-- ---- 4a) statement timeouts (tighten only; needs the postgres role) ----------------
do $$ declare r text[]; v_cur text; v_ms bigint; v_target bigint; m text[]; begin
  foreach r slice 1 in array array[['anon', '8000'], ['authenticated', '15000']] loop
    v_target := r[2]::bigint;
    select substring(s from '^statement_timeout=(.*)$') into v_cur
      from pg_db_role_setting d join pg_roles ro on ro.oid = d.setrole, unnest(d.setconfig) s
     where ro.rolname = r[1] and d.setdatabase = 0 and s like 'statement_timeout=%';
    v_ms := null;
    if v_cur is not null then
      m := regexp_match(btrim(v_cur, ' '''), '^([0-9]+)\s*(ms|s|min|h)?$');
      if m is not null then
        v_ms := m[1]::bigint * case coalesce(m[2], 'ms') when 'ms' then 1 when 's' then 1000 when 'min' then 60000 else 3600000 end;
      end if;
    end if;
    if v_cur is not null and (v_ms is null or (v_ms > 0 and v_ms <= v_target)) then
      raise notice '0049: % statement_timeout already % — kept (never loosened)', r[1], v_cur; continue;
    end if;
    begin
      execute format('alter role %I set statement_timeout = %L', r[1], (v_target / 1000)::text || 's');
    exception when insufficient_privilege or undefined_object then
      raise notice '0049: could not set % statement_timeout (%): run as the postgres role', r[1], sqlerrm;
    end;
  end loop;
end $$;

-- ---- 4b) per-studio storage quota + uploads per hour ---------------------------
alter table public.helm_plans           add column if not exists storage_quota_bytes bigint;
alter table public.helm_plans           add column if not exists uploads_per_hour integer;
alter table public.studio_subscriptions add column if not exists storage_quota_bytes bigint;
alter table public.studio_subscriptions add column if not exists uploads_per_hour integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'helm_plans_a49_limits_chk') then
    alter table public.helm_plans add constraint helm_plans_a49_limits_chk
      check ((storage_quota_bytes is null or storage_quota_bytes >= 0) and (uploads_per_hour is null or uploads_per_hour >= 0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'studio_subscriptions_a49_limits_chk') then
    alter table public.studio_subscriptions add constraint studio_subscriptions_a49_limits_chk
      check ((storage_quota_bytes is null or storage_quota_bytes >= 0) and (uploads_per_hour is null or uploads_per_hour >= 0));
  end if;
end $$;

-- effective limits: studio override → plan → default (2 GB, 200 uploads / hour)
create or replace function public.studio_upload_limits(p_org uuid)
returns table(storage_quota_bytes bigint, uploads_per_hour integer)
language sql stable security definer set search_path = '' as $$
  select coalesce(s.storage_quota_bytes, p.storage_quota_bytes, 2147483648::bigint),
         coalesce(s.uploads_per_hour, p.uploads_per_hour, 200)
    from (select 1) one
    left join public.studio_subscriptions s on s.org_id = p_org
    left join public.helm_plans p on p.id = s.plan_id;
$$;
revoke all on function public.studio_upload_limits(uuid) from public, anon, authenticated;
grant execute on function public.studio_upload_limits(uuid) to service_role;

create or replace function public.storage_quota_ok(p_bucket text, p_name text, p_metadata jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_org text := split_part(coalesce(p_name, ''), '/', 1); v_quota bigint; v_rate int;
        v_used bigint; v_new bigint := 0; v_n int;
begin
  if v_org !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  select l.storage_quota_bytes, l.uploads_per_hour into v_quota, v_rate from public.studio_upload_limits(v_org::uuid) l;
  if coalesce(p_metadata ->> 'size', '') ~ '^[0-9]{1,15}$' then v_new := (p_metadata ->> 'size')::bigint; end if;
  select coalesce(sum(case when coalesce(o.metadata ->> 'size', '') ~ '^[0-9]{1,15}$' then (o.metadata ->> 'size')::bigint else 0 end), 0),
         count(*) filter (where o.created_at > now() - interval '1 hour')
    into v_used, v_n
    from storage.objects o
   where o.bucket_id in ('invite-media', 'event-docs', 'chat-media', 'task-proof', 'member-avatars')
     and o.name like v_org || '/%';
  if v_used + v_new > v_quota then
    raise exception 'Your studio''s storage is full (% MB of % MB used). Delete old files or ask Helm to raise the limit.',
      round(v_used / 1048576.0), round(v_quota / 1048576.0) using errcode = '53400';
  end if;
  if v_n >= v_rate then
    raise exception 'Too many uploads from your studio in the last hour (limit %). Try again later.', v_rate
      using errcode = '53400';
  end if;
  return true;
end $$;
revoke all on function public.storage_quota_ok(text, text, jsonb) from public;
grant execute on function public.storage_quota_ok(text, text, jsonb) to anon, authenticated, service_role;

drop policy if exists upload_quota_insert on storage.objects;
create policy upload_quota_insert on storage.objects as restrictive for insert to anon, authenticated
  with check ( public.storage_quota_ok(bucket_id, name, metadata) );

notify pgrst, 'reload schema';

-- VERIFY — every row must say ok = true
select item, ok from (values
  ('close_event wrapped once (old body kept)',
     to_regprocedure('public.close_event__pre0049(uuid, boolean)') is not null
     and pg_get_functiondef('public.close_event(uuid,boolean)'::regprocedure) like '%_a49_close_gate%'),
  ('admin override entry point exists',
     to_regprocedure('public.close_event(uuid, boolean, text)') is not null
     and has_function_privilege('authenticated', 'public.close_event(uuid,boolean,text)', 'execute')
     and not has_function_privilege('anon', 'public.close_event(uuid,boolean,text)', 'execute')),
  ('close gate uses the ledger (helm_total_paid), not milestones',
     pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure) like '%helm_total_paid%'
     and pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure) not like '%payment_milestones%'),
  ('override log: RLS on, API cannot write',
     (select relrowsecurity from pg_class where oid = 'public.event_close_overrides'::regclass)
     and not has_table_privilege('authenticated', 'public.event_close_overrides', 'INSERT')),
  ('quotes: no direct INSERT/DELETE/table UPDATE for API roles',
     not has_table_privilege('authenticated', 'public.quotes', 'INSERT')
     and not has_table_privilege('anon', 'public.quotes', 'DELETE')
     and not has_table_privilege('authenticated', 'public.quotes', 'UPDATE')
     and not has_table_privilege('anon', 'public.quotes', 'UPDATE')),
  ('quotes: app columns still updatable, status/lifecycle not',
     has_column_privilege('authenticated', 'public.quotes', 'pricing', 'UPDATE')
     and has_column_privilege('authenticated', 'public.quotes', 'manager_id', 'UPDATE')
     and not has_column_privilege('authenticated', 'public.quotes', 'status', 'UPDATE')
     and not has_column_privilege('authenticated', 'public.quotes', 'lifecycle_stage', 'UPDATE')),
  ('create_studio wrapped with the clean matrix seed',
     to_regprocedure('public.create_studio__pre0049(text,text,text,text)') is not null
     and pg_get_functiondef('public.create_studio(text,text,text,text)'::regprocedure) like '%_a49_seed_clean_matrix%'),
  ('statement_timeout set for anon and authenticated',
     (select count(*) from pg_db_role_setting d join pg_roles r on r.oid = d.setrole, unnest(d.setconfig) s
       where r.rolname in ('anon', 'authenticated') and d.setdatabase = 0 and s like 'statement_timeout=%') = 2),
  ('upload quota policy is RESTRICTIVE',
     exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
              and policyname = 'upload_quota_insert' and permissive = 'RESTRICTIVE')),
  ('default limits 2 GB / 200 per hour',
     (select storage_quota_bytes = 2147483648 and uploads_per_hour = 200
        from public.studio_upload_limits('00000000-0000-0000-0000-000000000000')))
) v(item, ok);
-- informational: current role timeouts
select r.rolname, s from pg_db_role_setting d join pg_roles r on r.oid = d.setrole, unnest(d.setconfig) s
 where r.rolname in ('anon', 'authenticated') and s like 'statement_timeout=%';

-- ═══════════════════════════════ PART 0050 ═══════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0050 server-side two-step lockout + durable Edge rate limits (one paste)  (2026-10-07)
--   * 5 wrong two-step codes → that account's code entry is locked for 15 minutes,
--     counted on the SERVER (was: per-browser localStorage). Locks are audited.
--   * rate_hit(bucket, key, window_s, max) — durable counter for Edge Functions
--     (service role only).
-- REQUIRES the base audit_log table. Independent of 0049 (apply in either order).
-- WHAT IT TOUCHES: 2 new private tables, 5 new functions. NO existing row, table or
--   function is changed or deleted. SAFE TO RE-RUN. STAGING first, then PROD.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regclass('public.audit_log') is null then raise exception 'STOP: public.audit_log missing'; end if;
  raise notice 'Preflight OK — applying 0050…';
end $$;

-- Additive + idempotent: 2 new private tables, 5 new functions. No existing row,
-- table or function is changed or deleted.
-- ============================================================================

-- ---- 1. durable rate-limit counters -------------------------------------------------
create table if not exists public.auth_rate_hits (
  bucket       text        not null,
  key          text        not null,
  window_start timestamptz not null default now(),
  n            integer     not null default 0,
  primary key (bucket, key)
);
alter table public.auth_rate_hits enable row level security;
revoke all on table public.auth_rate_hits from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.auth_rate_hits from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.auth_rate_hits from authenticated; end if;
end $$;

create or replace function public.rate_hit(p_bucket text, p_key text, p_window_s integer, p_max integer)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_n integer; v_start timestamptz; v_win interval;
begin
  if p_bucket is null or p_bucket !~ '^[a-z0-9_.:-]{1,64}$' then raise exception 'rate_hit: bad bucket' using errcode = '22023'; end if;
  if p_key is null or length(p_key) < 1 or length(p_key) > 128 then raise exception 'rate_hit: bad key' using errcode = '22023'; end if;
  if p_window_s is null or p_window_s < 1 or p_window_s > 86400 then raise exception 'rate_hit: bad window' using errcode = '22023'; end if;
  if p_max is null or p_max < 1 or p_max > 1000000 then raise exception 'rate_hit: bad max' using errcode = '22023'; end if;
  v_win := make_interval(secs => p_window_s);
  insert into public.auth_rate_hits as h (bucket, key, window_start, n)
    values (p_bucket, p_key, now(), 1)
  on conflict (bucket, key) do update set
    n            = case when h.window_start <= now() - v_win then 1 else h.n + 1 end,
    window_start = case when h.window_start <= now() - v_win then now() else h.window_start end
  returning h.n, h.window_start into v_n, v_start;
  if v_n > p_max then
    return greatest(1, ceil(extract(epoch from (v_start + v_win - now())))::integer);
  end if;
  return 0;
end $$;
revoke all on function public.rate_hit(text, text, integer, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.rate_hit(text, text, integer, integer) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.rate_hit(text, text, integer, integer) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.rate_hit(text, text, integer, integer) to service_role; end if;
end $$;

-- ---- 2. server-side MFA wrong-code lockout -----------------------------------------
create table if not exists public.auth_mfa_attempts (
  user_id      uuid        primary key,
  fails        integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.auth_mfa_attempts enable row level security;
revoke all on table public.auth_mfa_attempts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.auth_mfa_attempts from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.auth_mfa_attempts from authenticated; end if;
end $$;

-- policy constants in one place (5 wrong codes → 15 minutes; counter window 15 minutes)
create or replace function public._mfa_lock_policy()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('max_fails', 5, 'lock_s', 900, 'window_s', 900);
$$;
revoke all on function public._mfa_lock_policy() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._mfa_lock_policy() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._mfa_lock_policy() from authenticated; end if;
end $$;

create or replace function public.mfa_lock_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); r public.auth_mfa_attempts; p jsonb := public._mfa_lock_policy();
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into r from public.auth_mfa_attempts where user_id = v_uid;
  if not found then return jsonb_build_object('locked', false, 'retry_after', 0, 'fails', 0); end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('locked', true, 'retry_after', greatest(1, ceil(extract(epoch from (r.locked_until - now())))::integer), 'fails', r.fails);
  end if;
  if r.window_start <= now() - make_interval(secs => (p->>'window_s')::int) or r.locked_until is not null then
    return jsonb_build_object('locked', false, 'retry_after', 0, 'fails', 0);
  end if;
  return jsonb_build_object('locked', false, 'retry_after', 0, 'fails', r.fails);
end $$;

create or replace function public.mfa_record_failure()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); r public.auth_mfa_attempts; p jsonb := public._mfa_lock_policy();
        v_rl integer; v_max int := (p->>'max_fails')::int;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  -- the recorder itself is rate-limited (a script can't churn the row / audit log)
  v_rl := public.rate_hit('mfa.record', v_uid::text, 600, 30);
  if v_rl > 0 then
    return jsonb_build_object('locked', true, 'retry_after', v_rl, 'fails', v_max);
  end if;
  insert into public.auth_mfa_attempts(user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into r from public.auth_mfa_attempts where user_id = v_uid for update;
  -- already locked: count nothing more, report the remaining time
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('locked', true, 'retry_after', greatest(1, ceil(extract(epoch from (r.locked_until - now())))::integer), 'fails', r.fails);
  end if;
  -- an expired lock or an old window starts a fresh count
  if r.locked_until is not null or r.window_start <= now() - make_interval(secs => (p->>'window_s')::int) then
    r.fails := 0; r.window_start := now(); r.locked_until := null;
  end if;
  r.fails := r.fails + 1;
  if r.fails >= v_max then
    r.locked_until := now() + make_interval(secs => (p->>'lock_s')::int);
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, (select u.email from auth.users u where u.id = v_uid), 'auth.mfa.locked', 'auth_mfa_attempts', v_uid::text,
              jsonb_build_object('fails', r.fails, 'locked_until', r.locked_until), null, now());
  end if;
  update public.auth_mfa_attempts
     set fails = r.fails, window_start = r.window_start, locked_until = r.locked_until, updated_at = now()
   where user_id = v_uid;
  return jsonb_build_object('locked', r.locked_until is not null,
    'retry_after', case when r.locked_until is null then 0 else greatest(1, ceil(extract(epoch from (r.locked_until - now())))::integer) end,
    'fails', r.fails);
end $$;

create or replace function public.mfa_record_success()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_had integer;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  -- only a session that has really passed the code may clear the counter
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then return false; end if;
  update public.auth_mfa_attempts set fails = 0, locked_until = null, window_start = now(), updated_at = now()
   where user_id = v_uid and (fails > 0 or locked_until is not null)
  returning 1 into v_had;
  if v_had is not null then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, (select u.email from auth.users u where u.id = v_uid), 'auth.mfa.counter_cleared', 'auth_mfa_attempts', v_uid::text,
              jsonb_build_object('by', 'successful_code'), null, now());
  end if;
  return true;
end $$;

do $$ declare f text; begin
  foreach f in array array['public.mfa_lock_status()', 'public.mfa_record_failure()', 'public.mfa_record_success()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- VERIFY — every row must say ok = true
select item, ok from (values
  ('tables are private (RLS on, no anon / authenticated access)',
     (select relrowsecurity from pg_class where oid = 'public.auth_rate_hits'::regclass)
     and (select relrowsecurity from pg_class where oid = 'public.auth_mfa_attempts'::regclass)
     and not has_table_privilege('authenticated', 'public.auth_rate_hits', 'select')
     and not has_table_privilege('authenticated', 'public.auth_mfa_attempts', 'select')
     and not has_table_privilege('anon', 'public.auth_mfa_attempts', 'select')),
  ('rate_hit is service-role only',
     has_function_privilege('service_role', 'public.rate_hit(text,text,integer,integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.rate_hit(text,text,integer,integer)', 'execute')
     and not has_function_privilege('anon', 'public.rate_hit(text,text,integer,integer)', 'execute')),
  ('MFA lockout RPCs: signed-in users only',
     has_function_privilege('authenticated', 'public.mfa_record_failure()', 'execute')
     and has_function_privilege('authenticated', 'public.mfa_lock_status()', 'execute')
     and has_function_privilege('authenticated', 'public.mfa_record_success()', 'execute')
     and not has_function_privilege('anon', 'public.mfa_record_failure()', 'execute')
     and not has_function_privilege('anon', 'public.mfa_lock_status()', 'execute'))
) v(item, ok);

-- ═══════════════════════════════ PART 0051 ═══════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0051 upload verification + quarantine (one paste)                  (2026-10-07)
--   * Every new upload in event-docs / chat-media / invite-media / task-proof is recorded as
--     "pending" until the verify-upload Edge Function checks its bytes (and optional antivirus)
--     and marks it clean or rejected. Files that exist today are grandfathered as clean.
--   * A rejected file is hidden from everyone (and moved to the private upload-quarantine bucket
--     by the function). An audit row 'upload.rejected' is written.
--   * DORMANT: pending files stay readable exactly as today until YOU deploy verify-upload and run
--       update public.upload_scan_config set enforce = true, updated_at = now();
--     Only then are pending files hidden from everyone but the uploader.
--     Turn it off again any time with  ... set enforce = false.
-- REQUIRES 0048 — the preflight stops if not. STAGING first, then PROD.
-- WHAT IT TOUCHES: 2 new tables (RLS on, no client access), new functions, 1 AFTER trigger on
--   storage.objects, 1 RESTRICTIVE select policy on storage.objects, 1 config row, 1 private
--   bucket. NO existing object, app row or policy is changed or deleted.
-- SAFE TO RE-RUN. If anything fails, it rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regprocedure('public.storage_object_name_ok(text,text)') is null then raise exception 'STOP: 0048 not installed'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP: current_org_id() missing'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP: audit_log missing'; end if;
  raise notice 'Preflight OK — applying 0051…';
end $$;
-- ---- tables ---------------------------------------------------------------------------
create table if not exists public.upload_scans (
  object_id  uuid primary key,
  bucket_id  text not null,
  name       text not null,
  org_id     uuid,
  owner_id   uuid,
  status     text not null default 'pending' check (status in ('pending', 'clean', 'rejected')),
  reason     text check (reason is null or length(reason) <= 200),
  size_bytes bigint,
  attempts   int not null default 0,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  scanned_at timestamptz
);
create index if not exists upload_scans_pending_idx on public.upload_scans (created_at) where status = 'pending';
create index if not exists upload_scans_bucket_name_idx on public.upload_scans (bucket_id, name);
alter table public.upload_scans enable row level security;
revoke all on table public.upload_scans from public, anon, authenticated;

create table if not exists public.upload_scan_config (
  id         boolean primary key default true check (id),
  enforce    boolean not null default false,     -- OWNER FLIPS to true after deploying verify-upload
  updated_at timestamptz not null default now()
);
insert into public.upload_scan_config (id, enforce) values (true, false) on conflict (id) do nothing;
alter table public.upload_scan_config enable row level security;
revoke all on table public.upload_scan_config from public, anon, authenticated;

-- ---- helpers ----------------------------------------------------------------------------
create or replace function public.upload_scan_bucket(p_bucket text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_bucket in ('event-docs', 'chat-media', 'invite-media', 'task-proof'), false);
$$;
revoke all on function public.upload_scan_bucket(text) from public;
grant execute on function public.upload_scan_bucket(text) to anon, authenticated, service_role;

create or replace function public.upload_scan_enforced()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select c.enforce from public.upload_scan_config c where c.id), false);
$$;
revoke all on function public.upload_scan_enforced() from public;
grant execute on function public.upload_scan_enforced() to anon, authenticated, service_role;

-- first path folder as a studio id (null when it isn't a uuid)
create or replace function public.upload_scan_org(p_name text)
returns uuid language sql immutable set search_path = '' as $$
  select case when split_part(coalesce(p_name, ''), '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then split_part(p_name, '/', 1)::uuid end;
$$;
revoke all on function public.upload_scan_org(text) from public;
grant execute on function public.upload_scan_org(text) to anon, authenticated, service_role;

-- storage.objects carries owner (uuid, legacy) and/or owner_id (text) depending on version
create or replace function public.upload_scan_owner(p_row jsonb)
returns uuid language plpgsql immutable set search_path = '' as $$
declare v text := coalesce(nullif(p_row ->> 'owner_id', ''), nullif(p_row ->> 'owner', ''));
begin
  if v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return v::uuid; end if;
  return null;
end $$;
revoke all on function public.upload_scan_owner(jsonb) from public, anon, authenticated;

-- RLS gate (restrictive): may the CURRENT caller see this object?
create or replace function public.upload_scan_read_ok(p_id uuid, p_bucket text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare s record;
begin
  if not public.upload_scan_bucket(p_bucket) then return true; end if;
  select us.status, us.owner_id into s from public.upload_scans us where us.object_id = p_id;
  if not found then
    -- no row: only possible if the trigger was bypassed; fail closed when enforcing
    return not public.upload_scan_enforced();
  end if;
  if s.status = 'clean' then return true; end if;
  if s.status = 'rejected' then return false; end if;                 -- always hidden
  -- pending
  if not public.upload_scan_enforced() then return true; end if;     -- dormant: unchanged behaviour
  return s.owner_id is not null and s.owner_id = auth.uid();          -- uploader only
end $$;
revoke all on function public.upload_scan_read_ok(uuid, text) from public;
grant execute on function public.upload_scan_read_ok(uuid, text) to anon, authenticated;

-- ---- trigger: every new / rewritten object in a scanned bucket → pending -----------------
create or replace function public._tg_upload_scan_record()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not public.upload_scan_bucket(new.bucket_id) then return null; end if;
  if tg_op = 'INSERT' then
    insert into public.upload_scans (object_id, bucket_id, name, org_id, owner_id, status)
    values (new.id, new.bucket_id, new.name, public.upload_scan_org(new.name),
            public.upload_scan_owner(to_jsonb(new)), 'pending')
    on conflict (object_id) do update
      set bucket_id = excluded.bucket_id, name = excluded.name, org_id = excluded.org_id,
          status = 'pending', reason = null, scanned_at = null, attempts = 0, claimed_at = null;
  elsif (to_jsonb(new) - 'last_accessed_at') is distinct from (to_jsonb(old) - 'last_accessed_at') then
    -- content / path rewritten in place (upsert, move within a scanned bucket) → re-scan
    insert into public.upload_scans (object_id, bucket_id, name, org_id, owner_id, status)
    values (new.id, new.bucket_id, new.name, public.upload_scan_org(new.name),
            public.upload_scan_owner(to_jsonb(new)), 'pending')
    on conflict (object_id) do update
      set bucket_id = excluded.bucket_id, name = excluded.name, org_id = excluded.org_id,
          status = case when public.upload_scans.status = 'rejected' then 'rejected' else 'pending' end,
          scanned_at = case when public.upload_scans.status = 'rejected' then public.upload_scans.scanned_at end,
          attempts = 0, claimed_at = null;
  end if;
  return null;
end $$;
revoke all on function public._tg_upload_scan_record() from public, anon, authenticated;
drop trigger if exists zz_upload_scan_record on storage.objects;
create trigger zz_upload_scan_record after insert or update on storage.objects
  for each row execute function public._tg_upload_scan_record();

-- ---- grandfather: objects that exist now are treated as clean ----------------------------
insert into public.upload_scans (object_id, bucket_id, name, org_id, owner_id, status, reason, scanned_at)
select o.id, o.bucket_id, o.name, public.upload_scan_org(o.name), public.upload_scan_owner(to_jsonb(o)),
       'clean', 'grandfathered', now()
  from storage.objects o
 where public.upload_scan_bucket(o.bucket_id)
on conflict (object_id) do nothing;

-- ---- restrictive read policy -------------------------------------------------------------
drop policy if exists upload_scan_read_gate on storage.objects;
create policy upload_scan_read_gate on storage.objects as restrictive for select to anon, authenticated
  using ( public.upload_scan_read_ok(id, bucket_id) );

-- ---- member read of scan status (own studio / own uploads only) ---------------------------
create or replace function public.upload_scan_status(p_bucket text, p_names text[])
returns table (name text, status text) language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or not public.upload_scan_bucket(p_bucket) or p_names is null
     or coalesce(array_length(p_names, 1), 0) > 200 then return; end if;
  return query
    select us.name, us.status from public.upload_scans us
     where us.bucket_id = p_bucket and us.name = any(p_names)
       and ((v_org is not null and us.org_id = v_org) or us.owner_id = auth.uid());
end $$;
revoke all on function public.upload_scan_status(text, text[]) from public;
grant execute on function public.upload_scan_status(text, text[]) to authenticated;

-- ---- scanner RPCs (service_role ONLY) -----------------------------------------------------
create or replace function public.upload_scan_claim(p_limit int default 20)
returns table (object_id uuid, bucket_id text, name text, mimetype text, size_bytes bigint, attempts int)
language plpgsql volatile security definer set search_path = '' as $$
begin
  return query
  with c as (
    select us.object_id from public.upload_scans us
     where us.status = 'pending' and us.attempts < 10
       and (us.claimed_at is null or us.claimed_at < now() - interval '5 minutes')
     order by us.created_at
     limit greatest(1, least(coalesce(p_limit, 20), 100))
     for update skip locked
  ), u as (
    update public.upload_scans us set claimed_at = now(), attempts = us.attempts + 1
      from c where us.object_id = c.object_id
    returning us.object_id, us.bucket_id, us.name, us.attempts
  )
  select u.object_id, u.bucket_id, u.name,
         (o.metadata ->> 'mimetype')::text, nullif(o.metadata ->> 'size', '')::bigint, u.attempts
    from u left join storage.objects o on o.id = u.object_id;
end $$;
revoke all on function public.upload_scan_claim(int) from public, anon, authenticated;

create or replace function public.upload_scan_mark(p_object uuid, p_status text, p_reason text, p_size bigint default null)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare r record;
begin
  if p_status not in ('clean', 'rejected', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  select * into r from public.upload_scans where object_id = p_object for update;
  if not found then return 'missing'; end if;
  if r.status <> 'pending' then return r.status; end if;            -- idempotent: never flips a decided row
  if p_status = 'retry' then
    update public.upload_scans set claimed_at = null, reason = left(p_reason, 200) where object_id = p_object;
    return 'pending';
  end if;
  update public.upload_scans
     set status = p_status, reason = left(p_reason, 200), size_bytes = coalesce(p_size, size_bytes),
         scanned_at = now(), claimed_at = null
   where object_id = p_object;
  if p_status = 'rejected' then
    insert into public.audit_log (actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (null, null, 'upload.rejected', 'storage.objects', p_object::text,
            jsonb_build_object('bucket', r.bucket_id, 'name', r.name, 'reason', left(p_reason, 200), 'owner', r.owner_id),
            r.org_id, now());
  end if;
  return p_status;
end $$;
revoke all on function public.upload_scan_mark(uuid, text, text, bigint) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.upload_scan_claim(int) to service_role;
    grant execute on function public.upload_scan_mark(uuid, text, text, bigint) to service_role;
    grant select on table public.upload_scans to service_role;
  end if;
end $$;

-- ---- quarantine bucket (private; no client policy → no client access) ---------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('upload-quarantine', 'upload-quarantine', false, 20971520, null)
on conflict (id) do nothing;
update storage.buckets set public = false where id = 'upload-quarantine' and public is distinct from false;


-- VERIFY — every row must say ok = true
select item, ok from (values
  ('read gate policy exists and is RESTRICTIVE',
     exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'upload_scan_read_gate' and permissive = 'RESTRICTIVE')),
  ('record trigger on storage.objects',
     exists (select 1 from pg_trigger where tgname = 'zz_upload_scan_record' and tgrelid = 'storage.objects'::regclass)),
  ('every existing object in a scanned bucket has a scan row',
     not exists (select 1 from storage.objects o where public.upload_scan_bucket(o.bucket_id)
                   and not exists (select 1 from public.upload_scans s where s.object_id = o.id))),
  ('clients have no table access',
     not has_table_privilege('authenticated', 'public.upload_scans', 'select')
     and not has_table_privilege('anon', 'public.upload_scan_config', 'select')),
  ('scanner RPCs not callable by clients',
     not has_function_privilege('authenticated', 'public.upload_scan_claim(int)', 'execute')
     and not has_function_privilege('anon', 'public.upload_scan_mark(uuid,text,text,bigint)', 'execute')),
  ('quarantine bucket private', exists (select 1 from storage.buckets where id = 'upload-quarantine' and public = false))
) v(item, ok);
-- informational: enforce stays false until you deploy verify-upload and flip it
select enforce from public.upload_scan_config;
select status, count(*) from public.upload_scans group by 1 order by 1;
