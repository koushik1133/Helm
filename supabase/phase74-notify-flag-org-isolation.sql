-- ============================================================================
-- Phase 74 — Isolation: mgr_notify + the _flag/_notify config read
-- ---------------------------------------------------------------------------
-- Two remaining SECURITY DEFINER gaps the master sweep found:
--  • mgr_notify(p_quote_id,...) injected a notification into ANY org's feed
--    (role gate only) — add assert_quote_org.
--  • _flag(p) read app_config channels with NO org filter; app_config PK is
--    (org_id,key), so under a definer it returned an arbitrary org's sms/pay
--    'live' flag. It's called from anon token flows where current_org_id() is
--    NULL, so the correct scope is the QUOTE's org — thread it through _notify.
-- Idempotent. Run AFTER phase57 (app_config PK) + phase72 (assert_quote_org).
-- ============================================================================

-- 1) org-aware channel-flag reader -------------------------------------------
create or replace function public._flag(p text, p_org uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select (value->>p)::boolean from public.app_config
                   where key='channels' and org_id = p_org), false);
$$;
grant execute on function public._flag(text, uuid) to authenticated, anon;

-- keep the 1-arg form working for authenticated callers, now org-scoped -------
create or replace function public._flag(p text) returns boolean
  language sql stable security definer set search_path = public as $$
  select public._flag(p, public.current_org_id());
$$;
grant execute on function public._flag(text) to authenticated, anon;

-- 2) _notify: mark sent/simulated using the QUOTE's org (works in anon flows) -
create or replace function public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare live boolean; v_org uuid;
begin
  v_org := (select org_id from public.quotes where id = p_quote);   -- quote's org, not the caller's
  live := case p_channel when 'sms' then public._flag('sms_live', v_org)
                         when 'email' then public._flag('email_live', v_org) else false end;
  insert into public.notifications(quote_id,channel,recipient,kind,status,detail)
    values (p_quote,p_channel,p_to,p_kind, case when live then 'sent' else 'simulated' end, coalesce(p_detail,'{}'::jsonb));
end; $$;

-- 3) mgr_notify: verify the quote is in the caller's org ----------------------
create or replace function public.mgr_notify(p_quote_id uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);                       -- << org isolation
  perform public._notify(p_quote_id, p_channel, p_to, p_kind, p_detail);
  return jsonb_build_object('logged', true);
end; $$;
grant execute on function public.mgr_notify(uuid,text,text,text,jsonb) to authenticated;

notify pgrst, 'reload schema';

select 'phase74' t, 'mgr_notify + _flag/_notify org-scoped' note;
