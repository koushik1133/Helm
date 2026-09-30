-- =====================================================================
-- SEC-07 — backend hardening: link expiry, SMS abuse limits, cross-studio
--          quote references, default function privileges
-- =====================================================================
-- Additive + idempotent. Uses triggers / defaults only — NO existing function
-- body is replaced, so it cannot regress logic already live. Apply AFTER SEC-05.
-- Staging first → VERIFY → production.
--
--  G1 Approval links never expired: generate_approval_token never sets
--     quotes.approval_token_expires_at (every token RPC already HONOURS it).
--     FIX: a trigger stamps now()+30 days whenever a token is issued without an
--     expiry; existing live tokens with no expiry get 30 days from today.
--  G2 Worker links never expired: worker RPCs honour work_tokens.expires_at
--     (PROD-01) but links are created without one.
--     FIX: column default now()+60 days; existing links with no expiry get 60
--     days from today.
--  G3 SMS abuse: an OTP could be requested for any number, 5 per 10 minutes
--     per quote, without a per-number cap (SMS-pumping cost).
--     FIX: a BEFORE INSERT trigger on quote_otps (covers request_otp AND the
--     send-otp Edge Function's admin_store_otp): max 3 codes per phone number
--     per hour and 10 per quote per day, across all quotes.
--  G4 Cross-studio references: tables that carry quote_id + org_id accept a row
--     whose org_id differs from the referenced quote's org (RLS only checks
--     org_id = caller's org). FIX: one trigger on every such table rejects a
--     write whose quote belongs to another studio. Existing rows are untouched
--     (PRECHECK lists any mismatches for manual review).
--  G5 Future functions were executable by PUBLIC/anon by default.
--     FIX: default privileges for functions created by postgres in schema
--     public no longer grant EXECUTE to PUBLIC or anon (authenticated and
--     service_role keep theirs). New anon-facing RPCs must grant anon
--     explicitly — existing migrations already do.
--
-- To change the lifetimes later: edit the intervals in G1/G2 and re-run.
-- =====================================================================

-- ---- PRECHECK (read-only) ----
-- Required columns (expect 3 rows)
select table_name, column_name from information_schema.columns
 where table_schema='public' and ((table_name='quotes' and column_name='approval_token_expires_at')
    or (table_name='work_tokens' and column_name='expires_at') or (table_name='quote_otps' and column_name='phone'));
-- Live links that will get an expiry (counts)
select (select count(*) from public.quotes where approval_token is not null and approval_token_expires_at is null) as approval_links_without_expiry,
       (select count(*) from public.work_tokens where expires_at is null) as worker_links_without_expiry;
-- Tables G4 will guard + existing cross-studio rows (review any non-zero)
do $$ declare r record; n bigint; begin
  for r in select c.table_name from information_schema.columns c
    join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
    join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
    where c.table_schema='public' and c.column_name='quote_id' and c.table_name <> 'quotes' order by 1
  loop
    execute format('select count(*) from public.%I x join public.quotes q on q.id = x.quote_id where x.org_id is distinct from q.org_id', r.table_name) into n;
    raise notice '% : % cross-studio row(s)', r.table_name, n;
  end loop;
end $$;

-- ---- APPLY (idempotent) ----
begin;

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='work_tokens' and column_name='expires_at') then
    raise exception 'SEC-07 not applied — work_tokens.expires_at missing: apply prod-rollout/PROD-01-APPLY.sql first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='approval_token_expires_at') then
    raise exception 'SEC-07 not applied — quotes.approval_token_expires_at missing: apply wave10 first';
  end if;
end $$;

-- G1 approval links: 30 days ------------------------------------------------
create or replace function public.tg_approval_token_expiry()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.approval_token is not null and new.approval_token_expires_at is null
     and (tg_op = 'INSERT' or new.approval_token is distinct from old.approval_token or old.approval_token_expires_at is null) then
    new.approval_token_expires_at := now() + interval '30 days';
  end if;
  return new;
end; $$;
drop trigger if exists zz_approval_token_expiry on public.quotes;
create trigger zz_approval_token_expiry before insert or update of approval_token, approval_token_expires_at
  on public.quotes for each row execute function public.tg_approval_token_expiry();
update public.quotes set approval_token_expires_at = now() + interval '30 days'
 where approval_token is not null and approval_token_expires_at is null;

-- G2 worker links: 60 days --------------------------------------------------
alter table public.work_tokens alter column expires_at set default now() + interval '60 days';
update public.work_tokens set expires_at = now() + interval '60 days' where expires_at is null;

-- G3 OTP send limits ----------------------------------------------------------
create or replace function public.tg_otp_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_digits text := regexp_replace(coalesce(new.phone,''), '[^0-9]', '', 'g'); n int;
begin
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

-- G4 a row's quote must belong to the row's studio --------------------------
-- "zz_" so it runs after the org-stamping BEFORE triggers (alphabetical order).
create or replace function public.tg_quote_org_match()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if new.quote_id is null or new.org_id is null then return new; end if;   -- NOT NULL reports a missing org
  select org_id into v_org from public.quotes where id = new.quote_id;
  if v_org is not null and new.org_id is distinct from v_org then
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
    execute format('create trigger zz_quote_org_match before insert or update of quote_id, org_id on public.%I for each row execute function public.tg_quote_org_match()', r.table_name);
  end loop;
end $$;

-- G5 future functions: no implicit PUBLIC / anon EXECUTE ---------------------
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

commit;
notify pgrst, 'reload schema';

-- ---- VERIFY (every row should read PASS) ----
select 'G1 approval links all expire' as check,
       case when not exists (select 1 from public.quotes where approval_token is not null and approval_token_expires_at is null) then 'PASS' else 'FAIL' end as result
union all select 'G2 worker links all expire',
       case when not exists (select 1 from public.work_tokens where expires_at is null) then 'PASS' else 'FAIL' end
union all select 'G2 worker default set',
       case when (select column_default from information_schema.columns where table_schema='public' and table_name='work_tokens' and column_name='expires_at') like '%60 days%' then 'PASS' else 'FAIL' end
union all select 'G3 OTP limit trigger',
       case when exists (select 1 from pg_trigger where tgname='zz_otp_rate_limit' and not tgisinternal) then 'PASS' else 'FAIL' end
union all select 'G4 guarded tables: ' || (select count(*) from pg_trigger where tgname='zz_quote_org_match')::text,
       case when (select count(*) from pg_trigger where tgname='zz_quote_org_match') > 0 then 'PASS' else 'FAIL' end
union all select 'G5 new functions not anon-executable',
       case when not exists (select 1 from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace
            where n.nspname='public' and d.defaclobjtype='f' and array_to_string(d.defaclacl, ',') ~ '(^|,)(anon)?=X') then 'PASS' else 'CHECK' end;
-- App smoke on staging: send an approval link (link opens); request an OTP 4× to
-- one number within an hour (4th is refused); create a worker link (opens);
-- save a discovery / plan / proposal (works).

-- ---- ROLLBACK (each line independent) ----
-- drop trigger if exists zz_approval_token_expiry on public.quotes;
-- alter table public.work_tokens alter column expires_at drop default;
-- drop trigger if exists zz_otp_rate_limit on public.quote_otps;
-- do $$ declare r record; begin for r in select event_object_table t from information_schema.triggers where trigger_name='zz_quote_org_match' loop execute format('drop trigger if exists zz_quote_org_match on public.%I', r.t); end loop; end $$;
-- alter default privileges in schema public grant execute on functions to public;
-- alter default privileges in schema public grant execute on functions to anon;
-- (expiry values written by G1/G2 can be cleared with: update … set …_expires_at = null)
