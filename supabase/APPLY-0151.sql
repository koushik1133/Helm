-- APPLY-0151.sql - paste into the Supabase SQL editor (staging first, then prod).
-- Additive + idempotent: 2 new append-only tables (RLS on, studio read-only), new functions,
-- 1 new trigger on integration_webhook_events. No existing rows change. Safe to run twice.
begin;
-- 0151_wa_proposal.sql - CANONICAL forward-only. "Send proposal on WhatsApp" + WhatsApp / e-mail
-- OTP for the client approval page, with an append-only audit trail.
-- REQUIRES 0042 (verify_and_consent / request_otp wrappers), 0092 (helm_norm_phone_cc,
-- _comms_country), 0117 (integration_webhook_events, whatsapp_opt_outs), current_org_id(),
-- has_area(), pgcrypto (extensions.digest).
--
-- In plain words:
--   * wa_proposal_optins: one row each time a studio user ticks "Client agreed to receive
--     WhatsApp updates" (who, when, which number, the exact wording). Append-only.
--   * wa_proposal_audit: one row per step - proposal sent (simulated / queued / sent / failed),
--     WhatsApp delivered / read (from wa-webhook), OTP sent, OTP checked, approved. Each row
--     carries the quote id + version + SHA-256 of the quote snapshot, studio, phone (E.164),
--     channel, template, wamid, IP (trusted proxy header) and user agent. Append-only: UPDATE
--     and DELETE are refused by a trigger.
--   * Both tables: RLS on, studio members with quotes VIEW can read their own studio's rows;
--     nobody writes directly - only the security definer functions below.
--   * wa_proposal_prepare(...)        studio (quotes EDIT): checks the number IS the client
--                                      number on the quote, records the opt-in, writes the
--                                      audit row, returns template variables. p_simulate=true
--                                      = nothing is sent (no Meta secrets yet).
--   * wa_proposal_mark(...)           service role (edge function): result of a real send.
--   * wa_proposal_state(p_quote)      studio: latest status + opt-in for the share panel.
--   * wa_otp_begin(p_token, channel)  service role: who gets the code (the phone / e-mail ON
--                                      THE QUOTE, never a typed one), cooldown 30 s, at most
--                                      4 codes (1 + 3 resends) per channel per 30 minutes.
--   * wa_request_otp(p_token, channel)        public link (anon): simulated path - stores the
--                                      code hash through the existing request_otp.
--   * wa_verify_and_consent(...)      public link (anon): the existing verify_and_consent with
--                                      the number on the quote; logs the attempt + approval.
--   * a trigger on integration_webhook_events adds delivered / read / failed audit rows for
--     a wamid this feature sent (never blocks the webhook insert).
--   OTP codes are still stored ONLY as bcrypt hashes in quote_otps (10 min, 5 attempts).
--   No secret is stored anywhere here.
--
-- ZERO DATA LOSS: additive + idempotent. New tables / functions / one new trigger only.
-- No DROP of data, no DELETE, no UPDATE of existing rows. ASCII only. Safe to run twice.

do $$ begin
  if to_regprocedure('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)') is null
     or to_regprocedure('public.request_otp(uuid, text)') is null then
    raise exception '0151: apply the approval OTP migrations (0042 / 0093) first'; end if;
  if to_regprocedure('public.helm_norm_phone_cc(text, text)') is null or to_regprocedure('public._comms_country(uuid)') is null then
    raise exception '0151: apply 0092 first'; end if;
  if to_regclass('public.integration_webhook_events') is null or to_regclass('public.whatsapp_opt_outs') is null then
    raise exception '0151: apply 0117 first'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.has_area(text,text)') is null then
    raise exception '0151: current_org_id() / has_area() missing'; end if;
end $$;

-- ---- 1) tables -----------------------------------------------------------------------------
create table if not exists public.wa_proposal_optins (
  id            bigint generated always as identity primary key,
  org_id        uuid not null,
  quote_id      uuid not null,
  phone_e164    text not null,
  opted_in      boolean not null default true,
  consent_text  text not null,
  source        text not null default 'studio_checkbox',
  recorded_by   uuid,
  recorded_at   timestamptz not null default now(),
  constraint wa_proposal_optins_phone_chk151 check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint wa_proposal_optins_text_chk151 check (char_length(consent_text) between 1 and 500)
);
create index if not exists wa_proposal_optins_q_idx151 on public.wa_proposal_optins (quote_id, recorded_at desc);
create index if not exists wa_proposal_optins_org_idx151 on public.wa_proposal_optins (org_id, recorded_at desc);

create table if not exists public.wa_proposal_audit (
  id               bigint generated always as identity primary key,
  org_id           uuid not null,
  quote_id         uuid not null,
  quote_version    integer,
  snapshot_sha256  text,
  step             text not null,
  channel          text not null,
  template         text,
  phone_e164       text,
  wamid            text,
  status           text not null,
  otp_attempts     integer,
  ip               text,
  user_agent       text,
  actor            uuid,
  ref_id           bigint,
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  constraint wa_proposal_audit_step_chk151 check (step in ('proposal_send', 'send_result', 'wa_status', 'otp_sent', 'otp_verify', 'approved')),
  constraint wa_proposal_audit_channel_chk151 check (channel in ('whatsapp', 'email', 'sms')),
  constraint wa_proposal_audit_sha_chk151 check (snapshot_sha256 is null or snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  constraint wa_proposal_audit_phone_chk151 check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);
create index if not exists wa_proposal_audit_q_idx151 on public.wa_proposal_audit (quote_id, created_at desc);
create index if not exists wa_proposal_audit_org_idx151 on public.wa_proposal_audit (org_id, created_at desc);
create index if not exists wa_proposal_audit_wamid_idx151 on public.wa_proposal_audit (wamid) where wamid is not null;

-- append-only: rows can be added, never changed or removed
create or replace function public._wa151_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'wa proposal records are append-only' using errcode = '42501';
end $$;
drop trigger if exists wa_proposal_optins_append_only151 on public.wa_proposal_optins;
create trigger wa_proposal_optins_append_only151 before update or delete on public.wa_proposal_optins
  for each row execute function public._wa151_append_only();
drop trigger if exists wa_proposal_audit_append_only151 on public.wa_proposal_audit;
create trigger wa_proposal_audit_append_only151 before update or delete on public.wa_proposal_audit
  for each row execute function public._wa151_append_only();

alter table public.wa_proposal_optins enable row level security;
alter table public.wa_proposal_audit enable row level security;
drop policy if exists wa_proposal_optins_read151 on public.wa_proposal_optins;
create policy wa_proposal_optins_read151 on public.wa_proposal_optins for select to authenticated
  using (org_id = public.current_org_id() and coalesce(public.has_area('quotes', 'view'), false));
drop policy if exists wa_proposal_audit_read151 on public.wa_proposal_audit;
create policy wa_proposal_audit_read151 on public.wa_proposal_audit for select to authenticated
  using (org_id = public.current_org_id() and coalesce(public.has_area('quotes', 'view'), false));
revoke all on table public.wa_proposal_optins from public, anon, authenticated;
revoke all on table public.wa_proposal_audit from public, anon, authenticated;
grant select on table public.wa_proposal_optins to authenticated;
grant select on table public.wa_proposal_audit to authenticated;
grant select, insert on table public.wa_proposal_optins to service_role;
grant select, insert on table public.wa_proposal_audit to service_role;

-- ---- 2) helpers (internal) -----------------------------------------------------------------
-- the quote's client number as E.164 (+digits), using the quote's country for a bare number
create or replace function public._wa151_quote_e164(p_quote uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_raw text; v_dial text; v text;
begin
  select coalesce(q.client ->> 'phone', ''),
         case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(q.org_id)))
           when 'AE' then '971' when 'US' then '1' else '91' end
    into v_raw, v_dial from public.quotes q where q.id = p_quote;
  if coalesce(btrim(v_raw), '') = '' then return null; end if;
  v := public._wa151_e164(v_raw, v_dial);
  return v;
end $$;

-- any typed number -> E.164 (+digits) with the given default dial code, or null
create or replace function public._wa151_e164(p_raw text, p_dial text)
returns text language plpgsql immutable set search_path = '' as $$
declare s text := btrim(coalesce(p_raw, '')); d text;
begin
  if s = '' then return null; end if;
  if left(s, 1) = '+' or s ~ '^00' then
    d := regexp_replace(s, '[^0-9]', '', 'g');
    if s ~ '^00' then d := substr(d, 3); end if;
  else
    d := public.helm_norm_phone_cc(s, coalesce(p_dial, '91'));
  end if;
  if d ~ '^[1-9][0-9]{7,14}$' then return '+' || d; end if;
  return null;
end $$;

-- version + SHA-256 of what the client is shown (title, type, date, client, pricing, terms)
create or replace function public._wa151_snapshot(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_ver integer; v_doc text;
begin
  select coalesce((select max(v.version_no) from public.quote_versions v where v.quote_id = q.id), 0),
         jsonb_build_object('id', q.id, 'code', q.code, 'title', q.title, 'event_type', q.event_type,
                            'event_date', q.event_date, 'client', q.client, 'pricing', q.pricing,
                            'tax', q.tax_snapshot, 'updated_at', q.updated_at)::text
    into v_ver, v_doc from public.quotes q where q.id = p_quote;
  if v_doc is null then return null; end if;
  return jsonb_build_object('version', v_ver, 'sha256', encode(extensions.digest(v_doc, 'sha256'), 'hex'));
end $$;

-- client IP from the trusted proxy headers PostgREST passes through (Cloudflare first)
create or replace function public._wa151_ip()
returns text language plpgsql stable set search_path = '' as $$
declare h jsonb; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  if h is null then return null; end if;
  v := coalesce(nullif(h ->> 'cf-connecting-ip', ''), nullif(h ->> 'x-real-ip', ''),
                nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''));
  if v is null or v !~ '^[0-9A-Fa-f:.]{2,45}$' then return null; end if;
  return v;
end $$;

-- the public link -> quote row (valid, not revoked, not expired, not demo)
create or replace function public._wa151_token_quote(p_token uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  select q.id into v from public.quotes q
   where q.approval_token = p_token and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
     and not coalesce(q.is_demo, false);
  return v;
end $$;

create or replace function public._wa151_log(p_quote uuid, p_step text, p_channel text, p_template text,
                                             p_phone text, p_wamid text, p_status text, p_attempts integer,
                                             p_ua text, p_ref bigint, p_detail jsonb)
returns bigint language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid; v_snap jsonb; v_id bigint;
begin
  select q.org_id into v_org from public.quotes q where q.id = p_quote;
  if v_org is null then return null; end if;
  v_snap := public._wa151_snapshot(p_quote);
  insert into public.wa_proposal_audit(org_id, quote_id, quote_version, snapshot_sha256, step, channel, template,
                                       phone_e164, wamid, status, otp_attempts, ip, user_agent, actor, ref_id, detail)
    values (v_org, p_quote, (v_snap ->> 'version')::integer, v_snap ->> 'sha256', p_step, p_channel, p_template,
            p_phone, left(p_wamid, 160), left(coalesce(p_status, 'unknown'), 40), p_attempts, public._wa151_ip(),
            left(p_ua, 400), auth.uid(), p_ref, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

-- ---- 3) studio: prepare a proposal message (quotes EDIT) -----------------------------------
create or replace function public.wa_proposal_prepare(p_quote uuid, p_kind text, p_phone text,
                                                      p_opt_in boolean, p_consent_text text, p_simulate boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- wa-proposal-0151
declare q record; v_org uuid := public.current_org_id(); v_to text; v_dial text; v_typed text;
        v_opt boolean; v_id bigint; v_studio text; v_total numeric; v_cur text;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('quotes', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('proposal_sent', 'proposal_reminder', 'proposal_approved_pay', 'payment_received') then
    raise exception 'unknown message' using errcode = '22023'; end if;
  select x.id, x.org_id, x.client, x.event_type, x.event_date, x.pricing, x.approval_token, x.approval_token_revoked_at,
         x.is_demo, x.tax_snapshot, x.title, x.code
    into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(q.is_demo, false) then raise exception 'Demo data: messages are switched off for demo events' using errcode = '42501'; end if;
  if q.approval_token is null or q.approval_token_revoked_at is not null then
    raise exception 'create the approval link first' using errcode = 'P0001'; end if;
  v_to := public._wa151_quote_e164(q.id);
  if v_to is null then raise exception 'add a valid client mobile number to the quote first' using errcode = '22023'; end if;
  v_dial := case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(q.org_id)))
              when 'AE' then '971' when 'US' then '1' else '91' end;
  v_typed := public._wa151_e164(p_phone, v_dial);
  if v_typed is null or v_typed <> v_to then
    raise exception 'that number is not the client number on this quote' using errcode = '22023'; end if;
  if exists (select 1 from public.whatsapp_opt_outs o where o.phone = substr(v_to, 2) and o.opted_out
               and (o.org_id is null or o.org_id = v_org)) then
    raise exception 'the client replied STOP to WhatsApp messages' using errcode = 'P0001'; end if;

  if p_opt_in is true then
    if coalesce(btrim(p_consent_text), '') = '' or char_length(p_consent_text) > 500 then
      raise exception 'opt-in wording is required' using errcode = '22023'; end if;
    insert into public.wa_proposal_optins(org_id, quote_id, phone_e164, opted_in, consent_text, recorded_by)
      values (v_org, q.id, v_to, true, p_consent_text, auth.uid());
  end if;
  select o.opted_in into v_opt from public.wa_proposal_optins o
   where o.quote_id = q.id and o.phone_e164 = v_to order by o.recorded_at desc, o.id desc limit 1;
  if v_opt is not true then
    raise exception 'tick "Client agreed to receive WhatsApp updates" first' using errcode = 'P0001'; end if;

  -- per-studio cap: 300 proposal messages per hour
  if (select count(*) from public.wa_proposal_audit a where a.org_id = v_org and a.step = 'proposal_send'
        and a.created_at > now() - interval '1 hour') >= 300 then
    raise exception 'WhatsApp limit reached for your studio - try again later' using errcode = 'HL429'; end if;

  v_id := public._wa151_log(q.id, 'proposal_send', 'whatsapp', p_kind, v_to, null,
                            case when p_simulate is false then 'queued' else 'simulated' end, null, null, null, '{}'::jsonb);
  select o.name into v_studio from public.organizations o where o.id = v_org;
  v_total := nullif(q.pricing ->> 'total', '')::numeric;
  v_cur := upper(coalesce(nullif(q.pricing ->> 'currency', ''), case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(v_org)))
             when 'AE' then 'AED' when 'US' then 'USD' else 'INR' end));
  return jsonb_build_object('audit_id', v_id, 'to', substr(v_to, 2), 'to_e164', v_to, 'kind', p_kind,
    'status', case when p_simulate is false then 'queued' else 'simulated' end,
    'token', q.approval_token,
    'vars', jsonb_build_object('client_name', coalesce(nullif(q.client ->> 'name', ''), 'there'),
                               'studio_name', coalesce(v_studio, 'your planner'),
                               'event_type', coalesce(nullif(q.event_type, ''), 'event'),
                               'event_date', coalesce(to_char(q.event_date, 'DD Mon YYYY'), 'to be confirmed'),
                               'total', case when v_total is null then 'see proposal' else v_cur || ' ' || to_char(round(v_total), 'FM999,999,999,990') end));
end $$;

-- ---- 4) edge function: result of a real send (service role) --------------------------------
create or replace function public.wa_proposal_mark(p_audit_id bigint, p_status text, p_wamid text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- wa-proposal-0151
declare a record; v_id bigint;
begin
  if p_status is null or p_status not in ('sent', 'failed', 'simulated') then raise exception 'bad status' using errcode = '22023'; end if;
  select x.id, x.quote_id, x.channel, x.template, x.phone_e164 into a from public.wa_proposal_audit x where x.id = p_audit_id;
  if a.id is null then raise exception 'unknown record' using errcode = '22023'; end if;
  v_id := public._wa151_log(a.quote_id, 'send_result', a.channel, a.template, a.phone_e164,
                            nullif(p_wamid, ''), p_status, null, null, a.id, '{}'::jsonb);
  return jsonb_build_object('recorded', v_id);
end $$;

-- ---- 5) studio: what the share panel shows --------------------------------------------------
create or replace function public.wa_proposal_state(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- wa-proposal-0151
declare v_org uuid := public.current_org_id(); v_last record; v_opt record; v_status text; v_send bigint;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('quotes', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select a.id, a.template, a.status, a.created_at into v_last from public.wa_proposal_audit a
   where a.quote_id = p_quote and a.step = 'proposal_send' order by a.created_at desc, a.id desc limit 1;
  v_status := v_last.status;
  if v_last.id is not null then
    -- newest of: send result, then webhook statuses for that message
    select a.status into v_status from public.wa_proposal_audit a
     where a.quote_id = p_quote and (a.id = v_last.id or a.ref_id = v_last.id
            or (a.step = 'wa_status' and a.wamid is not null and a.wamid in
                (select r.wamid from public.wa_proposal_audit r where r.ref_id = v_last.id and r.wamid is not null)))
     order by case a.status when 'read' then 5 when 'delivered' then 4 when 'failed' then 3 when 'sent' then 2 else 1 end desc,
              a.id desc limit 1;
  end if;
  select o.opted_in, o.recorded_at, o.recorded_by, o.phone_e164 into v_opt from public.wa_proposal_optins o
   where o.quote_id = p_quote order by o.recorded_at desc, o.id desc limit 1;
  return jsonb_build_object('status', v_status, 'template', v_last.template, 'at', v_last.created_at,
    'opted_in', coalesce(v_opt.opted_in, false), 'opted_in_at', v_opt.recorded_at,
    'opted_in_by', (select coalesce(nullif(p.full_name, ''), 'a studio member') from public.profiles p where p.id = v_opt.recorded_by),
    'phone', v_opt.phone_e164, 'quote_phone', public._wa151_quote_e164(p_quote));
end $$;

-- ---- 6) client OTP over WhatsApp / e-mail ----------------------------------------------------
-- service role (send-otp) + used by wa_request_otp: limits, recipient ON THE QUOTE, audit row
create or replace function public.wa_otp_begin(p_token uuid, p_channel text, p_user_agent text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- wa-proposal-0151
declare v_q uuid; v_raw text; v_e164 text; v_email text; v_last timestamptz; v_n int; v_mask text;
begin
  if p_channel is null or p_channel not in ('whatsapp', 'email') then raise exception 'bad channel' using errcode = '22023'; end if;
  v_q := public._wa151_token_quote(p_token);
  if v_q is null then raise exception 'invalid link' using errcode = 'HL404'; end if;
  select coalesce(q.client ->> 'phone', ''), nullif(btrim(coalesce(q.client ->> 'email', '')), '')
    into v_raw, v_email from public.quotes q where q.id = v_q;
  v_e164 := public._wa151_quote_e164(v_q);
  if v_e164 is null then
    raise exception 'The studio has no mobile number on file for you yet.' using errcode = 'HL403'; end if;
  if p_channel = 'email' and (v_email is null or v_email !~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$') then
    raise exception 'The studio has no e-mail address on file for you.' using errcode = 'HL403'; end if;
  select max(a.created_at), count(*) into v_last, v_n from public.wa_proposal_audit a
   where a.quote_id = v_q and a.step = 'otp_sent' and a.channel = p_channel and a.created_at > now() - interval '30 minutes';
  if v_last is not null and v_last > now() - interval '30 seconds' then
    raise exception 'please wait a moment before asking for another code' using errcode = 'HL429',
      detail = ceil(extract(epoch from (v_last + interval '30 seconds' - now())))::text; end if;
  if v_n >= 4 then raise exception 'too many codes requested - try again later' using errcode = 'HL429'; end if;
  perform public._wa151_log(v_q, 'otp_sent', p_channel,
    case when p_channel = 'whatsapp' then 'proposal_approval_otp' else 'email_otp' end,
    v_e164, null, 'requested', null, p_user_agent, null, '{}'::jsonb);
  v_mask := case when p_channel = 'email'
    then left(split_part(v_email, '@', 1), 1) || '***@' || split_part(v_email, '@', 2)
    else '+' || repeat('*', greatest(0, length(v_e164) - 5)) || right(v_e164, 4) end;
  return jsonb_build_object('quote_id', v_q, 'phone_key', v_raw, 'to', substr(v_e164, 2), 'to_e164', v_e164,
    'email', case when p_channel = 'email' then v_email end, 'masked', v_mask, 'resends_left', greatest(0, 3 - v_n));
end $$;

-- public link (anon), simulated / pre-deploy path: hash stored by the existing request_otp
create or replace function public.wa_request_otp(p_token uuid, p_channel text, p_user_agent text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- wa-proposal-0151
declare v jsonb; r jsonb; v_echo boolean;
begin
  v := public.wa_otp_begin(p_token, p_channel, p_user_agent);
  r := public.request_otp(p_token, v ->> 'phone_key');
  -- OTP-01: the code is shown on screen ONLY where the explicit dev echo is allowed (never prod)
  v_echo := public._a42_dev_echo_allowed() and not public._flag('sms_live', (select q.org_id from public.quotes q where q.id = (v ->> 'quote_id')::uuid))
            and public._flag('otp_dev_echo', (select q.org_id from public.quotes q where q.id = (v ->> 'quote_id')::uuid));
  if not coalesce(v_echo, false) then r := r || jsonb_build_object('dev_code', null); end if;
  return jsonb_build_object('sent', coalesce((r ->> 'sent')::boolean, false), 'live', false, 'simulated', true,
    'channel', p_channel, 'masked', v ->> 'masked', 'resends_left', (v ->> 'resends_left')::int,
    'dev_code', r ->> 'dev_code', 'delivery', r ->> 'delivery', 'message', r ->> 'message');
end $$;

-- public link (anon): verify the code against the number ON THE QUOTE, log attempt + approval
create or replace function public.wa_verify_and_consent(p_token uuid, p_channel text, p_code text, p_agreed boolean,
                                                        p_terms_version text, p_consent_text text,
                                                        p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- wa-proposal-0151
declare v_q uuid; v_raw text; v_e164 text; v_out jsonb; v_att int; v_ok boolean;
begin
  if p_channel is null or p_channel not in ('whatsapp', 'email') then raise exception 'bad channel' using errcode = '22023'; end if;
  v_q := public._wa151_token_quote(p_token);
  if v_q is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  select coalesce(q.client ->> 'phone', '') into v_raw from public.quotes q where q.id = v_q;
  v_e164 := public._wa151_quote_e164(v_q);
  v_out := public.verify_and_consent(p_token, v_raw, p_code, p_agreed, p_terms_version, p_consent_text, p_client_name, p_user_agent);
  v_ok := coalesce((v_out ->> 'approved')::boolean, false);
  select o.attempts into v_att from public.quote_otps o where o.quote_id = v_q
   order by o.created_at desc limit 1;
  perform public._wa151_log(v_q, 'otp_verify', p_channel, null, v_e164, null,
    case when v_ok then 'verified' else left(coalesce(v_out ->> 'error', 'rejected'), 40) end,
    coalesce(v_att, 0) + case when v_ok then 1 else 0 end, p_user_agent, null, '{}'::jsonb);
  if v_ok then
    perform public._wa151_log(v_q, 'approved', p_channel, null, v_e164, null, 'approved', null, p_user_agent, null,
      jsonb_build_object('terms_version', left(p_terms_version, 40), 'approved_at', now()));
  end if;
  return v_out;
end $$;

-- ---- 7) wa-webhook statuses for messages this feature sent ----------------------------------
create or replace function public._wa151_webhook_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare a record;
begin
  if new.provider <> 'whatsapp' or new.event_type <> 'message_status' or new.ref is null then return new; end if;
  begin
    select x.quote_id, x.channel, x.template, x.phone_e164 into a from public.wa_proposal_audit x
     where x.wamid = new.ref and x.step = 'send_result' order by x.id desc limit 1;
    if a.quote_id is not null and new.status in ('sent', 'delivered', 'read', 'failed') then
      perform public._wa151_log(a.quote_id, 'wa_status', a.channel, a.template, a.phone_e164, new.ref, new.status,
        null, null, null, jsonb_build_object('event_at', new.received_at));
    end if;
  exception when others then
    null;   -- never block the webhook record
  end;
  return new;
end $$;
drop trigger if exists zz_wa_proposal_status151 on public.integration_webhook_events;
create trigger zz_wa_proposal_status151 after insert on public.integration_webhook_events
  for each row execute function public._wa151_webhook_status();

-- ---- 8) grants ------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select * from (values
      ('public._wa151_append_only()', 'none'),
      ('public._wa151_quote_e164(uuid)', 'none'),
      ('public._wa151_e164(text, text)', 'none'),
      ('public._wa151_snapshot(uuid)', 'none'),
      ('public._wa151_ip()', 'none'),
      ('public._wa151_token_quote(uuid)', 'none'),
      ('public._wa151_log(uuid, text, text, text, text, text, text, integer, text, bigint, jsonb)', 'none'),
      ('public._wa151_webhook_status()', 'none'),
      ('public.wa_proposal_mark(bigint, text, text)', 'none'),
      ('public.wa_otp_begin(uuid, text, text)', 'none'),
      ('public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean)', 'auth'),
      ('public.wa_proposal_state(uuid)', 'auth'),
      ('public.wa_request_otp(uuid, text, text)', 'anon'),
      ('public.wa_verify_and_consent(uuid, text, text, boolean, text, text, text, text)', 'anon')) v(f, who)
  loop
    execute format('revoke all on function %s from public', r.f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format(case when r.who = 'anon' then 'grant execute on function %s to anon' else 'revoke all on function %s from anon' end, r.f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format(case when r.who in ('anon', 'auth') then 'grant execute on function %s to authenticated' else 'revoke all on function %s from authenticated' end, r.f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', r.f); end if;
  end loop;
end $$;
commit;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 tables exist', to_regclass('public.wa_proposal_optins') is not null and to_regclass('public.wa_proposal_audit') is not null),
  ('02 RLS on both tables', (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.wa_proposal_optins'::regclass, 'public.wa_proposal_audit'::regclass))),
  ('03 append-only triggers', exists (select 1 from pg_trigger where tgname = 'wa_proposal_audit_append_only151')
       and exists (select 1 from pg_trigger where tgname = 'wa_proposal_optins_append_only151')),
  ('04 webhook status trigger', exists (select 1 from pg_trigger where tgname = 'zz_wa_proposal_status151')),
  ('05 anon cannot read the tables', not has_table_privilege('anon', 'public.wa_proposal_audit', 'select')
       and not has_table_privilege('anon', 'public.wa_proposal_optins', 'select')),
  ('06 studio cannot write the tables', not has_table_privilege('authenticated', 'public.wa_proposal_audit', 'insert')
       and not has_table_privilege('authenticated', 'public.wa_proposal_audit', 'update')),
  ('07 public link RPCs open to anon', has_function_privilege('anon', 'public.wa_request_otp(uuid, text, text)', 'execute')
       and has_function_privilege('anon', 'public.wa_verify_and_consent(uuid, text, text, boolean, text, text, text, text)', 'execute')),
  ('08 studio RPCs not open to anon', not has_function_privilege('anon', 'public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean)', 'execute')
       and has_function_privilege('authenticated', 'public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean)', 'execute')),
  ('09 service-role helpers closed', not has_function_privilege('authenticated', 'public.wa_proposal_mark(bigint, text, text)', 'execute')
       and not has_function_privilege('anon', 'public.wa_otp_begin(uuid, text, text)', 'execute')
       and not has_function_privilege('authenticated', 'public.wa_otp_begin(uuid, text, text)', 'execute')),
  ('10 secdef with empty search_path', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('wa_proposal_prepare', 'wa_proposal_mark', 'wa_proposal_state', 'wa_otp_begin', 'wa_request_otp', 'wa_verify_and_consent')
       and (not p.prosecdef or not ('search_path=""' = any(p.proconfig)))))
) v(item, ok) order by item;
