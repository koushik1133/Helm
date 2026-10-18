-- APPLY-0204.sql - paste into the Supabase SQL editor (staging first, then production).
-- Fixes the invite dead end: a brand-new invitee whose "Accept invitation" e-mail link was used,
-- expired or opened while another account was signed in was told "This e-mail already has a Helm
-- account - sign in instead", although Supabase had created that login WITHOUT a password.
-- It also lets an EXISTING account's invitation e-mail name the same studio / role / inviter, and lets
-- an invitee whose invitation EXPIRED ask the studio for a new one (one bell note per 24 h).
-- What it adds: 4 small functions - invite_account_state, invite_auth_user_id, invite_request_new_link
-- (service role only: the edge functions invite-signup / invite-mailer) and my_needs_password (the
-- signed-in person's own login). The only row ever written later is that bell note (insert only).
-- No table, column, policy or existing function is changed. No DROP / DELETE / UPDATE / TRUNCATE.
-- Safe to run twice. After it: redeploy the edge functions invite-signup and invite-mailer.
begin;
-- 0204_invite_account_state.sql - CANONICAL forward-only.
-- REQUIRES phase83 (public.invitations) + 0131 (invite e-mails through Supabase Auth).
--
-- In plain words (prod bug 2026-10-18, "Join ABCD" invite says "already has a Helm account"):
--   When a studio invites a NEW e-mail and the invitation goes out through Supabase Auth's own mailer
--   (invite-mailer without a Resend key), Supabase creates the login (auth.users row) right away,
--   with NO password. The only way in is the one-time "Accept invitation" link (works once, 24 h).
--   When that link's sign-in is lost (already used, expired, or opened while another account was
--   signed in), the join form tried to create the account again and was told "already registered"
--   -> "sign in instead", although the invitee never had a password.
--   This file adds small helpers so the app can tell those cases apart (the first three are read-only):
--     * invite_account_state(token)  - SERVICE ROLE ONLY (edge function invite-signup). For a
--       pending, unexpired invitation: does its OWN invited e-mail have no login yet ('none'), a
--       login made by the invitation that still has no password and no Google / other sign-in
--       ('needs_password'), a self sign-up that was never confirmed ('unconfirmed' - signing in
--       cannot work yet), or a real account ('existing')? Plus whether that e-mail is confirmed.
--       Nothing about any other address is ever looked at or returned.
--     * my_needs_password()          - the signed-in person only: does MY OWN login still have no
--       password (and no Google / other sign-in)? The login page uses it after an e-mail link to
--       show "Set your password".
--     * invite_auth_user_id(token)    - SERVICE ROLE ONLY (invite-mailer): the login id of that
--       invitation's own e-mail, so the e-mail an existing account gets names the same studio / role.
--     * invite_request_new_link(token) - SERVICE ROLE ONLY (invite-signup): "Email me a new link" on an
--       EXPIRED invitation adds ONE bell note per invitation per 24 h for that studio ("<e-mail> asked
--       for a new invitation link"); the invitation itself is never renewed or changed.
--   The only row ever written: that bell note (public.notifications, insert only).
--   No table, column, policy or existing function is changed. No DROP / DELETE / UPDATE.
--   Safe to run twice.

create or replace function public.invite_account_state(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- invite-accept-0204: the invited e-mail's login state, for ONE valid invitation token (service role only)
declare v_inv record; v_u auth.users%rowtype; v_pw text; v_other boolean := false; v_state text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{16,128}$' then
    return jsonb_build_object('valid', false);
  end if;
  select i.id, lower(btrim(coalesce(i.email, ''))) as email, i.status, i.expires_at
    into v_inv from public.invitations i where i.token = p_token;
  if v_inv.id is null or v_inv.status is distinct from 'pending' or v_inv.expires_at is null
     or v_inv.expires_at <= now() or v_inv.email = '' then
    return jsonb_build_object('valid', false);
  end if;
  select u.* into v_u from auth.users u where lower(u.email) = v_inv.email order by u.created_at limit 1;
  if v_u.id is null then
    return jsonb_build_object('valid', true, 'account', 'none', 'confirmed', false);
  end if;
  v_pw := coalesce(v_u.encrypted_password, '');
  v_other := exists (select 1 from auth.identities d where d.user_id = v_u.id and coalesce(d.provider, '') <> 'email');
  if v_other or (to_jsonb(v_u) ->> 'deleted_at') is not null then
    v_state := 'existing';
  elsif v_pw <> '' and v_u.email_confirmed_at is null then
    -- signed up on their own first and never confirmed: signing in cannot work yet ("not confirmed"),
    -- so the invitee needs a link to that mailbox too (the invite link confirms + signs in)
    v_state := 'unconfirmed';
  elsif v_pw <> '' then
    v_state := 'existing';
  else
    v_state := 'needs_password';
  end if;
  return jsonb_build_object('valid', true, 'account', v_state, 'confirmed', v_u.email_confirmed_at is not null);
end $$;

create or replace function public.my_needs_password()
returns boolean language sql stable security definer set search_path = '' as $$
  -- invite-accept-0204: the caller's OWN login has no password and no Google / other sign-in
  select coalesce((
    select coalesce(u.encrypted_password, '') = ''
       and not exists (select 1 from auth.identities d where d.user_id = u.id and coalesce(d.provider, '') <> 'email')
      from auth.users u where u.id = auth.uid()), false);
$$;

-- the login id of ONE pending, unexpired invitation's own e-mail (null when it has none) - service
-- role only: invite-mailer refreshes that login's invitation details (studio / role / inviter) so the
-- Supabase sign-in e-mail an EXISTING account gets reads like the same "Join <studio>" invitation.
create or replace function public.invite_auth_user_id(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  -- invite-accept-0204
  select u.id from public.invitations i
    join auth.users u on lower(u.email) = lower(btrim(i.email))
   where p_token ~ '^[0-9a-f]{16,128}$' and i.token = p_token and i.status = 'pending' and i.expires_at > now()
   order by u.created_at limit 1;
$$;

-- "Email me a new link" on an EXPIRED invitation: the invitee cannot renew it (only the studio can,
-- and a renewed invitation must count against the seat limit again), so the studio's bell gets ONE
-- note per invitation per 24 hours: "<e-mail> asked for a new invitation link". Service role only.
-- Returns { result: requested | already_requested | not_expired | not_found, studio }.
create or replace function public.invite_request_new_link(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- invite-accept-0204: never renews, never changes the invitation; one bell row at most per 24 h
declare v_inv record; v_studio text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{16,128}$' then return jsonb_build_object('result', 'not_found'); end if;
  select i.id, i.org_id, lower(btrim(i.email)) as email, i.status, i.expires_at into v_inv
    from public.invitations i where i.token = p_token;
  if v_inv.id is null then return jsonb_build_object('result', 'not_found'); end if;
  select o.name into v_studio from public.organizations o where o.id = v_inv.org_id;
  if not (v_inv.status = 'expired' or (v_inv.status = 'pending' and v_inv.expires_at <= now())) then
    return jsonb_build_object('result', 'not_expired', 'studio', v_studio);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:invrelink:' || v_inv.id::text, 0));
  if exists (select 1 from public.notifications n where n.org_id = v_inv.org_id and n.kind = 'invite_link_request'
               and n.detail ->> 'invitation' = v_inv.id::text and n.created_at > now() - interval '24 hours') then
    return jsonb_build_object('result', 'already_requested', 'studio', v_studio);
  end if;
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    values (null, 'in_app', 'invite_link_request', 'simulated',
            jsonb_build_object('label', left(v_inv.email, 254) || ' asked for a new invitation link (the old one expired). Re-send it from Staff.',
                               'invitation', v_inv.id::text, 'source', '0204'),
            v_inv.org_id);
  return jsonb_build_object('result', 'requested', 'studio', v_studio);
end $$;

revoke all on function public.invite_account_state(text) from public;
revoke all on function public.invite_auth_user_id(text) from public;
revoke all on function public.invite_request_new_link(text) from public;
revoke all on function public.my_needs_password() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.invite_account_state(text) from anon';
    execute 'revoke all on function public.invite_auth_user_id(text) from anon';
    execute 'revoke all on function public.invite_request_new_link(text) from anon';
    execute 'revoke all on function public.my_needs_password() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.invite_account_state(text) from authenticated';
    execute 'revoke all on function public.invite_auth_user_id(text) from authenticated';
    execute 'revoke all on function public.invite_request_new_link(text) from authenticated';
    execute 'grant execute on function public.my_needs_password() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.invite_account_state(text) to service_role';
    execute 'grant execute on function public.invite_auth_user_id(text) to service_role';
    execute 'grant execute on function public.invite_request_new_link(text) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 invite_account_state exists, SECURITY DEFINER, empty search_path',
     coalesce((select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid = to_regprocedure('public.invite_account_state(text)')), false)),
  ('02 invite_account_state: service role only (not the app, not anon)',
     has_function_privilege('service_role', 'public.invite_account_state(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.invite_account_state(text)', 'execute')
     and not has_function_privilege('anon', 'public.invite_account_state(text)', 'execute')),
  ('03 my_needs_password exists, SECURITY DEFINER, signed-in only',
     coalesce((select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid = to_regprocedure('public.my_needs_password()')), false)
     and has_function_privilege('authenticated', 'public.my_needs_password()', 'execute')
     and not has_function_privilege('anon', 'public.my_needs_password()', 'execute')),
  ('04 a malformed / unknown token tells nothing', public.invite_account_state('x') = '{"valid": false}'::jsonb
     and public.invite_account_state(repeat('0', 48)) = '{"valid": false}'::jsonb),
  ('05 nobody signed in here -> my_needs_password is false', public.my_needs_password() = false),
  ('06 invite_auth_user_id + invite_request_new_link: service role only',
     has_function_privilege('service_role', 'public.invite_auth_user_id(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.invite_auth_user_id(text)', 'execute')
     and not has_function_privilege('anon', 'public.invite_auth_user_id(text)', 'execute')
     and has_function_privilege('service_role', 'public.invite_request_new_link(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.invite_request_new_link(text)', 'execute')
     and not has_function_privilege('anon', 'public.invite_request_new_link(text)', 'execute')),
  ('07 an unknown token is never renewable', public.invite_request_new_link(repeat('0', 48)) ->> 'result' = 'not_found')
) v(item, ok) order by item;
