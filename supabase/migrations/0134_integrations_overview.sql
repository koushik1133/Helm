-- 0134_integrations_overview.sql - CANONICAL forward-only. Read-only status for the in-app
-- Integrations page (/<studio>/integrations). REQUIRES current_org_id(), has_area(), is_admin().
-- Uses 0078 (comms_settings), 0117 (org_whatsapp_accounts / org_payment_accounts) and
-- 0131 (invite_email_outbox) WHEN PRESENT - each is looked up with to_regclass, so this
-- works on a database that does not have them yet (that part just reports "unknown").
--
-- In plain words:
--   integrations_overview() tells a studio member who can see Control Center:
--     * email   - how many staff-invite e-mails Helm sent / could not send in the last 30 days
--                 (counts only - never an address, never a token)
--     * whatsapp - the studio WhatsApp number saved in Control Center (digits only, as stored)
--                 and the status of a connected WhatsApp Business account (no ids, no tokens)
--     * razorpay - status + test/live mode of a connected Razorpay account (no keys)
--   It READS ONLY. No table, column or row is created, changed or deleted. ASCII only.
--   Idempotent: create or replace + grants.

create or replace function public.integrations_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- integrations-overview-0134
declare
  v_org uuid := public.current_org_id();
  v_out jsonb;
  v_wa  jsonb := null;
  v_rz  jsonb := null;
  v_em  jsonb := null;
  v_num text := null;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('controls', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if to_regclass('public.comms_settings') is not null then
    execute 'select s.studio_whatsapp from public.comms_settings s where s.org_id = $1' into v_num using v_org;
  end if;

  if to_regclass('public.org_whatsapp_accounts') is not null then
    execute 'select jsonb_build_object(''status'', w.status, ''display_phone'', w.display_phone, ''connected_at'', w.connected_at)
               from public.org_whatsapp_accounts w where w.org_id = $1' into v_wa using v_org;
  end if;

  if to_regclass('public.org_payment_accounts') is not null then
    execute 'select jsonb_build_object(''status'', p.status, ''mode'', p.mode, ''connected_at'', p.connected_at)
               from public.org_payment_accounts p where p.org_id = $1' into v_rz using v_org;
  end if;

  if to_regclass('public.invite_email_outbox') is not null then
    execute 'select jsonb_build_object(
               ''sent_30d'',    count(*) filter (where o.status = ''sent''    and o.sent_at > now() - interval ''30 days''),
               ''skipped_30d'', count(*) filter (where o.status = ''skipped'' and o.sent_at > now() - interval ''30 days''),
               ''failed_30d'',  count(*) filter (where o.status = ''failed''  and o.sent_at > now() - interval ''30 days''),
               ''pending'',     count(*) filter (where o.sent_at is null),
               ''last_sent_at'', max(o.sent_at) filter (where o.status = ''sent''))
               from public.invite_email_outbox o where o.org_id = $1' into v_em using v_org;
  end if;

  v_out := jsonb_build_object(
    'is_admin', coalesce(public.is_admin(), false),
    'studio_whatsapp', v_num,
    'whatsapp', v_wa,
    'razorpay', v_rz,
    'email', v_em,
    'has_comms', to_regclass('public.comms_settings') is not null,
    'has_accounts', to_regclass('public.org_whatsapp_accounts') is not null,
    'has_invite_mailer', to_regclass('public.invite_email_outbox') is not null);
  return v_out;
end $$;

do $$ begin
  revoke all on function public.integrations_overview() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.integrations_overview() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.integrations_overview() to authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.integrations_overview() to service_role; end if;
end $$;
