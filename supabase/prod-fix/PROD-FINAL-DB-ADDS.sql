-- ============================================================================
-- HELM PROD — FINAL DB ADDS (forward-only, minimal). Run in prod SQL editor (nqltz).
-- Closes the last two DB gaps BLOCK 1 found on prod:
--   (A) C2b: verify_and_consent OTP-lockout rollback bug
--   (B) my_pending RPC missing -> dashboard 'Upcoming & my tasks' widget hidden
-- Both are additive/idempotent (create or replace). Run each section; check VERIFY.
-- Generated 2026-09-30T12:33:17Z from staging (xizeh), verified there.
-- ============================================================================

-- ========================= (A) C2b — verify_and_consent =====================
-- PRECHECK (expect 'BUGGY (needs fix)'):
select case when pg_get_functiondef(oid) like '%raise exception ''incorrect code''%' then 'BUGGY (needs fix)' else 'already fixed/different' end as precheck from pg_proc where proname='verify_and_consent' and pronamespace='public'::regnamespace;
-- UPGRADE:
CREATE OR REPLACE FUNCTION public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q public.quotes; rec public.quote_otps;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select * into rec from public.quote_otps
    where quote_id=q.id and phone=p_phone and verified_at is null and expires_at > now()
    order by created_at desc limit 1;
  if rec.id is null then
    return jsonb_build_object('approved', false, 'error','no_active_code', 'message','no active code — request a new OTP');
  end if;
  if rec.attempts >= 5 then
    return jsonb_build_object('approved', false, 'error','locked', 'message','too many attempts — request a new OTP');
  end if;
  if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then
    update public.quote_otps set attempts = attempts+1 where id = rec.id;
    return jsonb_build_object('approved', false, 'error','incorrect_code', 'message','incorrect code',
      'remaining', greatest(0, 5 - (rec.attempts+1)));
  end if;
  if p_agreed is not true then
    return jsonb_build_object('approved', false, 'error','not_agreed', 'message','you must accept the terms to confirm');
  end if;
  update public.quote_otps set verified_at = now() where id = rec.id;
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, user_agent)
    values (q.id, p_phone, p_client_name, p_terms_version, p_consent_text, true, true, p_user_agent);
  update public.quotes set approval_status='approved', updated_at=now() where id=q.id;
  return jsonb_build_object('approved', true);
end; $function$;
-- VERIFY (expect fixed=t):
select (pg_get_functiondef(oid) like '%''incorrect_code''%' and pg_get_functiondef(oid) not like '%raise exception ''incorrect code''%') as fixed from pg_proc where proname='verify_and_consent' and pronamespace='public'::regnamespace;

-- ========================= (B) my_pending RPC ==============================
-- PRECHECK (expect exists=f):
select exists(select 1 from pg_proc where proname='my_pending' and pronamespace='public'::regnamespace) as exists_before;
-- UPGRADE:
CREATE OR REPLACE FUNCTION public.my_pending()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select auth.uid() as uid, public.current_org_id() as org, public.has_area('quotes','view') as can_view
  ),
  ev as (
    select q.id, q.code, q.title, q.event_type, q.event_date, q.event_time, q.lifecycle_stage,
           (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is null)     as open_tasks,
           (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is not null) as done_tasks
    from public.quotes q, me
    where me.can_view
      and q.org_id = me.org
      and coalesce(q.lifecycle_stage,'') <> 'closed'
    order by q.event_date nulls last, q.updated_at desc
    limit 25
  ),
  unread as (
    select count(*)::int as c
    from public.notifications n, me
    where n.org_id = me.org
      and n.created_at > coalesce((select last_seen_at from public.notification_seen s where s.user_id = me.uid), '-infinity'::timestamptz)
  )
  select jsonb_build_object(
    'upcoming', coalesce((select jsonb_agg(to_jsonb(ev) order by (ev.event_date is null), ev.event_date) from ev), '[]'::jsonb),
    'unread',   (select c from unread),
    'as_of',    now()
  );
$function$;
revoke all on function public.my_pending() from anon, public;
grant execute on function public.my_pending() to authenticated;
-- VERIFY (expect ok=t):
select has_function_privilege('authenticated','public.my_pending()','EXECUTE') as ok, not has_function_privilege('anon','public.my_pending()','EXECUTE') as anon_denied;
