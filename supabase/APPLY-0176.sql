-- APPLY-0176.sql - paste into the Supabase SQL editor (staging first, then production).
-- Additive + idempotent: trial-only Skip OTP on the client portal + trial event confirmed after it. Paid studios unchanged. Safe to run twice.
begin;
-- 0176_trial_client_flow.sql - CANONICAL forward-only. REQUIRES 0128 + 0146 (trial_test_approve,
-- _aud1017_is_member), 0166 (trial sandbox, outbound guard).
--
-- In plain words:
--   TRIAL CLIENT FLOW. In a free-trial studio no SMS / WhatsApp / email is ever sent (0166 outbound
--   guard), so a client opening the approval portal could never receive the OTP and the event was
--   stuck. 0146 had limited "Skip OTP" to a signed-in member of the studio, so the portal (opened
--   by the client, not signed in) never showed it.
--     1) _trial_client_skip_ok(org): ACTIVE trial (same _trial_test_mode_ok: trial running, no active
--        subscription, not locked) AND (caller is a member of that studio OR caller is not signed in,
--        i.e. the client on the portal). A signed-in member of another studio is refused.
--     2) trial_test_mode_for_token uses it (the portal shows "Test mode - confirm").
--     3) trial_test_approve uses it, and after the approval moves the event to status 'confirmed'
--        (trial only) so the event group, booklet link and adding members work right away.
--   Paid / converted / ended trials: unchanged - request_otp / verify_and_consent still require the
--   real OTP, and trial_test_approve still refuses ('trial_test_unavailable').
--   Changes: 1 new function, 2 functions replaced (same signatures + grants). No table, column or
--   trigger is changed; the only row write is the trial event's own status after the client
--   approves. Additive + idempotent: safe to run twice. ASCII only.

do $$ begin
  if to_regprocedure('public._trial_test_mode_ok(uuid)') is null or to_regprocedure('public._aud1017_is_member(uuid)') is null then
    raise exception '0176: apply 0128 + 0146 first'; end if;
end $$;

create or replace function public._trial_client_skip_ok(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0176-trial-client
  select public._trial_test_mode_ok(p_org)
     and (public._aud1017_is_member(p_org) or auth.uid() is null);
$$;
revoke all on function public._trial_client_skip_ok(uuid) from public, anon, authenticated;
grant execute on function public._trial_client_skip_ok(uuid) to service_role;

create or replace function public.trial_test_mode_for_token(p_token uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0128-trial-test (0176: studio member or the client on the portal, active trial only)
  select coalesce((select public._trial_client_skip_ok(q.org_id) from public.quotes q
                    where p_token is not null and q.approval_token = p_token
                      and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
                    limit 1), false);
$$;
revoke all on function public.trial_test_mode_for_token(uuid) from public;
grant execute on function public.trial_test_mode_for_token(uuid) to anon, authenticated, service_role;

create or replace function public.trial_test_approve(p_token uuid, p_phone text, p_client_name text,
                                                     p_terms_version text, p_consent_text text,
                                                     p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0128-trial-test (0176: client portal allowed in trial; event confirmed after the skip)
declare v_q uuid; v_org uuid; v_file text; v_phone text; v_code text; r bigint; v_out jsonb;
begin
  select q.id, q.org_id, coalesce(q.client ->> 'phone', '') into v_q, v_org, v_file
    from public.quotes q
   where p_token is not null and q.approval_token = p_token
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  -- 0146 aud1017: the skip is for the studio owner testing alone - a client (or anyone else
  -- holding the link) must go through the real OTP.
  -- 0176: the studio's own member (testing alone) OR the client on the portal (not signed in).
  -- A signed-in member of ANOTHER studio is still refused. Paid / ended / locked: always refused.
  if not public._trial_client_skip_ok(v_org) then
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
    -- 0176: trial only - the approved event moves on to Confirmed so the next steps work
    -- (event group, booklet link, members). Never for a paid studio (gate above).
    update public.quotes qq set status = 'confirmed', confirmed_at = coalesce(qq.confirmed_at, now())
     where qq.id = v_q and qq.status is distinct from 'confirmed' and qq.status is distinct from 'cancelled'
       and qq.deleted_at is null and qq.approval_status = 'approved';
    v_out := v_out || jsonb_build_object('trial_test', true, 'confirmed', true);
  end if;
  return v_out;
end $$;
revoke all on function public.trial_test_approve(uuid, text, text, text, text, text) from public;
grant execute on function public.trial_test_approve(uuid, text, text, text, text, text) to anon, authenticated, service_role;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 _trial_client_skip_ok exists, not callable by app', to_regprocedure('public._trial_client_skip_ok(uuid)') is not null
      and not has_function_privilege('anon', 'public._trial_client_skip_ok(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._trial_client_skip_ok(uuid)', 'execute')),
  ('02 trial_test_mode_for_token uses 0176 gate', position('_trial_client_skip_ok' in pg_get_functiondef('public.trial_test_mode_for_token(uuid)'::regprocedure)) > 0),
  ('03 trial_test_approve uses 0176 gate + confirms', position('_trial_client_skip_ok' in pg_get_functiondef('public.trial_test_approve(uuid,text,text,text,text,text)'::regprocedure)) > 0
      and position('''confirmed'', true' in pg_get_functiondef('public.trial_test_approve(uuid,text,text,text,text,text)'::regprocedure)) > 0),
  ('04 gate still requires an active trial', position('_trial_test_mode_ok' in pg_get_functiondef('public._trial_client_skip_ok(uuid)'::regprocedure)) > 0),
  ('05 portal can call both RPCs', has_function_privilege('anon', 'public.trial_test_approve(uuid,text,text,text,text,text)', 'execute')
      and has_function_privilege('anon', 'public.trial_test_mode_for_token(uuid)', 'execute')),
  ('06 no paid studio has Skip OTP', not exists (select 1 from public.studio_subscriptions s where s.status = 'active' and public._trial_test_mode_ok(s.org_id)))
) v(item, ok) order by item;
