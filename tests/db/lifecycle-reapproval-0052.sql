-- lifecycle-reapproval-0052.sql — 0052: allowed lifecycle transitions (+ audited admin
-- override) and re-approval when an approved quote's total changes after client consent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _g52; create temp table _g52(name text, result text); grant all on _g52 to anon, authenticated;

create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare n bigint; v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v; get diagnostics n = row_count;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g52 values (p_name, case when p_ok then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.stage() returns text language sql as $$
  select lifecycle_stage from public.quotes where id = 'a0000000-0000-4000-8000-0000000052a1' $$;

do $$ begin
  execute 'reset role';
  delete from public.quote_consents where quote_id = 'a0000000-0000-4000-8000-0000000052a1';   -- disposable test DB
  delete from public.lifecycle_stage_overrides where quote_id = 'a0000000-0000-4000-8000-0000000052a1';
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id,
                            approval_token, lifecycle_stage, event_date, created_at, updated_at)
    values ('a0000000-0000-4000-8000-0000000052a1', 'A-0052', 'Reapproval A', 'quote', '{"name":"Ann"}'::jsonb,
            '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb, 1, 'sent',
            'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000052aa', 'quote',
            current_date + 10, now(), now())
    on conflict (id) do update set pricing = excluded.pricing, approval_status = 'sent', lifecycle_stage = 'quote',
      approval_token = excluded.approval_token, consent_stale = false, event_date = excluded.event_date,
      approval_token_revoked_at = null, approval_token_expires_at = null;
end $$;

do $$ declare r text; n int; begin
  -- ---- transitions ----
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'confirmed')::text$q$);
  perform pg_temp.t('confirmed without client consent → HL409', r like 'err:HL409%not approved%', r);
  perform pg_temp.t('refused move left the stage alone', pg_temp.stage() = 'quote', pg_temp.stage());
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'planning')::text$q$);
  perform pg_temp.t('skip quote→planning without consent → HL409', r like 'err:HL409%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'proposal')::text$q$);
  perform pg_temp.t('backward quote→proposal allowed', r like 'ok:%' and pg_temp.stage() = 'proposal', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'quote')::text$q$);
  perform pg_temp.t('forward to next stage (no gate) allowed', r like 'ok:%' and pg_temp.stage() = 'quote', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'confirmed', 'phone approval ok')::text$q$);
  perform pg_temp.t('override by non-admin (sales) → 42501', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'confirmed', 'abc')::text$q$);
  perform pg_temp.t('override reason too short → 22023', r like 'err:22023%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'confirmed', 'org B tries this')::text$q$);
  perform pg_temp.t('Org B admin override on Org A event → 42501', r like 'err:42501%' and pg_temp.stage() = 'quote', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'proposal')::text$q$);
  perform pg_temp.t('Org B admin plain move on Org A event → 42501', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'confirmed', 'client approved by phone call')::text$q$);
  perform pg_temp.t('admin override with reason allowed', r like 'ok:%' and pg_temp.stage() = 'confirmed', r);
  select count(*) into n from public.lifecycle_stage_overrides
   where quote_id = 'a0000000-0000-4000-8000-0000000052a1' and to_stage = 'confirmed' and reason = 'client approved by phone call';
  perform pg_temp.t('override recorded in lifecycle_stage_overrides', n = 1, n::text);
  perform pg_temp.t('override recorded in audit_log', exists (select 1 from public.audit_log where action = 'stage_override'
     and quote_id = 'a0000000-0000-4000-8000-0000000052a1' and changed ->> 'reason' = 'client approved by phone call'), null);
  r := pg_temp.as_try('a_staff@a.test', $q$select count(*)::text from public.lifecycle_stage_overrides where quote_id = 'a0000000-0000-4000-8000-0000000052a1'$q$);
  perform pg_temp.t('Org A member reads the override', r = 'ok:1', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select count(*)::text from public.lifecycle_stage_overrides where quote_id = 'a0000000-0000-4000-8000-0000000052a1'$q$);
  perform pg_temp.t('Org B cannot read Org A overrides', r = 'ok:0', r);
  r := pg_temp.as_try('a_staff@a.test', $q$insert into public.lifecycle_stage_overrides(org_id, quote_id, to_stage, reason) values ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-0000000052a1','ready','forged row') returning id::text$q$);
  perform pg_temp.t('client cannot forge an override row', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'settlement')::text$q$);
  perform pg_temp.t('settlement before the event date → HL409', r like 'err:HL409%has not arrived%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'closed', 'just close it')::text$q$);
  perform pg_temp.t('closed never via set_lifecycle_stage (even admin) → 22023', r like 'err:22023%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'bogus')::text$q$);
  perform pg_temp.t('unknown stage → 22023', r like 'err:22023%', r);
  update public.quotes set event_date = current_date - 1 where id = 'a0000000-0000-4000-8000-0000000052a1';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'settlement')::text$q$);
  perform pg_temp.t('settlement once the event date passed (skip, gates met)', r like 'ok:%' and pg_temp.stage() = 'settlement', r);
  update public.quotes set event_date = current_date + 10 where id = 'a0000000-0000-4000-8000-0000000052a1';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'quote')::text$q$);
  perform pg_temp.t('backward settlement→quote allowed', r like 'ok:%' and pg_temp.stage() = 'quote', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.lifecycle_stage_blockers('a0000000-0000-4000-8000-0000000052a1', 'confirmed')::text$q$);
  perform pg_temp.t('blockers RPC explains the gate', r like 'ok:%not approved%', r);

  -- ---- client consent ----
  insert into public.quote_consents(quote_id, phone, client_name, agreed, verified_via_otp, created_at)
    values ('a0000000-0000-4000-8000-0000000052a1', '9999999999', 'Ann', true, true, clock_timestamp());
  update public.quotes set approval_status = 'approved' where id = 'a0000000-0000-4000-8000-0000000052a1';
  perform pg_temp.t('consent snapshot recorded the total', (select quote_total from public.quote_consents
     where quote_id = 'a0000000-0000-4000-8000-0000000052a1') = 236000, null);
  perform pg_temp.t('consent moved an early-stage quote to confirmed', pg_temp.stage() = 'confirmed', pg_temp.stage());
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'planning')::text$q$);
  perform pg_temp.t('planning once confirmed with consent', r like 'ok:%' and pg_temp.stage() = 'planning', r);

  -- ---- unchanged total keeps approval ----
  r := pg_temp.as_try('a_staff@a.test', $q$update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000.00}'::jsonb where id = 'a0000000-0000-4000-8000-0000000052a1' returning 'x'$q$);
  perform pg_temp.t('pricing edit with the same total keeps the approval',
    r like 'ok:%' and (select not consent_stale and approval_status = 'approved' from public.quotes where id = 'a0000000-0000-4000-8000-0000000052a1'), r);

  -- ---- price change after consent → stale ----
  select count(*) into n from public.quote_consents where quote_id = 'a0000000-0000-4000-8000-0000000052a1';
  r := pg_temp.as_try('a_staff@a.test', $q$update public.quotes set pricing = '{"subtotal":210000,"discount":0,"gstPct":18,"total":247800}'::jsonb where id = 'a0000000-0000-4000-8000-0000000052a1' returning 'x'$q$);
  perform pg_temp.t('price edit itself is allowed', r like 'ok:%', r);
  perform pg_temp.t('approval marked stale + back to sent',
    (select consent_stale and approval_status = 'sent' and consent_stale_prev_total = 236000 and consent_stale_new_total = 247800
       from public.quotes where id = 'a0000000-0000-4000-8000-0000000052a1'), null);
  perform pg_temp.t('consent history kept', (select count(*) from public.quote_consents where quote_id = 'a0000000-0000-4000-8000-0000000052a1') = n, null);
  perform pg_temp.t('studio notified', exists (select 1 from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000052a1'
     and kind = 'reapproval_required' and org_id = 'a0000000-0000-4000-8000-000000000001'), null);
  perform pg_temp.t('audit row consent_stale', exists (select 1 from public.audit_log where action = 'consent_stale'
     and quote_id = 'a0000000-0000-4000-8000-0000000052a1'), null);
  r := pg_temp.as_try('a_staff@a.test', $q$update public.quotes set consent_stale = false where id = 'a0000000-0000-4000-8000-0000000052a1' returning 'x'$q$);
  perform pg_temp.t('client cannot clear consent_stale directly', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.confirm_quote('a0000000-0000-4000-8000-0000000052a1', null, null)::text$q$);
  perform pg_temp.t('confirm & lock blocked while stale → HL428', r like 'err:HL428%approve again%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_plan_lock('a0000000-0000-4000-8000-0000000052a1', true)::text$q$);
  perform pg_temp.t('plan lock blocked while stale → HL428', r like 'err:HL428%', r);
  r := pg_temp.as_try('anon', $q$select public.create_payment('a0000000-0000-4000-8000-0000000052aa')::text$q$);
  perform pg_temp.t('client payment blocked while stale', r like 'err:HL428%', r);
  r := pg_temp.as_try(null, $q$select public.payment_link_begin('a0000000-0000-4000-8000-0000000052aa', 60)::text$q$);
  perform pg_temp.t('payment-link creation refused while stale', r like 'ok:%not_approved%reapproval_required%', r);
  r := pg_temp.as_try('anon', $q$select public.public_get_quote('a0000000-0000-4000-8000-0000000052aa')::text$q$);
  perform pg_temp.t('client page sees reapproval_required', r like '%"reapproval_required": true%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'quote')::text$q$);
  perform pg_temp.t('backward still allowed while stale', r like 'ok:%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'confirmed', 'admin wants to skip it')::text$q$);
  perform pg_temp.t('stale approval cannot be overridden (admin) → HL428', r like 'err:HL428%' and pg_temp.stage() = 'quote', r);

  -- ---- new approval link + new consent ----
  r := pg_temp.as_try('b_admin@b.test', $q$select public.reissue_approval_link('a0000000-0000-4000-8000-0000000052a1')::text$q$);
  perform pg_temp.t('Org B cannot reissue Org A link', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.reissue_approval_link('a0000000-0000-4000-8000-0000000052a1')::text$q$);
  perform pg_temp.t('studio reissues a NEW approval link',
    r like 'ok:%' and r <> 'ok:a0000000-0000-4000-8000-0000000052aa'
    and (select approval_token::text from public.quotes where id = 'a0000000-0000-4000-8000-0000000052a1') = substr(r, 4)
    and (select approval_status from public.quotes where id = 'a0000000-0000-4000-8000-0000000052a1') = 'sent', r);
  r := pg_temp.as_try('anon', $q$select public.create_payment('a0000000-0000-4000-8000-0000000052aa')::text$q$);
  perform pg_temp.t('old link is dead', r like 'err:%', r);
  insert into public.quote_consents(quote_id, phone, client_name, agreed, verified_via_otp, created_at)
    values ('a0000000-0000-4000-8000-0000000052a1', '9999999999', 'Ann', true, true, clock_timestamp());
  update public.quotes set approval_status = 'approved' where id = 'a0000000-0000-4000-8000-0000000052a1';
  perform pg_temp.t('new consent clears stale', (select not consent_stale and consent_stale_at is null
     from public.quotes where id = 'a0000000-0000-4000-8000-0000000052a1'), null);
  perform pg_temp.t('new consent snapshot = new total', public._a52_consent_total('a0000000-0000-4000-8000-0000000052a1') = 247800, null);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000052a1', 'planning')::text$q$);
  perform pg_temp.t('planning allowed after re-approval', r like 'ok:%' and pg_temp.stage() = 'planning', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_plan_lock('a0000000-0000-4000-8000-0000000052a1', true)::text$q$);
  perform pg_temp.t('plan lock allowed after re-approval', r like 'ok:%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.confirm_quote('a0000000-0000-4000-8000-0000000052a1', null, null)::text$q$);
  perform pg_temp.t('confirm allowed after re-approval', r like 'ok:%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.reissue_approval_link('a0000000-0000-4000-8000-0000000052a1')::text$q$);
  perform pg_temp.t('reissue refused when not stale', r like 'err:22023%', r);

  -- ---- price changed then reverted ----
  update public.quotes set pricing = '{"subtotal":220000,"discount":0,"gstPct":18,"total":259600}'::jsonb where id = 'a0000000-0000-4000-8000-0000000052a1';
  update public.quotes set pricing = '{"subtotal":210000,"discount":0,"gstPct":18,"total":247800}'::jsonb where id = 'a0000000-0000-4000-8000-0000000052a1';
  perform pg_temp.t('reverting to the approved total restores approval',
    (select not consent_stale and approval_status = 'approved' from public.quotes where id = 'a0000000-0000-4000-8000-0000000052a1'), null);

  -- ---- a never-approved quote is not affected ----
  update public.quotes set pricing = '{"subtotal":100,"discount":0,"gstPct":18,"total":118}'::jsonb where id = 'b0000000-0000-4000-8000-00000000da01';
  perform pg_temp.t('unapproved quote price edit not flagged', (select not consent_stale from public.quotes where id = 'b0000000-0000-4000-8000-00000000da01'), null);
  update public.quotes set pricing = '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb where id = 'b0000000-0000-4000-8000-00000000da01';
end $$;

select name, result from _g52 where result <> 'PASS';
select case when not exists (select 1 from _g52 where result <> 'PASS')
            then 'LIFECYCLE-REAPPROVAL-0052: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'LIFECYCLE-REAPPROVAL-0052: FAILURES (' || count(*) filter (where result <> 'PASS') || ')' end
  from _g52;
