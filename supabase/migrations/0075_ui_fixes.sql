-- 0075_ui_fixes.sql - CANONICAL forward-only. UI fix pass (L8 blank-quote reuse, #16 booklet
-- studio contact). REQUIRES 0072 (create_quote with F10 gate + advisory-locked codes) and
-- 0070 (public_get_booklet wrapper: sections filter, snapshots, menu.mode, payments helper).
--
-- In plain words:
--   1) start_blank_quote(code, title): the dashboard "Generate a quote" button used to make a
--      brand-new empty quote on every click. Now it hands back YOUR most recent untouched
--      blank quote in this studio, and only creates one when there is none. "Untouched" =
--      no client name, no event date, still version 1 with zero layout items, no payments,
--      milestones, consents or approval, status still 'quote', not archived or deleted,
--      version 1 saved by you, created less than 7 days ago. Same gates as create_quote
--      (quotes edit + can_create, F10). A per-user advisory lock stops two tabs creating two.
--      Nothing is ever deleted.
--   2) organizations.business_email_confirmed (new, default false): signup used to copy the
--      owner's login e-mail into business_email, and the client booklet showed it. Now the
--      booklet shows the studio e-mail ONLY when an admin saved it in Control Center >
--      Studio details (the app sends business_email_confirmed = true on that save). New
--      studios and server-side changes never count as confirmed; clearing the e-mail clears it.
--   3) public_get_booklet is wrapped ONCE (old body kept as public_get_booklet__pre0075):
--      same output as 0070 except studio.email is removed unless confirmed. Venue, sections,
--      snapshots, menu.mode, payments - unchanged.
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, guarded rename.
-- No rows are deleted or rewritten.

do $$ begin
  if to_regprocedure('public.create_quote(text, text, text, jsonb, integer, date)') is null then
    raise exception '0075: create_quote (0072) is not installed'; end if;
  if to_regprocedure('public.public_get_booklet(uuid)') is null then
    raise exception '0075: public_get_booklet (0065/0070) is not installed'; end if;
  if to_regprocedure('public._bk_payments(uuid, uuid, jsonb)') is null then
    raise exception '0075: 0070 (_bk_payments) is not installed'; end if;
end $$;

-- ---- 1) L8: reuse the caller's untouched blank quote -------------------------------------
create or replace function public.start_blank_quote(p_code text, p_title text default null)
returns public.quotes language plpgsql volatile security definer set search_path = '' as $$
-- ui-fixes-0075 (L8)
declare v_org uuid; v_uid uuid; q public.quotes;
begin
  v_uid := auth.uid(); v_org := public.current_org_id();
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;  -- F10
  if not public.can_create() then raise exception 'not authorized to create' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:blankq:' || v_org::text || ':' || v_uid::text, 0));
  select x.* into q from public.quotes x
   where x.org_id = v_org
     and x.deleted_at is null and x.archived_at is null
     and x.created_at > now() - interval '7 days'
     and coalesce(btrim(x.client ->> 'name'), '') = ''
     and x.event_date is null
     and x.current_version = 1
     and coalesce(x.status, 'quote') = 'quote'
     and coalesce(x.approval_status, 'none') = 'none'
     and x.confirmed_at is null and x.approval_token is null
     and exists (select 1 from public.quote_versions v
                  where v.quote_id = x.id and v.version_no = 1 and v.created_by = v_uid
                    and coalesce(v.object_count, 0) = 0
                    and (case when jsonb_typeof(v.data -> 'items') = 'array' then jsonb_array_length(v.data -> 'items') else 0 end) = 0)
     and not exists (select 1 from public.quote_versions v where v.quote_id = x.id and v.version_no <> 1)
     and not exists (select 1 from public.quote_payments p where p.quote_id = x.id)
     and not exists (select 1 from public.payment_milestones m where m.quote_id = x.id)
     and not exists (select 1 from public.quote_consents c where c.quote_id = x.id)
   order by x.created_at desc, x.id desc
   limit 1
   for update of x;
  if q.id is not null then return q; end if;
  return public.create_quote(p_code, coalesce(p_title, p_code), null, '{"items":[]}'::jsonb, 0, null);
end $$;
revoke all on function public.start_blank_quote(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.start_blank_quote(text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.start_blank_quote(text, text) to authenticated'; end if;
end $$;

-- ---- 2) #16: business e-mail shown to clients only once an admin saved it ------------------
alter table public.organizations add column if not exists business_email_confirmed boolean not null default false;

create or replace function public.tg_org_bizmail_confirm()
returns trigger language plpgsql set search_path = '' as $$
-- ui-fixes-0075 (#16)
begin
  if tg_op = 'INSERT' then
    new.business_email_confirmed := false;              -- signup seeding never counts
  elsif nullif(btrim(coalesce(new.business_email, '')), '') is null then
    new.business_email_confirmed := false;              -- no e-mail, nothing to confirm
  elsif current_user not in ('anon', 'authenticated')
        and new.business_email is distinct from old.business_email then
    new.business_email_confirmed := false;              -- server-side change: not an admin save
  end if;
  return new;
end $$;
revoke all on function public.tg_org_bizmail_confirm() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.tg_org_bizmail_confirm() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.tg_org_bizmail_confirm() from authenticated'; end if;
end $$;
drop trigger if exists bec75_bizmail_confirm on public.organizations;
create trigger bec75_bizmail_confirm before insert or update on public.organizations
  for each row execute function public.tg_org_bizmail_confirm();

-- ---- 3) booklet: studio e-mail only when confirmed ----------------------------------------
do $$ begin
  if to_regprocedure('public.public_get_booklet__pre0075(uuid)') is null then
    alter function public.public_get_booklet(uuid) rename to public_get_booklet__pre0075;
  end if;
end $$;

create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- ui-fixes-0075: the 0070 reader, then studio.email only when the admin confirmed it
declare r jsonb; v_ok boolean;
begin
  r := public.public_get_booklet__pre0075(p_token);     -- validates token, rate limit, audit, sections
  if r is null or jsonb_typeof(r -> 'studio') <> 'object' then return r; end if;
  select coalesce(o.business_email_confirmed, false) into v_ok
    from public.client_booklets b join public.organizations o on o.id = b.org_id
   where b.token = p_token;
  if not coalesce(v_ok, false) then r := jsonb_set(r, '{studio}', (r -> 'studio') - 'email'); end if;
  return r;
end $$;

do $$ declare s text; begin
  foreach s in array array['public.public_get_booklet__pre0075(uuid)', 'public.public_get_booklet(uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.public_get_booklet(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.public_get_booklet(uuid) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.public_get_booklet__pre0075(uuid) to service_role;
  end if;
end $$;
