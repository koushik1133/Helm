-- 0298_r57_hq_auth_hardening.sql - CANONICAL forward-only.
-- REQUIRES 0041 (member_profile_list, _mp_row_json), 0050 (rate_hit), 0253 (hq_mfa_reset), 0271 (Contact sales,
--          suggestions, _r24s_ip_hash), 0276 (submit_* captcha wrappers), 0277 (HQ roles: _hq27_require, _hq27_me,
--          signup_email_preauthorised), 0278 (hq_log_reveal), 0279 (referrals: _r29_net, _r29_rate, referral_click,
--          referral_lookup, partner codes), 0280 (hq_grant_studio_credit), 0281 (_r31_client_ip), 0282
--          (invitations.mail_key_hash), 0283 (team_member_status).
--
-- In plain words (r57, audit 2026-10-28, groups G-hq / A-auth / B-shell / E-money / I-database):
--   G-HQ-1  Helm HQ lists and the studio page used to send every e-mail, phone, PAN, GSTIN, tax id and mandate
--           reference in clear; the page only HID them. Now the database itself sends them masked
--           (ab...@x.com, ........10, AB......9F) from hq_studios, hq_studio_detail, hq_users, hq_sales_enquiries,
--           hq_sales_requests and hq_suggestions. The real value comes only from NEW hq_reveal(entity, id, field),
--           which checks the HQ role first, writes the "hq.reveal" audit row and returns the value in ONE step
--           (the log and the value can no longer be separated). hq_log_reveal stays for the CSV export.
--   G-HQ-7  PAN, tax id and the payment mandate reference are revealed only to HQ roles that may read billing
--           (Owner / Admin); Sales, Support and Security see them masked and are refused on Show.
--   G-HQ-2  Creating / editing / switching partner codes and attaching a code to a studio now need the
--           billing.write permission (Owner / Admin) + a fresh two-step code. Sales and Support keep reading them.
--   G-HQ-3  hq_mfa_reset checks the HQ role (security.write) and the fresh code BEFORE it looks any e-mail up, so a
--           Viewer can no longer ask "does this e-mail have an account / two-step?". Resetting the two-step of a
--           Helm HQ team member (any HQ role, including the Owner) is for the HQ Owner only.
--   G-HQ-4  referral_click answers the same {ok:true} for every code and counts per network before looking the code
--           up; referral_lookup answers "unknown" for an unknown AND a switched-off code ("off" for every code while
--           the program is off), and a network that asked about 20 codes that do not work in an hour gets "rate"
--           for every look-up until the hour is over.
--   G-HQ-6  hq_grant_studio_credit: a written reason of at least 15 characters and at most 5 grants per HQ person
--           in 24 hours.
--   G-HQ-5 / BS-02 / E-02  The caller's internet address used by the rate limits is the one the platform sets:
--           Cloudflare's cf-connecting-ip (Cloudflare sets it on every request that reaches its edge), else the
--           LAST public hop of x-forwarded-for (proxies append, so the first entry is whatever the caller typed),
--           else x-real-ip. A value that is not an IP address is ignored. NEW _r57_trusted_ip / _r57_client_net
--           (IPv6 counted per /64 network); _r31_client_ip, _r29_net and _r24s_ip_hash re-issued on top.
--           Contact sales + Suggestions (signed out) also get a per-network daily cap and one shared small bucket
--           for callers without a readable address, so one bot can't fill the shared hourly cap alone.
--   A-1     signup_email_preauthorised answers the same for EVERY address on a Helm domain (it no longer tells a
--           stranger which helm.events addresses are on the staff list; the sign-up hook still decides) and is
--           rate limited per network.
--   A-3     member_profile_list: members below the Users-view level no longer see deactivated colleagues or
--           anyone's e-mail name; crew / worker / client logins see names + roles only. Admins and Users-view
--           members see the list as before (they manage deactivated people).
--   A-5 / I-04  The browser may no longer read invitations.token or invitations.mail_key_hash (column privileges:
--           every other column stays readable under the same row policies). "Copy link" keeps working: it reuses
--           create_invitation, which returns the live link to the admin.
-- Every re-issued function keeps its name, arguments, answer shape and grants; the previous body is kept once as
-- <name>__pre0298 (no app privilege). Wrapped functions call that kept body.
-- ZERO DATA LOSS: no table, column or row is created, changed or deleted (privileges and functions only).
-- Additive + idempotent: safe to run twice. ASCII only.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regprocedure('public._hq27_me()') is null then
    raise exception 'STOP 0298: HQ staff roles (0277) missing - run 0277 first'; end if;
  if to_regprocedure('public.hq_log_reveal(text,text,text)') is null then raise exception 'STOP 0298: hq_log_reveal (0278) missing'; end if;
  if to_regprocedure('public.hq_grant_studio_credit(uuid,text,integer,text)') is null then raise exception 'STOP 0298: 0280 missing'; end if;
  if to_regprocedure('public._r29_rate(text,integer)') is null or to_regclass('public.referral_rate_buckets') is null then
    raise exception 'STOP 0298: referral program (0279) missing'; end if;
  if to_regprocedure('public._r31_client_ip()') is null then raise exception 'STOP 0298: _r31_client_ip (0281) missing'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0298: rate_hit (0050) missing'; end if;
  if to_regprocedure('public.hq_mfa_reset(text,text)') is null then raise exception 'STOP 0298: hq_mfa_reset (0253) missing'; end if;
  if to_regprocedure('public._mp_row_json(uuid,integer)') is null then raise exception 'STOP 0298: member profiles (0041) missing'; end if;
  if to_regclass('public.team_member_status') is null then raise exception 'STOP 0298: team_member_status (0283) missing'; end if;
  if to_regprocedure('public.submit_sales_enquiry(jsonb)') is null or to_regprocedure('public.submit_suggestion(jsonb)') is null then
    raise exception 'STOP 0298: Contact sales / suggestions (0271 / 0276) missing'; end if;
  if not exists (select 1 from pg_attribute a where a.attrelid = 'public.invitations'::regclass and a.attname = 'mail_key_hash' and not a.attisdropped) then
    raise exception 'STOP 0298: invitations.mail_key_hash (0282) missing'; end if;
end $$;

-- ---- 1) keep each previous body once (__pre0298) --------------------------------------------------------------
-- wrap = true: the new function calls the kept body; if a re-run of an older migration put a plain body back under the
-- public name, that newer body becomes the kept one (as 0276 does). wrap = false: re-issued in full; the FIRST kept
-- copy stays.
do $$
declare r record; v_pub regprocedure; v_pre regprocedure;
begin
  for r in select * from (values
      ('hq_studios', 'text,text,integer,integer', true), ('hq_studio_detail', 'uuid', true),
      ('hq_users', 'text,integer,integer', true), ('hq_sales_enquiries', 'text', true),
      ('hq_sales_requests', 'text', true), ('hq_suggestions', 'text', true),
      ('hq_partner_code_upsert', 'jsonb', true), ('hq_referral_attach', 'uuid,text,text', true),
      ('hq_partner_code_set_active', 'text,boolean', true),
      ('submit_sales_enquiry', 'jsonb', true), ('submit_suggestion', 'jsonb', true),
      ('hq_mfa_reset', 'text,text', false), ('hq_grant_studio_credit', 'uuid,text,integer,text', false),
      ('referral_click', 'text', false), ('referral_lookup', 'text', false),
      ('member_profile_list', '', false), ('signup_email_preauthorised', 'text', false),
      ('_r31_client_ip', '', false), ('_r29_net', '', false), ('_r24s_ip_hash', '', false)) x(fn, args, wrap) loop
    v_pub := to_regprocedure('public.' || r.fn || '(' || r.args || ')');
    v_pre := to_regprocedure('public.' || r.fn || '__pre0298(' || r.args || ')');
    if v_pub is not null and position('r57-0298' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      if v_pre is null then
        execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, r.fn || '__pre0298');
      elsif r.wrap then
        execute 'drop function ' || v_pre::text;
        execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, r.fn || '__pre0298');
      end if;
    end if;
    v_pre := to_regprocedure('public.' || r.fn || '__pre0298(' || r.args || ')');
    if r.wrap and v_pre is null then raise exception 'STOP 0298: %__pre0298 missing', r.fn; end if;
    if v_pre is not null then
      execute 'revoke all on function ' || v_pre::text || ' from public';
      if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
    end if;
  end loop;
end $$;

-- ---- 2) the trusted caller address (G-HQ-5 / BS-02 / E-02) ------------------------------------------------------
-- true for an address that a proxy inside the platform could have added (private, loopback, link-local, CGNAT)
create or replace function public._r57_ip_internal(a inet)
returns boolean language sql immutable set search_path = '' as $$
  -- r57-0298
  select a is null
      or a <<= '10.0.0.0/8'::inet or a <<= '172.16.0.0/12'::inet or a <<= '192.168.0.0/16'::inet
      or a <<= '127.0.0.0/8'::inet or a <<= '169.254.0.0/16'::inet or a <<= '100.64.0.0/10'::inet or a <<= '0.0.0.0/8'::inet
      or a <<= '::1/128'::inet or a <<= 'fc00::/7'::inet or a <<= 'fe80::/10'::inet or a <<= '::/128'::inet
$$;

create or replace function public._r57_trusted_ip()
returns text language plpgsql stable set search_path = '' as $$
-- r57-0298: the address the PLATFORM saw, never one the caller typed.
--   1 cf-connecting-ip - set by Cloudflare at its edge for every request (Supabase's API is behind Cloudflare);
--   2 else the LAST x-forwarded-for hop that is not an internal address - proxies APPEND to x-forwarded-for, so the
--     first entries are whatever the caller sent;
--   3 else x-real-ip. Anything that is not an IP address is ignored (null = "no readable address").
declare h jsonb; v text; a inet; parts text[]; i int; last_ok inet;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  if h is null or jsonb_typeof(h) <> 'object' then return null; end if;
  v := btrim(coalesce(h ->> 'cf-connecting-ip', ''));
  if v <> '' and length(v) <= 64 then
    begin a := v::inet; exception when others then a := null; end;
    if a is not null and ((family(a) = 4 and masklen(a) = 32) or (family(a) = 6 and masklen(a) = 128)) then return host(a); end if;
  end if;
  parts := string_to_array(left(coalesce(h ->> 'x-forwarded-for', ''), 2000), ',');
  if parts is not null then
    for i in reverse coalesce(array_length(parts, 1), 0) .. 1 loop
      v := btrim(parts[i]); a := null;
      if v <> '' and length(v) <= 64 then
        begin a := v::inet; exception when others then a := null; end;
      end if;
      if a is not null and ((family(a) = 4 and masklen(a) = 32) or (family(a) = 6 and masklen(a) = 128)) then
        if not public._r57_ip_internal(a) then return host(a); end if;
        if last_ok is null then last_ok := a; end if;        -- the platform's own hop (local tests: the only one)
      elsif v <> '' then
        exit;                                               -- a garbage entry: nothing left of it is trusted
      end if;
    end loop;
  end if;
  if last_ok is not null then return host(last_ok); end if;
  v := btrim(coalesce(h ->> 'x-real-ip', ''));
  if v <> '' and length(v) <= 64 then
    begin a := v::inet; exception when others then a := null; end;
    if a is not null and ((family(a) = 4 and masklen(a) = 32) or (family(a) = 6 and masklen(a) = 128)) then return host(a); end if;
  end if;
  return null;
end $$;

-- the caller's NETWORK for rate limits: an IPv4 address as it is, an IPv6 address as its /64 (one home / server)
create or replace function public._r57_client_net()
returns text language plpgsql stable set search_path = '' as $$
-- r57-0298
declare v text := public._r57_trusted_ip(); a inet;
begin
  if v is null then return null; end if;
  a := v::inet;
  if family(a) = 6 and not (a <<= '::ffff:0:0/96'::inet) then return network(set_masklen(a, 64))::text; end if;
  return host(a);
end $$;

create or replace function public._r31_client_ip()
returns text language plpgsql stable set search_path = '' as $$
-- r57-0298 (was r31-client-ip-0281: cf-connecting-ip, else the FIRST x-forwarded-for entry)
begin
  return public._r57_trusted_ip();
end $$;

create or replace function public._r29_net()
returns text language plpgsql stable set search_path = '' as $$
-- r57-0298 (r29-referrals-0279 r29d REF-04: same answer shape - IPv4 address / IPv6 /64 network)
begin
  return public._r57_client_net();
end $$;

create or replace function public._r24s_ip_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
-- r57-0298 (r31-client-ip-0281 hashed the address; now the trusted network: IPv6 per /64)
declare v text;
begin
  v := public._r57_client_net();
  return case when v is null then null else encode(pg_catalog.sha256(convert_to('helm-sales:' || v, 'UTF8')), 'hex') end;
end $$;

-- ---- 3) Contact sales + Suggestions: per-network daily cap + a shared bucket for "no address" (signed out) -------
-- (the marker r26-captcha-0276 below keeps a later re-run of 0276 from re-wrapping this wrapper)
create or replace function public.submit_sales_enquiry(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298 + r26-captcha-0276 (inside __pre0298): signed-out callers - 20 a day per network, 10 an hour in total for
-- callers without a readable address - then the 0276 security check and the 0271 form
declare v_net text;
begin
  if auth.uid() is null then
    v_net := public._r24s_ip_hash();
    if v_net is null then
      if public.rate_hit('sales.noip', 'noip', 3600, 10) > 0 then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'We are receiving many messages. Please try again a little later.'); end if;
    elsif public.rate_hit('sales.ipday', v_net, 86400, 20) > 0 then
      return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many messages from this network. Please try again tomorrow.'); end if;
  end if;
  return public.submit_sales_enquiry__pre0298(p);
end $$;

create or replace function public.submit_suggestion(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298 + r26-captcha-0276 (inside __pre0298): signed-out callers - 15 a day per network, 10 an hour in total for
-- callers without a readable address - then the 0276 security check and the 0271 form
declare v_net text;
begin
  if auth.uid() is null then
    v_net := public._r24s_ip_hash();
    if v_net is null then
      if public.rate_hit('sugg.noip', 'noip', 3600, 10) > 0 then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'We are receiving many messages. Please try again a little later.'); end if;
    elsif public.rate_hit('sugg.ipday', v_net, 86400, 15) > 0 then
      return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many messages from this network. Please try again tomorrow.'); end if;
  end if;
  return public.submit_suggestion__pre0298(p);
end $$;

-- ---- 4) masking helpers (G-HQ-1) - the same rules as public/hq.js maskEmail / maskPhone / maskId ------------------
create or replace function public._r57_mask_email(p text)
returns text language plpgsql immutable set search_path = '' as $$
-- r57-0298: "ab" + 3 dots + "@domain" (1 letter kept for a short name); never more than a hint
declare s text := btrim(coalesce(p, '')); d text := chr(8226); v_at int; loc text;
begin
  if p is null then return null; end if;
  if s = '' then return ''; end if;
  if position(d in s) > 0 then return s; end if;
  if position('@' in s) = 0 then return left(s, 1) || d || d || d; end if;
  v_at := length(s) - position('@' in reverse(s)) + 1;
  if v_at < 2 then return left(s, 1) || d || d || d; end if;
  loc := left(s, v_at - 1);
  return left(loc, case when length(loc) > 3 then 2 else 1 end) || d || d || d || substr(s, v_at);
end $$;

create or replace function public._r57_mask_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
-- r57-0298: dots + the last 2 digits (a "+cc " prefix written with a space / dash is kept)
declare s text := btrim(coalesce(p, '')); d text := chr(8226); dg text; cc text; rest text;
begin
  if p is null then return null; end if;
  if position(d in s) > 0 then return s; end if;
  dg := regexp_replace(s, '[^0-9]', '', 'g');
  if dg = '' then return ''; end if;
  cc := substring(s from '^\+([0-9]{1,3})[[:space:]-]');
  rest := case when cc is not null then substr(dg, length(cc) + 1) else dg end;
  return case when cc is not null then '+' || cc || ' ' else '' end || repeat(d, greatest(2, length(rest) - 2)) || right(rest, 2);
end $$;

create or replace function public._r57_mask_id(p text)
returns text language plpgsql immutable set search_path = '' as $$
-- r57-0298: first 2 + dots + last 2 (PAN, GSTIN, tax id, mandate reference); 4 or fewer characters: all dots
declare s text := regexp_replace(coalesce(p, ''), '[[:space:]]+', '', 'g'); d text := chr(8226);
begin
  if p is null then return null; end if;
  if s = '' then return ''; end if;
  if position(d in s) > 0 then return s; end if;
  if length(s) <= 4 then return repeat(d, length(s)); end if;
  return left(s, 2) || repeat(d, length(s) - 4) || right(s, 2);
end $$;

create or replace function public._r57_mask_obj(o jsonb, p_emails text[], p_phones text[], p_ids text[])
returns jsonb language plpgsql immutable set search_path = '' as $$
-- r57-0298: the named string keys of one object masked (anything else untouched)
declare r jsonb := o; k text;
begin
  if o is null or jsonb_typeof(o) <> 'object' then return o; end if;
  foreach k in array coalesce(p_emails, '{}'::text[]) loop
    if jsonb_typeof(r -> k) = 'string' then r := jsonb_set(r, array[k], to_jsonb(public._r57_mask_email(r ->> k))); end if; end loop;
  foreach k in array coalesce(p_phones, '{}'::text[]) loop
    if jsonb_typeof(r -> k) = 'string' then r := jsonb_set(r, array[k], to_jsonb(public._r57_mask_phone(r ->> k))); end if; end loop;
  foreach k in array coalesce(p_ids, '{}'::text[]) loop
    if jsonb_typeof(r -> k) = 'string' then r := jsonb_set(r, array[k], to_jsonb(public._r57_mask_id(r ->> k))); end if; end loop;
  return r;
end $$;

create or replace function public._r57_mask_rows(r jsonb, p_emails text[], p_phones text[])
returns jsonb language plpgsql immutable set search_path = '' as $$
-- r57-0298: {rows: [...]} with the named keys of every row masked; a "who" that is an e-mail address is masked too
declare v jsonb;
begin
  if r is null or jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'rows') <> 'array' then return r; end if;
  select coalesce(jsonb_agg(
           case when jsonb_typeof(m.e -> 'who') = 'string' and position('@' in m.e ->> 'who') > 0
                then jsonb_set(m.e, '{who}', to_jsonb(public._r57_mask_email(m.e ->> 'who'))) else m.e end order by m.n), '[]'::jsonb)
    into v
    from (select public._r57_mask_obj(x.e, p_emails, p_phones, '{}'::text[]) as e, x.n
            from jsonb_array_elements(r -> 'rows') with ordinality x(e, n)) m;
  return jsonb_set(r, '{rows}', v);
end $$;

-- ---- 5) HQ lists / detail: masked in the database (G-HQ-1 + G-HQ-7) ----------------------------------------------
create or replace function public.hq_studios(p_search text default null, p_status text default null, p_limit integer default 25, p_offset integer default 0)
returns table(org_id uuid, name text, slug text, created_at timestamp with time zone, owner_email text, users_count bigint,
              plan_code text, plan_name text, status text, current_period_end date, last_activity timestamp with time zone,
              total_paid numeric, country text, state text, primary_contact_name text, primary_contact_email text,
              primary_contact_phone text, total_count bigint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
-- r57-0298: the 0045 / 0277 list (gates + audit inside __pre0298) with e-mails / phones masked; search still uses the real values
begin
  perform public._hq27_require('studios.read', false);   -- refused here first (the inner body checks + audits again)
  return query
    select x.org_id, x.name, x.slug, x.created_at, public._r57_mask_email(x.owner_email), x.users_count, x.plan_code, x.plan_name,
           x.status, x.current_period_end, x.last_activity, x.total_paid, x.country, x.state, x.primary_contact_name,
           public._r57_mask_email(x.primary_contact_email), public._r57_mask_phone(x.primary_contact_phone), x.total_count
      from public.hq_studios__pre0298(p_search, p_status, p_limit, p_offset) x;
end $$;

create or replace function public.hq_users(p_search text default null, p_limit integer default 25, p_offset integer default 0)
returns table(user_id uuid, email text, studio text, org_id uuid, role text, created_at timestamp with time zone,
              last_sign_in_at timestamp with time zone, email_confirmed boolean, mfa_enabled boolean, total_count bigint)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
-- r57-0298: the 0029 / 0277 people list with the e-mail masked (hq_reveal('person', user_id, 'email') shows one)
begin
  perform public._hq27_require('people.read', false);
  return query
    select x.user_id, public._r57_mask_email(x.email), x.studio, x.org_id, x.role, x.created_at, x.last_sign_in_at,
           x.email_confirmed, x.mfa_enabled, x.total_count
      from public.hq_users__pre0298(p_search, p_limit, p_offset) x;
end $$;

create or replace function public.hq_studio_detail(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r57-0298: the 0045 detail with every e-mail / phone / GSTIN / PAN / tax id / mandate reference masked, and each
-- member's user_id (so HQ can reveal one member's e-mail)
declare r jsonb; v_m jsonb;
begin
  perform public._hq27_require('studios.read', false);
  r := public.hq_studio_detail__pre0298(p_org);
  if r is null or jsonb_typeof(r) <> 'object' then return r; end if;
  r := public._r57_mask_obj(r, array['owner_email'], '{}'::text[], '{}'::text[]);
  if jsonb_typeof(r -> 'account') = 'object' then
    r := jsonb_set(r, '{account}', public._r57_mask_obj(r -> 'account',
           array['primary_contact_email', 'secondary_contact_email', 'billing_contact_email'],
           array['primary_contact_phone', 'secondary_contact_phone'],
           array['gstin', 'pan', 'tax_id', 'payment_mandate_ref']));
  end if;
  if jsonb_typeof(r -> 'members') = 'array' then
    select coalesce(jsonb_agg(public._r57_mask_obj(x.e, array['email'], '{}'::text[], '{}'::text[])
             || case when x.e ? 'user_id' then '{}'::jsonb else jsonb_build_object('user_id',
                  (select p.id from public.profiles p left join auth.users u on u.id = p.id
                    where p.org_id = p_org and coalesce(u.email, p.email) = x.e ->> 'email' order by p.created_at, p.id limit 1)) end
             order by x.n), '[]'::jsonb)
      into v_m from jsonb_array_elements(r -> 'members') with ordinality x(e, n);
    r := jsonb_set(r, '{members}', v_m);
  end if;
  return r;
end $$;

create or replace function public.hq_sales_enquiries(p_status text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r57-0298: the 0271 inbox with e-mails / phones masked (hq_reveal('enquiry', id, 'email' | 'phone') shows one)
begin
  perform public._hq27_require('inbox.read', false);
  return public._r57_mask_rows(public.hq_sales_enquiries__pre0298(p_status), array['email'], array['phone']);
end $$;

create or replace function public.hq_sales_requests(p_status text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r57-0298: the 0244 plan requests with e-mails / phones masked (hq_reveal('request', id, ...))
begin
  perform public._hq27_require('inbox.read', false);
  return public._r57_mask_rows(public.hq_sales_requests__pre0298(p_status), array['contact_email'], array['contact_phone']);
end $$;

create or replace function public.hq_suggestions(p_status text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r57-0298: the 0271 suggestions with e-mails masked (hq_reveal('suggestion', id, 'email'))
begin
  perform public._hq27_require('inbox.read', false);
  return public._r57_mask_rows(public.hq_suggestions__pre0298(p_status), array['email'], '{}'::text[]);
end $$;

-- ---- 6) hq_reveal: role check, audit row and the real value in ONE call ------------------------------------------
create or replace function public.hq_reveal(p_entity text, p_entity_id text, p_field text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298
declare
  v_entity text := lower(btrim(coalesce(p_entity, ''))); v_field text := lower(btrim(coalesce(p_field, '')));
  v_id text := btrim(coalesce(p_entity_id, '')); v_uuid uuid; v_perm text; v_col text; v_val text; v_acc jsonb;
begin
  if v_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_uuid := v_id::uuid; end if;
  v_perm := case
    when v_entity = 'studio' and v_field in ('owner_email', 'email', 'phone', 'billing_email', 'secondary_email', 'secondary_phone', 'gstin') then 'studios.read'
    when v_entity = 'studio' and v_field in ('pan', 'tax_id', 'payment_mandate_ref') then 'billing.read'
    when v_entity = 'studio' and v_field = 'business_details' then 'studios.edit'
    when v_entity = 'member' and v_field in ('email', 'member_email') then 'studios.read'
    when v_entity = 'person' and v_field = 'email' then 'people.read'
    when v_entity in ('request', 'enquiry') and v_field in ('email', 'reply_email', 'phone') then 'inbox.read'
    when v_entity = 'suggestion' and v_field in ('email', 'reply_email') then 'inbox.read'
    else null end;
  if v_perm is null then raise exception 'bad entity or field' using errcode = '22023'; end if;
  -- the HQ role (+ two-step, session rules) BEFORE anything is looked up
  perform public._hq27_require(v_perm, false);
  if v_uuid is null then raise exception 'bad id' using errcode = '22023'; end if;
  if v_entity = 'studio' then
    if v_field = 'business_details' then
      v_acc := coalesce((select to_jsonb(a) - 'org_id' from public.studio_account a where a.org_id = v_uuid), '{}'::jsonb);
    elsif v_field = 'owner_email' or v_field = 'email' then
      v_val := case when v_field = 'email' then (select nullif(btrim(a.primary_contact_email), '') from public.studio_account a where a.org_id = v_uuid) end;
      if v_val is null then v_val := (select s.owner_email from public._hq_studio_rows() s where s.org_id = v_uuid); end if;
    else
      v_col := case v_field when 'phone' then 'primary_contact_phone' when 'billing_email' then 'billing_contact_email'
                            when 'secondary_email' then 'secondary_contact_email' when 'secondary_phone' then 'secondary_contact_phone'
                            else v_field end;
      execute format('select a.%I::text from public.studio_account a where a.org_id = $1', v_col) into v_val using v_uuid;
    end if;
  elsif v_entity in ('member', 'person') then
    v_val := (select coalesce(u.email::text, p.email) from auth.users u full join public.profiles p on p.id = u.id
               where coalesce(u.id, p.id) = v_uuid limit 1);
  elsif v_entity = 'request' then
    v_val := (select case when v_field = 'phone' then r.contact_phone else r.contact_email end from public.sales_requests r where r.id = v_uuid);
  elsif v_entity = 'enquiry' then
    v_val := (select case when v_field = 'phone' then e.phone else e.email end from public.sales_enquiries e where e.id = v_uuid);
  elsif v_entity = 'suggestion' then
    v_val := (select g.email from public.suggestions g where g.id = v_uuid);
  end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, 'hq.reveal', v_entity, v_uuid::text, jsonb_build_object('field', v_field), null, now()
      from auth.users u where u.id = auth.uid();
  if v_field = 'business_details' then return jsonb_build_object('ok', true, 'field', v_field, 'account', v_acc); end if;
  return jsonb_build_object('ok', true, 'field', v_field, 'value', v_val);
end $$;

-- ---- 7) partner codes: billing.write + a fresh two-step code (G-HQ-2) ---------------------------------------------
create or replace function public.hq_partner_code_upsert(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298: billing.write (Owner / Admin) + two-step + a fresh code, then the 0279 body (audited there)
begin
  perform public._hq27_require('billing.write', true);
  return public.hq_partner_code_upsert__pre0298(p);
end $$;

create or replace function public.hq_partner_code_set_active(p_code text, p_active boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298: billing.write (Owner / Admin) + two-step + a fresh code, then the 0279 body (audited there)
begin
  perform public._hq27_require('billing.write', true);
  return public.hq_partner_code_set_active__pre0298(p_code, p_active);
end $$;

create or replace function public.hq_referral_attach(p_org uuid, p_code text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298: billing.write (Owner / Admin) + two-step + a fresh code, then the 0279 body (audited there)
begin
  perform public._hq27_require('billing.write', true);
  return public.hq_referral_attach__pre0298(p_org, p_code, p_note);
end $$;

-- ---- 8) hq_mfa_reset: role first, HQ team targets Owner only (G-HQ-3) -------------------------------------------
create or replace function public.hq_mfa_reset(p_email text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298 (r22-mfa-reset-0253 body; the role + fresh-code check moved BEFORE any e-mail lookup; HQ team targets: Owner only)
declare
  v_me     uuid := auth.uid();
  v_aal    text := coalesce(auth.jwt() ->> 'aal', '');
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_target uuid; v_temail text; v_memail text; v_n int := 0; v_recent int; me public.platform_admins;
begin
  -- who may: an HQ operator whose own session passed two-step, always (independent of hq_require_mfa)
  if v_me is null or not public.is_platform_admin() or v_aal <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501',
      hint = 'Only a Helm HQ operator signed in with two-step verification can reset two-step for someone else.';
  end if;
  -- r57: the HQ role (security.write) + a fresh two-step code FIRST - nothing is looked up for anyone else
  perform public._hq27_require('security.write', true);
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'Enter the person''s e-mail address.' using errcode = '22023'; end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'Give a reason of 10 to 500 characters (for example how you confirmed who they are).' using errcode = '22023';
  end if;
  select u.id, u.email into v_target, v_temail from auth.users u where lower(u.email) = v_email order by u.created_at limit 1;
  if v_target is null then raise exception 'No Helm account uses that e-mail address.' using errcode = 'P0002'; end if;
  -- no self-bypass: never your own account (another operator, or the owner's SQL-editor runbook)
  if v_target = v_me then
    raise exception 'You can''t reset your own two-step. Ask another Helm HQ operator to do it.' using errcode = '42501';
  end if;
  -- r57: a Helm HQ team member's two-step (any HQ role, the Owner included) is reset only by the HQ Owner
  select * into me from public._hq27_me();
  if exists (select 1 from public.platform_admins pa
              where (pa.email = lower(v_temail) or pa.user_id = v_target) and coalesce(pa.status, '') <> 'removed')
     and coalesce(me.role, '') <> 'owner' then
    raise exception 'Only the Helm HQ Owner can reset the two-step of a Helm HQ team member.' using errcode = '42501';
  end if;
  select count(*) into v_recent from public.mfa_resets r where r.operator_user_id = v_me and r.at > now() - interval '24 hours';
  if v_recent >= 10 then raise exception 'Too many two-step resets in the last 24 hours. Try again tomorrow.' using errcode = 'P0001'; end if;
  if to_regclass('auth.mfa_factors') is null then raise exception 'Two-step verification is not available on this database.' using errcode = 'P0001'; end if;
  execute 'select count(*) from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'''
    into v_n using v_target;
  if coalesce(v_n, 0) = 0 then
    return jsonb_build_object('ok', true, 'factors_reset', 0, 'message', 'This account has no two-step set up - nothing to reset.');
  end if;
  -- audited HQ write (refuses again if the caller is not an operator)
  perform public._hq_wgate('hq.mfa.reset', 'auth_user', v_target::text,
    jsonb_build_object('email', v_temail, 'factors', v_n, 'reason', v_reason));
  -- mark (never delete) the verified authenticator(s) as unverified
  execute 'update auth.mfa_factors set status = ''unverified'', updated_at = now() where user_id = $1 and status::text = ''verified'''
    using v_target;
  get diagnostics v_n = row_count;
  select u.email into v_memail from auth.users u where u.id = v_me;
  insert into public.mfa_resets(target_user_id, target_email, operator_user_id, operator_email, reason, factors_reset)
    values (v_target, v_temail, v_me, v_memail, v_reason, v_n);
  return jsonb_build_object('ok', true, 'factors_reset', v_n,
    'message', 'Two-step reset. At their next sign-in they use their password (or Google) only and Helm asks them to set two-step up again.');
end $$;

-- ---- 9) studio credits: reason >= 15 characters, at most 5 grants per HQ person per 24 hours (G-HQ-6) ------------
create or replace function public.hq_grant_studio_credit(p_org uuid, p_kind text, p_months integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r57-0298 (r28-hq-v2-0280 body + a longer reason + a daily cap per HQ person)
  v_kind text := lower(btrim(coalesce(p_kind, ''))); v_reason text := btrim(coalesce(p_reason, '')); v_id uuid; v_email text;
begin
  perform public._hq27_require('billing.write', true);   -- role + two-step + a fresh code for this change
  if v_kind not in ('referral', 'goodwill', 'promo') then raise exception 'kind must be referral, goodwill or promo' using errcode = '22023'; end if;
  if p_months is null or p_months < 1 or p_months > 12 then raise exception 'a credit is 1 to 12 months' using errcode = '22023'; end if;
  if char_length(v_reason) < 15 or char_length(v_reason) > 500 then
    raise exception 'give a reason of 15 to 500 characters (why this studio gets free months)' using errcode = '22023'; end if;
  if not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'studio not found' using errcode = '22023'; end if;
  select u.email into v_email from auth.users u where u.id = auth.uid();
  if (select count(*) from public.hq_studio_credits c where c.granted_by = v_email and c.granted_at > now() - interval '24 hours') >= 5 then
    raise exception 'You have granted 5 credits in the last 24 hours - the most one HQ person can grant in a day. Try again tomorrow or ask another HQ admin.'
      using errcode = 'P0001';
  end if;
  insert into public.hq_studio_credits(org_id, kind, months, reason, granted_by) values (p_org, v_kind, p_months, v_reason, v_email) returning id into v_id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), v_email, 'hq.credit.grant', 'organization', p_org::text, jsonb_build_object('kind', v_kind, 'months', p_months, 'credit_id', v_id), null, now());
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---- 10) referral codes: no existence oracle (G-HQ-4) ------------------------------------------------------------
-- true when this network already asked about 20 codes that don't work within the hour (peek, nothing counted)
create or replace function public._r57_ref_misses_over(p_net text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r57-0298
  select exists (select 1 from public.referral_rate_buckets b
                  where b.bucket = 'lkm:' || left(coalesce(p_net, 'none'), 32) and b.window_start >= now() - interval '1 hour' and b.n >= 20)
$$;

create or replace function public.referral_click(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298 (r29-referrals-0279): one answer {ok:true} for every code; the per-network limit runs BEFORE the look-up
declare v text := upper(btrim(coalesce(p_code, ''))); v_net text := coalesce(public._r29_hash('ip', public._r29_net()), 'none');
begin
  if v !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then return jsonb_build_object('ok', true); end if;
  if not public._r29_rate('ckn:' || left(v_net, 32), 120) or public._r57_ref_misses_over(v_net) then return jsonb_build_object('ok', true); end if;
  if not exists (select 1 from public.referral_codes c where c.code = v) then
    perform public._r29_rate('lkm:' || left(v_net, 32), 1000000);           -- a miss counts toward the look-up limit
    return jsonb_build_object('ok', true); end if;
  if not public._r29_rate('ck:' || left(v_net, 32) || ':' || v, 3) or not public._r29_rate('ck:all', 20000) then
    return jsonb_build_object('ok', true); end if;
  insert into public.referral_click_days(code, day, clicks) values (v, (now() at time zone 'Asia/Kolkata')::date, 1)
  on conflict (code, day) do update set clicks = public.referral_click_days.clicks + 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.referral_lookup(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298 (r29-referrals-0279): unknown and switched-off codes give the same "unknown" (program off: "off" for every
-- code); 20 misses an hour per network and every look-up from that network answers "rate" until the hour is over
declare v text := upper(btrim(coalesce(p_code, ''))); c public.referral_codes; v_prob text;
  v_net text := coalesce(public._r29_hash('ip', public._r29_net()), 'none');
begin
  if v !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then return jsonb_build_object('ok', false, 'reason', 'shape'); end if;
  -- r29c REF-03: per network only - a shared "everyone" counter let one sender block the look-up for all visitors
  if not public._r29_rate('lk:' || left(v_net, 32), 60) or public._r57_ref_misses_over(v_net) then
    return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  -- program switched off: the same "off" for every code (known or not)
  if not coalesce((public._r29_cfg()).program_on, false) then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  select * into c from public.referral_codes where code = v;
  v_prob := public._r29_code_problem(c);
  if v_prob in ('unknown', 'inactive') then
    perform public._r29_rate('lkm:' || left(v_net, 32), 1000000);
    return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  if v_prob <> '' then return jsonb_build_object('ok', false, 'reason', v_prob); end if;
  return jsonb_build_object('ok', true, 'code', c.code, 'kind', case when c.kind = 'studio' then 'referral' else 'partner' end,
    'offer', public._r29_offer(c), 'offer_type', c.offer_type, 'months', c.offer_months, 'percent', c.offer_percent,
    'for_months', c.offer_for_months, 'ends_at', c.ends_at, 'terms', c.terms);
end $$;

-- ---- 11) sign-up: never says which helm.events addresses are on the staff list (A-1) -----------------------------
create or replace function public.signup_email_preauthorised(p_email text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298 (r27-hq-staff-0277 told "listed" from "not listed"): true for EVERY address on a Helm domain, so the sign-up
-- page lets the server decide (its before-user-created hook / guards still refuse an address that is not listed).
-- 30 asks per 10 minutes per network; over that the early "reserved" message shows (false) - same for everyone.
declare v text := lower(btrim(coalesce(p_email, ''))); v_net text;
begin
  if v = '' or length(v) > 254 or position('@' in v) < 2 then return false; end if;
  if to_regprocedure('public.reserved_email_domain(text)') is null then return false; end if;
  v_net := encode(pg_catalog.sha256(convert_to('helm-preauth:' || coalesce(public._r57_client_net(), 'noip'), 'UTF8')), 'hex');
  if public.rate_hit('preauth.ip', v_net, 600, 30) > 0 then return false; end if;
  return public.reserved_email_domain(v) is not null;
end $$;

-- ---- 12) member_profile_list: deactivated + e-mail names hidden below Users-view; crew / client: names + roles (A-3)
create or replace function public.member_profile_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r57-0298 (0041 body): levels 1 / 2 (Users view / admin) unchanged - they manage deactivated people too
declare v_org uuid := public.current_org_id(); v_level int; v_me uuid := auth.uid(); v_role text;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_level := case when public.is_admin() then 2 when public.has_area('users', 'view') then 1 else 0 end;
  if v_level >= 1 then
    return coalesce((select jsonb_agg(public._mp_row_json(p.id, case when p.id = v_me then greatest(v_level, 1) else v_level end)
                                      order by lower(coalesce(p.full_name, p.email, '')), p.id)
                       from public.profiles p where p.org_id = v_org), '[]'::jsonb);
  end if;
  v_role := (select p.role from public.profiles p where p.id = v_me);
  return coalesce((select jsonb_agg(
             case when p.id = v_me then public._mp_row_json(p.id, 1)
                  when v_role in ('crew', 'worker', 'client') then jsonb_build_object('user_id', p.id, 'full_name', p.full_name, 'role', p.role)
                  else public._mp_row_json(p.id, 0) - 'email_name' end
             order by lower(coalesce(p.full_name, '')), p.id)
           from public.profiles p
          where p.org_id = v_org
            and (p.id = v_me or not exists (select 1 from public.team_member_status s
                                              where s.user_id = p.id and s.org_id = v_org and s.status = 'deactivated'))), '[]'::jsonb);
end $$;

-- ---- 13) grants: same callers as before; the new helpers are internal --------------------------------------------
do $$
declare f text;
begin
  -- internal helpers: no API access
  foreach f in array array['public._r57_ip_internal(inet)', 'public._r57_trusted_ip()', 'public._r57_client_net()',
                           'public._r31_client_ip()', 'public._r29_net()', 'public._r24s_ip_hash()',
                           'public._r57_mask_email(text)', 'public._r57_mask_phone(text)', 'public._r57_mask_id(text)',
                           'public._r57_mask_obj(jsonb,text[],text[],text[])', 'public._r57_mask_rows(jsonb,text[],text[])',
                           'public._r57_ref_misses_over(text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
  -- signed-in only (HQ functions check the HQ role inside; member_profile_list checks the studio)
  foreach f in array array['public.hq_studios(text,text,integer,integer)', 'public.hq_users(text,integer,integer)',
                           'public.hq_studio_detail(uuid)', 'public.hq_sales_enquiries(text)', 'public.hq_sales_requests(text)',
                           'public.hq_suggestions(text)', 'public.hq_reveal(text,text,text)', 'public.hq_partner_code_upsert(jsonb)',
                           'public.hq_partner_code_set_active(text,boolean)', 'public.hq_referral_attach(uuid,text,text)',
                           'public.hq_mfa_reset(text,text)', 'public.hq_grant_studio_credit(uuid,text,integer,text)',
                           'public.member_profile_list()'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
  end loop;
  -- signed out too (rate-limited inside)
  foreach f in array array['public.submit_sales_enquiry(jsonb)', 'public.submit_suggestion(jsonb)', 'public.referral_click(text)',
                           'public.referral_lookup(text)', 'public.signup_email_preauthorised(text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function ' || f || ' to anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
  end loop;
end $$;

-- ---- 14) invitations: the browser can't read token / mail_key_hash (A-5 / I-04) -------------------------------------
-- A column REVOKE is ignored while the table-wide SELECT stays, so: table-wide SELECT off, then SELECT on every other
-- column back (the same row policies apply). Update / delete privileges are untouched (Revoke still works).
-- Revoking the table-wide privilege also drops column grants, so the column grants are (re)made after it.
do $$
declare c text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then return; end if;
  if has_table_privilege('authenticated', 'public.invitations', 'select') then
    execute 'revoke select on public.invitations from authenticated';
    for c in select a.attname from pg_attribute a where a.attrelid = 'public.invitations'::regclass and a.attnum > 0
               and not a.attisdropped and a.attname not in ('token', 'mail_key_hash') order by a.attnum loop
      execute format('grant select (%I) on public.invitations to authenticated', c);
    end loop;
  end if;
  execute 'revoke select (token, mail_key_hash) on public.invitations from authenticated';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke select (token, mail_key_hash) on public.invitations from anon';
  end if;
end $$;

notify pgrst, 'reload schema';
