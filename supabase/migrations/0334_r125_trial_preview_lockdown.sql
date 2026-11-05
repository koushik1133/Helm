-- 0334_r125_trial_preview_lockdown.sql - CANONICAL forward-only. R125 (owner): in a free trial no link and no message
-- leaves Helm, except sign-up, sign-in and team invitations for teammates. Every send button becomes a "(Preview)"
-- pop-up that runs inside the signed-in studio session. Test approval and Simulate payment move to a members-only path.
-- REQUIRES 0116 / 0183 (trial lock), 0179 (_tb179_no_send), 0241 (delivery links), 0256 (vendor request links),
--          0260 (cancel gate, the *__pre0260 chain), 0265 (crew self-service), 0269 (enquiry form), 0279 / 0306 (referrals),
--          0284 (invitation RSVP), 0297 (client link allow-lists), 0322 / 0323 / 0324 / 0325 (trial test mode + simulation),
--          0333 (goes after R124).
--
-- In plain words:
--   1  _r125_closed(org) says "this is a trial studio": subscription status trial, or an ended / suspended trial that
--      never paid (active and ended trials alike). A paid studio answers false after one primary-key look-up.
--   2  Every public page and action asks that question first. A closed studio's token is swapped for one that cannot
--      exist, so the kept body gives EXACTLY the answer a random token gets: same error, same null, no hint that the
--      studio, the event or the trial exists. Approve, portal, booklet, invitation, proposal, crew, vendor, delivery,
--      enquiry and referral links; RSVP, package choice, approval (000000 too), payment, vendor and crew writes.
--      Paid studios run the kept bodies with the real token, unchanged.
--   3  Nothing is deleted. Links of trial studios are refused, not removed: the same address works again after an
--      upgrade if it has not expired.
--   4  A trial studio can no longer create a link: generate_approval_token, booklet_share, publish_proposal,
--      publish_event_site, event_site_new_link, delivery_link_issue, vendor_request_link refuse (hint trial_no_links), and
--      triggers repeat that on the tables. Crew, delivery and vendor link rows are skipped quietly, because assigning a
--      task or saving a vendor request must keep working. On upgrade the missing crew links are made (tg_r125_unlock).
--   5  Members-only path, signed-in staff of that studio only, no token left behind:
--        my_trial_links()                    is this studio closed, active or ended
--        trial_preview_bundle(kind, quote)   what the client / guest / crew / vendor would see, as data for the pop-up.
--                                            It makes the link in a sub-transaction, reads the real public functions and
--                                            rolls back, so no token, row or log entry ever exists outside it.
--        trial_member_test_approve(...)      the test approval (code 000000): TEST, consent marked test mode
--        trial_member_simulate_payment(...)  a TEST row with a TEST- receipt, never in income, ledger or P&L
--   6  The trial terms changed, so _trial_terms_version() = 'trial-2026-11-05': trial owners see the one-time Agree box again.
--   7  Team invitations, sign-up, sign-in, owner trial e-mails and security notices are not touched. Trial limits are
--      not touched. Studio naming is not touched. The R124 follow-up e-mails are not touched.
-- ZERO DATA LOSS: no table, column, row or policy is dropped or deleted (the only delete removes the audit row of the
-- transient token inside trial_member_test_approve, in the same transaction that created it). Functions are wrapped, old
-- bodies kept once as *__pre0334 with NO app privilege. Additive + idempotent: safe to run twice. ASCII only.
-- Goes after 0333.
-- ROLLBACK (manual, only if ever needed), per wrapped function F(args):
--   drop function public.F(args); alter function public.F__pre0334(args) rename to F; + re-grant as before
--   (the four storage functions were not renamed: re-issue F from the body of F__pre0334 instead)
--   drop trigger if exists a0_r125_no_link on public.quotes; (same on client_booklets, event_proposal, event_sites)
--   drop trigger if exists a0_r125_no_token on public.work_tokens; (same on delivery_links, vendor_request_links)
--   drop trigger if exists zz_r125_unlock on public.studio_subscriptions;

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.trial_followup_email_claim(integer)') is null then
    raise exception 'STOP 0334: 0333 (R124) is not applied - run APPLY-0333.sql first'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null or to_regprocedure('public._trial_locked(uuid)') is null
     or to_regprocedure('public._trial_test_mode_ok(uuid)') is null then
    raise exception 'STOP 0334: 0179 / 0183 / 0236 (trial checks) are not applied'; end if;
  if to_regprocedure('public.public_get_quote__pre0297(uuid)') is null or to_regprocedure('public.public_get_portal__pre0297(uuid)') is null then
    raise exception 'STOP 0334: 0297 (client link allow-lists) is not applied'; end if;
  if to_regprocedure('public.trial_test_approve_code(uuid,text,text,text,text,text,text)') is null
     or to_regprocedure('public.trial_simulate_payment(uuid,text,text)') is null
     or to_regprocedure('public.public_trial_sim_payments(text,text)') is null
     or to_regprocedure('public.public_trial_simulation_for_proposal(text)') is null then
    raise exception 'STOP 0334: 0322 / 0323 / 0324 / 0325 (trial test mode) are not applied'; end if;
  if to_regprocedure('public._work_token_live(uuid)') is null or to_regprocedure('public._a260_gate(text,text)') is null then
    raise exception 'STOP 0334: 0260 (cancel gate) is not applied'; end if;
  if to_regprocedure('public.delivery_link_issue(uuid)') is null or to_regprocedure('public.vendor_request_link(uuid)') is null then
    raise exception 'STOP 0334: 0241 / 0256 (delivery + vendor links) are not applied'; end if;
  if to_regprocedure('public.public_invite_rsvp(text,jsonb)') is null or to_regprocedure('public._r24_enquiry_org(text)') is null then
    raise exception 'STOP 0334: 0269 / 0284 (enquiry form, invitation RSVP) are not applied'; end if;
  if to_regprocedure('public.my_referral(text)') is null or to_regclass('public.referral_codes') is null then
    raise exception 'STOP 0334: 0279 / 0306 (referrals) are not applied'; end if;
end $$;

-- ---- 1) the question: is this a trial studio? -----------------------------------------------------------------------------
-- One look-up on the subscription row. The first test (status = 'trial') settles it; a paid studio reads one row and stops.
-- helm.r125_gate = off: only the dry run below and the test suites set it (it can only be set inside a function or by a
-- database role; an app caller has no way to set it).
create or replace function public._r125_closed(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r125-0334
  select p_org is not null
     and coalesce(current_setting('helm.r125_gate', true), '') <> 'off'
     and exists (select 1 from public.studio_subscriptions s
                  where s.org_id = p_org
                    and (s.status = 'trial'
                         or (s.status in ('past_due', 'cancelled', 'suspended')
                             and s.trial_ends_at is not null and s.current_period_end is null
                             and not exists (select 1 from public.subscription_payments sp
                                              where sp.org_id = p_org and sp.voided_at is null)))
                    and not exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master));
$$;

-- which studio does this link belong to? null for anything unknown or malformed
create or replace function public._r125_ref_org(p_kind text, p_ref text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
declare v_org uuid; v_id uuid; v_hash text;
begin
  if p_ref is null or length(p_ref) > 200 then return null; end if;
  if p_kind in ('quote', 'booklet', 'proposal', 'work') then
    if p_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    v_id := p_ref::uuid;
    if p_kind = 'quote' then select q.org_id into v_org from public.quotes q where q.approval_token = v_id limit 1;
    elsif p_kind = 'booklet' then select b.org_id into v_org from public.client_booklets b where b.token = v_id limit 1;
    elsif p_kind = 'proposal' then
      select q.org_id into v_org from public.event_proposal pr join public.quotes q on q.id = pr.quote_id where pr.share_token = v_id limit 1;
    else select w.org_id into v_org from public.work_tokens w where w.token = v_id limit 1;
    end if;
  elsif p_kind = 'site' then
    select s.org_id into v_org from public.event_sites s where s.slug = p_ref limit 1;
    if v_org is null then select h.org_id into v_org from public.event_site_slug_history h where h.slug = p_ref limit 1; end if;
  elsif p_kind in ('vendor', 'delivery') then
    if p_ref !~ '^[0-9a-f]{64}$' then return null; end if;
    v_hash := encode(pg_catalog.sha256(convert_to(p_ref, 'UTF8')), 'hex');
    if p_kind = 'vendor' then select l.org_id into v_org from public.vendor_request_links l where l.token_hash = v_hash limit 1;
    else select l.org_id into v_org from public.delivery_links l where l.token_hash = v_hash limit 1;
    end if;
  end if;
  return v_org;
end $$;

create or replace function public._r125_ref_closed(p_kind text, p_ref text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r125-0334: a link of a closed studio (any other link, known or not: false)
  select coalesce(public._r125_closed(public._r125_ref_org(p_kind, p_ref)), false);
$$;

-- the token the kept body gets: the real one, or (closed studio) one that cannot exist, so the answer is the random-token answer
create or replace function public._r125_uuid(p_kind text, p_ref uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  -- r125-0334
  select case when p_ref is not null and public._r125_ref_closed(p_kind, p_ref::text)
              then '00000000-0000-0000-0000-000000000000'::uuid else p_ref end;
$$;
create or replace function public._r125_text(p_kind text, p_ref text)
returns text language sql stable security definer set search_path = '' as $$
  -- r125-0334
  select case when p_ref is not null and public._r125_ref_closed(p_kind, p_ref) then 'r125-unavailable' else p_ref end;
$$;

-- the studio of a storage path "<org>/<quote>/..." (null when the first part is not a uuid)
create or replace function public._r125_path_org(p_name text)
returns uuid language sql immutable set search_path = '' as $$
  -- r125-0334
  select case when split_part(coalesce(p_name, ''), '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end;
$$;

create or replace function public._r125_refuse()
returns void language plpgsql set search_path = '' as $$
-- r125-0334
begin
  raise exception 'Links are not available in a free trial. Use the preview to see what your client would receive.'
    using errcode = '42501', hint = 'trial_no_links';
end $$;

-- ---- 2) public pages and actions: keep the body once, then ask first ---------------------------------------------------
do $$
declare
  f record; v_pub regprocedure; v_pre regprocedure; v_args text; v_res text; v_vol text; v_call text; v_names text[]; v_set boolean; v_body text;
begin
  for f in select * from (values
      -- function, argument types, link kind, 'u' uuid / 't' text token (always the first argument)
      ('public_get_quote', 'uuid', 'quote', 'u'), ('public_get_portal', 'uuid', 'quote', 'u'),
      ('public_portal_extras', 'uuid', 'quote', 'u'), ('public_quote_paid_status', 'uuid', 'quote', 'u'),
      ('public_quote_ready', 'uuid', 'quote', 'u'), ('public_trial_approval_mode', 'uuid', 'quote', 'u'),
      ('public_trial_payment_sim', 'uuid', 'quote', 'u'), ('trial_test_mode_for_token', 'uuid', 'quote', 'u'),
      ('trial_simulate_payment', 'uuid,text,text', 'quote', 'u'),
      ('trial_test_approve', 'uuid,text,text,text,text,text', 'quote', 'u'),
      ('trial_test_approve_code', 'uuid,text,text,text,text,text,text', 'quote', 'u'),
      ('create_payment', 'uuid', 'quote', 'u'), ('request_otp', 'uuid,text', 'quote', 'u'),
      ('verify_and_consent', 'uuid,text,text,boolean,text,text,text,text', 'quote', 'u'),
      ('wa_request_otp', 'uuid,text,text', 'quote', 'u'),
      ('wa_verify_and_consent', 'uuid,text,text,boolean,text,text,text,text', 'quote', 'u'),
      ('public_get_booklet', 'uuid', 'booklet', 'u'), ('public_get_booklet_image', 'uuid,text,text', 'booklet', 'u'),
      ('public_booklet_choose', 'uuid,uuid,integer,text,text', 'booklet', 'u'), ('public_booklet_otp_request', 'uuid', 'booklet', 'u'),
      ('public_booklet_packages', 'uuid', 'booklet', 'u'), ('public_booklet_pay_terms', 'uuid', 'booklet', 'u'),
      ('public_booklet_studio', 'text,text', 'booklet', 't'),
      ('public_get_proposal', 'uuid', 'proposal', 'u'), ('public_trial_simulation_for_proposal', 'text', 'proposal', 't'),
      ('public_event_site', 'text', 'site', 't'), ('public_invite_info', 'text', 'site', 't'),
      ('public_invite_reveal', 'text,text', 'site', 't'), ('public_invite_rsvp', 'text,jsonb', 'site', 't'),
      ('vendor_link_get', 'text', 'vendor', 't'), ('vendor_link_respond', 'text,text,text', 'vendor', 't'),
      ('vendor_invoice_submit', 'text,jsonb', 'vendor', 't'), ('vendor_invoice_upload', 'text,text', 'vendor', 't'),
      ('delivery_link_get', 'text', 'delivery', 't'),
      ('delivery_link_update', 'text,text,text,timestamptz', 'delivery', 't')) x(n, a, k, t)
  loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    if v_pub is null then raise exception 'STOP 0334: public.%(%) is missing', f.n, f.a; end if;
    v_pre := to_regprocedure('public.' || f.n || '__pre0334(' || f.a || ')');
    if v_pre is null then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0334');
      v_pre := to_regprocedure('public.' || f.n || '__pre0334(' || f.a || ')');
    end if;
    select pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.proargnames, p.proretset,
           case p.provolatile when 's' then 'stable' when 'i' then 'immutable' else 'volatile' end
      into v_args, v_res, v_names, v_set, v_vol from pg_proc p where p.oid = v_pre;
    v_call := case when f.t = 'u' then format('public._r125_uuid(%L, %I)', f.k, v_names[1])
                   else format('public._r125_text(%L, %I)', f.k, v_names[1]) end;
    if array_length(string_to_array(f.a, ','), 1) > 1 then
      for i in 2 .. array_length(string_to_array(f.a, ','), 1) loop v_call := v_call || ', ' || quote_ident(v_names[i]); end loop;
    end if;
    v_call := format('public.%I(%s)', f.n || '__pre0334', v_call);
    v_body := '-- r125-0334: a trial studio''s link gets the answer a random token gets; every other link runs the kept body' || chr(10)
           || 'begin' || chr(10)
           || case when v_set then '  return query select * from ' || v_call || ';' else '  return ' || v_call || ';' end || chr(10)
           || 'end';
    execute format('create or replace function public.%I(%s) returns %s language plpgsql %s security definer set search_path = '''' as %L',
                   f.n, v_args, v_res, v_vol, v_body);
    execute 'revoke all on function ' || v_pre::text || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    execute 'revoke all on function ' || v_pub::text || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function ' || v_pub::text || ' to anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || v_pub::text || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || v_pub::text || ' to service_role'; end if;
  end loop;
end $$;

-- ---- 3) the ones with their own shape: keep the body once ------------------------------------------------------------------
do $$
declare
  f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values
      ('public_quote_validity', 'text,uuid'), ('public_request_new_quote', 'text,uuid,text'),
      ('public_trial_simulation', 'text,text'), ('public_trial_sim_payments', 'text,text'),
      ('public_link_opened', 'text,uuid'), ('public_link_viewed', 'text,uuid,boolean'), ('public_link_studio', 'text,text,text'),
      ('_work_token_live', 'uuid'), ('_r24_enquiry_org', 'text'), ('_r29_code_problem', 'public.referral_codes'),
      ('my_referral', 'text'), ('_vr256_issue', 'public.vendor_requests,text'),
      ('generate_approval_token', 'uuid'), ('booklet_share', 'uuid,integer,uuid[],text,text'), ('publish_proposal', 'uuid,boolean'),
      ('publish_event_site', 'uuid,boolean'), ('event_site_new_link', 'uuid'),
      ('delivery_link_issue', 'uuid'), ('vendor_request_link', 'uuid')) x(n, a)
  loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0334(' || f.a || ')');
    if v_pub is null and v_pre is null then raise exception 'STOP 0334: public.%(%) is missing', f.n, f.a; end if;
    if v_pub is not null and v_pre is null then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0334');
    end if;
    v_pre := to_regprocedure('public.' || f.n || '__pre0334(' || f.a || ')');
    execute 'revoke all on function ' || v_pre::text || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
  end loop;
end $$;

-- four functions used BY storage policies: a policy points at the function itself, so these keep their name (and identity)
-- and the kept body is a copy. Renaming them would leave the policies calling the kept body, which has no app privilege.
do $$
declare f text; v_pub regprocedure; v_def text;
begin
  foreach f in array array['invite_media_guest_read_ok', 'invite_media_on_published_site', 'task_proof_upload_ok', 'vendor_invoice_upload_ok'] loop
    v_pub := to_regprocedure('public.' || f || '(text)');
    if v_pub is null then raise exception 'STOP 0334: public.%(text) is missing', f; end if;
    if to_regprocedure('public.' || f || '__pre0334(text)') is null then
      v_def := pg_get_functiondef(v_pub);
      v_def := replace(v_def, 'public.' || f || '(p_name', 'public.' || f || '__pre0334(p_name');
      execute v_def;
    end if;
    execute format('revoke all on function public.%I(text) from public', f || '__pre0334');
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(text) from anon', f || '__pre0334'); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(text) from authenticated', f || '__pre0334'); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function public.%I(text) from service_role', f || '__pre0334'); end if;
  end loop;
end $$;

create or replace function public.public_quote_validity(p_kind text, p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  if p_kind in ('quote', 'booklet') and public._r125_ref_closed(p_kind, p_token::text) then return null; end if;
  return public.public_quote_validity__pre0334(p_kind, p_token);
end $$;

create or replace function public.public_request_new_quote(p_kind text, p_token uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  return public.public_request_new_quote__pre0334(p_kind,
    case when p_kind in ('quote', 'booklet') then public._r125_uuid(p_kind, p_token) else p_token end, p_note);
end $$;

create or replace function public.public_trial_simulation(p_kind text, p_ref text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
begin
  if p_kind in ('quote', 'booklet', 'site') and public._r125_ref_closed(p_kind, btrim(coalesce(p_ref, ''))) then return null; end if;
  return public.public_trial_simulation__pre0334(p_kind, p_ref);
end $$;

create or replace function public.public_trial_sim_payments(p_kind text, p_ref text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
begin
  if p_kind in ('quote', 'booklet') and public._r125_ref_closed(p_kind, btrim(coalesce(p_ref, ''))) then return null; end if;
  return public.public_trial_sim_payments__pre0334(p_kind, p_ref);
end $$;

create or replace function public.public_link_opened(p_kind text, p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  if p_kind in ('quote', 'booklet') and public._r125_ref_closed(p_kind, p_token::text) then return; end if;
  perform public.public_link_opened__pre0334(p_kind, p_token);
end $$;

create or replace function public.public_link_viewed(p_page text, p_token uuid, p_preview boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_ref_closed(case when p_page = 'booklet' then 'booklet' else 'quote' end, p_token::text) then return; end if;
  perform public.public_link_viewed__pre0334(p_page, p_token, p_preview);
end $$;

create or replace function public.public_link_studio(p_kind text, p_ref text, p_studio text)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r125-0334: a trial studio's link never names the studio
begin
  if public._r125_ref_closed(case p_kind when 'portal' then 'quote' when 'invite' then 'site' else p_kind end, p_ref) then return null; end if;
  return public.public_link_studio__pre0334(p_kind, p_ref, p_studio);
end $$;

create or replace function public.invite_media_guest_read_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(public._r125_path_org(p_name)) then return false; end if;
  return public.invite_media_guest_read_ok__pre0334(p_name);
end $$;

create or replace function public.invite_media_on_published_site(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(public._r125_path_org(p_name)) then return false; end if;
  return public.invite_media_on_published_site__pre0334(p_name);
end $$;

create or replace function public.task_proof_upload_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(public._r125_path_org(p_name)) then return false; end if;
  return public.task_proof_upload_ok__pre0334(p_name);
end $$;

create or replace function public.vendor_invoice_upload_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(public._r125_path_org(p_name)) then return false; end if;
  return public.vendor_invoice_upload_ok__pre0334(p_name);
end $$;

-- every crew page and action comes through this one function
create or replace function public._work_token_live(p_token uuid)
returns public.work_tokens language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  return public._work_token_live__pre0334(public._r125_uuid('work', p_token));
end $$;

-- both enquiry functions ask this one; a closed studio's address answers like a studio that does not exist
create or replace function public._r24_enquiry_org(p_slug text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
declare v_org uuid := public._r24_enquiry_org__pre0334(p_slug);
begin
  if public._r125_closed(v_org) then return null; end if;
  return v_org;
end $$;

-- a trial studio's referral code answers like a code that does not exist
create or replace function public._r29_code_problem(c public.referral_codes)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
begin
  if c.studio_id is not null and public._r125_closed(c.studio_id) then return 'unknown'; end if;
  return public._r29_code_problem__pre0334(c);
end $$;

create or replace function public.my_referral(p_device text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334: no referral link in a trial
begin
  if public._r125_closed(public.current_org_id()) then return jsonb_build_object('program_on', false); end if;
  return public.my_referral__pre0334(p_device);
end $$;

-- ---- 4) a trial studio cannot create a link ----------------------------------------------------------------------------------
create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(public.current_org_id()) then perform public._r125_refuse(); end if;
  return public.generate_approval_token__pre0334(p_quote_id);
end $$;

create or replace function public.booklet_share(p_quote_id uuid, p_days integer default 30, p_version_ids uuid[] default null,
                                                p_terms text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334 (the six-argument form calls this one)
begin
  if public._r125_closed(public.current_org_id()) then perform public._r125_refuse(); end if;
  return public.booklet_share__pre0334(p_quote_id, p_days, p_version_ids, p_terms, p_note);
end $$;

create or replace function public.publish_proposal(p_quote_id uuid, p_published boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
-- r125-0334: taking a proposal down stays allowed
begin
  if p_published and public._r125_closed(public.current_org_id()) then perform public._r125_refuse(); end if;
  return public.publish_proposal__pre0334(p_quote_id, p_published);
end $$;

create or replace function public.publish_event_site(p_id uuid, p_publish boolean default true)
returns public.event_sites language plpgsql security definer set search_path = '' as $$
-- r125-0334: unpublishing stays allowed
begin
  if p_publish and public._r125_closed(public.current_org_id()) then perform public._r125_refuse(); end if;
  return public.publish_event_site__pre0334(p_id, p_publish);
end $$;

create or replace function public.event_site_new_link(p_site uuid)
returns public.event_sites language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(public.current_org_id()) then perform public._r125_refuse(); end if;
  return public.event_site_new_link__pre0334(p_site);
end $$;

create or replace function public.delivery_link_issue(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(public.current_org_id()) then perform public._r125_refuse(); end if;
  return public.delivery_link_issue__pre0334(p_id);
end $$;

create or replace function public.vendor_request_link(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(public.current_org_id()) then perform public._r125_refuse(); end if;
  return public.vendor_request_link__pre0334(p_id);
end $$;

-- saving a vendor request keeps working in a trial: only the link is left out (no row, token null)
create or replace function public._vr256_issue(p_r public.vendor_requests, p_via text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
begin
  if public._r125_closed(p_r.org_id) then return jsonb_build_object('token', null, 'expires_at', null, 'expires_text', null, 'trial', true); end if;
  return public._vr256_issue__pre0334(p_r, p_via);
end $$;

-- the same rule on the tables, for every path that does not go through the functions above
-- Sample events are the exception: the sample studio is cloned into every new trial, links included. Those rows stay as they
-- are (the sample data does not change) and their links are refused like every other trial link.
create or replace function public.tg_r125_no_link()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r125-0334
declare v_org uuid; v_quote uuid; v_demo boolean := false;
begin
  if tg_table_name = 'quotes' then
    if new.approval_token is null or (tg_op = 'UPDATE' and new.approval_token is not distinct from old.approval_token) then return new; end if;
    v_org := new.org_id; v_demo := coalesce(new.is_demo, false);
  elsif tg_table_name = 'client_booklets' then
    v_org := new.org_id; v_quote := new.quote_id;
  elsif tg_table_name = 'event_proposal' then
    if not (coalesce(new.published, false) and (tg_op = 'INSERT' or not coalesce(old.published, false)))
       and (new.share_token is null or (tg_op = 'UPDATE' and new.share_token is not distinct from old.share_token)) then return new; end if;
    v_quote := new.quote_id;
  elsif tg_table_name = 'event_sites' then
    if new.status is distinct from 'published' or (tg_op = 'UPDATE' and old.status is not distinct from 'published') then return new; end if;
    v_quote := new.quote_id;
  end if;
  if v_quote is not null then select q.org_id, coalesce(q.is_demo, false) into v_org, v_demo from public.quotes q where q.id = v_quote; end if;
  if not v_demo and public._r125_closed(v_org) then perform public._r125_refuse(); end if;
  return new;
end $$;

-- crew / delivery / vendor link rows are written as a side step of a normal action: the action goes on, the row is left out
create or replace function public.tg_r125_no_token()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r125-0334: sample events keep theirs, see tg_r125_no_link
declare v_org uuid := new.org_id; v_demo boolean := false;
begin
  if tg_table_name = 'work_tokens' then
    select q.org_id, coalesce(q.is_demo, false) into v_org, v_demo from public.quotes q where q.id = new.quote_id;
  end if;
  if not v_demo and public._r125_closed(v_org) then return null; end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['quotes', 'client_booklets', 'event_proposal', 'event_sites'] loop
    execute format('drop trigger if exists a0_r125_no_link on public.%I', t);
    execute format('create trigger a0_r125_no_link before insert or update on public.%I for each row execute function public.tg_r125_no_link()', t);
  end loop;
  foreach t in array array['work_tokens', 'delivery_links', 'vendor_request_links'] loop
    execute format('drop trigger if exists a0_r125_no_token on public.%I', t);
    execute format('create trigger a0_r125_no_token before insert on public.%I for each row execute function public.tg_r125_no_token()', t);
  end loop;
end $$;

-- on upgrade: the crew links that were left out during the trial are made, so everything unlocks normally
create or replace function public.tg_r125_unlock()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r125-0334: only the move from a never-paid trial to an active plan; never blocks the activation
begin
  if new.status = 'active' and old.status is distinct from 'active'
     and (old.status = 'trial' or (old.trial_ends_at is not null and old.current_period_end is null)) then
    begin
      insert into public.work_tokens (quote_id, phone, name, org_id)
        select distinct on (t.quote_id, t.assignee_phone) t.quote_id, t.assignee_phone, t.assignee_name, new.org_id
          from public.event_tasks t join public.quotes q on q.id = t.quote_id
         where t.org_id = new.org_id and q.deleted_at is null and coalesce(t.assignee_phone, '') <> ''
           and t.status not in ('rejected', 'cancelled')
        on conflict (quote_id, phone) do nothing;
    exception when others then null;
    end;
  end if;
  return null;
end $$;
drop trigger if exists zz_r125_unlock on public.studio_subscriptions;
create trigger zz_r125_unlock after update of status on public.studio_subscriptions
  for each row execute function public.tg_r125_unlock();

-- ---- 5) the members-only path --------------------------------------------------------------------------------------------
-- the signed-in staff member's studio, for a quote of that studio. Raises for anybody else.
create or replace function public._r125_member_org(p_quote uuid, p_level text, p_kind text default null)
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r125-0334: the same area the real page belongs to (a crew-only role never reads a client's quote through a preview)
declare v_org uuid := public.current_org_id(); v_ok boolean;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_quote is not null and not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org and q.deleted_at is null) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_ok := public.has_area('quotes', p_level)
       or (p_kind = 'proposal' and public.has_area('proposal', p_level))
       or (p_kind = 'crew' and public.has_area('staff', p_level))
       or (p_kind = 'vendor' and public.has_area('vendors', p_level))
       or p_kind = 'enquiry';
  if not v_ok then raise exception 'not authorized' using errcode = '42501'; end if;
  return v_org;
end $$;

-- what the studio pages ask on load
create or replace function public.my_trial_links()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r125-0334
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._r125_closed(v_org) then return jsonb_build_object('closed', false); end if;
  return jsonb_build_object('closed', true, 'active', coalesce(public._trial_test_mode_ok(v_org), false),
                            'ended', not coalesce(public._trial_test_mode_ok(v_org), false));
end $$;

-- one read, or null when it failed; the error stays inside
create or replace function public._r125_read(p_sql text, p_ref text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
declare r jsonb;
begin
  execute p_sql into r using p_ref;
  return coalesce(r, 'null'::jsonb);
exception when others then
  return jsonb_build_object('__error', left(sqlerrm, 200), '__state', sqlstate);
end $$;

-- The data for one pop-up: the real public functions, run in a sub-transaction on a link that exists only there.
-- The last statement of the block always raises, so everything written inside is rolled back: link, view counters, rate
-- rows, audit rows. Only the jsonb answer (a plpgsql variable) survives. Nothing here can commit.
create or replace function public.trial_preview_bundle(p_kind text, p_quote uuid default null, p_opts jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
declare
  v_org uuid; v_uid uuid := auth.uid(); v jsonb := '{}'::jsonb; v_err text; v_t uuid; v_tt text; v_slug text; v_o jsonb := coalesce(p_opts, '{}'::jsonb);
  v_claims text := current_setting('request.jwt.claims', true); v_phone text; v_name text; r public.vendor_requests; v_days integer;
  v_active boolean; v_sec jsonb; v_vers uuid[]; v_site uuid;
begin
  if p_kind is null or p_kind not in ('approval', 'booklet', 'proposal', 'invitation', 'crew', 'vendor', 'enquiry') then
    raise exception 'unknown preview' using errcode = '22023'; end if;
  v_org := public._r125_member_org(p_quote, 'view', p_kind);
  if p_kind <> 'enquiry' and p_quote is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._r125_closed(v_org) then raise exception 'previews are for free-trial studios' using errcode = '42501', hint = 'trial_only'; end if;
  if public.rate_hit('r125_preview', v_uid::text, 3600, 600) > 0 then
    raise exception 'Too many previews - try again in a few minutes.' using errcode = '54000'; end if;
  v_active := coalesce(public._trial_test_mode_ok(v_org), false);
  if p_kind = 'enquiry' then
    return jsonb_build_object('public_enquiry_info', jsonb_build_object('ok', true, 'studio', (select o.name from public.organizations o where o.id = v_org)));
  end if;

  begin
    perform set_config('helm.r125_gate', 'off', true);
    perform set_config('request.jwt.claims', (coalesce(nullif(v_claims, ''), '{}')::jsonb || '{"role":"service_role"}'::jsonb)::text, true);

    if p_kind = 'approval' then
      select q.approval_token into v_t from public.quotes q where q.id = p_quote and q.approval_token is not null
         and q.approval_token_revoked_at is null and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
      if v_t is null then
        v_t := gen_random_uuid();
        update public.quotes q set approval_token = v_t, approval_token_revoked_at = null,
               approval_token_expires_at = now() + interval '30 days' where q.id = p_quote;
      end if;
      v := jsonb_build_object(
        'public_get_quote', public._r125_read('select public.public_get_quote($1::uuid)', v_t::text),
        'public_quote_ready', public._r125_read('select public.public_quote_ready($1::uuid)', v_t::text),
        'public_quote_validity', public._r125_read('select public.public_quote_validity(''quote'', $1::uuid)', v_t::text),
        'public_quote_paid_status', public._r125_read('select public.public_quote_paid_status($1::uuid)', v_t::text),
        'public_trial_payment_sim', public._r125_read('select public.public_trial_payment_sim($1::uuid)', v_t::text),
        'public_trial_sim_payments', public._r125_read('select public.public_trial_sim_payments(''quote'', $1)', v_t::text),
        'public_get_portal', public._r125_read('select public.public_get_portal($1::uuid)', v_t::text),
        'public_portal_extras', public._r125_read('select public.public_portal_extras($1::uuid)', v_t::text),
        'public_payment_schedule', public._r125_read('select public.public_payment_schedule($1::uuid)', v_t::text));
    elsif p_kind = 'booklet' then
      v_days := greatest(7, least(180, coalesce(nullif(v_o ->> 'days', '')::integer, 30)));
      if jsonb_typeof(v_o -> 'version_ids') = 'array' then
        select array_agg(x::uuid) into v_vers from jsonb_array_elements_text(v_o -> 'version_ids') x;
      end if;
      v_sec := case when jsonb_typeof(v_o -> 'sections') = 'object' then v_o -> 'sections' end;
      v_tt := public.booklet_share(p_quote, v_days, v_vers, null, nullif(v_o ->> 'note', ''), v_sec) ->> 'token';
      v := jsonb_build_object(
        'public_get_booklet', public._r125_read('select public.public_get_booklet($1::uuid)', v_tt),
        'public_booklet_packages', public._r125_read('select public.public_booklet_packages($1::uuid)', v_tt),
        'public_booklet_pay_terms', public._r125_read('select public.public_booklet_pay_terms($1::uuid)', v_tt),
        'public_quote_validity', public._r125_read('select public.public_quote_validity(''booklet'', $1::uuid)', v_tt),
        'public_trial_sim_payments', public._r125_read('select public.public_trial_sim_payments(''booklet'', $1)', v_tt),
        'versions', public._r125_read('select coalesce(jsonb_agg(jsonb_build_object(''id'', v.id, ''label'', v.label, ''total'', v.total, ''created_at'', v.created_at) order by v.created_at desc), ''[]''::jsonb) from public.quotation_versions v where v.quote_id = $1::uuid', p_quote::text));
    elsif p_kind = 'proposal' then
      if not exists (select 1 from public.event_proposal pr where pr.quote_id = p_quote) then
        insert into public.event_proposal (quote_id) values (p_quote);
      end if;
      v_t := gen_random_uuid();
      update public.event_proposal pr set published = true, share_token = coalesce(pr.share_token, v_t)
       where pr.quote_id = p_quote returning pr.share_token into v_t;
      v := jsonb_build_object('public_get_proposal', public._r125_read('select public.public_get_proposal($1::uuid)', v_t::text));
    elsif p_kind = 'invitation' then
      select s.id, s.slug into v_site, v_slug from public.event_sites s where s.quote_id = p_quote limit 1;
      if v_site is null then
        v_slug := 'draft-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
        insert into public.event_sites (quote_id, org_id, event_type, template, slug, created_by)
          values (p_quote, v_org, 'general', 'soiree', v_slug, v_uid) returning id into v_site;
      end if;
      update public.event_sites s set status = 'published', published_at = coalesce(s.published_at, now()),
             template = coalesce(nullif(v_o ->> 'template', ''), s.template) where s.id = v_site;
      v := jsonb_build_object(
        'public_event_site', public._r125_read('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.public_event_site($1) x', v_slug),
        'public_invite_info', public._r125_read('select public.public_invite_info($1)', v_slug));
    elsif p_kind = 'crew' then
      if nullif(v_o ->> 'phone', '') is not null then
        select t.assignee_phone, t.assignee_name into v_phone, v_name from public.event_tasks t
         where t.quote_id = p_quote and t.org_id = v_org and t.assignee_phone = v_o ->> 'phone' limit 1;
      end if;
      if v_phone is null then
        select t.assignee_phone, t.assignee_name into v_phone, v_name from public.event_tasks t
         where t.quote_id = p_quote and t.org_id = v_org and coalesce(t.assignee_phone, '') <> '' and t.status not in ('rejected', 'cancelled')
         order by t.created_at limit 1;
      end if;
      if v_phone is not null then
        select w.token into v_t from public.work_tokens w where w.quote_id = p_quote and w.phone = v_phone limit 1;
        if v_t is null then
          v_t := gen_random_uuid();
          insert into public.work_tokens (token, quote_id, phone, name, org_id) values (v_t, p_quote, v_phone, v_name, v_org);
        end if;
        v := jsonb_build_object(
          'worker_get_tasks', public._r125_read('select public.worker_get_tasks($1::uuid)', v_t::text),
          'worker_get_equipment', public._r125_read('select public.worker_get_equipment($1::uuid)', v_t::text),
          'worker_assignment_updates', public._r125_read('select public.worker_assignment_updates($1::uuid)', v_t::text),
          'crew_link_home', public._r125_read('select public.crew_link_home($1::uuid)', v_t::text),
          'crew_name', to_jsonb(v_name));
      end if;
    elsif p_kind = 'vendor' then
      select x.* into r from public.vendor_requests x
       where x.quote_id = p_quote and x.org_id = v_org
         and (nullif(v_o ->> 'request_id', '') is null or x.id::text = v_o ->> 'request_id')
       order by x.created_at desc limit 1;
      if r.id is not null then
        v_tt := public._vr256_issue(r, 'copy') ->> 'token';
        v := jsonb_build_object('vendor_link_get', public._r125_read('select public.vendor_link_get($1)', v_tt));
      end if;
    end if;
    raise exception 'r125 dry run' using errcode = 'R1250';
  exception
    when sqlstate 'R1250' then null;
    when others then v_err := left(sqlerrm, 200);
  end;
  if v_err is not null then return jsonb_build_object('__error', v_err); end if;
  return v || jsonb_build_object('hint', (select jsonb_build_object('client_name', q.client ->> 'name', 'client_email', q.client ->> 'email',
                                    'client_phone', q.client ->> 'phone', 'title', q.title, 'code', q.code, 'event_date', q.event_date, 'event_type', q.event_type,
                                    'venue', q.client ->> 'venue', 'total', q.pricing ->> 'total', 'currency', q.currency,
                                    'expires_after', public.client_link_window_days(case when p_kind = 'approval' then 'quote' else 'invite' end))
                                  from public.quotes q where q.id = p_quote),
                                 'studio', (select o.name from public.organizations o where o.id = v_org), 'active', v_active);
end $$;

-- The test approval for signed-in staff: same checks and same records as the old public path, marked test mode. It needs a
-- link inside the transaction (the approval functions take a token); when the quote has none, one is made and taken away
-- again before the transaction ends, so no link ever exists for anyone else.
create or replace function public.trial_member_test_approve(p_quote uuid, p_code text, p_client_name text, p_phone text default null,
    p_terms_version text default null, p_consent_text text default null, p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
declare v_org uuid; v_old uuid; v_exp timestamptz; v_rev timestamptz; v_tok uuid; v_live boolean; v_out jsonb; v_phone text; v_name text;
begin
  v_org := public._r125_member_org(p_quote, 'edit');
  if not public._r125_closed(v_org) then
    return jsonb_build_object('approved', false, 'error', 'trial_only', 'message', 'Test mode is only for studios on a Helm free trial.');
  end if;
  if not coalesce(public._trial_test_mode_ok(v_org), false) then
    return jsonb_build_object('approved', false, 'error', 'trial_ended', 'message', 'Your free trial has ended, so the test approval is closed.');
  end if;
  select q.approval_token, q.approval_token_expires_at, q.approval_token_revoked_at, q.client ->> 'phone', q.client ->> 'name'
    into v_old, v_exp, v_rev, v_phone, v_name from public.quotes q where q.id = p_quote for update;
  v_live := v_old is not null and v_rev is null and (v_exp is null or v_exp > now());
  v_phone := coalesce(nullif(btrim(coalesce(p_phone, '')), ''), nullif(btrim(coalesce(v_phone, '')), ''), '+910000000000');
  perform set_config('helm.r125_gate', 'off', true);
  if v_live then
    v_tok := v_old;
  else
    v_tok := gen_random_uuid();
    update public.quotes q set approval_token = v_tok, approval_token_revoked_at = null,
           approval_token_expires_at = now() + interval '30 days' where q.id = p_quote;
  end if;
  v_out := public.trial_test_approve_code(v_tok, p_code, v_phone, coalesce(nullif(btrim(coalesce(p_client_name, '')), ''), v_name, 'Test client'),
             p_terms_version, p_consent_text, p_user_agent);
  if not v_live then
    update public.quotes q set approval_token = v_old, approval_token_expires_at = v_exp, approval_token_revoked_at = v_rev where q.id = p_quote;
    delete from public.client_link_issued c where c.kind = 'quote' and c.token = v_tok;
  end if;
  perform set_config('helm.r125_gate', '', true);
  return coalesce(v_out, '{}'::jsonb) || jsonb_build_object('test_mode', true);
end $$;

-- Simulate payment for signed-in staff: the 0323 body with the quote instead of a token. A TEST row only: never a
-- quote_payments row, so it never reaches income, the ledger or P&L.
create or replace function public.trial_member_simulate_payment(p_quote uuid, p_client_name text default null, p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r125-0334
declare v_org uuid; v_status text; v_cur text; v_next jsonb; v_id uuid; v_receipt text;
begin
  v_org := public._r125_member_org(p_quote, 'edit');
  perform pg_advisory_xact_lock(hashtextextended('helm:r323:simpay:' || p_quote::text, 0));
  select coalesce(q.approval_status, ''), upper(coalesce(nullif(btrim(q.pricing ->> 'currency'), ''), nullif(btrim(q.currency), ''), 'INR'))
    into v_status, v_cur from public.quotes q where q.id = p_quote;
  if not public._r125_closed(v_org) then
    return jsonb_build_object('simulated', false, 'error', 'trial_only', 'message', 'Simulated payments are only for studios on a Helm free trial.');
  end if;
  if not coalesce(public._trial_test_mode_ok(v_org), false) then
    return jsonb_build_object('simulated', false, 'error', 'trial_ended', 'message', 'Your free trial has ended, so the payment simulation is closed.');
  end if;
  if v_status not in ('approved', 'paid') then
    return jsonb_build_object('simulated', false, 'error', 'not_approved', 'message', 'Approve the quote first (test mode) - then the simulated payment step opens.');
  end if;
  v_next := public._r323_next_due(p_quote);
  if v_next is null then
    return jsonb_build_object('simulated', true, 'already', true, 'test_mode', true,
      'message', 'Every payment on this quote has already been simulated. Nothing real was charged.');
  end if;
  insert into public.trial_sim_payments(org_id, quote_id, milestone_id, amount, currency, label, client_name)
    values (v_org, p_quote, nullif(v_next ->> 'milestone_id', '')::uuid, coalesce((v_next ->> 'amount')::numeric, 0), left(v_cur, 3),
            v_next ->> 'label', nullif(left(btrim(coalesce(p_client_name, '')), 120), ''))
    on conflict do nothing
    returning id into v_id;
  if v_id is null then
    return jsonb_build_object('simulated', true, 'already', true, 'test_mode', true,
      'message', 'This payment was already simulated a moment ago. Nothing real was charged.');
  end if;
  v_receipt := 'TEST-' || upper(left(replace(v_id::text, '-', ''), 8));
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'payment.simulated', 'quotes', p_quote::text,
            jsonb_build_object('test_mode', true, 'real_payment', false, 'amount', coalesce((v_next ->> 'amount')::numeric, 0),
                               'currency', left(v_cur, 3), 'milestone_id', v_next ->> 'milestone_id', 'receipt', v_receipt,
                               'client_name', left(coalesce(p_client_name, ''), 120), 'user_agent', left(coalesce(p_user_agent, ''), 200), 'path', 'member'),
            v_org, now());
  return jsonb_build_object('simulated', true, 'test_mode', true, 'real_payment', false,
    'amount', coalesce((v_next ->> 'amount')::numeric, 0), 'currency', left(v_cur, 3), 'label', v_next ->> 'label',
    'receipt', v_receipt, 'more_due', public._r323_next_due(p_quote) is not null);
end $$;

-- the trial terms wording changed ("no link and no message leaves Helm"): a new version, trial owners agree once more
create or replace function public._trial_terms_version()
returns text language sql immutable set search_path = '' as $$
  -- trial-terms-0207 trial-quotes-0211 trial-email-0212 trial-quotes-cap-0238 r117-trial-terms-0325 r125-0334: = HelmTrialFacts.VERSION (public/trial-facts.js)
  select 'trial-2026-11-05'::text;
$$;

-- ---- 6) privileges ---------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  -- wrappers that keep their old audience
  foreach f in array array['public.public_quote_validity(text, uuid)', 'public.public_request_new_quote(text, uuid, text)',
      'public.public_trial_simulation(text, text)', 'public.public_trial_sim_payments(text, text)',
      'public.public_link_opened(text, uuid)', 'public.public_link_viewed(text, uuid, boolean)', 'public.public_link_studio(text, text, text)',
      'public.invite_media_guest_read_ok(text)', 'public.invite_media_on_published_site(text)',
      'public.task_proof_upload_ok(text)', 'public.vendor_invoice_upload_ok(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  foreach f in array array['public.my_referral(text)', 'public.generate_approval_token(uuid)',
      'public.booklet_share(uuid, integer, uuid[], text, text)', 'public.publish_proposal(uuid, boolean)',
      'public.publish_event_site(uuid, boolean)', 'public.event_site_new_link(uuid)', 'public.delivery_link_issue(uuid)',
      'public.vendor_request_link(uuid)', 'public.my_trial_links()', 'public.trial_preview_bundle(text, uuid, jsonb)',
      'public.trial_member_test_approve(uuid, text, text, text, text, text, text)',
      'public.trial_member_simulate_payment(uuid, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', f); end if;
  end loop;
  -- helpers: no app privilege at all
  foreach f in array array['public._r125_closed(uuid)', 'public._r125_ref_org(text, text)', 'public._r125_ref_closed(text, text)',
      'public._r125_uuid(text, uuid)', 'public._r125_text(text, text)', 'public._r125_path_org(text)', 'public._r125_refuse()',
      'public._r125_member_org(uuid, text, text)', 'public._r125_read(text, text)', 'public._work_token_live(uuid)',
      'public._r24_enquiry_org(text)', 'public._r29_code_problem(public.referral_codes)',
      'public._vr256_issue(public.vendor_requests, text)', 'public.tg_r125_no_link()', 'public.tg_r125_no_token()', 'public.tg_r125_unlock()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
