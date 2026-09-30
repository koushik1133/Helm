-- SEC-07 v2 — BLOCK 1: APPLY. STAGING ONLY (xizehqgeyjcfpzrdymly). Verbatim from SEC-07-backend-hardening.sql
-- (lines 76-262). One transaction; any error rolls everything back. Idempotent: safe on top of v1.
begin;

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='work_tokens' and column_name='expires_at') then
    raise exception 'SEC-07 not applied — work_tokens.expires_at missing: apply prod-rollout/PROD-01-APPLY.sql first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='approval_token_revoked_at') then
    raise exception 'SEC-07 not applied — quotes.approval_token_revoked_at missing: apply wave10 / prod-rollout first';
  end if;
  if to_regprocedure('public.generate_approval_token(uuid)') is null
     or pg_get_functiondef('public.generate_approval_token(uuid)'::regprocedure) not like '%SEC-05 F10%' then
    raise exception 'SEC-07 not applied — apply SEC-05 first';
  end if;
end $$;

-- G1 approval links --------------------------------------------------------
create or replace function public.tg_approval_token_expiry()
returns trigger language plpgsql set search_path = public as $$
declare v_floor timestamptz;
begin
  if new.approval_token is null or new.approval_token_revoked_at is not null then return new; end if;
  -- usable 30 days from issue, and until 30 days after the event (client portal)
  v_floor := greatest(now() + interval '30 days',
                      coalesce(new.event_date::timestamptz + interval '30 days', '-infinity'));
  if tg_op = 'INSERT' or new.approval_token is distinct from old.approval_token then
    if new.approval_token_expires_at is null then new.approval_token_expires_at := v_floor; end if;
  elsif new.approval_token_expires_at is null then
    new.approval_token_expires_at := old.approval_token_expires_at;      -- an expiry is never silently cleared
  elsif new.approval_token_expires_at > now()                             -- only a LIVE link is extended
    and ((new.approval_status is distinct from old.approval_status and new.approval_status in ('approved','paid'))
         or new.event_date is distinct from old.event_date) then
    new.approval_token_expires_at := greatest(new.approval_token_expires_at, v_floor);
  end if;
  return new;
end; $$;
drop trigger if exists zz_approval_token_expiry on public.quotes;
create trigger zz_approval_token_expiry
  before insert or update of approval_token, approval_token_expires_at, approval_status, event_date
  on public.quotes for each row execute function public.tg_approval_token_expiry();

-- generate_approval_token: SEC-05 body; the ONLY change is that an expired or
-- revoked token is replaced by a NEW one (status kept if already approved/paid).
create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid; v_exp timestamptz; v_rev timestamptz;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit')) then raise exception 'not authorized' using errcode='42501'; end if;   -- SEC-05 F10
  perform public.assert_quote_org(p_quote_id);
  select approval_token, approval_token_expires_at, approval_token_revoked_at into tok, v_exp, v_rev
    from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if tok is null or v_rev is not null or (v_exp is not null and v_exp <= now()) then   -- SEC-07 G1: renew dead links
    tok := gen_random_uuid();
    update public.quotes set approval_token = tok, approval_token_expires_at = null, approval_token_revoked_at = null,
           approval_status = case when approval_status in ('approved','paid') then approval_status else 'sent' end,
           updated_at = now()
      where id = p_quote_id and org_id = public.current_org_id();
  else
    update public.quotes set approval_status = case when approval_status='none' then 'sent' else approval_status end
      where id = p_quote_id and org_id = public.current_org_id();
  end if;
  return tok;
end; $$;
revoke all on function public.generate_approval_token(uuid) from public, anon;
grant execute on function public.generate_approval_token(uuid) to authenticated;

-- Backfill: never revives or prolongs a stale link. No issue timestamp exists,
-- so the last activity (updated_at) stands in for it; links whose window has
-- already passed are expired now. Upcoming events keep their portal.
update public.quotes
   set approval_token_expires_at = greatest(least(updated_at + interval '30 days', now() + interval '30 days'),
                                            coalesce(event_date::timestamptz + interval '30 days', '-infinity'))
 where approval_token is not null and approval_token_expires_at is null;

-- G2 worker links ----------------------------------------------------------
alter table public.work_tokens alter column expires_at drop default;   -- v1 set now()+60d; the trigger decides now
create or replace function public.tg_work_token_expiry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.expires_at is null then
    new.expires_at := greatest(now() + interval '60 days',
      coalesce((select event_date::timestamptz + interval '14 days' from public.quotes where id = new.quote_id), '-infinity'));
  end if;
  return new;
end; $$;
revoke all on function public.tg_work_token_expiry() from public, anon, authenticated;
drop trigger if exists zz_work_token_expiry on public.work_tokens;
create trigger zz_work_token_expiry before insert on public.work_tokens
  for each row execute function public.tg_work_token_expiry();

-- a new task assigned to a worker renews that worker's link (never a revoked one)
create or replace function public.tg_work_token_renew()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_phone is null then return new; end if;
  update public.work_tokens w
     set expires_at = greatest(w.expires_at, now() + interval '60 days',
           coalesce((select event_date::timestamptz + interval '14 days' from public.quotes where id = new.quote_id), '-infinity'))
   where w.quote_id = new.quote_id and w.phone = new.assignee_phone and w.revoked_at is null;
  return new;
end; $$;
revoke all on function public.tg_work_token_renew() from public, anon, authenticated;
drop trigger if exists zz_work_token_renew on public.event_tasks;
create trigger zz_work_token_renew after insert on public.event_tasks
  for each row execute function public.tg_work_token_renew();

update public.work_tokens w
   set expires_at = greatest(w.created_at + interval '60 days',
                             coalesce((select q.event_date::timestamptz + interval '14 days' from public.quotes q where q.id = w.quote_id), '-infinity'))
 where w.expires_at is null;

-- G3 OTP send limits (serialized) -------------------------------------------
create or replace function public.tg_otp_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_digits text := regexp_replace(coalesce(new.phone,''), '[^0-9]', '', 'g'); n int;
begin
  -- Serialize per phone number, then per quote (fixed order → no deadlock).
  -- The lock is held to COMMIT, and each count below runs as a new statement,
  -- so under READ COMMITTED it sees every row committed by the previous holder.
  perform pg_advisory_xact_lock(hashtextextended('helm:otp:phone:' || v_digits, 0));
  perform pg_advisory_xact_lock(hashtextextended('helm:otp:quote:' || new.quote_id::text, 0));
  select count(*) into n from public.quote_otps
   where regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') = v_digits and created_at > now() - interval '1 hour';
  if n >= 3 then raise exception 'too many codes sent to this number — try again in an hour' using errcode = 'P0001'; end if;
  select count(*) into n from public.quote_otps where quote_id = new.quote_id and created_at > now() - interval '1 day';
  if n >= 10 then raise exception 'too many codes requested for this quote today' using errcode = 'P0001'; end if;
  return new;
end; $$;
revoke all on function public.tg_otp_rate_limit() from public, anon, authenticated;
drop trigger if exists zz_otp_rate_limit on public.quote_otps;
create trigger zz_otp_rate_limit before insert on public.quote_otps
  for each row execute function public.tg_otp_rate_limit();
create index if not exists quote_otps_created_idx on public.quote_otps (created_at);

-- G4 quote/studio match ------------------------------------------------------
-- "zz_" sorts after every org-stamping BEFORE trigger (verified: the only later
-- BEFORE trigger on a candidate is zz_task_verify_guard, which changes nothing).
create or replace function public.tg_quote_org_match()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_found boolean;
begin
  if new.quote_id is null or new.org_id is null then return new; end if;   -- NOT NULL reports a missing org
  select true, org_id into v_found, v_org from public.quotes where id = new.quote_id;
  if v_found is null then
    if tg_nargs > 0 and tg_argv[0] = 'allow_dangling' then return new; end if;   -- audit / archive of deleted rows
    raise exception 'quote not found' using errcode = '23503';
  end if;
  if new.org_id is distinct from v_org then
    raise exception 'quote belongs to another studio' using errcode = '42501';
  end if;
  return new;
end; $$;
revoke all on function public.tg_quote_org_match() from public, anon, authenticated;
do $$ declare r record; begin
  for r in select c.table_name from information_schema.columns c
    join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
    join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
    where c.table_schema='public' and c.column_name='quote_id' and c.table_name <> 'quotes'
  loop
    execute format('drop trigger if exists zz_quote_org_match on public.%I', r.table_name);
    execute format('create trigger zz_quote_org_match before insert or update of quote_id, org_id on public.%I for each row execute function public.tg_quote_org_match(%L)',
                   r.table_name, case when r.table_name in ('audit_log','lead_archive') then 'allow_dangling' else 'strict' end);
  end loop;
end $$;

-- G5 default function privileges --------------------------------------------
do $$ declare r record; begin
  for r in
    select distinct pg_get_userbyid(p.proowner) as owner from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    union select current_user::text
  loop
    if pg_has_role(current_user, r.owner, 'MEMBER') then
      execute format('alter default privileges for role %I revoke execute on functions from public', r.owner);
      execute format('alter default privileges for role %I in schema public revoke execute on functions from anon', r.owner);
      execute format('alter default privileges for role %I in schema public grant execute on functions to authenticated, service_role', r.owner);
      if to_regnamespace('extensions') is not null then   -- extension functions keep working as before
        execute format('alter default privileges for role %I in schema extensions grant execute on functions to public', r.owner);
      end if;
    else
      raise warning 'G5: % cannot set default privileges for role % — functions it creates keep PUBLIC execute', current_user, r.owner;
    end if;
  end loop;
end $$;

commit;
notify pgrst, 'reload schema';
