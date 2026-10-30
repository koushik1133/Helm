-- 0315_r105_signup_sales_no_studio.sql - CANONICAL forward-only. R105 (owner: "you create a studio but didn't pay").
--
-- In plain words:
--   Until now "Contact sales" on the sign-up plan step created a studio straight away (create_direct_studio, 0255)
--   that waited for a payment nobody could make yet, so the new owner hit payment walls. Now "Contact sales" on the
--   sign-up saves ONLY a sales request for the ACCOUNT (no studio):
--     request_signup_sales(plan, interval, studio, phone, message)  signed-in, the caller has no studio yet and is not
--       a Helm HQ operator. Saves one row in sales_requests (org_id empty, created_by = the caller, source 'checkout',
--       the message starts with "[Sign-up, no studio yet]"), queues the usual e-mail to sales (helm_notice_outbox
--       'sales_request') and writes an audit row. The same plan + billing again within a day = the same request; at
--       most 5 a day. Name and e-mail come from the signed-in account (never typed).
--     my_signup_sales_request()  the caller's newest such request (plan, billing, studio name, status, when) or null,
--       so the sign-in page can show "Our team will contact you" instead of the studio form again.
--     my_studio_signup_location(country, state, city)  (owner: "ask location ONCE") the sign-up step 3 country
--       (IN / AE / US) + state (India: from the GST state list) + city, saved on the caller's OWN studio (admin) into
--       organizations.brand.billing (city / state / country - the 0089 trigger mirrors country / tax_region for tax) and
--       studio_account (country / state / city). Fills ONLY empty fields - never overwrites a saved value. The trial
--       welcome and Studio setup > Business details read these, so they are prefilled and not asked again. A studio that
--       cannot be written (e.g. read-only while waiting for payment) answers {saved:false} instead of failing.
--   Nothing else changes: studios already waiting for payment, paid / active studios, free trials, create_direct_studio,
--   request_plan_activation and HQ "Activate plan" (hq_activate_plan / _sub_activate) are untouched. HQ sees these
--   requests in Requests -> Plan requests like any other (hq_sales_requests already reads rows without a studio).
--   No table / column / policy / index / trigger created, changed or deleted; existing rows only gain values in EMPTY location fields. Safe to run twice. ASCII only.
--   Goes after 0244 + 0255 (+ 0249 captcha guard, which applies unchanged when the owner switches it on).
do $$
begin
  if to_regclass('public.sales_requests') is null then raise exception 'STOP 0315: 0244 (sales_requests) is not applied'; end if;
  if to_regclass('public.helm_notice_outbox') is null then raise exception 'STOP 0315: 0244 (helm_notice_outbox) is not applied'; end if;
  if to_regprocedure('public.is_platform_operator()') is null then raise exception 'STOP 0315: is_platform_operator() is missing'; end if;
  if to_regprocedure('public.create_direct_studio(text,text,text,text,text)') is null then raise exception 'STOP 0315: 0255 is not applied'; end if;
  if to_regprocedure('public._in_states_0210()') is null then raise exception 'STOP 0315: 0210 (_in_states_0210) is not applied'; end if;
  if to_regprocedure('public._studio_account_apply(uuid,jsonb)') is null then raise exception 'STOP 0315: _studio_account_apply is missing'; end if;
end $$;

create or replace function public.request_signup_sales(p_plan text, p_interval text default null, p_studio text default null,
                                                       p_phone text default null, p_message text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r105-signup-sales-0315
declare v_uid uuid := auth.uid(); v_had uuid; v_plan text; v_pname text; v_iv text; v_studio text; v_name text;
  v_email text; v_phone text; v_msg text; v_meta jsonb; v_id uuid; n int;
begin
  if v_uid is null then raise exception 'Please sign in first' using errcode = '42501'; end if;
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then
    raise exception 'You already have a studio' using errcode = '22023', hint = 'has_studio'; end if;
  if coalesce(public.is_platform_operator(), false) then
    raise exception 'Helm HQ accounts can''t create or join a studio.' using errcode = '42501', hint = 'operator'; end if;
  v_plan := lower(btrim(coalesce(p_plan, '')));
  if v_plan !~ '^[a-z0-9][a-z0-9_-]{1,39}$' then raise exception 'Choose a plan' using errcode = '22023'; end if;
  select hp.name into v_pname from public.helm_plans hp where hp.code = v_plan;
  if v_pname is null and v_plan not in ('starter', 'studio', 'enterprise') then raise exception 'Choose a plan' using errcode = '22023'; end if;
  v_pname := left(coalesce(v_pname, initcap(v_plan)), 80);
  v_iv := case when p_interval = 'yearly' then 'yearly' else 'monthly' end;
  v_studio := nullif(left(btrim(regexp_replace(coalesce(p_studio, ''), '[\x00-\x1f\x7f]', ' ', 'g')), 160), '');
  if v_studio is null or char_length(v_studio) < 2 then raise exception 'Enter your studio name' using errcode = '22023'; end if;
  select lower(u.email), coalesce(u.raw_user_meta_data, '{}'::jsonb) into v_email, v_meta from auth.users u where u.id = v_uid;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Your account has no e-mail address' using errcode = '22023'; end if;
  v_name := nullif(left(btrim(regexp_replace(coalesce(v_meta ->> 'full_name', v_meta ->> 'name', ''), '[\x00-\x1f\x7f]', ' ', 'g')), 80), '');
  v_name := coalesce(v_name, left(split_part(v_email, '@', 1), 80));
  v_phone := nullif(left(btrim(coalesce(p_phone, '')), 20), '');
  if v_phone is not null and v_phone !~ '^\+?[0-9][0-9 ()-]{5,19}$' then raise exception 'Enter a valid phone number' using errcode = '22023'; end if;
  v_msg := left('[Sign-up, no studio yet] ' || coalesce(nullif(btrim(regexp_replace(replace(coalesce(p_message, ''), E'\r', ''),
             '[\x01-\x09\x0b-\x1f\x7f]', ' ', 'g')), ''), ''), 1000);
  perform pg_advisory_xact_lock(hashtext('helm_signup_sales:' || v_uid::text));
  select r.id into v_id from public.sales_requests r
   where r.created_by = v_uid and r.org_id is null and r.plan_code = v_plan and r.billing_interval = v_iv and r.status = 'new'
     and r.created_at > now() - interval '1 day' order by r.created_at desc limit 1;
  if v_id is not null then return jsonb_build_object('id', v_id, 'status', 'received', 'duplicate', true); end if;
  select count(*) into n from public.sales_requests r where r.created_by = v_uid and r.created_at > now() - interval '1 day';
  if n >= 5 then
    raise exception 'We already have your requests from today - our team will contact you within one working day' using errcode = '22023', hint = 'rate_limited';
  end if;
  insert into public.sales_requests(org_id, created_by, source, plan_code, plan_name, billing_interval, studio_name,
                                    contact_name, contact_email, contact_phone, message)
    values (null, v_uid, 'checkout', v_plan, v_pname, v_iv, v_studio, v_name, v_email, v_phone, v_msg)
    returning id into v_id;
  insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
    values ('sales_request', null, v_id, jsonb_build_object('request_id', v_id), 'sales_request:' || v_id::text)
  on conflict (dedupe_key) do nothing;
  begin
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, v_email, 'sales.request', 'sales_requests', v_id::text,
              jsonb_build_object('plan', v_plan, 'interval', v_iv, 'source', 'signup', 'studio', null), null, now());
  exception when others then raise warning 'r105-signup-sales-0315: audit row skipped (%)', sqlstate;
  end;
  return jsonb_build_object('id', v_id, 'status', 'received', 'duplicate', false);
end $$;

create or replace function public.my_signup_sales_request()
returns jsonb language sql stable security definer set search_path = '' as $$
-- r105-signup-sales-0315
  select jsonb_build_object('id', r.id, 'plan_code', r.plan_code, 'plan_name', r.plan_name, 'billing_interval', r.billing_interval,
           'studio_name', r.studio_name, 'status', r.status, 'created_at', r.created_at)
    from public.sales_requests r
   where auth.uid() is not null and r.created_by = auth.uid() and r.org_id is null
   order by r.created_at desc limit 1
$$;

create or replace function public.my_studio_signup_location(p_country text default 'IN', p_state text default null, p_city text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r105-signup-location-0315: the caller's OWN studio (admin); fills ONLY empty fields, never overwrites
declare v_org uuid := public.current_org_id(); v_cc text := upper(btrim(coalesce(p_country, 'IN')));
  v_state text := nullif(left(btrim(regexp_replace(coalesce(p_state, ''), '[\x00-\x1f\x7f]', ' ', 'g')), 60), '');
  v_city text := nullif(btrim(regexp_replace(coalesce(p_city, ''), '[\x00-\x1f\x7f]', ' ', 'g')), '');
  b jsonb; add jsonb := '{}'::jsonb; sa public.studio_account; v_patch jsonb := '{}'::jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_cc not in ('IN', 'AE', 'US') then raise exception 'Choose your country' using errcode = '22023'; end if;
  if v_city is not null and char_length(v_city) > 80 then raise exception 'Please keep the city to 80 characters' using errcode = '22023'; end if;
  if v_cc = 'IN' and v_state is not null then
    select s into v_state from unnest(public._in_states_0210()) s where lower(s) = lower(v_state) limit 1;
    if v_state is null then raise exception 'Choose a state from the list.' using errcode = '22023'; end if;
  end if;
  begin
    select case when jsonb_typeof(o.brand -> 'billing') = 'object' then o.brand -> 'billing' else '{}'::jsonb end into b
      from public.organizations o where o.id = v_org;
    b := coalesce(b, '{}'::jsonb);
    if nullif(btrim(coalesce(b ->> 'country', '')), '') is null then add := add || jsonb_build_object('country', v_cc); end if;
    if v_state is not null and nullif(btrim(coalesce(b ->> 'state', '')), '') is null then add := add || jsonb_build_object('state', v_state); end if;
    if v_city is not null and nullif(btrim(coalesce(b ->> 'city', '')), '') is null then add := add || jsonb_build_object('city', v_city); end if;
    if add <> '{}'::jsonb then
      update public.organizations o
         set brand = coalesce(case when jsonb_typeof(o.brand) = 'object' then o.brand else null end, '{}'::jsonb)
                   || jsonb_build_object('billing', b || add)
       where o.id = v_org;
    end if;
    select * into sa from public.studio_account a where a.org_id = v_org;
    if sa.country is null then v_patch := v_patch || jsonb_build_object('country', v_cc); end if;
    if v_state is not null and sa.state is null then v_patch := v_patch || jsonb_build_object('state', v_state); end if;
    if v_city is not null and sa.city is null then v_patch := v_patch || jsonb_build_object('city', v_city); end if;
    if v_patch <> '{}'::jsonb then perform public._studio_account_apply(v_org, v_patch); end if;
  exception when others then
    -- e.g. a studio waiting for payment is read-only: Studio setup asks for the location instead
    return jsonb_build_object('saved', false, 'reason', sqlstate);
  end;
  return jsonb_build_object('saved', true, 'billing', add, 'account', v_patch);
end $$;

revoke all on function public.request_signup_sales(text, text, text, text, text) from public;
revoke all on function public.my_studio_signup_location(text, text, text) from public;
revoke all on function public.my_signup_sales_request() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.request_signup_sales(text, text, text, text, text) from anon;
    revoke all on function public.my_signup_sales_request() from anon;
    revoke all on function public.my_studio_signup_location(text, text, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.request_signup_sales(text, text, text, text, text) to authenticated;
    grant execute on function public.my_signup_sales_request() to authenticated;
    grant execute on function public.my_studio_signup_location(text, text, text) to authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.request_signup_sales(text, text, text, text, text) to service_role;
    grant execute on function public.my_signup_sales_request() to service_role; end if;
end $$;
