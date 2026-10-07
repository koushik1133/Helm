-- ============================================================================
-- 0032_rescore2_fixes.sql — CANONICAL forward-only. Security re-score #2 fixes.
-- Every ATTACK below was reproduced on the disposable test DB
-- (tests/db/rescore2-fixes.sql FAILS on 0001-0031 and passes after this file).
--
-- What this changes, in plain words:
--   1  REFUNDS: a new refund entry entered straight through the API always starts
--      as 'pending'. (Before: the maker could insert it already 'approved' or
--      'processed', skipping the second person.) The same rule holds for a studio
--      admin: a one-person studio enters it, then approves it (the UPDATE rule from
--      0026 still lets the admin approve their own entry) — two steps, same result,
--      and the approval is a separate audited change.
--   2  FUNCTION GRANTS: signed-out visitors (anon) may call ONLY the client-link
--      functions the public pages really use (quote approval, proposal, portal,
--      crew work link, invitation site, studio links, invite banner). Every other
--      public function loses anon EXECUTE (production had drifted: helm_total_paid,
--      has_area, current_org_id, get_pricing_config, … were callable signed out).
--      Signed-in access is preserved exactly as it is, except helm_total_paid,
--      which is internal-only (0005 F4) and is revoked from signed-in users too.
--      invitation_preview (0010) is (re)created ONLY if the database lacks it.
--   3  inventory_availability view runs with the CALLER's row-level security
--      (security_invoker) — it used to show every studio's stock to anyone.
--   4  QUOTE PRICING bounds now apply to every pricing save, including payloads
--      without gstPct / subtotal / total (those skipped every check before).
--      Drafts with no pricing (null / {}) still save.
--   5  EVENT DATES must be between 2000-01-01 and 2100-12-31 when a date is set or
--      changed (quotes.event_date, leads.event_date, event_sites data.date). It is
--      a trigger, not a CHECK, so legacy rows (e.g. a year-61115 date) are never
--      re-checked and can still be edited — only a NEW or CHANGED date is checked.
--   6  EVENT CLOSURE can only be written through close_event / set_closure (direct
--      API insert/update/delete revoked). NO balance gate is added (owner product
--      decision pending).
--   7  TEMP PASSWORD backstop: while profiles.must_change_password is true the
--      account can read but cannot insert / update / delete any row directly
--      (restrictive RLS on every RLS table except profiles). Sign-in, the password
--      change and clear_password_change_required are untouched.
--   8  MASS ASSIGNMENT: organizations.plan / created_by and quotes.code / created_by
--      can't be changed through the API; plan can't be chosen on insert; created_by
--      is stamped by the server on insert. Server functions (create_studio,
--      rebrand_quote_code, …) run as their owner and are unaffected.
--   9  UPLOAD RATE: every storage upload is logged (public.storage_upload_log), and
--      the per-user 100-per-10-minutes cap counts the log, so delete + re-upload no
--      longer resets it. If this database won't let the migration add a trigger on
--      storage.objects, that step is skipped with a NOTICE (the old cap stays).
--   10 INVITATION LINKS: new published slugs get 64 random bits (16 hex) instead of
--      24 (6 hex). Existing slugs are untouched.
--   11 OTP: request_otp / verify_and_consent only accept the client phone number on
--      file (when the event has one with 8+ digits), and a link is locked for 24 h
--      after 15 wrong codes in total (across all codes) or 20 codes requested.
--      Drift-safe like 0026: each database's OWN body is kept as *__base and a thin
--      wrapper adds the checks (the 0026 markers stay satisfied).
--
-- Zero data loss: additive + idempotent. No row is deleted or rewritten; no
-- table/column is dropped. Safe to run twice.
-- ============================================================================

-- ============================================================================
-- 1) refund maker-checker: inserts start as pending
-- ============================================================================
create or replace function public.tg_refund_maker_checker()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      -- rescore2-0032: an entry starts as pending for everyone (admin included);
      -- approving it is a separate update, checked below.
      if new.status is distinct from 'pending' then
        raise exception 'A new refund starts as pending — approve it as a separate step.' using errcode = '42501';
      end if;
    else
      if new.created_by is distinct from old.created_by then
        raise exception 'who entered a refund can''t be changed' using errcode = '42501';
      end if;
      if new.status is distinct from old.status and new.status in ('approved', 'processed')
         and old.created_by is not null and old.created_by = auth.uid()
         and coalesce(public.user_role(), '') <> 'admin' then
        raise exception 'Someone else must approve a refund you entered.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_refund_maker_checker() from public, anon, authenticated;
drop trigger if exists ab_refund_maker_checker on public.event_refunds;
create trigger ab_refund_maker_checker before insert or update on public.event_refunds
  for each row execute function public.tg_refund_maker_checker();

-- ============================================================================
-- 2) function EXECUTE grants
-- ============================================================================
-- 2a) invitation_preview (0010): the login page's invite banner. Re-create ONLY if
--     this database does not have it (production answered PGRST202).
do $guard$ begin
  if to_regprocedure('public.invitation_preview(text)') is null then
    execute $sql$
create function public.invitation_preview(p_token text)
  returns jsonb
  language plpgsql stable security definer set search_path = public as $fn$
declare v_row public.invitations; v_org text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    return jsonb_build_object('valid', false, 'status', 'not_found', 'expired', false);
  end if;
  select * into v_row from public.invitations where token = p_token;
  if v_row.id is null then
    return jsonb_build_object('valid', false, 'status', 'not_found', 'expired', false);
  end if;
  select name into v_org from public.organizations where id = v_row.org_id;
  return jsonb_build_object(
    'valid',    (v_row.status = 'pending' and v_row.expires_at > now()),
    'status',   v_row.status,
    'role',     v_row.role,
    'org_name', v_org,
    'expired',  (v_row.expires_at <= now())
  );
end; $fn$
$sql$;
  end if;
end $guard$;
revoke all on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to anon, authenticated, service_role;

-- 2b) anon allowlist. Names (all overloads). Signed-out pages and what they call:
--   approve.html  (/<studio>/quote/<token>) : public_get_quote, request_otp,
--                                            verify_and_consent, create_payment
--   proposal-view (/<studio>/proposal/<t>)  : public_get_proposal
--   portal.html   (/<studio>/portal/<t>)    : public_get_portal
--   work.html     (/<studio>/work/<t>)      : worker_get_tasks, worker_get_equipment,
--                                            worker_respond, worker_checkin_equipment
--   invite.html   (/i/<slug>, /<s>/invite/) : public_event_site; photos are signed
--                                            through storage policy 0019, which
--                                            calls invite_media_on_published_site
--   every branded link                      : public_link_studio
--   login.html (invite banner, pre-sign-in) : invitation_preview
--   pure helpers granted by 0020/0022/0027/0028 (no table data): helm_norm_phone,
--     mfa_ok, studio_slug_reserved, studio_slug_valid, studio_slugify, try_date,
--     client_link_window_days
-- Trigger functions are skipped (they can't be called through the API).
-- A helper referenced by a storage.objects policy that applies to anon is KEPT
-- (revoking it would turn the guest photo read into an error) — with a NOTICE.
do $$
declare
  v_allow text[] := array['public_get_quote','public_get_portal','public_get_proposal','public_event_site',
                          'request_otp','create_payment','verify_and_consent',
                          'worker_get_tasks','worker_get_equipment','worker_respond','worker_checkin_equipment',
                          'invitation_preview','invite_media_on_published_site','public_link_studio',
                          'helm_norm_phone','mfa_ok','studio_slug_reserved','studio_slug_valid','studio_slugify',
                          'try_date','client_link_window_days'];
  f record; r record;
begin
  for f in
    select p.oid, p.oid::regprocedure::text as sig, p.proname
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
       and p.prorettype <> 'trigger'::regtype
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and has_function_privilege('anon', p.oid, 'EXECUTE')
       and p.proname <> all (v_allow)
     order by 2
  loop
    if exists (select 1 from pg_policies pp
                where pp.schemaname = 'storage'
                  and (pp.roles && array['public','anon']::name[])
                  and (coalesce(pp.qual, '') || ' ' || coalesce(pp.with_check, '')) ~ ('\m' || f.proname || '\M')) then
      raise notice 'kept anon EXECUTE on % (used by a storage policy that applies to anon)', f.sig;
      continue;
    end if;
    -- keep every OTHER role's access exactly as it is today (authenticated,
    -- service_role, supabase_auth_admin hooks, …): roles that only had it through
    -- PUBLIC get an explicit grant first. Roles anon belongs to are skipped.
    for r in select rolname from pg_roles
              where rolname <> 'anon' and rolname !~ '^pg_' and not rolsuper
                and not pg_has_role('anon', oid, 'MEMBER')
                and has_function_privilege(oid, f.oid, 'EXECUTE')
                and not (rolname = 'authenticated' and f.proname = 'helm_total_paid')
    loop
      execute format('grant execute on function %s to %I', f.sig, r.rolname);
    end loop;
    execute format('revoke execute on function %s from public', f.sig);
    execute format('revoke execute on function %s from anon', f.sig);
  end loop;
end $$;

-- 2c) internal-only (0005 F4): never callable by API roles, signed in or not.
--     The overpayment triggers call helm_total_paid as their owner (unaffected).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('helm_total_paid', '_flag', 'create_helm_user', '_notify')
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('revoke all on function %s from authenticated', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

-- ============================================================================
-- 3) inventory_availability: caller's RLS, never anon, read-only
-- ============================================================================
do $$ begin
  if to_regclass('public.inventory_availability') is not null then
    execute 'alter view public.inventory_availability set (security_invoker = true)';
    execute 'revoke all on public.inventory_availability from public';
    execute 'revoke all on public.inventory_availability from anon';
    execute 'revoke insert, update, delete, truncate, references, trigger on public.inventory_availability from authenticated';
  end if;
end $$;

-- ============================================================================
-- 4) quote pricing bounds on EVERY pricing save
-- ============================================================================
create or replace function public.tg_quote_pricing_bounds()
returns trigger language plpgsql security definer set search_path = '' as $$
declare p jsonb := new.pricing; v numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return new; end if;       -- drafts: no pricing yet
  if tg_op = 'UPDATE' and p is not distinct from old.pricing then return new; end if;
  -- every component present is a finite number in range (0..1e12, % 0..100)
  perform public.helm_pricing_assert_sane(p);
  if jsonb_typeof(p -> 'catering') = 'object' then
    v := public.helm_pricing_num(p -> 'catering' -> 'gstPct');
    if v is not null and not (v >= 0 and v < 100.0000001) then
      raise exception 'pricing value "catering.gstPct" must be a number from 0 to 100 (got %)', v using errcode = '22003';
    end if;
  end if;
  -- the total trigger (0001) only recomputes when gstPct+items / subtotal / total is
  -- present. For any other shape with items, bound the total it WOULD come to, so
  -- e.g. guests x platePrice can't store an unbounded amount.
  if not (p ? 'subtotal') and not (p ? 'total')
     and not ((p ? 'gstPct') and (p ? 'chairs' or p ? 'guests' or p ? 'other' or p ? 'catering' or p ? 'platePrice'))
     and (p ? 'chairs' or p ? 'chairPrice' or p ? 'guests' or p ? 'platePrice' or p ? 'other' or p ? 'catering') then
    begin
      v := public.helm_quote_total_canonical(p);
    exception when invalid_text_representation or undefined_function then
      v := null;                         -- non-numeric strings are left exactly as before
    end;
    if v is not null and not (v >= 0 and v < 1e13) then
      raise exception 'the quote total is out of range (%)', v using errcode = '22003';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_quote_pricing_bounds() from public, anon, authenticated;
drop trigger if exists ab_quote_pricing_bounds on public.quotes;
create trigger ab_quote_pricing_bounds before insert or update of pricing on public.quotes
  for each row execute function public.tg_quote_pricing_bounds();

-- ============================================================================
-- 5) event dates between 2000 and 2100 (new / changed values only)
-- ============================================================================
create or replace function public.helm_event_date_parse(p text)
returns date language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4,}-\d{2}-\d{2}' then return null; end if;
  return substring(p from '^\d{4,}-\d{2}-\d{2}')::date;
exception when others then return null;
end $$;
revoke all on function public.helm_event_date_parse(text) from public, anon;
grant execute on function public.helm_event_date_parse(text) to authenticated, service_role;

create or replace function public.tg_event_date_bounds()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_new date; v_old date;
begin
  if tg_table_name = 'event_sites' then
    v_new := public.helm_event_date_parse(new.data ->> 'date');
    if tg_op = 'UPDATE' then v_old := public.helm_event_date_parse(old.data ->> 'date'); end if;
  else
    v_new := (to_jsonb(new) ->> tg_argv[0])::date;
    if tg_op = 'UPDATE' then v_old := (to_jsonb(old) ->> tg_argv[0])::date; end if;
  end if;
  if v_new is null or (tg_op = 'UPDATE' and v_new is not distinct from v_old) then return new; end if;
  if v_new < date '2000-01-01' or v_new > date '2100-12-31' then
    raise exception 'The event date must be between the years 2000 and 2100 (got %).', v_new using errcode = '22008';
  end if;
  return new;
end $$;
revoke all on function public.tg_event_date_bounds() from public, anon, authenticated;

do $$
declare r record;
begin
  for r in select * from (values ('quotes','event_date'), ('leads','event_date'), ('event_sites','data')) v(tbl, col)
  loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = r.tbl and column_name = r.col) then
      execute format('drop trigger if exists ab_event_date_bounds on public.%I', r.tbl);
      execute format('create trigger ab_event_date_bounds before insert or update of %I on public.%I for each row execute function public.tg_event_date_bounds(%L)',
                     r.col, r.tbl, r.col);
    end if;
  end loop;
end $$;

-- ============================================================================
-- 6) event_closure: only through close_event / set_closure (SECURITY DEFINER)
--    The app only READS the table directly (store-api closure.get).
-- ============================================================================
revoke insert, update, delete, truncate on public.event_closure from public, anon, authenticated;
revoke all on public.event_closure from anon;

-- ============================================================================
-- 7) temp-password backstop: no direct writes until the password is changed
-- ============================================================================
create or replace function public.helm_pw_change_pending()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.must_change_password from public.profiles p where p.id = auth.uid()), false);
$$;
revoke all on function public.helm_pw_change_pending() from public, anon;
grant execute on function public.helm_pw_change_pending() to authenticated, service_role;

do $$
declare t record;
begin
  for t in
    select c.relname from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relrowsecurity
       and c.relname not in ('profiles', 'storage_upload_log')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
     order by 1
  loop
    execute format('drop policy if exists helm_pwgate_ins on public.%I', t.relname);
    execute format('create policy helm_pwgate_ins on public.%I as restrictive for insert to authenticated with check (not (select public.helm_pw_change_pending()))', t.relname);
    execute format('drop policy if exists helm_pwgate_upd on public.%I', t.relname);
    execute format('create policy helm_pwgate_upd on public.%I as restrictive for update to authenticated using (not (select public.helm_pw_change_pending())) with check (not (select public.helm_pw_change_pending()))', t.relname);
    execute format('drop policy if exists helm_pwgate_del on public.%I', t.relname);
    execute format('create policy helm_pwgate_del on public.%I as restrictive for delete to authenticated using (not (select public.helm_pw_change_pending()))', t.relname);
  end loop;
end $$;

-- ============================================================================
-- 8) mass assignment: plan / code / created_by are server-owned
-- ============================================================================
create or replace function public.tg_mass_assign_guard()
returns trigger language plpgsql set search_path = '' as $$
declare n jsonb; o jsonb; k text;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  n := to_jsonb(new);
  if tg_op = 'INSERT' then
    if tg_table_name = 'organizations' and (n ->> 'plan') is not null and (n ->> 'plan') <> 'free' then
      raise exception 'the plan is set by Helm, not by the app' using errcode = '42501';
    end if;
    if n ? 'created_by' then
      new := jsonb_populate_record(new, jsonb_build_object('created_by', auth.uid()));
    end if;
    return new;
  end if;
  o := to_jsonb(old);
  foreach k in array tg_argv loop
    if (n ? k) and (n -> k) is distinct from (o -> k) then
      raise exception '% can''t be changed here', k using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.tg_mass_assign_guard() from public, anon, authenticated;
drop trigger if exists ab_mass_assign_guard on public.organizations;
create trigger ab_mass_assign_guard before insert or update on public.organizations
  for each row execute function public.tg_mass_assign_guard('plan', 'created_by');
drop trigger if exists ab_mass_assign_guard on public.quotes;
create trigger ab_mass_assign_guard before insert or update on public.quotes
  for each row execute function public.tg_mass_assign_guard('code', 'created_by');

-- ============================================================================
-- 9) upload rate: count uploads in the window, not surviving objects
-- ============================================================================
create table if not exists public.storage_upload_log (
  id bigint generated always as identity primary key,
  owner uuid,
  bucket_id text,
  created_at timestamptz not null default now()
);
create index if not exists storage_upload_log_owner_at_idx on public.storage_upload_log (owner, created_at);
alter table public.storage_upload_log enable row level security;   -- no policy: server only
revoke all on public.storage_upload_log from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.storage_upload_log to service_role';
  end if;
end $$;

create or replace function public.tg_storage_upload_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_upload_log (owner, bucket_id) values (coalesce(new.owner, auth.uid()), new.bucket_id);
  return null;
end $$;
revoke all on function public.tg_storage_upload_log() from public, anon, authenticated;

do $$ begin
  begin
    execute 'drop trigger if exists zz_helm_upload_log on storage.objects';
    execute 'create trigger zz_helm_upload_log after insert on storage.objects for each row execute function public.tg_storage_upload_log()';
  exception when insufficient_privilege then
    raise notice 'storage.objects trigger not added (no privilege here): the upload rate keeps the 0027 rule';
  end;
end $$;

-- 0027 body + the log count (the per-event cap still counts live objects: it is a
-- storage cap, delete frees a slot by design)
create or replace function public.storage_upload_allowed(p_bucket text, p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_cap   int;
  n       int;
  n_log   int;
begin
  if not public.storage_key_ok(p_bucket, p_name) then return false; end if;
  v_cap := case p_bucket when 'invite-media' then 120 when 'event-docs' then 200 else null end;
  -- per-event object cap (the row being inserted is not counted yet)
  if v_cap is not null then
    select count(*) into n from storage.objects o
     where o.bucket_id = p_bucket and o.name like v_parts[1] || '/' || v_parts[2] || '/%';
    if n >= v_cap then return false; end if;
  end if;
  -- per-user upload frequency, all buckets: surviving objects AND logged uploads
  -- (rescore2-0032: delete + re-upload no longer resets the count)
  select count(*) into n from storage.objects o
   where o.owner = auth.uid() and o.created_at > now() - interval '10 minutes';
  select count(*) into n_log from public.storage_upload_log l
   where l.owner = auth.uid() and l.created_at > now() - interval '10 minutes';
  if greatest(n, n_log) >= 100 then return false; end if;
  return true;
end $$;
revoke all on function public.storage_upload_allowed(text, text) from public, anon;
grant execute on function public.storage_upload_allowed(text, text) to authenticated;

-- ============================================================================
-- 10) invitation slugs: 64 random bits for NEW slugs (this database's own
--     publish_event_site body is kept; only the 6-hex suffix becomes 16-hex)
-- ============================================================================
do $$
declare v_def text; v_new text;
  v_re text := '(substr\(\s*replace\(\s*gen_random_uuid\(\)::text\s*,\s*''-''\s*,\s*''''\s*\)\s*,\s*1\s*,\s*)6(\s*\))';
begin
  if to_regprocedure('public.publish_event_site(uuid,boolean)') is null then return; end if;
  v_def := pg_get_functiondef('public.publish_event_site(uuid,boolean)'::regprocedure);
  if v_def ~ v_re then
    v_new := regexp_replace(v_def, v_re, '\116\2', 'g');
    execute v_new;
  elsif position('1, 16)' in v_def) = 0 and position('1,16)' in v_def) = 0 then
    raise notice 'publish_event_site: slug generator not recognised — left unchanged, review by hand';
  end if;
end $$;

-- ============================================================================
-- 11) OTP: phone on file + cumulative per-link lockout (wrappers keep each
--     database's own request_otp / verify_and_consent body as *__base)
-- ============================================================================
do $$ begin
  if to_regprocedure('public.request_otp__base(uuid,text)') is null
     and to_regprocedure('public.request_otp(uuid,text)') is not null then
    alter function public.request_otp(uuid,text) rename to request_otp__base;
  end if;
  if to_regprocedure('public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)') is null
     and to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)') is not null then
    alter function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) rename to verify_and_consent__base;
  end if;
end $$;
revoke all on function public.request_otp__base(uuid,text) from public, anon, authenticated;
revoke all on function public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text) from public, anon, authenticated;

-- last 10 digits of the client phone on file, or null when there is none worth checking
create or replace function public.helm_otp_phone_on_file(p_client jsonb)
returns text language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_client) = 'object'
               and length(regexp_replace(coalesce(p_client ->> 'phone', ''), '[^0-9]', '', 'g')) >= 8
              then right(regexp_replace(p_client ->> 'phone', '[^0-9]', '', 'g'), 10) end;
$$;
revoke all on function public.helm_otp_phone_on_file(jsonb) from public, anon;
grant execute on function public.helm_otp_phone_on_file(jsonb) to authenticated, service_role;

create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- rescore2-0032 wrapper. The code is still generated by request_otp__base
-- (secure: extensions.gen_random_bytes, see 0026).
declare q public.quotes; v_file text; v_fails int; v_sent int;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is not null then
    v_file := public.helm_otp_phone_on_file(q.client);
    if v_file is not null and length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) >= 8
       and right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 10) <> v_file then
      raise exception 'use the phone number the studio has on file for you' using errcode = 'P0001';
    end if;
    select coalesce(sum(o.attempts), 0), count(*) into v_fails, v_sent
      from public.quote_otps o where o.quote_id = q.id and o.created_at > now() - interval '24 hours';
    if v_fails >= 15 then
      raise exception 'too many wrong codes on this link — try again tomorrow or contact the studio' using errcode = 'P0001';
    end if;
    if v_sent >= 20 then
      raise exception 'too many OTP requests on this link today — try again tomorrow' using errcode = 'P0001';
    end if;
  end if;
  return public.request_otp__base(p_token, p_phone);
end $$;
revoke all on function public.request_otp(uuid,text) from public;
grant execute on function public.request_otp(uuid,text) to anon, authenticated, service_role;

create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean,
  p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- rescore2-0032 wrapper. verify_and_consent__base keeps the single-use row lock
-- (select ... for update) and the persisted counter (attempts + 1), see 0026.
declare q public.quotes; v_file text; v_fails int;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is not null then
    select coalesce(sum(o.attempts), 0) into v_fails
      from public.quote_otps o where o.quote_id = q.id and o.created_at > now() - interval '24 hours';
    if v_fails >= 15 then
      return jsonb_build_object('approved', false, 'error', 'locked',
        'message', 'too many wrong codes on this link — try again tomorrow or contact the studio');
    end if;
    v_file := public.helm_otp_phone_on_file(q.client);
    if v_file is not null and right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 10) <> v_file then
      return jsonb_build_object('approved', false, 'error', 'phone_mismatch',
        'message', 'use the phone number the studio has on file for you');
    end if;
  end if;
  return public.verify_and_consent__base(p_token, p_phone, p_code, p_agreed, p_terms_version,
                                         p_consent_text, p_client_name, p_user_agent);
end $$;
revoke all on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) from public;
grant execute on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select has_function_privilege('anon','public.has_area(text,text)','EXECUTE');            -- f
-- select has_function_privilege('anon','public.public_get_quote(uuid)','EXECUTE');          -- t
-- select has_function_privilege('authenticated','public.helm_total_paid(uuid,uuid,uuid)','EXECUTE'); -- f
-- select reloptions from pg_class where oid = 'public.inventory_availability'::regclass;    -- {security_invoker=true}
-- select has_table_privilege('authenticated','public.event_closure','INSERT');              -- f
-- select count(*) from pg_policies where policyname = 'helm_pwgate_ins';                   -- = RLS tables - 1
-- select pg_get_functiondef('public.publish_event_site(uuid,boolean)'::regprocedure) like '%1, 16)%';
-- supabase/audit/GRANT-PARITY.sql lists every remaining grant drift.
-- ============================================================================
