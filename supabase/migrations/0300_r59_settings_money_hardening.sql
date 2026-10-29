-- 0300_r59_settings_money_hardening.sql - CANONICAL forward-only.
-- R59 audit fixes (2026-10-28 audit groups F-settings, E-money, B-shell). Database part.
-- REQUIRES (all on production): base (set_pricing_config, admin_get_role_access, app_config, audit_log, role_access),
--   0045 (my_studio_account, studio_account), 0051 (upload_scan_bucket, upload_scans), 0035 (chat card guard),
--   0041 (chat_directory__base, member_profiles), 0061 (studio_search), 0075 (organizations.business_email_confirmed),
--   0078 / 0150 (comms_settings.studio_whatsapp), 0157 + 0181 (privacy_pin_reset), 0164 (_audit_redact),
--   0173 (_tl173_guard), 0256 (_vr256_public, vendor_invoices), 0283 (_r283_is_off, _r283_owner),
--   0285 (_r285_step_up, admin_set_role_access money-switch wrapper). NOT 0117 (nothing here needs it).
--
-- In plain words (what was wrong -> what this changes):
--   F-2  Settings > Pricing: anyone with Settings edit could save ANY pricing (negative prices, text, GST 0, service
--        charge 0) with no check and no record. Now set_pricing_config checks every number (numbers only, never
--        negative, GST / catering GST 0-28 %, service charge 0-25 %, prices up to Rs 1,00,00,000, set-up fee up to
--        Rs 10,00,00,000, booking gap 0-48 h, item prices 0 - Rs 10,00,00,000), needs a studio admin or someone with
--        "Approve discounts", and writes an audit_log row with the old and new value of every changed field.
--        The same table could also be written straight through the API (RLS "cfg write"); the 'pricing' row can now
--        only be changed through set_pricing_config (trigger, API roles only - the database itself is unaffected).
--   F-3  admin_get_role_access (the whole access matrix) answered every signed-in member; now studio admins and
--        people with "Users & access" view only (anyone else 42501).
--   F-4  my_studio_account gave every member (crew, sales ...) the billing address, GSTIN, legal name and contact
--        e-mails; those now go only to admins, Finance view and Users edit (the people who edit / pay).
--   F-5  "Control Center" in database messages: the live user-facing texts already say "Settings" (0291); this file
--        re-checks every live function and, should one still carry "Control Center" outside a comment, edits that
--        text in place to "Settings" (previous body kept). Rows already stored are not changed.
--   F-9  admin_set_role_access accepted any area name (junk rows); now only known areas (or one the studio already
--        has a row for). Privacy PIN reset (back to 0000) needed only a sign-in in the last 15 minutes; it now
--        needs a fresh two-step code (the 0285 check, same as payment details).
--   F-1  (database half) NEW integrations_wa_test_target(): the "Send test WhatsApp" target for STUDIO ADMINS only,
--        and only when the studio WhatsApp number is the saved mobile of an active member of the same studio
--        (the integrations-test edge function adds the STOP list, the trial guard and a daily cap).
--   E-03 NEW studio_billing_email(org) (service role only): Helm payment / billing mails go to the studio e-mail
--        only once it is confirmed; otherwise to the studio owner's (else the first active admin's) login e-mail.
--   E-05 Vendor invoice upload: the database now refuses an invoice whose stored file type does not match its
--        name (pdf / jpg / png / webp), whose uploaded Content-Type differs, that is empty / over 10 MB, or that the
--        upload check rejected; the vendor-invoices bucket joins the 0051 upload check (verify-upload reads the
--        first bytes when the owner turns the checker on). Existing invoice files are marked clean (unchanged).
--   E-06 Public vendor link: the event is shown as its type (e.g. "Wedding") + date, never the quote title, which
--        often carries the client's name.
--   E-08 Audit log redaction also hides mail_key_hash, key_secret, webhook_secret, upi_id and every *_hash field.
--   BS-04 Chat quote cards: the server rebuilds a quote card from the real quote (code, title, stage, date - never
--        the total or the client) and refuses a card for a quote outside the studio or one the sender cannot view.
--   BS-05 Studio search: deactivated members are no longer listed under Team.
--   BS-06 Chat directory: the e-mail local part is returned only to admins / Users view (others get null).
--
-- ZERO DATA LOSS: functions are re-issued IN PLACE (same name, arguments, result, grants; previous body kept once
-- as <name>__pre0300 with no API privilege). New: 3 functions, 3 trigger functions + 3 triggers, helpers. No table,
-- column, row (except: upload_scans rows ADDED for existing vendor invoice files, status clean), policy or index
-- is dropped or deleted. Additive + idempotent: safe to run twice. ASCII only.
-- NOTE: re-running APPLY-0285 later re-creates admin_set_role_access from 0285 - run APPLY-0300 again after it.

-- ---- 0) preflight -----------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.set_pricing_config(jsonb)') is null or to_regprocedure('public.admin_get_role_access()') is null
     or to_regclass('public.app_config') is null or to_regclass('public.audit_log') is null or to_regclass('public.role_access') is null then
    raise exception 'STOP 0300: base objects missing (set_pricing_config / admin_get_role_access / app_config / audit_log / role_access)'; end if;
  if to_regprocedure('public.admin_set_role_access(text,text,boolean,boolean)') is null then
    raise exception 'STOP 0300: admin_set_role_access missing'; end if;
  if to_regprocedure('public.my_studio_account()') is null then raise exception 'STOP 0300: my_studio_account missing - run 0045 first'; end if;
  if to_regprocedure('public.privacy_pin_reset()') is null or to_regprocedure('public._pp_org()') is null
     or to_regprocedure('public._pp_clear(uuid)') is null or to_regprocedure('public._tl173_guard()') is null then
    raise exception 'STOP 0300: privacy PIN (0157) / trial guard (0173) missing'; end if;
  if to_regprocedure('public._r285_step_up(uuid)') is null then raise exception 'STOP 0300: _r285_step_up missing - run 0285 first'; end if;
  if to_regprocedure('public._r283_is_off(uuid,uuid)') is null or to_regprocedure('public._r283_owner(uuid)') is null then
    raise exception 'STOP 0300: 0283 helpers missing - run 0283 first'; end if;
  if to_regprocedure('public._audit_redact(jsonb,boolean)') is null then raise exception 'STOP 0300: _audit_redact missing - run 0164 first'; end if;
  if to_regprocedure('public._vr256_public(public.vendor_requests)') is null or to_regclass('public.vendor_invoices') is null then
    raise exception 'STOP 0300: vendor requests (0256) missing'; end if;
  if to_regprocedure('public.studio_search(text,integer)') is null then raise exception 'STOP 0300: studio_search missing - run 0061 first'; end if;
  if to_regprocedure('public.chat_directory()') is null or to_regprocedure('public.chat_directory__base()') is null then
    raise exception 'STOP 0300: chat_directory (0041) missing'; end if;
  if to_regprocedure('public.upload_scan_bucket(text)') is null or to_regclass('public.upload_scans') is null then
    raise exception 'STOP 0300: upload check (0051) missing'; end if;
  if to_regclass('public.chat_messages') is null or to_regclass('public.chat_conversations') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'meta') then
    raise exception 'STOP 0300: chat (0016 / 0035) missing'; end if;
  if to_regclass('public.comms_settings') is null or to_regclass('public.member_profiles') is null then
    raise exception 'STOP 0300: comms_settings (0078) / member_profiles (0041) missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'business_email_confirmed') then
    raise exception 'STOP 0300: organizations.business_email_confirmed (0075) missing'; end if;
end $$;

-- ---- 1) keep a function's current body once as <name>__pre0300 (no API privilege) --------------------------------
create or replace function public._r300_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r59-0300: copy (never rename - triggers / policies stay bound to the live function) the current body once
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text;
begin
  if v_oid is null then return; end if;
  select p.proname, oidvectortypes(p.proargtypes) into v_name, v_types from pg_proc p where p.oid = v_oid;
  v_pre := format('public.%I(%s)', v_name || '__pre0300', v_types);
  if to_regprocedure(v_pre) is not null then return; end if;
  v_def := pg_get_functiondef(v_oid);
  v_def := regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                          'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0300(');
  if position(v_name || '__pre0300(' in v_def) = 0 then raise exception 'r59-0300: could not keep %', p_fn; end if;
  execute v_def;
  execute format('revoke all on function %s from public', v_pre);
  if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_pre); end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_pre); end if;
end $$;
revoke all on function public._r300_keep(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r300_keep(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r300_keep(text) from authenticated; end if;
end $$;

select public._r300_keep(f) from unnest(array[
  'public.set_pricing_config(jsonb)', 'public.admin_get_role_access()', 'public.my_studio_account()',
  'public.admin_set_role_access(text,text,boolean,boolean)', 'public.privacy_pin_reset()', 'public._audit_redact(jsonb,boolean)',
  'public._vr256_public(public.vendor_requests)', 'public.studio_search(text,integer)', 'public.chat_directory()',
  'public.upload_scan_bucket(text)']) f;

-- ---- 2) F-2 pricing: validate, gate, audit -------------------------------------------------------------------------
-- the checked copy of a pricing value, or an exception with a plain message (22023). Numeric text ("250") of the
-- known number fields is stored as a number; anything else that is not a number is refused.
create or replace function public._r300_pricing_clean(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
-- r59-0300
declare v jsonb := p; k text; x jsonb; n numeric; lim numeric; lbl text; a jsonb := '{}'::jsonb; ak text; av jsonb; cnt int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Pricing must be a set of named values.' using errcode = '22023'; end if;
  if octet_length(p::text) > 262144 then raise exception 'Pricing is too large to save.' using errcode = '22023'; end if;
  foreach k in array array['chairPrice', 'platePrice', 'layoutBase', 'conflictBufferHours', 'gstPct', 'cateringGstPct', 'serviceChargePct'] loop
    x := p -> k;
    continue when x is null or x = 'null'::jsonb;
    lbl := case k when 'chairPrice' then 'Price per chair' when 'platePrice' then 'Price per plate' when 'layoutBase' then 'Layout & setup fee'
                  when 'conflictBufferHours' then 'Venue booking gap' when 'gstPct' then 'Tax %' when 'cateringGstPct' then 'Catering tax %'
                  else 'Service charge %' end;
    if jsonb_typeof(x) = 'string' and btrim(x #>> '{}') ~ '^[0-9]{1,12}(\.[0-9]{1,4})?$' then
      x := to_jsonb(btrim(x #>> '{}')::numeric); v := jsonb_set(v, array[k], x);
    end if;
    if jsonb_typeof(x) <> 'number' then raise exception '% must be a number.', lbl using errcode = '22023'; end if;
    n := (x #>> '{}')::numeric;
    if n < 0 then raise exception '% cannot be negative.', lbl using errcode = '22023'; end if;
    lim := case k when 'gstPct' then 28 when 'cateringGstPct' then 28 when 'serviceChargePct' then 25 when 'conflictBufferHours' then 48
                  when 'layoutBase' then 100000000 else 10000000 end;
    if n > lim then
      raise exception '% can be 0 to %.', lbl, case when k in ('gstPct', 'cateringGstPct', 'serviceChargePct') then lim::text || '%'
                                                 when k = 'conflictBufferHours' then lim::text || ' hours' else 'Rs ' || lim::text end
        using errcode = '22023';
    end if;
  end loop;
  x := p -> 'assetPrices';
  if x is not null and x <> 'null'::jsonb then
    if jsonb_typeof(x) <> 'object' then raise exception 'Item prices must be a list of item prices.' using errcode = '22023'; end if;
    for ak, av in select e.key, e.value from jsonb_each(x) e loop
      cnt := cnt + 1;
      if cnt > 3000 then raise exception 'Too many item prices.' using errcode = '22023'; end if;
      if char_length(ak) > 80 or ak !~ '^[A-Za-z0-9_.:-]+$' then raise exception 'An item price has an unknown item name.' using errcode = '22023'; end if;
      if av is null or av = 'null'::jsonb then a := a || jsonb_build_object(ak, av); continue; end if;
      if jsonb_typeof(av) = 'string' and btrim(av #>> '{}') = '' then a := a || jsonb_build_object(ak, av); continue; end if;
      if jsonb_typeof(av) = 'string' and btrim(av #>> '{}') ~ '^[0-9]{1,12}(\.[0-9]{1,4})?$' then av := to_jsonb(btrim(av #>> '{}')::numeric); end if;
      if jsonb_typeof(av) <> 'number' then raise exception 'Item prices must be numbers.' using errcode = '22023'; end if;
      n := (av #>> '{}')::numeric;
      if n < 0 then raise exception 'Item prices cannot be negative.' using errcode = '22023'; end if;
      if n > 100000000 then raise exception 'An item price can be at most Rs 100000000.' using errcode = '22023'; end if;
      a := a || jsonb_build_object(ak, av);
    end loop;
    v := jsonb_set(v, '{assetPrices}', a);
  end if;
  x := p -> 'taxInclusive';
  if x is not null and x <> 'null'::jsonb and jsonb_typeof(x) <> 'boolean' then
    raise exception 'Prices include tax must be on or off.' using errcode = '22023'; end if;
  foreach k in array array['currency', 'country', 'taxCountry', 'taxRegion', 'taxName'] loop
    x := p -> k;
    continue when x is null or x = 'null'::jsonb;
    if jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') > 40 or (x #>> '{}') ~ '[<>"`\\]' then
      raise exception 'Pricing field % is not valid.', k using errcode = '22023'; end if;
  end loop;
  return v;
end $$;
revoke all on function public._r300_pricing_clean(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r300_pricing_clean(jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r300_pricing_clean(jsonb) from authenticated; end if;
end $$;

create or replace function public.set_pricing_config(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r59-0300: checked numbers + admin / "Approve discounts" + audit (old -> new per changed field)
declare v_org uuid := public.current_org_id(); v_new jsonb; v_old jsonb; v_changed jsonb := '{}'::jsonb; k text;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('controls', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not (coalesce(public.is_admin(), false) or coalesce(public.has_area('discount_approve', 'edit'), false)) then
    raise exception 'Only a studio admin, or someone allowed to "Approve discounts", can change pricing.'
      using errcode = '42501', hint = 'pricing_right'; end if;
  v_new := public._r300_pricing_clean(p);
  select c.value into v_old from public.app_config c where c.org_id = v_org and c.key = 'pricing' for update;
  insert into public.app_config(org_id, key, value, updated_at) values (v_org, 'pricing', v_new, now())
    on conflict (org_id, key) do update set value = excluded.value, updated_at = now();
  for k in select x from (select jsonb_object_keys(coalesce(v_old, '{}'::jsonb)) x union select jsonb_object_keys(v_new)) s loop
    continue when (coalesce(v_old, '{}'::jsonb) -> k) is not distinct from (v_new -> k);
    if k = 'assetPrices' then
      v_changed := v_changed || jsonb_build_object(k, jsonb_build_object('changed_items',
        (select count(*) from (select e.key from jsonb_each(coalesce(v_old -> k, '{}'::jsonb)) e
                                union select e.key from jsonb_each(coalesce(v_new -> k, '{}'::jsonb)) e) z
          where (coalesce(v_old -> k, '{}'::jsonb) -> z.key) is distinct from (coalesce(v_new -> k, '{}'::jsonb) -> z.key))));
    else
      v_changed := v_changed || jsonb_build_object(k, jsonb_build_object('old', coalesce(v_old, '{}'::jsonb) -> k, 'new', v_new -> k));
    end if;
  end loop;
  if v_changed <> '{}'::jsonb then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id)
      select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'pricing.update', 'app_config', 'pricing', v_changed, v_org;
  end if;
  return v_new;
end $$;

-- the 'pricing' row: only through set_pricing_config when the caller is an API role (RLS "cfg write" allowed a
-- direct write with no checks). The database itself (functions, cron, migrations) is not affected.
create or replace function public._r300_tg_cfg_pricing()
returns trigger language plpgsql set search_path = '' as $$
-- r59-0300 (SECURITY INVOKER on purpose: current_user is the API role only for a direct table write)
begin
  if current_user in ('authenticated', 'anon')
     and ((tg_op in ('INSERT', 'UPDATE') and new.key = 'pricing') or (tg_op in ('UPDATE', 'DELETE') and old.key = 'pricing')) then
    raise exception 'Pricing is changed with Save pricing in Settings.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public._r300_tg_cfg_pricing() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r300_tg_cfg_pricing() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r300_tg_cfg_pricing() from authenticated; end if;
end $$;
drop trigger if exists a300_cfg_pricing_guard on public.app_config;
create trigger a300_cfg_pricing_guard before insert or update or delete on public.app_config
  for each row execute function public._r300_tg_cfg_pricing();

-- ---- 3) F-3 the access matrix: admins + "Users & access" view only ------------------------------------------------
create or replace function public.admin_get_role_access()
returns setof public.role_access language plpgsql stable security definer set search_path = '' as $$
-- r59-0300
begin
  if auth.uid() is null or public.current_org_id() is null
     or not (coalesce(public.is_admin(), false) or coalesce(public.has_area('users', 'view'), false)) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return query select * from public.role_access r where r.org_id = public.current_org_id() order by r.role, r.area;
end $$;

-- ---- 4) F-4 studio account: billing / tax / contact e-mails only for admins, Finance view, Users edit -------------
create or replace function public.my_studio_account()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r59-0300 (0045 body + the money / contact fields only for the people who edit or pay)
declare v_org uuid := public.current_org_id(); r jsonb; v_edit boolean; v_money boolean;
begin
  if v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  begin perform public._studio_account_prefill(v_org); exception when others then null; end;   -- empty fields only
  select to_jsonb(a) into r from public.studio_account a where a.org_id = v_org;
  r := coalesce(r, jsonb_build_object('org_id', v_org));
  v_edit := coalesce(public.is_admin(), false) or coalesce(public.has_area('users', 'edit'), false);
  v_money := v_edit or coalesce(public.has_area('finance', 'view'), false);
  if not v_edit then
    r := r - 'primary_contact_phone' - 'secondary_contact_phone' - 'updated_by';
  end if;
  if not v_money then
    r := r - 'billing_address' - 'gstin' - 'legal_business_name' - 'primary_contact_email' - 'secondary_contact_email' - 'billing_contact_email';
  end if;
  return r || jsonb_build_object('can_edit', v_edit);
end $$;

-- ---- 5) F-9a the access matrix accepts known areas only -----------------------------------------------------------
create or replace function public._r300_area_ok(p_area text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r59-0300: the areas the app knows (store-api AREAS + server-only areas), or one this studio already has a row for
  select coalesce(p_area, '') ~ '^[a-z][a-z0-9_]{1,39}$'
     and (p_area = any (array['leads', 'crm', 'nurture', 'discovery', 'proposal', 'quotes', 'quote_create', 'layouts', 'design',
                              'photo_render', 'staff', 'inventory', 'vendors', 'calendar', 'templates', 'venues', 'resources', 'runsheet',
                              'plan', 'logistics', 'ready', 'finance', 'settlement', 'closure', 'pkg_review', 'pkg_payments',
                              'discount_approve', 'close_owed', 'command', 'deliveries', 'issues', 'media', 'controls', 'business',
                              'insights', 'codes', 'item_pricing', 'users', 'audit'])
          or exists (select 1 from public.role_access r where r.org_id = public.current_org_id() and r.area = p_area));
$$;
revoke all on function public._r300_area_ok(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r300_area_ok(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r300_area_ok(text) from authenticated; end if;
end $$;

create or replace function public.admin_set_role_access(p_role text, p_area text, p_view boolean, p_edit boolean)
returns public.role_access language plpgsql security definer set search_path = '' as $$
-- r59-0300: admin + known area, then the previous body (0285 money-switch two-step + alert, then the base upsert)
begin
  if auth.uid() is null or public.current_org_id() is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._r300_area_ok(p_area) then
    raise exception 'unknown access area: %', left(coalesce(p_area, ''), 40) using errcode = '22023'; end if;
  return public.admin_set_role_access__pre0300(p_role, p_area, p_view, p_edit);
end $$;

-- ---- 6) F-9b privacy PIN reset needs a fresh two-step code ---------------------------------------------------------
create or replace function public.privacy_pin_reset()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r59-0300: free-trial check (0181), studio admin, then a fresh two-step code (0285) instead of "signed in within 15 min"
declare v_org uuid := public._pp_org(); v_me uuid := auth.uid();
begin
  perform public._tl173_guard();
  if v_me is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'only a studio admin can reset the privacy PIN' using errcode = '42501'; end if;
  perform public._r285_step_up(v_org);
  update public.privacy_pin set pin_hash = null, updated_by = v_me, updated_at = now() where org_id = v_org;
  perform public._pp_clear(v_me);
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (v_me, 'privacy_pin.reset', 'privacy_pin', v_org::text, jsonb_build_object('pin', 'default', 'two_step', true), v_org);
  return jsonb_build_object('ok', true, 'is_default', true);
end $$;

-- ---- 7) E-08 audit redaction: more secret-shaped keys ------------------------------------------------------------
create or replace function public._audit_redact(p jsonb, p_diff boolean)
returns jsonb language sql immutable set search_path = '' as $$
-- sys-quiet-0164: link secrets never stored raw in audit_log (only that they changed)
-- r59-0300: + mail_key_hash, key_secret, webhook_secret, upi_id and every *_hash key
  select case when p is null or jsonb_typeof(p) <> 'object' then p else
    coalesce((select jsonb_object_agg(e.key,
        case when e.key in ('approval_token','share_token','portal_token','token','worker_token','access_token',
                            'refresh_token','secret','otp_hash','code_hash','pin_hash','password_hash','token_hash',
                            'mail_key_hash','key_secret','webhook_secret','upi_id')
                  or e.key like '%\_hash' escape '\'
             then case when p_diff and jsonb_typeof(e.value) = 'array'
                       then (select jsonb_agg(case when x = 'null'::jsonb then x else to_jsonb('[redacted]'::text) end)
                               from jsonb_array_elements(e.value) x)
                       when e.value = 'null'::jsonb then e.value
                       else to_jsonb('[redacted]'::text) end
             else e.value end)
      from jsonb_each(p) e), '{}'::jsonb) end
$$;

-- ---- 8) E-06 the public vendor link names the event by type + date, never the quote title --------------------------
create or replace function public._r300_event_label(p_type text)
returns text language sql immutable set search_path = '' as $$
  -- r59-0300: a known event type ("Wedding", "Product launch") - free text (often a client's name) reads "Event"
  select case when lower(btrim(replace(coalesce(p_type, ''), '_', ' '))) = any (array['wedding', 'reception', 'engagement', 'sangeet',
                'haldi', 'mehendi', 'mehndi', 'henna', 'henna night', 'birthday', 'anniversary', 'corporate', 'conference', 'concert',
                'festival', 'exhibition', 'product launch', 'launch', 'political', 'rally', 'political rally', 'gala', 'gala dinner',
                'seminar', 'workshop', 'religious / puja', 'puja', 'house warming', 'housewarming', 'baby shower', 'get-together',
                'iftar', 'suhoor', 'eid', 'eid celebration', 'national day', 'national day celebration', 'award ceremony',
                'naming ceremony', 'upanayanam', 'party'])
              then upper(left(btrim(replace(p_type, '_', ' ')), 1)) || lower(substr(btrim(replace(p_type, '_', ' ')), 2))
              else 'Event' end;
$$;
revoke all on function public._r300_event_label(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r300_event_label(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r300_event_label(text) from authenticated; end if;
end $$;

create or replace function public._vr256_public(p_r public.vendor_requests)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r59-0300 E-06: 'event' = the event type (never the quote title, which often carries the client's name)
  select jsonb_build_object('ok', true, 'vendor_name', p_r.vendor_name, 'what', p_r.what, 'qty', p_r.qty,
    'when_text', public._dl241_when(p_r.when_at, p_r.org_id), 'where_text', p_r.where_text, 'details', p_r.details,
    'agreed_amount', p_r.agreed_amount, 'currency', p_r.currency, 'status', p_r.status, 'response_note', p_r.response_note,
    'respond_by_text', public._dl241_when(p_r.respond_by, p_r.org_id),
    'event', coalesce((select public._r300_event_label(q.event_type) from public.quotes q where q.id = p_r.quote_id), 'Event'),
    'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = p_r.quote_id),
    'venue', (select left(nullif(btrim(ep.venue_name), ''), 160) from public.event_plan ep where ep.quote_id = p_r.quote_id limit 1),
    'studio', (select o.name from public.organizations o where o.id = p_r.org_id),
    'can_respond', p_r.status = 'sent' and not coalesce(public._trial_locked(p_r.org_id), false),
    'can_invoice', p_r.status = 'accepted' and not coalesce(public._trial_locked(p_r.org_id), false),
    'invoices', coalesce((select jsonb_agg(public._vr256_inv(i, false) order by i.submitted_at)
                            from public.vendor_invoices i where i.request_id = p_r.id), '[]'::jsonb),
    'max_file_mb', 10);
$$;

-- ---- 9) E-05 vendor invoice files: type / size / upload check on the server ----------------------------------------
create or replace function public.upload_scan_bucket(p_bucket text)
returns boolean language sql immutable set search_path = '' as $$
  -- r59-0300: + vendor-invoices (0256 public vendor link uploads)
  select coalesce(p_bucket in ('event-docs', 'chat-media', 'invite-media', 'task-proof', 'vendor-invoices'), false);
$$;
-- invoice files that exist now were accepted before this check: grandfathered as clean (as 0051 did)
insert into public.upload_scans (object_id, bucket_id, name, org_id, owner_id, status, reason, scanned_at)
select o.id, o.bucket_id, o.name, public.upload_scan_org(o.name), public.upload_scan_owner(to_jsonb(o)), 'clean', 'grandfathered 0300', now()
  from storage.objects o
 where o.bucket_id = 'vendor-invoices'
on conflict (object_id) do nothing;

create or replace function public._r300_tg_vendor_invoice_file()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r59-0300: the stored file must be what the invoice row says (the browser check alone could be skipped)
declare o record; v_ext text; v_want text; v_decl text; v_size numeric;
begin
  if new.storage_path is null then return new; end if;
  select x.id, x.metadata into o from storage.objects x where x.bucket_id = 'vendor-invoices' and x.name = new.storage_path;
  if o.id is null then raise exception 'the invoice file did not arrive - please attach it again' using errcode = '22023'; end if;
  v_ext := lower(substring(new.storage_path from '\.([A-Za-z0-9]+)$'));
  v_want := case v_ext when 'pdf' then 'application/pdf' when 'jpg' then 'image/jpeg' when 'png' then 'image/png' when 'webp' then 'image/webp' end;
  if v_want is null or new.mime is distinct from v_want then
    raise exception 'the invoice file type does not match - attach a PDF or a photo (JPG, PNG or WebP)' using errcode = '22023'; end if;
  v_decl := lower(btrim(split_part(coalesce(o.metadata ->> 'mimetype', o.metadata ->> 'contentType', ''), ';', 1)));
  v_decl := case v_decl when 'image/jpg' then 'image/jpeg' when 'image/pjpeg' then 'image/jpeg' when 'application/x-pdf' then 'application/pdf' else v_decl end;
  if v_decl <> '' and v_decl <> 'application/octet-stream' and v_decl <> v_want then
    raise exception 'the invoice file type does not match - attach a PDF or a photo (JPG, PNG or WebP)' using errcode = '22023'; end if;
  if coalesce(o.metadata ->> 'size', '') ~ '^[0-9]{1,15}$' then
    v_size := (o.metadata ->> 'size')::numeric;
    if v_size < 12 or v_size > 10485760 then raise exception 'the invoice file is empty or larger than 10 MB' using errcode = '22023'; end if;
  end if;
  if exists (select 1 from public.upload_scans us where us.object_id = o.id and us.status = 'rejected') then
    raise exception 'the invoice file was refused by the upload check - attach a real PDF or photo' using errcode = '22023'; end if;
  return new;
end $$;
revoke all on function public._r300_tg_vendor_invoice_file() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r300_tg_vendor_invoice_file() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r300_tg_vendor_invoice_file() from authenticated; end if;
end $$;
drop trigger if exists a300_vendor_invoice_file on public.vendor_invoices;
create trigger a300_vendor_invoice_file before insert on public.vendor_invoices
  for each row execute function public._r300_tg_vendor_invoice_file();

-- ---- 10) BS-04 chat quote cards are rebuilt from the real quote ------------------------------------------------------
create or replace function public._r300_tg_chat_quote_card()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r59-0300: a card is only ever {kind, ref_id, code, title, status, event_date} of a quote of the SAME studio that the
-- sender may view (never a total or the client); mentions (already cleaned by the 0035 guard) are kept
declare v_ref text; v_org uuid; q record; v_meta jsonb;
begin
  if new.meta is null or jsonb_typeof(new.meta) <> 'object' or coalesce(new.meta ->> 'kind', '') <> 'quote' then return new; end if;
  if tg_op = 'UPDATE' and new.meta is not distinct from old.meta then return new; end if;
  v_ref := coalesce(new.meta ->> 'ref_id', '');
  select c.org_id into v_org from public.chat_conversations c where c.id = new.conversation_id;
  if v_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_org is null then
    raise exception 'That quote can''t be attached.' using errcode = '22023'; end if;
  select x.id, x.code, x.title, coalesce(x.lifecycle_stage, x.status) as stage, x.event_date into q
    from public.quotes x where x.id = v_ref::uuid and x.org_id = v_org and x.deleted_at is null;
  if q.id is null then raise exception 'That quote can''t be attached.' using errcode = '22023'; end if;
  if new.sender_id is not null and auth.uid() is not null and not coalesce(public.has_area('quotes', 'view'), false) then
    raise exception 'That quote can''t be attached.' using errcode = '42501'; end if;
  v_meta := jsonb_build_object('kind', 'quote', 'ref_id', q.id, 'code', coalesce(q.code, ''), 'title', coalesce(q.title, ''),
                               'status', coalesce(q.stage, ''), 'event_date', coalesce(to_char(q.event_date, 'YYYY-MM-DD'), ''));
  if new.meta ? 'mentions' then v_meta := v_meta || jsonb_build_object('mentions', new.meta -> 'mentions'); end if;
  new.meta := v_meta;
  return new;
end $$;
revoke all on function public._r300_tg_chat_quote_card() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r300_tg_chat_quote_card() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r300_tg_chat_quote_card() from authenticated; end if;
end $$;
-- runs after chat_messages_meta_guard_biu (0035; BEFORE triggers fire in name order)
drop trigger if exists chat_messages_quote_card_r300_biu on public.chat_messages;
create trigger chat_messages_quote_card_r300_biu before insert or update of meta on public.chat_messages
  for each row execute function public._r300_tg_chat_quote_card();

-- ---- 11) BS-05 studio search: no deactivated members under Team ------------------------------------------------------
create or replace function public.studio_search(p_q text, p_limit integer default 5)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r59-0300: 0061 body + the Team branch skips deactivated members (0283)
declare
  v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_role text; v_q text; v_like text; v_pre text; v_lim int; v_out jsonb := '{}'::jsonb; v_rows jsonb;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = v_me and p.org_id = v_org;
  if not found or v_role is null or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;

  v_q := left(btrim(regexp_replace(coalesce(p_q, ''), '\s+', ' ', 'g')), 80);
  if char_length(v_q) < 2 then return v_out; end if;
  v_lim := greatest(1, least(10, coalesce(p_limit, 5)));
  -- literal match: escape the escape char first, then the two wildcards
  v_pre := replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_');
  v_like := '%' || v_pre || '%';
  v_pre := v_pre || '%';

  if public.has_area('leads', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', l.id, 'title', l.name,
               'subtitle', concat_ws(' / ', nullif(l.status, ''), nullif(l.event_type, ''), to_char(l.event_date, 'YYYY-MM-DD')),
               'link', 'leads.html?hs=') as j,
             case when lower(l.name) like v_pre escape '\' then 0 else 1 end as rk, lower(l.name) as t
        from public.leads l
       where l.org_id = v_org
         and (lower(l.name) like v_like escape '\' or lower(coalesce(l.event_type, '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('leads', v_rows);
  end if;

  if public.has_area('quotes', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', q.id, 'title', q.title,
               'subtitle', concat_ws(' / ', q.code, nullif(q.client ->> 'name', ''), nullif(coalesce(q.lifecycle_stage, q.status), ''), to_char(q.event_date, 'YYYY-MM-DD')),
               'link', 'event.html?id=' || q.id::text) as j,
             case when lower(q.code) like v_pre escape '\' or lower(q.title) like v_pre escape '\' then 0 else 1 end as rk,
             lower(q.title) as t
        from public.quotes q
       where q.org_id = v_org
         and (lower(q.title) like v_like escape '\' or lower(q.code) like v_like escape '\'
              or lower(coalesce(q.client ->> 'name', '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('events', v_rows);
  end if;

  if public.has_area('staff', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', c.id, 'title', c.name,
               'subtitle', concat_ws(' / ', nullif(c.role, ''), nullif(c.department, '')),
               'link', 'staff.html?hs=') as j,
             case when lower(c.name) like v_pre escape '\' then 0 else 1 end as rk, lower(c.name) as t
        from public.crew_members c
       where c.org_id = v_org and c.active
         and (lower(c.name) like v_like escape '\' or lower(coalesce(c.role, '')) like v_like escape '\'
              or lower(coalesce(c.department, '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('staff', v_rows);
  end if;

  if public.has_area('users', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', p.id, 'title', p.full_name, 'subtitle', p.role, 'link', 'control.html#users') as j,
             case when lower(p.full_name) like v_pre escape '\' then 0 else 1 end as rk, lower(p.full_name) as t
        from public.profiles p
       where p.org_id = v_org and p.role is distinct from 'client'
         and not public._r283_is_off(p.id, v_org)
         and nullif(btrim(coalesce(p.full_name, '')), '') is not null
         and lower(p.full_name) like v_like escape '\'
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('team', v_rows);
  end if;

  if public.has_area('vendors', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', v.id, 'title', v.name,
               'subtitle', concat_ws(' / ', nullif(v.category, ''), nullif(v.kind, '')),
               'link', 'vendors.html?hs=') as j,
             case when lower(v.name) like v_pre escape '\' then 0 else 1 end as rk, lower(v.name) as t
        from public.vendors v
       where v.org_id = v_org and v.active
         and (lower(v.name) like v_like escape '\' or lower(coalesce(v.category, '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('vendors', v_rows);
  end if;

  if public.has_area('inventory', 'view') then
    select coalesce(jsonb_agg(x.j order by x.rk, x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', i.id, 'title', i.name,
               'subtitle', concat_ws(' / ', nullif(i.category, ''), trim(to_char(i.total_qty, 'FM999999990.##') || ' ' || coalesce(i.unit, ''))),
               'link', 'inventory.html?hs=') as j,
             case when lower(i.name) like v_pre escape '\' then 0 else 1 end as rk, lower(i.name) as t
        from public.inventory_items i
       where i.org_id = v_org and i.active
         and (lower(i.name) like v_like escape '\' or lower(coalesce(i.category, '')) like v_like escape '\')
       order by 2, 3 limit v_lim) x;
    v_out := v_out || jsonb_build_object('inventory', v_rows);
  end if;

  if public.has_area('finance', 'view') then
    select coalesce(jsonb_agg(x.j order by x.t), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('id', pm.id, 'title', pm.receipt_no,
               'subtitle', concat_ws(' / ', q.code, pm.currency || ' ' || to_char(pm.amount, 'FM999999999990.00'), pm.status),
               'link', 'settlement.html?quote=' || pm.quote_id::text) as j,
             lower(pm.receipt_no) as t
        from public.quote_payments pm
        join public.quotes q on q.id = pm.quote_id and q.org_id = v_org
       where pm.org_id = v_org and pm.receipt_no is not null
         and lower(pm.receipt_no) like v_like escape '\'
       order by 2 limit v_lim) x;
    v_out := v_out || jsonb_build_object('payments', v_rows);
  end if;

  return v_out;
end $$;

-- ---- 12) BS-06 chat directory: the e-mail local part only for admins / Users view ------------------------------------
create or replace function public.chat_directory()
returns table(id uuid, full_name text, email_name text, role text, avatar_path text, job_title text, department text)
language sql stable security definer set search_path = '' as $$
  -- r33-0283 B1: a deactivated member reads "Name (deactivated)"
  -- r59-0300 BS-06: email_name (the part of a login e-mail before "@") only for admins / Users & access view
  with me as (select coalesce(public.is_admin(), false) or coalesce(public.has_area('users', 'view'), false) as full_view)
  select b.id,
         case when public._r283_is_off(b.id, public.current_org_id())
              then coalesce(nullif(btrim(b.full_name), ''), case when me.full_view then b.email_name end, 'Member') || ' (deactivated)'
              else b.full_name end,
         case when me.full_view then b.email_name end, b.role, m.avatar_path, m.job_title, m.department
    from me cross join public.chat_directory__base() with ordinality as b(id, full_name, email_name, role, n)
    left join public.member_profiles m on m.user_id = b.id
   order by b.n;
$$;

-- ---- 13) F-1 the "Send test WhatsApp" target (studio admins, a team member's own mobile only) ------------------------
create or replace function public.integrations_wa_test_target()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r59-0300 F-1: never a relay - the number is the studio's saved WhatsApp, and only when it is the saved mobile of an
-- active (not deactivated) member of the same studio; the edge function adds STOP list, trial guard and a daily cap
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_d text;
begin
  if v_me is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'Only a studio admin can send a test WhatsApp.' using errcode = '42501'; end if;
  select regexp_replace(coalesce(s.studio_whatsapp, ''), '[^0-9]', '', 'g') into v_d from public.comms_settings s where s.org_id = v_org;
  if coalesce(v_d, '') !~ '^[1-9][0-9]{7,14}$' then return jsonb_build_object('ok', false, 'reason', 'no_number'); end if;
  if not exists (select 1 from public.profiles p join public.member_profiles m on m.user_id = p.id
                  where p.org_id = v_org and p.role is distinct from 'client' and not public._r283_is_off(p.id, v_org)
                    and regexp_replace(coalesce(m.phone, ''), '[^0-9]', '', 'g') = v_d) then
    return jsonb_build_object('ok', false, 'reason', 'not_team_number');
  end if;
  return jsonb_build_object('ok', true, 'studio_whatsapp', v_d, 'org_id', v_org);
end $$;
revoke all on function public.integrations_wa_test_target() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.integrations_wa_test_target() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.integrations_wa_test_target() to authenticated; end if;
end $$;

-- ---- 14) E-03 where Helm's payment / billing mails go -----------------------------------------------------------------
create or replace function public.studio_billing_email(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r59-0300 E-03: the studio e-mail once CONFIRMED; else the studio owner's login e-mail; else the first active admin's
  select coalesce(
    (select nullif(btrim(o.business_email), '') from public.organizations o
      where o.id = p_org and coalesce(o.business_email_confirmed, false) and btrim(coalesce(o.business_email, '')) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    (select u.email from auth.users u join public.profiles p on p.id = u.id
      where u.id = public._r283_owner(p_org) and p.org_id = p_org and not public._r283_is_off(u.id, p_org)
        and coalesce(u.email, '') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    (select u.email from public.profiles p join auth.users u on u.id = p.id
      where p.org_id = p_org and p.role = 'admin' and not public._r283_is_off(p.id, p_org)
        and coalesce(u.email, '') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
      order by p.created_at, p.id limit 1));
$$;
revoke all on function public.studio_billing_email(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.studio_billing_email(uuid) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.studio_billing_email(uuid) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.studio_billing_email(uuid) to service_role; end if;
end $$;

-- ---- 15) F-5 "Control Center" -> "Settings" in every live function text (in place, previous body kept once) ----------
do $r300cc$ declare r record; v_def text; begin
  for r in select p.oid, p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' and p.proname !~ '__pre[0-9]'
              and position('Control Center' in regexp_replace(p.prosrc, '--[^\n]*', '', 'g')) > 0
            order by p.oid loop
    perform public._r300_keep(r.sig);
    v_def := replace(pg_get_functiondef(r.oid), 'Control Center', 'Settings');
    execute v_def;
  end loop;
end $r300cc$;

notify pgrst, 'reload schema';
