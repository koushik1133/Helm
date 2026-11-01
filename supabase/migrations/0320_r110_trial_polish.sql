-- 0320_r110_trial_polish.sql - CANONICAL forward-only. R110 (free-trial end-to-end run, testing/phase2/TRIAL-E2E-REPORT.md).
--
-- In plain words:
--   1  (B2) A lead that Helm makes BY ITSELF from a quote's client (sync_quote_to_lead: source 'quote', linked to that
--      quote) no longer uses one of the 2 free-trial lead slots. Before, 2 trial quotes made 2 leads and the owner saw
--      "2 of 2 leads used" and could never add a lead of their own. Now only leads the studio adds itself count.
--      A lead is "made from a quote" when: source = 'quote', it is linked to one of the studio's OWN (not sample)
--      quotes, and no other lead of the studio is linked to that same quote - so at most one free lead per quote
--      (and quotes are themselves capped at 2 in the trial). A lead the owner typed in and later turned into a quote
--      still counts (its source is not 'quote'). The trial cap functions are re-issued with that ONE exemption:
--      _tl181_used (the count my_trial_limits shows), _tl181_tg_cap_check + _tl173_tg_create_cap (the refusals) and
--      _tl181_tg_cap_log (such a lead is not written to trial_create_log). Every other list / rule is unchanged.
--   2  (B3) Helm's billing currency follows the studio's billing COUNTRY while the studio has never paid: a studio in
--      India is billed in rupees (INR, GST), anywhere else in US dollars. Before, a trial owner whose browser was on
--      e.g. America/Chicago got USD at sign-up and kept it after saying "India" - checkout then showed
--      "$59 + IGST 18% = $69.62". Now:
--        * NEW trigger zzzz_r320_currency_country on studio_account: when the billing country is set or changed and
--          the studio has NEVER paid (no recorded payment, no active / past-due subscription), billing_currency is
--          set from the country (IN -> INR, other -> USD; the 0273 rule). An explicit currency set in the same
--          change (Helm HQ) is kept; a non-INR/USD currency set by HQ is kept.
--        * trial_welcome_save (the trial is India-only) also fills the studio_account country 'IN' when it is
--          empty (house wrapper: trial_welcome_save__pre0320 kept, app privileges taken away).
--        * once: a never-paid studio whose billing country is India (studio_account.country, else the sign-up /
--          welcome brand.billing country) but whose billing currency is USD is moved to INR (one audit_log row each).
--      Studios that have paid / have a running subscription are NEVER changed (the 0273 lock stays).
--   3  (B10a) Chat / team directory: a member whose profile has no full name yet shows the name they typed at
--      sign-up (auth user_metadata full_name / name, control characters removed, max 50) instead of the e-mail
--      prefix. chat_directory re-issued = the 0300 body + that fallback. Nothing is written.
--   No table / column / policy / index deleted; no row deleted. One new trigger; existing rows changed only by
--   section 2's one-time INR fix (never-paid, India, USD only, audited). Safe to run twice. ASCII only.
--   Goes after 0181 + 0199 + 0210 + 0236 + 0273 + 0300.
do $$
begin
  if to_regprocedure('public._tl181_used(uuid,text)') is null or to_regprocedure('public._tl181_tg_cap_check()') is null
     or to_regprocedure('public._tl181_tg_cap_log()') is null or to_regprocedure('public._tl173_tg_create_cap()') is null then
    raise exception 'STOP 0320: the trial cap functions (0181 / 0236) are not applied'; end if;
  if to_regprocedure('public._r25_currency_for(text,text)') is null then
    raise exception 'STOP 0320: 0273 (_r25_currency_for) is not applied'; end if;
  if to_regprocedure('public.trial_welcome_save(text,text,text,text,text)') is null then
    raise exception 'STOP 0320: 0210 (trial_welcome_save) is not applied'; end if;
  if to_regprocedure('public.chat_directory__base()') is null or to_regprocedure('public._r283_is_off(uuid,uuid)') is null then
    raise exception 'STOP 0320: 0041 / 0283 (chat_directory__base, _r283_is_off) are not applied'; end if;
  if to_regprocedure('public._studio_account_apply(uuid,jsonb)') is null then
    raise exception 'STOP 0320: 0045 (_studio_account_apply) is not applied'; end if;
end $$;

-- ==== 1) leads made from a quote are not trial lead slots =============================================================
-- p_lead = the row's id (null for a row not saved yet); free = source 'quote' + linked to an own non-sample quote +
-- no OTHER lead of the studio linked to that quote
create or replace function public._r320_quote_lead(p_org uuid, p_lead uuid, p_source text, p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r110-trial-polish-0320
  select p_org is not null and p_quote is not null and coalesce(p_source, '') = 'quote'
     and exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = p_org and not coalesce(q.is_demo, false))
     and not exists (select 1 from public.leads l2 where l2.org_id = p_org and l2.quote_id = p_quote
                       and (p_lead is null or l2.id <> p_lead));
$$;

create or replace function public._tl181_used(p_org uuid, p_table text)
returns integer language plpgsql stable security definer set search_path = '' as $$
-- trial-guards-0181 trial-unify-0236 (crew_members: rows linked to a login are not counted)
-- r110-trial-polish-0320 (leads: a lead made from a quote is not counted)
declare n integer;
begin
  if p_org is null or p_table is null
     or p_table not in ('leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues') then return 0; end if;
  if p_table = 'crew_members' then
    select (select count(*) from public.trial_create_log l
             where l.org_id = p_org and l.entity = 'crew_members'
               and not exists (select 1 from public.crew_members c
                                where c.org_id = p_org and c.id::text = l.row_id and c.profile_id is not null))::integer
         + (select count(*) from public.crew_members x
             where x.org_id = p_org and not x.is_demo and x.profile_id is null
               and not exists (select 1 from public.trial_create_log l
                                where l.org_id = p_org and l.entity = 'crew_members' and l.row_id = x.id::text))::integer
      into n;
    return coalesce(n, 0);
  end if;
  if p_table = 'leads' then
    select (select count(*) from public.trial_create_log l
             where l.org_id = p_org and l.entity = 'leads'
               and not exists (select 1 from public.leads c
                                where c.org_id = p_org and c.id::text = l.row_id
                                  and public._r320_quote_lead(p_org, c.id, c.source, c.quote_id)))::integer
         + (select count(*) from public.leads x
             where x.org_id = p_org and not x.is_demo
               and not public._r320_quote_lead(p_org, x.id, x.source, x.quote_id)
               and not exists (select 1 from public.trial_create_log l
                                where l.org_id = p_org and l.entity = 'leads' and l.row_id = x.id::text))::integer
      into n;
    return coalesce(n, 0);
  end if;
  execute format('select (select count(*) from public.trial_create_log l where l.org_id = $1 and l.entity = $2)::integer
                       + (select count(*) from public.%I x where x.org_id = $1 and not x.is_demo
                            and not exists (select 1 from public.trial_create_log l
                                             where l.org_id = $1 and l.entity = $2 and l.row_id = x.id::text))::integer', p_table)
    into n using p_org, p_table;
  return coalesce(n, 0);
end $$;

create or replace function public._tl181_tg_cap_check()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-guards-0181: 2 own rows created IN TOTAL per list in the free trial
-- trial-unify-0236: a staff row linked to a login (member sync) is not a slot
-- r110-trial-polish-0320: a lead made from a quote (sync_quote_to_lead) is not a slot
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return new; end if;
  if tg_table_name = 'crew_members' and (to_jsonb(new) ->> 'profile_id') is not null then return new; end if;
  if tg_table_name = 'leads' and public._r320_quote_lead(new.org_id, new.id, to_jsonb(new) ->> 'source',
                                                         nullif(to_jsonb(new) ->> 'quote_id', '')::uuid) then return new; end if;
  if public._is_system_change() then return new; end if;
  if not public._tl173_trial_locked(new.org_id) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:cap:' || tg_table_name || ':' || new.org_id::text, 0));
  -- a restored row (same id) that was already counted comes back without using a new slot
  if exists (select 1 from public.trial_create_log l
              where l.org_id = new.org_id and l.entity = tg_table_name and l.row_id = new.id::text) then
    return new;
  end if;
  if public._tl181_used(new.org_id, tg_table_name) >= 2 then
    raise exception 'Free trial limit reached (2). Upgrade to add more.' using errcode = '42501', hint = 'trial_cap';
  end if;
  return new;
end $$;

create or replace function public._tl181_tg_cap_log()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-guards-0181: remember the own row the trial studio just added (AFTER INSERT: only rows really saved)
-- trial-unify-0236: a staff row linked to a login (member sync) is not logged
-- r110-trial-polish-0320: a lead made from a quote is not logged
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return null; end if;
  if tg_table_name = 'crew_members' and (to_jsonb(new) ->> 'profile_id') is not null then return null; end if;
  if tg_table_name = 'leads' and public._r320_quote_lead(new.org_id, new.id, to_jsonb(new) ->> 'source',
                                                         nullif(to_jsonb(new) ->> 'quote_id', '')::uuid) then return null; end if;
  if public._is_system_change() then return null; end if;
  if not public._tl173_trial_locked(new.org_id) then return null; end if;
  insert into public.trial_create_log(org_id, entity, row_id) values (new.org_id, tg_table_name, new.id::text)
    on conflict do nothing;
  return null;
end $$;

create or replace function public._tl173_tg_create_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-lockdown-0173 trial-unify-0236 (crew_members: rows linked to a login are not counted)
-- r110-trial-polish-0320 (leads: a lead made from a quote is not counted and is never refused)
declare v_n integer;
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return new; end if;
  if tg_table_name = 'crew_members' and (to_jsonb(new) ->> 'profile_id') is not null then return new; end if;
  if tg_table_name = 'leads' and public._r320_quote_lead(new.org_id, new.id, to_jsonb(new) ->> 'source',
                                                         nullif(to_jsonb(new) ->> 'quote_id', '')::uuid) then return new; end if;
  if public._is_system_change() then return new; end if;
  if not public._tl173_trial_locked(new.org_id) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:cap:' || tg_table_name || ':' || new.org_id::text, 0));
  if tg_table_name = 'crew_members' then
    select count(*) into v_n from public.crew_members x where x.org_id = new.org_id and not x.is_demo and x.profile_id is null;
  elsif tg_table_name = 'leads' then
    select count(*) into v_n from public.leads x where x.org_id = new.org_id and not x.is_demo
       and not public._r320_quote_lead(x.org_id, x.id, x.source, x.quote_id);
  else
    execute format('select count(*) from public.%I x where x.org_id = $1 and not x.is_demo', tg_table_name) into v_n using new.org_id;
  end if;
  if v_n >= 2 then
    raise exception 'Free trial limit reached (2). Upgrade to add more.' using errcode = '42501', hint = 'trial_cap';
  end if;
  return new;
end $$;

-- ==== 2) Helm's billing currency follows the billing country until the studio first pays ============================
create or replace function public._r320_never_paid(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r110-trial-polish-0320: no recorded (not voided) payment and no active / past-due subscription
  select p_org is not null
     and not exists (select 1 from public.subscription_payments sp where sp.org_id = p_org and sp.voided_at is null)
     and not exists (select 1 from public.studio_subscriptions s where s.org_id = p_org and s.status in ('active', 'past_due'));
$$;

create or replace function public._r320_tg_currency_country()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r110-trial-polish-0320: never paid -> billing_currency follows the billing country (IN -> INR, other -> USD)
declare v_cc text := upper(btrim(coalesce(new.country, '')));
begin
  if v_cc !~ '^[A-Z]{2}$' then return new; end if;
  if tg_op = 'INSERT' then
    if new.billing_currency is not null then return new; end if;                 -- an explicit currency wins
  else
    if new.billing_currency is distinct from old.billing_currency then return new; end if;   -- HQ set it in this change
    if upper(btrim(coalesce(old.country, ''))) = v_cc and old.billing_currency is not null then return new; end if;
  end if;
  if coalesce(new.billing_currency, 'INR') not in ('INR', 'USD') then return new; end if;   -- a special HQ currency
  if not public._r320_never_paid(new.org_id) then return new; end if;                       -- paying studios: never
  new.billing_currency := public._r25_currency_for(v_cc, null);
  return new;
end $$;
drop trigger if exists zzzz_r320_currency_country on public.studio_account;
create trigger zzzz_r320_currency_country before insert or update on public.studio_account
  for each row execute function public._r320_tg_currency_country();

-- trial_welcome_save: the trial is India-only - also fill the account's billing country when it is empty
create or replace function public._r320_welcome_save(p_name text, p_city text, p_state text, p_phone text, p_country text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r110-trial-polish-0320
declare r jsonb; v_org uuid;
begin
  r := public.trial_welcome_save__pre0320(p_name, p_city, p_state, p_phone, p_country);
  v_org := public.current_org_id();
  begin
    if v_org is not null and not exists (select 1 from public.studio_account a
                                          where a.org_id = v_org and nullif(btrim(coalesce(a.country, '')), '') is not null) then
      perform public._studio_account_apply(v_org, jsonb_build_object('country', 'IN'));
    end if;
  exception when others then
    raise warning 'r110-0320: billing country not filled (%)', sqlstate;   -- the welcome itself is saved
  end;
  return r;
end $$;

do $$ declare v_src text; begin
  if to_regprocedure('public.trial_welcome_save__pre0320(text,text,text,text,text)') is null then
    alter function public.trial_welcome_save(text, text, text, text, text) rename to trial_welcome_save__pre0320;
    create function public.trial_welcome_save(p_name text, p_city text, p_state text, p_phone text default null, p_country text default 'IN')
      returns jsonb language sql volatile security definer set search_path = ''
      as 'select public._r320_welcome_save(p_name, p_city, p_state, p_phone, p_country) /* r110-trial-polish-0320 */';
  else
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.trial_welcome_save(text,text,text,text,text)');
    if position('_r320_welcome_save' in coalesce(v_src, '')) = 0 then
      raise notice '0320: trial_welcome_save was re-issued after 0320 - left unchanged (check the chain still reaches _r320_welcome_save)';
    end if;
  end if;
end $$;

-- once: never-paid India studios still on USD -> INR (audited); paying studios are never touched
do $$ declare r record; n int := 0; begin
  for r in
    select a.org_id
      from public.studio_account a join public.organizations o on o.id = a.org_id
     where a.billing_currency = 'USD'
       and upper(btrim(coalesce(nullif(btrim(a.country), ''),
             case when jsonb_typeof(o.brand -> 'billing') = 'object' then o.brand -> 'billing' ->> 'country' end, ''))) = 'IN'
       and public._r320_never_paid(a.org_id)
  loop
    update public.studio_account set billing_currency = 'INR', updated_at = now()
     where org_id = r.org_id and billing_currency = 'USD';
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id, at)
      values (null, 'studio_account.billing_currency', 'studio_account', r.org_id::text,
              jsonb_build_object('billing_currency', 'INR', 'from', 'USD', 'reason', 'r110-0320 India studio, never paid'), r.org_id, now());
    n := n + 1;
  end loop;
  if n > 0 then raise notice '0320: % never-paid India studio(s) moved from USD to INR billing', n; end if;
end $$;

-- ==== 3) chat directory: the sign-up name when the profile has no full name yet =====================================
create or replace function public._r320_signup_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r110-trial-polish-0320: auth user_metadata full_name / name, control characters and < > removed, max 50
  select nullif(left(btrim(regexp_replace(regexp_replace(coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                                                                   u.raw_user_meta_data ->> 'name', ''),
                                                          '[\x00-\x1f\x7f<>]', ' ', 'g'), '\s+', ' ', 'g')), 50), '')
    from auth.users u where u.id = p_user;
$$;

create or replace function public.chat_directory()
returns table(id uuid, full_name text, email_name text, role text, avatar_path text, job_title text, department text)
language sql stable security definer set search_path = '' as $$
  -- r33-0283 B1: a deactivated member reads "Name (deactivated)"
  -- r59-0300 BS-06: email_name (the part of a login e-mail before "@") only for admins / Users & access view
  -- r110-trial-polish-0320: no profile name yet -> the name typed at sign-up (before the e-mail prefix)
  with me as (select coalesce(public.is_admin(), false) or coalesce(public.has_area('users', 'view'), false) as full_view)
  select b.id,
         case when public._r283_is_off(b.id, public.current_org_id())
              then coalesce(nullif(btrim(b.full_name), ''), public._r320_signup_name(b.id),
                            case when me.full_view then b.email_name end, 'Member') || ' (deactivated)'
              else coalesce(nullif(btrim(b.full_name), ''), public._r320_signup_name(b.id)) end,
         case when me.full_view then b.email_name end, b.role, m.avatar_path, m.job_title, m.department
    from me cross join public.chat_directory__base() with ordinality as b(id, full_name, email_name, role, n)
    left join public.member_profiles m on m.user_id = b.id
   order by b.n;
$$;

-- ==== privileges ======================================================================================================
revoke all on function public._r320_quote_lead(uuid, uuid, text, uuid) from public;
revoke all on function public._r320_never_paid(uuid) from public;
revoke all on function public._r320_tg_currency_country() from public;
revoke all on function public._r320_welcome_save(text, text, text, text, text) from public;
revoke all on function public._r320_signup_name(uuid) from public;
revoke all on function public.trial_welcome_save(text, text, text, text, text) from public;
revoke all on function public.trial_welcome_save__pre0320(text, text, text, text, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._r320_quote_lead(uuid, uuid, text, uuid) from %I', r);
      execute format('revoke all on function public._r320_never_paid(uuid) from %I', r);
      execute format('revoke all on function public._r320_tg_currency_country() from %I', r);
      execute format('revoke all on function public._r320_welcome_save(text, text, text, text, text) from %I', r);
      execute format('revoke all on function public._r320_signup_name(uuid) from %I', r);
      execute format('revoke all on function public.trial_welcome_save__pre0320(text, text, text, text, text) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.trial_welcome_save(text, text, text, text, text) from anon';
    execute 'revoke all on function public.chat_directory() from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.trial_welcome_save(text, text, text, text, text) to authenticated';
    execute 'grant execute on function public.chat_directory() to authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.trial_welcome_save(text, text, text, text, text) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
