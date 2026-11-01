-- r109-otp-verify-org-0319.sql - 0319: the client's "Confirm & approve" works when the approval link is opened in a
-- browser signed in to ANOTHER studio (production R109: 42501 "quote ... belongs to another studio", shown as
-- "You don't have permission to verify the OTP.").
-- Proves, for a PAID studio and a FREE-TRIAL studio, quote total 0 and > 0, e-mail and WhatsApp/SMS channels
-- (since 0318 / R108 a quote with total 0 is refused with the friendly HL409 "no price" in EVERY viewer context,
-- nothing saved and the code not consumed; a priced quote approves):
--   (1) WITHOUT the 0319 trigger (old behaviour) a viewer signed in to another studio gets 42501 from
--       zz_quote_org_match on the quote_consents insert (the production bug, reproduced);
--   (2) WITH it the same call approves, the consent row carries the QUOTE's studio, and no row created by the call is
--       stamped with the viewer's studio; signed-out (anon) and own-studio callers still approve;
--   (3) a wrong code still answers {approved:false, error:...} (no 42501), the code stays usable, nothing is saved;
--   (4) structure: trigger is BEFORE INSERT only, fires before the other consent triggers, anon / authenticated still
--       cannot insert consents, a consent UPDATE to another studio is still refused by zz_quote_org_match.
-- The code is stored the way the live send-otp edge function does it (service role: wa_otp_begin /
-- trial_email_otp_begin -> admin_store_otp). Re-applies 0319 twice. Every case runs in a rolled-back sub-block.
-- R113 (0322): trial cases run with the 0322 test-mode triggers switched off inside the rolled-back case (a trial now
-- gets no real code at all - see tests/db/r113-trial-test-mode-0322.sql); the 0319 org stamp is what is proven here.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0319_r109_consent_org_from_quote.sql
\ir ../../supabase/migrations/0319_r109_consent_org_from_quote.sql
set client_min_messages = warning;
begin;
drop table if exists _g319; create temp table _g319(name text, result text); grant all on _g319 to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g319 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who = 'service' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set local role service_role';
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;

-- one case = store a code like send-otp, then verify as p_who; everything is rolled back (raise HR109 at the end)
create or replace function pg_temp.run_case(p_status text, p_total numeric, p_who text, p_ch text, p_code text, p_old boolean)
returns text language plpgsql as $$
declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; tok text := 'b0000000-0000-4000-8000-0000000000bb';
  a_org uuid := 'a0000000-0000-4000-8000-000000000001'; b_org uuid := 'b0000000-0000-4000-8000-000000000001';
  v_key text; r text; v_store text; v_res text; v_corg text; v_leak int; v_n0 int; v_stat text; t text; n int;
begin
  begin
    if p_old then execute 'alter table public.quote_consents disable trigger ab0_r109_consent_org'; end if;
    -- R113 (0322): a free trial no longer stores / accepts a real code (proven in r113-trial-test-mode-0322.sql). This suite
    -- proves the 0319 org stamp on the code path, so its trial cases switch the 0322 test-mode triggers off (rolled back).
    if p_status = 'trial' then
      if exists (select 1 from pg_trigger where tgname = 'ab2_r322_trial_otp' and tgrelid = 'public.quote_otps'::regclass) then
        execute 'alter table public.quote_otps disable trigger ab2_r322_trial_otp';
        execute 'alter table public.trial_email_sends disable trigger ab2_r322_trial_otp_slot';
        execute 'alter table public.quote_consents disable trigger ab2_r322_trial_consent';
      end if;
    end if;
    insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (b_org, p_status, current_date + 10)
      on conflict (org_id) do update set status = excluded.status, trial_ends_at = excluded.trial_ends_at;
    update public.quotes set pricing = jsonb_build_object('total', p_total, 'subtotal', p_total), approval_status = 'sent',
           consent_stale = false, approval_token = tok::uuid, approval_token_expires_at = null,
           client = coalesce(client, '{}'::jsonb) || '{"phone":"+919800000319","email":"client319@example.com"}'::jsonb
     where id = q;
    delete from public.a156_quote_served where quote_id = q;
    delete from public.quote_otps where quote_id = q;
    select count(*) into v_n0 from public.quote_consents where quote_id = q;
    -- the send-otp edge function (service role): trial e-mail -> trial_email_otp_begin; otherwise wa_otp_begin.
    -- (a trial never sends WhatsApp / SMS; for the trial + whatsapp case the code is stored for the quote's phone.)
    if p_status = 'trial' and p_ch = 'email' then
      v_key := pg_temp.as_val('service', format($s$select public.trial_email_otp_begin(%L, 'UA') ->> 'phone_key'$s$, tok));
    elsif p_status = 'trial' then
      v_key := pg_temp.as_val('service', format($s$select public._otp_canon_phone(%L, '+919800000319')$s$, tok));
    else
      v_key := pg_temp.as_val('service', format($s$select public.wa_otp_begin(%L, %L, 'UA') ->> 'phone_key'$s$, tok, p_ch));
    end if;
    v_store := pg_temp.as_val('service', format($s$select public.admin_store_otp(%L, %L, '424242')::text$s$, tok, v_key));
    if v_store not like '%"stored": true%' then
      raise exception using errcode = 'HR109', message = 'store failed: key=' || coalesce(v_key, '<null>') || ' ' || v_store;
    end if;
    r := pg_temp.as_val(p_who, format($s$select public.wa_verify_and_consent(%L, %L, %L, true, 'v1', 'I agree', 'Client', 'UA')::text$s$,
                                      tok, p_ch, p_code));
    select string_agg(distinct c.org_id::text, ',') into v_corg from public.quote_consents c where c.quote_id = q and c.created_at >= now();
    select approval_status into v_stat from public.quotes where id = q;
    v_leak := 0;
    for t in select c.table_name from information_schema.columns c
               join information_schema.columns d on d.table_schema = 'public' and d.table_name = c.table_name and d.column_name = 'created_at'
               join information_schema.tables x on x.table_schema = 'public' and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
              where c.table_schema = 'public' and c.column_name = 'org_id' loop
      execute format('select count(*) from public.%I where created_at >= now() and org_id = %L', t, a_org) into n;
      v_leak := v_leak + n;
    end loop;
    v_res := 'R=' || r || ' |CORG=' || coalesce(v_corg, '-') || ' |NEW=' ||
             ((select count(*) from public.quote_consents where quote_id = q) - v_n0)::text || ' |STAT=' || coalesce(v_stat, '-') ||
             ' |LEAKA=' || v_leak::text || ' |OPEN=' ||
             (select count(*) from public.quote_otps o where o.quote_id = q and o.verified_at is null and o.expires_at > now())::text;
    raise exception using errcode = 'HR109', message = v_res;
  exception when sqlstate 'HR109' then
    return sqlerrm;
  end;
end $$;

do $$ declare st text; ch text; who text; tot numeric; r text; b text := 'b0000000-0000-4000-8000-000000000001'; lbl text;
begin
  foreach st in array array['active', 'trial'] loop
    foreach tot in array array[0, 118000]::numeric[] loop
      foreach ch in array array['email', 'whatsapp'] loop
        lbl := st || '/total ' || tot || '/' || ch;
        -- (1) OLD behaviour: signed in to another studio -> the production 42501
        r := pg_temp.run_case(st, tot, 'a_admin@a.test', ch, '424242', true);
        perform pg_temp.t('01 OLD ' || lbl || ': other-studio viewer gets 42501 belongs to another studio',
          r like 'R=err:42501:%belongs to another studio%', r);
        -- (2) NEW: other-studio viewer approves; consent carries the quote's studio; nothing stamped to the viewer's studio
        r := pg_temp.run_case(st, tot, 'a_admin@a.test', ch, '424242', false);
        if tot > 0 then
          perform pg_temp.t('02 NEW ' || lbl || ': other-studio viewer approves, consent org = quote org, no row for viewer studio',
            r like 'R={"approved": true}%' and r like '%|CORG=' || b || ' |NEW=1 |STAT=approved |LEAKA=0 |OPEN=0', r);
        else   -- 0318 (R108): an unpriced quote is never approved - friendly HL409, nothing saved, code not consumed
          perform pg_temp.t('02 NEW ' || lbl || ': other-studio viewer gets the 0318 no-price refusal (HL409), nothing saved, code still open',
            r like 'R=err:HL409:%no price%' and r like '%|CORG=- |NEW=0 |STAT=sent |LEAKA=0 |OPEN=1', r);
        end if;
        foreach who in array array['anon', 'b_staff@b.test'] loop
          r := pg_temp.run_case(st, tot, who, ch, '424242', false);
          if tot > 0 then
            perform pg_temp.t('03 NEW ' || lbl || ': ' || who || ' approves',
              r like 'R={"approved": true}%' and r like '%|CORG=' || b || ' |NEW=1 |STAT=approved |LEAKA=0 |OPEN=0', r);
          else
            perform pg_temp.t('03 NEW ' || lbl || ': ' || who || ' gets the 0318 no-price refusal (HL409), nothing saved, code still open',
              r like 'R=err:HL409:%no price%' and r like '%|CORG=- |NEW=0 |STAT=sent |LEAKA=0 |OPEN=1', r);
          end if;
        end loop;
      end loop;
    end loop;
  end loop;
  -- (3) a wrong code: the normal "wrong code" answer, nothing saved, code still open (anon and other-studio viewer)
  foreach who in array array['anon', 'a_admin@a.test'] loop
    foreach st in array array['active', 'trial'] loop
      r := pg_temp.run_case(st, 0, who, 'email', '000000', false);
      perform pg_temp.t('04 wrong code ' || st || '/' || who || ': approved false with an error, no 42501, nothing saved',
        r like 'R={%"approved": false%' and r like '%"error"%' and r like '%|NEW=0 |STAT=sent |LEAKA=0 |OPEN=1', r);
    end loop;
  end loop;
end $$;

-- (4) structure + guard still in force
do $$ declare v_ok boolean; v text;
begin
  perform pg_temp.t('05 trigger ab0_r109_consent_org: BEFORE INSERT row, enabled, first after aa_api_write_block',
    exists (select 1 from pg_trigger t where t.tgrelid = 'public.quote_consents'::regclass and t.tgname = 'ab0_r109_consent_org'
              and t.tgenabled = 'O' and t.tgtype = 7 and t.tgfoid = 'public._r109_tg_consent_org_from_quote()'::regprocedure)
    and (select array_agg(tgname order by tgname) from pg_trigger where tgrelid = 'public.quote_consents'::regclass and not tgisinternal
           and tgtype & 2 = 2)[1:2] = array['aa_api_write_block', 'ab0_r109_consent_org']::name[], null);
  perform pg_temp.t('06 trigger function: definer, empty search_path, not callable by anon / authenticated',
    coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%' from pg_proc p
               where p.oid = 'public._r109_tg_consent_org_from_quote()'::regprocedure), false)
    and not has_function_privilege('anon', 'public._r109_tg_consent_org_from_quote()', 'execute')
    and not has_function_privilege('authenticated', 'public._r109_tg_consent_org_from_quote()', 'execute'), null);
  perform pg_temp.t('07 anon / authenticated still cannot insert or update consents directly',
    not has_table_privilege('anon', 'public.quote_consents', 'insert') and not has_table_privilege('authenticated', 'public.quote_consents', 'insert')
    and not has_table_privilege('anon', 'public.quote_consents', 'update') and not has_table_privilege('authenticated', 'public.quote_consents', 'update'), null);
  begin
    -- a consent inserted with a WRONG org is re-stamped to its quote's studio by the trigger ...
    insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, org_id)
      values ('b0000000-0000-4000-8000-00000000da01', '+919800000319', 'Client', 'v1', 'I agree', true, true,
              'a0000000-0000-4000-8000-000000000001');
    if (select org_id from public.quote_consents where quote_id = 'b0000000-0000-4000-8000-00000000da01' order by created_at desc limit 1)
       is distinct from 'b0000000-0000-4000-8000-000000000001'::uuid then
      raise exception using errcode = 'HR109', message = 'insert not re-stamped';
    end if;
    -- ... and an UPDATE that moves it to another studio is still refused
    update public.quote_consents set org_id = 'a0000000-0000-4000-8000-000000000001'
     where quote_id = 'b0000000-0000-4000-8000-00000000da01';
    v := case when found then 'moved' else 'no consent row to move' end;
    raise exception using errcode = 'HR109', message = v;
  exception when sqlstate 'HR109' then v := sqlerrm;
            when others then v := 'err:' || sqlstate || ':' || sqlerrm;
  end;
  perform pg_temp.t('08 a consent inserted with a wrong org gets the quote studio; moving it to another studio is still refused',
    v like 'err:42501:%belongs to another studio%', v);
  perform pg_temp.t('09 0307 single-use wrapper still live (verify_and_consent reaches _r307_verify)',
    position('_r307_verify' in (select prosrc from pg_proc where oid = 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure)) > 0
    and has_function_privilege('anon', 'public.wa_verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute'), null);
end $$;

select name, result from _g319 where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R109-OTP-VERIFY-ORG-0319: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R109-OTP-VERIFY-ORG-0319: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g319;
rollback;
