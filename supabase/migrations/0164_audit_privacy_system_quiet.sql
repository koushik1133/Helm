-- 0164_audit_privacy_system_quiet.sql
-- Audit log privacy + no notifications for direct database (system) changes.
--   1  public._is_system_change(): true when a change is made straight in the database
--      (SQL editor, Table Editor, migration, psql as postgres): no signed-in user, no API
--      request claims (so anon client links and service_role edge functions are NOT system),
--      and not a pg_cron job (scheduled reminders keep working). Override per session/txn:
--      set_config('helm.maintenance','on',true) forces quiet, 'off' forces normal.
--   2  notifications: a BEFORE INSERT trigger drops the bell row for a system change, so the
--      bell and the WhatsApp forwarder (AFTER INSERT) never see it.
--   3  every outbox (pkg / comms / security alert / invite / welcome / assignment): a BEFORE
--      INSERT trigger keeps the row but stores it as status 'skipped' (senders only claim
--      'pending'), same pattern as the demo skip in 0097. Nothing is sent.
--   4  tg_audit: still records EVERY change (compliance), but a system change is tagged
--      actor_email 'helm:maintenance' (UI shows "System maintenance"), and link secrets
--      (approval/share/portal/worker tokens, hashes) are stored as '[redacted]' instead of
--      the raw value. Existing audit rows are NOT touched.
-- Real user actions behave exactly as before. Additive + idempotent: new functions, create or
-- replace of tg_audit (guarded by its known marker), triggers created only if missing.
-- No table, column or existing row is changed or removed. Safe to run twice. Needs 0148.

create or replace function public._is_system_change()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- sys-quiet-0164
declare v_flag text := coalesce(current_setting('helm.maintenance', true), '');
begin
  if v_flag = 'on' then return true; end if;
  if v_flag = 'off' then return false; end if;
  if auth.uid() is not null then return false; end if;
  -- any API request (signed-in, anon client link, service_role edge function) carries claims
  if coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}') <> '{}' then return false; end if;
  if nullif(current_setting('request.jwt.claim.role', true), '') is not null then return false; end if;
  if coalesce(current_setting('application_name', true), '') = 'pg_cron' then return false; end if;
  return true;
end $$;

-- 2) bell: no notification row for a system change
create or replace function public._sq164_tg_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
-- sys-quiet-0164
begin
  if public._is_system_change() then return null; end if;
  return NEW;
end $$;
do $$ begin
  if to_regclass('public.notifications') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.notifications'::regclass and tgname = 'a_sq164_system_quiet') then
    execute 'create trigger a_sq164_system_quiet before insert on public.notifications for each row execute function public._sq164_tg_notification()';
  end if;
end $$;

-- 3) outboxes: kept as 'skipped' for a system change (nothing is sent)
create or replace function public._sq164_tg_outbox()
returns trigger language plpgsql security definer set search_path = '' as $$
-- sys-quiet-0164
begin
  if public._is_system_change() and coalesce(NEW.status, 'pending') = 'pending' then NEW.status := 'skipped'; end if;
  return NEW;
end $$;
do $$ declare t text; begin
  foreach t in array array['pkg_outbox','comms_outbox','security_alert_outbox','invite_email_outbox','welcome_email_outbox','assign_notify_outbox'] loop
    if to_regclass('public.' || t) is not null
       and exists (select 1 from pg_attribute where attrelid = format('public.%I', t)::regclass and attname = 'status' and not attisdropped)
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzz_sq164_system_skip') then
      execute format('create trigger zzz_sq164_system_skip before insert on public.%I for each row execute function public._sq164_tg_outbox()', t);
    end if;
  end loop;
end $$;

-- 4) audit: secrets redacted, system changes tagged
create or replace function public._audit_redact(p jsonb, p_diff boolean)
returns jsonb language sql immutable set search_path = '' as $$
-- sys-quiet-0164: link secrets never stored raw in audit_log (only that they changed)
  select case when p is null or jsonb_typeof(p) <> 'object' then p else
    coalesce((select jsonb_object_agg(e.key,
        case when e.key in ('approval_token','share_token','portal_token','token','worker_token','access_token',
                            'refresh_token','secret','otp_hash','code_hash','pin_hash','password_hash','token_hash')
             then case when p_diff and jsonb_typeof(e.value) = 'array'
                       then (select jsonb_agg(case when x = 'null'::jsonb then x else to_jsonb('[redacted]'::text) end)
                               from jsonb_array_elements(e.value) x)
                       when e.value = 'null'::jsonb then e.value
                       else to_jsonb('[redacted]'::text) end
             else e.value end)
      from jsonb_each(p) e), '{}'::jsonb) end
$$;

-- internal helpers + trigger functions: never callable over the API
do $$ declare f text; begin
  foreach f in array array['public._is_system_change()','public._sq164_tg_notification()','public._sq164_tg_outbox()','public._audit_redact(jsonb, boolean)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.tg_audit()');
  if v_src is null then
    raise notice '0164: public.tg_audit() not found - audit part skipped';
  elsif position('audit-1017-0148' in v_src) > 0 or position('sys-quiet-0164' in v_src) > 0 then
    execute $fn$
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = 'public' as $body$
-- audit-run2-0042: the audit row carries the changed row's studio (C-09)
-- audit-1017-0148: role_access rows also carry role + area (entity id "role:area")
-- sys-quiet-0164: link secrets redacted; direct-DB changes tagged actor_email 'helm:maintenance'
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_id text;
  v_quote uuid;
  v_changed jsonb;
  v_org uuid;
  o jsonb; n jsonb;
begin
  if v_actor is not null then select email into v_email from auth.users where id = v_actor;
  elsif public._is_system_change() then v_email := 'helm:maintenance';
  end if;
  if tg_op = 'DELETE' then n := to_jsonb(OLD); else n := to_jsonb(NEW); end if;
  if tg_op = 'UPDATE' then o := to_jsonb(OLD); end if;

  v_id := coalesce(n->>'id', n->>'quote_id');
  if tg_table_name = 'role_access' then v_id := coalesce(n->>'role', '') || ':' || coalesce(n->>'area', ''); end if;
  if tg_table_name = 'quotes' then v_quote := (n->>'id')::uuid;
  elsif n ? 'quote_id' then v_quote := nullif(n->>'quote_id','')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(o->key, n->key))
      into v_changed
      from jsonb_object_keys(n) as key
      where (o->key) is distinct from (n->key)
        and key not in ('updated_at','confirmed_at');
    if v_changed is null then return null; end if;
    if tg_table_name = 'role_access' then
      v_changed := v_changed || jsonb_build_object('role', n->'role', 'area', n->'area');
    end if;
    v_changed := public._audit_redact(v_changed, true);
  else
    v_changed := public._audit_redact(n, false);
  end if;

  if tg_table_name = 'organizations' and coalesce(n->>'id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'id')::uuid;
  elsif coalesce(n->>'org_id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'org_id')::uuid;
  end if;
  if v_org is null and v_quote is not null then
    select q.org_id into v_org from public.quotes q where q.id = v_quote;
  end if;
  v_org := coalesce(v_org, public.current_org_id());

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_actor, v_email, lower(tg_op), tg_table_name, v_id, v_quote, v_changed, v_org);
  return null;
end $body$
$fn$;
  else
    raise notice '0164: tg_audit on this database is not the known 0148 body - left unchanged';
  end if;
end $do$;
