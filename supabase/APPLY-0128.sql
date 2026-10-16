-- APPLY 0128 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
begin;
-- 0128_trial_test_mode.sql - CANONICAL forward-only. REQUIRES 0026 (quote_otps.code_hash), 0042, 0093 (_otp_canon_phone), 0116 (_trial_locked).
--
-- In plain words:
--   TRIAL TEST MODE. Inside a free-trial studio the owner is testing alone: there is no real
--   client to receive an SMS code. So, ONLY for a studio whose free trial is still running,
--   the client approval page offers "Skip OTP (trial test mode)".
--
--   How the skip works (marker: helm-0128-trial-test):
--     1) trial_test_mode_for_token(token) - true only when the link's studio is an ACTIVE
--        trial (organizations.trial_ends_at set and in the future, not locked). The page uses
--        it only to decide whether to SHOW the skip button.
--     2) trial_test_approve(token, phone, name, terms, consent text, user agent) - checks the
--        SAME thing again on the server (never trusts the page), then writes a one-time code
--        straight into quote_otps (hashed, 10 minutes, no _notify -> no SMS / email / WhatsApp
--        is queued) and calls the normal public.verify_and_consent with it. So the consent row,
--        the quote approval_status flip and every trigger (lifecycle, audit, link expiry,
--        shelf, rate limits) are exactly the real flow. Afterwards the consent is stamped
--        verified_via_otp = false (honest: no SMS was verified) and an audit_log row
--        'approval.trial_test_skip' records that the OTP step was skipped.
--   Non-trial studios: trial_test_approve refuses ('trial_test_unavailable'), and nothing about
--   request_otp / verify_and_consent changes - they still require the OTP exactly as before.
--   Paid / converted / ended trials: refused too (an active subscription or a passed end date).
--
--   Changes: 3 new functions. No table, column, row, existing function or trigger is changed or
--   deleted. Additive + idempotent: safe to run twice. ASCII only.

-- ---- 1) is this org an active trial (internal) -------------------------------------
create or replace function public._trial_test_mode_ok(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0128-trial-test
  select p_org is not null
     and exists (select 1 from public.organizations o
                  where o.id = p_org and o.trial_ends_at is not null and o.trial_ends_at > now())
     and not exists (select 1 from public.studio_subscriptions s
                      where s.org_id = p_org and s.status = 'active')
     and not public._trial_locked(p_org);
$$;
revoke all on function public._trial_test_mode_ok(uuid) from public, anon, authenticated;
grant execute on function public._trial_test_mode_ok(uuid) to service_role;

-- ---- 2) page helper: show the skip button? ------------------------------------------
create or replace function public.trial_test_mode_for_token(p_token uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0128-trial-test
  select coalesce((select public._trial_test_mode_ok(q.org_id) from public.quotes q
                    where p_token is not null and q.approval_token = p_token
                      and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
                    limit 1), false);
$$;
revoke all on function public.trial_test_mode_for_token(uuid) from public;
grant execute on function public.trial_test_mode_for_token(uuid) to anon, authenticated, service_role;

-- ---- 3) the skip itself ------------------------------------------------------------
create or replace function public.trial_test_approve(p_token uuid, p_phone text, p_client_name text,
                                                     p_terms_version text, p_consent_text text,
                                                     p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0128-trial-test: OTP skipped ONLY for an active trial studio; same verify_and_consent path
declare v_q uuid; v_org uuid; v_file text; v_phone text; v_code text; r bigint; v_out jsonb;
begin
  select q.id, q.org_id, coalesce(q.client ->> 'phone', '') into v_q, v_org, v_file
    from public.quotes q
   where p_token is not null and q.approval_token = p_token
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  if not public._trial_test_mode_ok(v_org) then
    return jsonb_build_object('approved', false, 'error', 'trial_test_unavailable',
      'message', 'Skipping the OTP is only available in an active free-trial studio.');
  end if;
  if public.link_age_expired(public.approval_link_age_until(p_token)) or public._a42_quote_shelved(v_q) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if v_phone is null or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 8 then v_phone := nullif(v_file, ''); end if;
  if v_phone is null or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 8 then
    return jsonb_build_object('approved', false, 'error', 'phone_required',
      'message', 'Enter a mobile number (any test number works in trial test mode).');
  end if;
  v_phone := public._otp_canon_phone(p_token, v_phone);
  -- one-time random code, hashed like request_otp; never returned, never sent
  loop
    r := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    exit when r < 4294000000;
  end loop;
  v_code := lpad((r % 1000000)::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (v_q, v_phone, extensions.crypt(v_code, extensions.gen_salt('bf', 8)), now() + interval '10 minutes');
  v_out := public.verify_and_consent(p_token, v_phone, v_code, true, p_terms_version,
                                     p_consent_text, p_client_name, p_user_agent);
  if coalesce((v_out ->> 'approved')::boolean, false) then
    update public.quote_consents c set verified_via_otp = false
     where c.id = (select c2.id from public.quote_consents c2 where c2.quote_id = v_q
                    order by c2.created_at desc, c2.id desc limit 1)
       and c.verified_via_otp;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), null, 'approval.trial_test_skip', 'quotes', v_q::text,
              jsonb_build_object('trial_test', true, 'otp', 'skipped', 'client_name', p_client_name),
              v_org, now());
    v_out := v_out || jsonb_build_object('trial_test', true);
  end if;
  return v_out;
end $$;
revoke all on function public.trial_test_approve(uuid, text, text, text, text, text) from public;
grant execute on function public.trial_test_approve(uuid, text, text, text, text, text) to anon, authenticated, service_role;
commit;

-- VERIFY 0128 (read-only; expect every ok = true)
select '0128 _trial_test_mode_ok exists' as item, to_regprocedure('public._trial_test_mode_ok(uuid)') is not null as ok
union all select '0128 _trial_test_mode_ok not callable by anon', not has_function_privilege('anon', 'public._trial_test_mode_ok(uuid)', 'execute')
union all select '0128 _trial_test_mode_ok not callable by authenticated', not has_function_privilege('authenticated', 'public._trial_test_mode_ok(uuid)', 'execute')
union all select '0128 trial_test_mode_for_token callable by anon', has_function_privilege('anon', 'public.trial_test_mode_for_token(uuid)', 'execute')
union all select '0128 trial_test_approve callable by anon', has_function_privilege('anon', 'public.trial_test_approve(uuid, text, text, text, text, text)', 'execute')
union all select '0128 trial_test_approve security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')), false)
union all select '0128 trial_test_approve gates on active trial', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) like '%_trial_test_mode_ok(v_org)%', false)
union all select '0128 trial_test_approve reuses verify_and_consent', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) like '%public.verify_and_consent(p_token%', false)
union all select '0128 trial_test_approve sends nothing (no _notify)', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) not like '%_notify(%', false)
union all select '0128 no non-trial studio is in trial test mode', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_test_mode_ok(o.id))
union all select '0128 verify_and_consent unchanged (no trial marker)', coalesce(pg_get_functiondef(to_regprocedure('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)')) not like '%helm-0128%', false);
