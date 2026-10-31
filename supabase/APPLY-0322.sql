-- APPLY-0322.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0322: ..." if an earlier migration it builds on (0128 / 0176 / 0179 / 0236 / 0260 / 0311) is missing.
-- R113 (owner decision): the client approval in a FREE TRIAL studio is a TEST. A studio on a Helm free trial (active or
--   ended) never sends a real approval code - no e-mail, no WhatsApp, no SMS. The client's approval page says "Test mode"
--   and the client types the test code 000000 + "Simulate approval". That approval is recorded as a TEST (the consent row
--   is flagged test_mode, audit row 'approval.test_mode'). Paid studios: nothing changes. Nothing is deleted. Safe to run
--   twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the send-otp edge function (it no longer e-mails a code for a trial) and the site (approve page).
--   3  Open a trial studio's approval link: the "Test mode" banner shows; 000000 + Simulate approval approves.
begin;
-- 0322_r113_trial_approval_test_mode.sql - CANONICAL forward-only. R113 (owner decision): the client approval in a
-- FREE TRIAL studio is a DUMMY / TEST approval.
--
-- In plain words:
--   A studio on a Helm free trial (active OR ended, and the sample master - the 0179 rule _tb179_no_send) never sends a
--   real approval code to its client: no e-mail, no WhatsApp, no SMS. The client's approval page shows "Test mode" and
--   accepts only the test code 000000 ("Simulate approval"). The approval it records is a TEST: the consent row is
--   flagged test_mode = true and one audit_log row 'approval.test_mode' is written. Paid studios: nothing changes.
--   (0212 had let an ACTIVE trial e-mail the real code; that is now off. Booklet / approval LINK e-mails are unchanged.)
--
--   1) NEW column quote_consents.test_mode boolean not null default false (existing rows: false; nothing rewritten).
--   2) NEW BEFORE INSERT trigger ab2_r322_trial_otp on quote_otps: an app call (anon / authenticated / service_role,
--      _r311_app_call) cannot store an approval code for a trial studio's quote -> 42501, hint trial_no_send. Covers
--      every code path (admin_store_otp used by send-otp, request_otp, wa_request_otp, ...) whatever wrapper is on top.
--   3) NEW BEFORE INSERT trigger ab2_r322_trial_otp_slot on trial_email_sends (0212 ledger): no 'otp' slot (= no code
--      by e-mail) for a trial -> trial_email_otp_begin refuses with 42501 / trial_no_send (send-otp answers 403 trial).
--   4) NEW BEFORE INSERT trigger ab2_r322_trial_consent on quote_consents: for a trial studio's quote an app call may
--      only save the consent inside the test approval below (transaction-local mark helm.r322_test = the quote id);
--      that row gets test_mode = true and verified_via_otp = false. Any other trial consent -> 42501 hint
--      trial_test_only ("use the test code 000000"). Paid studios untouched. 0318 (no price) and 0319 (consent org from
--      the quote) still run on the same insert.
--   5) NEW public RPC trial_test_approve_code(token, code, phone, name, terms version, consent text, user agent):
--      trial studio + code 000000 -> runs the existing trial test approval (trial_test_approve: 0176 / 0260 checks, event
--      Confirmed) inside the mark, writes audit 'approval.test_mode' and answers {approved, test_mode: true, ...}.
--      Any other code -> {approved:false, error:'test_code'}; paid studio -> {approved:false, error:'trial_test_unavailable'};
--      ended trial -> {approved:false, error:'trial_ended'}. The old trial_test_approve (no code) called directly by the
--      app is refused by (2) (no code row), so the only way to approve a trial quote is the test code.
--   6) NEW public RPC public_trial_approval_mode(token) -> {test_mode, can_approve, ended} (anon; null for an unknown /
--      expired / revoked / deleted / cancelled link; no price, phone or id) - the approval page shows the banner.
-- No table / row / policy / index deleted; no existing function body replaced. Safe to run twice. ASCII only.
-- Goes after 0128 + 0176 + 0179 + 0212 + 0236 + 0260 + 0311 + 0318 + 0319.
-- ROLLBACK (manual, only if ever needed; no data involved): drop trigger ab2_r322_trial_otp on public.quote_otps;
-- drop trigger ab2_r322_trial_otp_slot on public.trial_email_sends; drop trigger ab2_r322_trial_consent on
-- public.quote_consents; (the column, the two RPCs and the audit rows can stay - nothing reads them on the old path).

do $$
begin
  if to_regclass('public.quotes') is null or to_regclass('public.quote_otps') is null or to_regclass('public.quote_consents') is null then
    raise exception 'STOP 0322: quotes / quote_otps / quote_consents missing'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception 'STOP 0322: _tb179_no_send missing - run 0179 first'; end if;
  if to_regprocedure('public._trial_client_skip_ok(uuid)') is null or to_regprocedure('public._trial_test_mode_ok(uuid)') is null then
    raise exception 'STOP 0322: _trial_client_skip_ok / _trial_test_mode_ok missing - run 0128 + 0176 + 0236 first'; end if;
  if to_regprocedure('public.trial_test_approve(uuid,text,text,text,text,text)') is null then
    raise exception 'STOP 0322: trial_test_approve missing - run 0176 first'; end if;
  if to_regprocedure('public._r311_app_call()') is null then raise exception 'STOP 0322: _r311_app_call missing - run 0311 first'; end if;
  if to_regprocedure('public._a260_quote_cancelled(uuid)') is null then raise exception 'STOP 0322: _a260_quote_cancelled missing - run 0260 first'; end if;
end $$;

-- ---- 1) the test flag on a consent ---------------------------------------------------------------------------------
alter table public.quote_consents add column if not exists test_mode boolean not null default false;
comment on column public.quote_consents.test_mode is
  'R113 (0322): true = a free-trial TEST approval (code 000000, nothing sent) - never a real client approval.';

-- ---- 2) helpers (not callable by the app) ---------------------------------------------------------------------------
-- the quote is a free-trial studio's (active or ended trial, or the sample master: the 0179 "never send" rule)
create or replace function public._r322_trial_quote(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r113-trial-test-0322
  select coalesce((select public._tb179_no_send(q.org_id) from public.quotes q where q.id = p_quote), false);
$$;
-- inside the test approval of exactly this quote (transaction-local mark set only by trial_test_approve_code)
create or replace function public._r322_in_test(p_quote uuid)
returns boolean language sql stable set search_path = '' as $$
  -- r113-trial-test-0322
  select p_quote is not null and coalesce(current_setting('helm.r322_test', true), '') = p_quote::text;
$$;

-- ---- 3) no real approval code is ever stored for a trial studio's quote ---------------------------------------------
create or replace function public._r322_tg_trial_otp()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r113-trial-test-0322: app calls only (SQL by hand stays free); the test approval's own one-time row is allowed
begin
  if not public._r311_app_call() or public._r322_in_test(new.quote_id) then return new; end if;
  if public._r322_trial_quote(new.quote_id) then
    raise exception 'Free trial: no approval code is sent - the client uses the test code 000000 on the approval page.'
      using errcode = '42501', hint = 'trial_no_send';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'public.quote_otps'::regclass
                   and t.tgname = 'ab2_r322_trial_otp' and not t.tgisinternal) then
    create trigger ab2_r322_trial_otp before insert on public.quote_otps
      for each row execute function public._r322_tg_trial_otp();
  end if;
end $$;

-- ---- 4) no trial "code by e-mail" slot (0212 trial_email_otp_begin) ---------------------------------------------------
create or replace function public._r322_tg_trial_otp_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r113-trial-test-0322: an 'otp' row in the trial e-mail ledger = a real code e-mailed by a trial studio -> refused
begin
  if new.kind = 'otp' and public._r311_app_call() then
    raise exception 'Free trial: no approval code is sent - the client uses the test code 000000 on the approval page.'
      using errcode = '42501', hint = 'trial_no_send';
  end if;
  return new;
end $$;

do $$ begin
  if to_regclass('public.trial_email_sends') is not null
     and not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'public.trial_email_sends'::regclass
                       and t.tgname = 'ab2_r322_trial_otp_slot' and not t.tgisinternal) then
    create trigger ab2_r322_trial_otp_slot before insert on public.trial_email_sends
      for each row execute function public._r322_tg_trial_otp_slot();
  end if;
end $$;

-- ---- 5) a trial consent is only ever the test approval, and is flagged -----------------------------------------------
create or replace function public._r322_tg_trial_consent()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r113-trial-test-0322
begin
  if public._r322_in_test(new.quote_id) then
    new.test_mode := true; new.verified_via_otp := false;
    return new;
  end if;
  if public._r311_app_call() and public._r322_trial_quote(new.quote_id) then
    raise exception 'Test mode: this studio is on a Helm free trial, so no code is sent. Use the test code 000000 on the approval page.'
      using errcode = '42501', hint = 'trial_test_only';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'public.quote_consents'::regclass
                   and t.tgname = 'ab2_r322_trial_consent' and not t.tgisinternal) then
    create trigger ab2_r322_trial_consent before insert on public.quote_consents
      for each row execute function public._r322_tg_trial_consent();
  end if;
end $$;

-- ---- 6) the approval page: is this link a free-trial test-mode approval -----------------------------------------------
create or replace function public.public_trial_approval_mode(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r113-trial-test-0322: {test_mode, can_approve, ended} only; unknown / expired / revoked / deleted / cancelled -> null
declare v_q uuid; v_org uuid; v_trial boolean; v_active boolean;
begin
  if p_token is null then return null; end if;
  select q.id, q.org_id into v_q, v_org
    from public.quotes q
   where q.approval_token = p_token
     and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
     and q.deleted_at is null
   limit 1;
  if v_q is null or coalesce(public._a260_quote_cancelled(v_q), false) then return null; end if;
  v_trial := coalesce(public._tb179_no_send(v_org), false);
  if not v_trial then return jsonb_build_object('test_mode', false, 'can_approve', false, 'ended', false); end if;
  v_active := coalesce(public._trial_test_mode_ok(v_org), false);
  return jsonb_build_object('test_mode', true, 'can_approve', v_active and coalesce(public._trial_client_skip_ok(v_org), false),
                            'ended', not v_active);
end $$;

-- ---- 7) the test approval: code 000000 only, trial studios only ---------------------------------------------------------
create or replace function public.trial_test_approve_code(p_token uuid, p_code text, p_phone text, p_client_name text,
                                                          p_terms_version text, p_consent_text text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r113-trial-test-0322
declare v_q uuid; v_org uuid; v_studio text; v_out jsonb;
begin
  select q.id, q.org_id into v_q, v_org
    from public.quotes q
   where p_token is not null and q.approval_token = p_token
     and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
     and q.deleted_at is null
   limit 1;
  if v_q is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  if not coalesce(public._tb179_no_send(v_org), false) then
    return jsonb_build_object('approved', false, 'error', 'trial_test_unavailable',
      'message', 'Test mode is only for studios on a Helm free trial - use the code sent to you.');
  end if;
  if regexp_replace(coalesce(p_code, ''), '\s', '', 'g') <> '000000' then
    return jsonb_build_object('approved', false, 'error', 'test_code',
      'message', 'That is not the test code. In test mode no code is sent - use 000000.');
  end if;
  select nullif(btrim(coalesce(o.name, '')), '') into v_studio from public.organizations o where o.id = v_org;
  if not coalesce(public._trial_test_mode_ok(v_org), false) then
    return jsonb_build_object('approved', false, 'error', 'trial_ended',
      'message', 'This studio''s free trial has ended, so the test approval is closed. Please contact '
                 || coalesce(left(v_studio, 120), 'your planner') || '.');
  end if;
  if not coalesce(public._trial_client_skip_ok(v_org), false) then
    return jsonb_build_object('approved', false, 'error', 'trial_test_unavailable',
      'message', 'You are signed in to another Helm studio - open this link in a private window to try the test approval.');
  end if;
  perform set_config('helm.r322_test', v_q::text, true);
  v_out := public.trial_test_approve(p_token, p_phone, p_client_name, p_terms_version, p_consent_text, p_user_agent);
  perform set_config('helm.r322_test', '', true);
  if coalesce((v_out ->> 'approved')::boolean, false) and not coalesce((v_out ->> 'already_approved')::boolean, false) then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), null, 'approval.test_mode', 'quotes', v_q::text,
              jsonb_build_object('test_mode', true, 'code', 'test', 'sent', false,
                                 'client_name', left(coalesce(p_client_name, ''), 120)),
              v_org, now());
  end if;
  return coalesce(v_out, '{}'::jsonb) || jsonb_build_object('test_mode', true);
end $$;

-- ---- 8) privileges --------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._r322_trial_quote(uuid)', 'public._r322_in_test(uuid)', 'public._r322_tg_trial_otp()',
                           'public._r322_tg_trial_otp_slot()', 'public._r322_tg_trial_consent()',
                           'public.public_trial_approval_mode(uuid)',
                           'public.trial_test_approve_code(uuid, text, text, text, text, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_catalog.pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.public_trial_approval_mode(uuid) to %I', r);
      execute format('grant execute on function public.trial_test_approve_code(uuid, text, text, text, text, text, text) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 column quote_consents.test_mode: boolean, not null, default false',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_consents'
               and column_name = 'test_mode' and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false')),
  ('02 triggers ab2_r322_trial_otp (quote_otps) + ab2_r322_trial_consent (quote_consents): BEFORE INSERT, enabled',
     exists (select 1 from pg_trigger t where t.tgrelid = 'public.quote_otps'::regclass and t.tgname = 'ab2_r322_trial_otp' and t.tgenabled = 'O' and t.tgtype = 7)
     and exists (select 1 from pg_trigger t where t.tgrelid = 'public.quote_consents'::regclass and t.tgname = 'ab2_r322_trial_consent' and t.tgenabled = 'O' and t.tgtype = 7)),
  ('03 trigger ab2_r322_trial_otp_slot on trial_email_sends (or no 0212 ledger on this database)',
     to_regclass('public.trial_email_sends') is null
     or exists (select 1 from pg_trigger t where t.tgrelid = to_regclass('public.trial_email_sends') and t.tgname = 'ab2_r322_trial_otp_slot' and t.tgenabled = 'O')),
  ('04 the approval page can call trial_test_approve_code + public_trial_approval_mode (anon)',
     has_function_privilege('anon', 'public.trial_test_approve_code(uuid,text,text,text,text,text,text)', 'execute')
     and has_function_privilege('anon', 'public.public_trial_approval_mode(uuid)', 'execute')),
  ('05 helper + trigger functions are not callable by anon / authenticated',
     not has_function_privilege('anon', 'public._r322_trial_quote(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r322_in_test(uuid)', 'execute')
     and not has_function_privilege('anon', 'public._r322_tg_trial_otp()', 'execute')
     and not has_function_privilege('authenticated', 'public._r322_tg_trial_consent()', 'execute')),
  ('06 0318 no-price guard + 0319 consent org stamp still on quote_consents',
     exists (select 1 from pg_trigger where tgrelid = 'public.quote_consents'::regclass and tgname = 'zz_r318_consent_priced')
     and exists (select 1 from pg_trigger where tgrelid = 'public.quote_consents'::regclass and tgname = 'ab0_r109_consent_org')),
  ('07 approval link functions still callable by the client (anon)',
     has_function_privilege('anon', 'public.wa_verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute')
     and has_function_privilege('anon', 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute'))
) v(item, ok);
