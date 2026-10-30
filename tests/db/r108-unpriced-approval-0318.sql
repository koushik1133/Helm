-- r108-unpriced-approval-0318.sql - 0318: a quote with no price cannot be approved by the client.
-- Proves: (1) a quote with total 0 (and the helper: missing / non-numeric total = not priced): the right code is refused with HL409 quote_not_priced, no consent row,
-- quote stays 'sent', the code is NOT used up; (2) once priced, a (new) code approves normally; (3) wa_verify path and
-- the trial Test mode confirm go through the same guard (consent insert); (4) public_quote_ready answers {priced, studio}
-- only, null for an unknown / revoked link; (5) grants. Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0318_r108_unpriced_approval.sql
\ir ../../supabase/migrations/0318_r108_unpriced_approval.sql
set client_min_messages = warning;
begin;
drop table if exists _g318; create temp table _g318(name text, result text); grant all on _g318 to anon, authenticated;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g318 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.seed(p_q uuid, p_code text) returns uuid language sql as $$
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id, created_at)
  select q.id, public._otp_canon_phone(q.approval_token, q.client ->> 'phone'), extensions.crypt(p_code, extensions.gen_salt('bf', 4)),
         now() + interval '10 minutes', q.org_id, now()
    from public.quotes q where q.id = p_q returning id $$;

do $$ declare r text; q uuid := 'a0000000-0000-4000-8000-00000000da01'; tok text := 'a0000000-0000-4000-8000-0000000000aa';
  a uuid; n0 int; vsql text; v_studio text;
begin
  delete from public.a156_quote_served where quote_id = q;
  update public.quotes set approval_status = 'sent', consent_stale = false, approval_token = tok::uuid, approval_token_expires_at = null,
         approval_token_revoked_at = null, client = client || '{"phone":"+919800000318"}'::jsonb,
         pricing = '{"subtotal":0,"discount":0,"gstPct":18,"total":0}'::jsonb where id = q;
  delete from public.quote_otps where quote_id = q;
  select count(*) into n0 from public.quote_consents where quote_id = q;
  select o.name into v_studio from public.organizations o join public.quotes x on x.org_id = o.id where x.id = q;
  vsql := $q$select public.verify_and_consent(%L, '+919800000318', %L, true, 'v2-2026-10', 'I agree', 'R108', 'ua')::text$q$;

  r := pg_temp.as_val('anon', format('select public.public_quote_ready(%L)::text', tok));
  perform pg_temp.t('01 public_quote_ready: total 0 -> priced false + studio name, nothing else',
    r::jsonb = jsonb_build_object('priced', false, 'studio', coalesce(v_studio, '')), r);

  a := pg_temp.seed(q, '318318');
  r := pg_temp.as_val('anon', format(vsql, tok, '318318'));
  perform pg_temp.t('02 right code on a Rs 0 quote: refused HL409 with the friendly message',
    r like 'err:HL409:This quote isn''t ready yet - it has no price. Please contact %', r);
  perform pg_temp.t('03 no consent row, quote still sent',
    (select count(*) from public.quote_consents where quote_id = q) = n0
    and (select approval_status from public.quotes where id = q) = 'sent', null);
  perform pg_temp.t('04 the code is not used up (rolled back)',
    (select verified_at is null and expires_at > now() from public.quote_otps where id = a), null);

  update public.quotes set pricing = '{"subtotal":0,"discount":0,"gstPct":18}'::jsonb where id = q;   -- server stamps total 0
  r := pg_temp.as_val('anon', format(vsql, tok, '318318'));
  perform pg_temp.t('05 subtotal 0 (server-stamped total 0): refused too', r like 'err:HL409:%'
    and not public._r318_quote_priced('{"subtotal":200000}'::jsonb) and not public._r318_quote_priced('{"total":"abc"}'::jsonb), r);

  update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb where id = q;
  r := pg_temp.as_val('anon', format('select public.public_quote_ready(%L)::text', tok));
  perform pg_temp.t('06 public_quote_ready: priced true once the total is saved', r like '%"priced": true%', r);
  a := pg_temp.seed(q, '318319');   -- a price change expires open codes (0052), so the client asks for a new one
  r := pg_temp.as_val('anon', format(vsql, tok, '318319'));
  perform pg_temp.t('07 priced: a code now approves normally', r like '%"approved": true%'
    and (select count(*) from public.quote_consents where quote_id = q) = n0 + 1
    and (select approval_status from public.quotes where id = q) = 'approved', r);

  -- any other app path that writes a consent (service role / API) on a Rs 0 quote is refused; SQL by hand stays free
  update public.quotes set pricing = '{"subtotal":0,"discount":0,"gstPct":18,"total":0}'::jsonb where id = q;
  begin
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, org_id)
      select q, '+919800000318', 'R108', 'v2-2026-10', 'x', true, true, x.org_id from public.quotes x where x.id = q;
    perform set_config('request.jwt.claims', '', true);
    perform pg_temp.t('08 app (service role) consent insert on an unpriced quote refused', false, 'inserted');
  exception when sqlstate 'HL409' then
    perform set_config('request.jwt.claims', '', true);
    perform pg_temp.t('08 app (service role) consent insert on an unpriced quote refused', sqlerrm like 'This quote isn''t ready yet%', sqlerrm);
  end;
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, org_id)
    select q, '+919800000318', 'R108', 'v2-2026-10', 'by hand', true, false, x.org_id from public.quotes x where x.id = q;
  perform pg_temp.t('08b SQL by hand (no API claims) is not blocked', exists (select 1 from public.quote_consents where quote_id = q and consent_text = 'by hand'), null);

  r := pg_temp.as_val('anon', $s$select coalesce(public.public_quote_ready('00000000-0000-4000-8000-000000000318')::text, 'null')$s$);
  perform pg_temp.t('09 unknown link -> null', r = 'null', r);
  update public.quotes set approval_token_revoked_at = now() where id = q;
  r := pg_temp.as_val('anon', format($s$select coalesce(public.public_quote_ready(%L)::text, 'null')$s$, tok));
  perform pg_temp.t('10 revoked link -> null', r = 'null', r);

  perform pg_temp.t('11 grants: anon runs public_quote_ready; helper + trigger fn not callable by the app; definer + empty search_path',
    has_function_privilege('anon', 'public.public_quote_ready(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r318_quote_priced(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r318_tg_consent_priced()', 'execute')
    and coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%'
                    from pg_proc p where p.oid = 'public.public_quote_ready(uuid)'::regprocedure), false), null);
  perform pg_temp.t('12 one trigger after two runs',
    (select count(*) from pg_trigger t where t.tgrelid = 'public.quote_consents'::regclass and t.tgname = 'zz_r318_consent_priced') = 1, null);
end $$;

select name, result from _g318 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R108-UNPRICED-APPROVAL-0318: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R108-UNPRICED-APPROVAL-0318: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g318;
rollback;
