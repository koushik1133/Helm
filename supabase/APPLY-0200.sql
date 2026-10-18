-- APPLY-0200.sql - paste into the Supabase SQL editor (staging first, then production). Apply 0195 first.
-- Additive + idempotent: client booklet "Send to client" (queued e-mail / WhatsApp; free trial = skipped, nothing sent). Safe to run twice.
-- After this, comms-dispatch must be redeployed (it learns purpose 'booklet_link'); until then booklet rows are
-- claimed but have no text, so they are marked skipped (nothing half-written is sent).
begin;
-- 0200_booklet_send.sql - CANONICAL forward-only. REQUIRES 0065 (client_booklets), 0078 (comms_outbox, _comms_cfg,
-- _comms_quote_live), 0151 (wa_proposal_optins, _wa151_e164), 0155 (_wa_opted_out, claim wrapper),
-- 0166 (_sample_outbound_blocked + the trial outbox skip trigger on comms_outbox). Same pattern as 0195.
--
-- In plain words: "Send to client" in the "Share booklet" dialog (event workspace / client page).
--   1) booklet_send(quote, channel, to, opt_in, consent_text): the studio (quotes EDIT, own studio) sends the
--      LIVE client booklet link to the client by e-mail or WhatsApp. The message is fixed text built here
--      ("Hi <client>, here is your event booklet from <studio>:" + the link + "(valid until <date>)"); the
--      studio only picks the channel and the address (pre-filled from the quote, editable). It is QUEUED in
--      comms_outbox (purpose 'booklet_link') and sent by comms-dispatch like the invitation link. Rules:
--        * the booklet link must be live (not revoked, not expired); the event not cancelled / closed
--        * WhatsApp: the client's opt-in must be on record for that number (stored in wa_proposal_optins
--          with who / when), a number that replied STOP is refused, and the studio must have its WhatsApp
--          number set up (Messages settings)
--        * caps: 10 sends per event per day, 5 different recipients per event per day, 60 per studio per hour
--        * FREE TRIAL / sample studio / demo event: nothing is sent - the row is stored as 'skipped' (the 0166
--          trigger does this for a trial studio on every comms_outbox insert; demo events are skipped here) and
--          the answer says { status: 'skipped', reason: 'free_trial' | 'demo' }
--      Log: audit_log 'booklet.link_sent' (masked address) + the quote's activity (notifications 'booklet_link').
--   2) booklet_send_log(quote): the last 10 booklet sends of this event (masked address, status).
--   3) comms_outbox_claim: wrapper (the previous one is kept as comms_outbox_claim__pre0200) that first hands
--      out 'booklet_link' rows after re-checking them (the SAME booklet link is still the live one, event live,
--      not demo, not a trial, WhatsApp: STOP + studio number), then the previous claim for everything else.
--      The booklet token is NEVER stored in the outbox row: the row carries the booklet id, and the claim adds
--      the link path (<studio>/booklet/<token> or booklet?t=<token>) to the handed-out payload only;
--      comms-dispatch joins it to its own APP_URL. A dispatcher that does not know 'booklet_link' yet finds no
--      text and marks the row skipped (fails closed - nothing half-written is sent).
--   4) comms_outbox purpose check widened with 'booklet_link' (every existing value kept, e.g. invite_site).
--   5) AFTER UPDATE trigger: when a 'booklet_link' row is finally sent / failed / skipped, one activity row.
-- Additive + idempotent: 4 new functions, 1 wrapper (original kept), 1 trigger, 1 index, 1 CHECK widened.
-- No row is changed or deleted. Safe to run twice. ASCII only.

do $$ begin
  if to_regclass('public.client_booklets') is null or to_regclass('public.comms_outbox') is null
     or to_regclass('public.wa_proposal_optins') is null then
    raise exception '0200: apply 0065 + 0078 + 0151 first'; end if;
  if to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null or to_regprocedure('public._wa_opted_out(text,uuid)') is null
     or to_regprocedure('public._wa151_e164(text,text)') is null or to_regprocedure('public._comms_cfg(uuid)') is null
     or to_regprocedure('public._comms_quote_live(uuid)') is null or to_regprocedure('public.comms_outbox_claim(integer)') is null
     or to_regprocedure('public._comms_country(uuid)') is null
     or to_regclass('public.audit_log') is null or to_regclass('public.notifications') is null then
    raise exception '0200: apply 0022 + 0078 + 0151 + 0155 + 0166 first'; end if;
end $$;

-- ---- 4) purpose check: keep every existing value, add 'booklet_link' ----------------------------------
do $$
declare c record; v_vals text[]; v_list text;
begin
  select con.conname, pg_get_constraintdef(con.oid) as def into c
    from pg_constraint con
   where con.conrelid = 'public.comms_outbox'::regclass and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%purpose%' and pg_get_constraintdef(con.oid) like '%pay_reminder%'
   order by con.conname limit 1;
  if c.conname is not null and position('booklet_link' in c.def) > 0 then return; end if;
  if c.conname is not null then
    select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(c.def, '''([a-z_]+)''', 'g') m;
  end if;
  v_vals := coalesce(v_vals, array['follow_up', 'pay_reminder', 'wa_forward']::text[]);
  if not ('booklet_link' = any (v_vals)) then v_vals := v_vals || 'booklet_link'::text; end if;
  select string_agg(quote_literal(x), ', ' order by x) into v_list from unnest(v_vals) x;
  if c.conname is not null then execute format('alter table public.comms_outbox drop constraint %I', c.conname); end if;
  execute format('alter table public.comms_outbox add constraint comms_outbox_purpose_check check (purpose in (%s))', v_list);
end $$;

create index if not exists comms_outbox_booklet_idx200 on public.comms_outbox (quote_id, created_at)
  where purpose = 'booklet_link';

-- ---- helpers (internal) --------------------------------------------------------------------------------
-- the live booklet link of an event (same rule as booklet_current: newest, not revoked, not expired)
create or replace function public._bk200_live(p_quote uuid)
returns table (id uuid, token uuid, expires_at timestamptz, org_id uuid)
language sql stable security definer set search_path = '' as $$
  -- booklet-send-0200
  select b.id, b.token, b.expires_at, b.org_id from public.client_booklets b
   where b.quote_id = p_quote and b.revoked_at is null and b.expires_at > now()
   order by b.created_at desc, b.id desc limit 1;
$$;

-- the public path of a booklet link (same rule as the app: /<studio link name>/booklet/<token>, else booklet?t=<token>)
create or replace function public._bk200_link_path(p_booklet uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- booklet-send-0200
  select case when coalesce(o.public_slug, '') ~ '^[a-z0-9-]{3,40}$' then o.public_slug || '/booklet/' || b.token::text
              else 'booklet?t=' || b.token::text end
    from public.client_booklets b left join public.organizations o on o.id = b.org_id
   where b.id = p_booklet;
$$;

create or replace function public._bk200_mask(p_channel text, p_to text)
returns text language sql immutable set search_path = '' as $$
  -- booklet-send-0200: a***@b.com / +91******3210
  select case when p_channel = 'email' and position('@' in coalesce(p_to, '')) > 1
              then left(p_to, 1) || '***' || substr(p_to, position('@' in p_to))
              when p_channel = 'whatsapp' and length(coalesce(p_to, '')) >= 6
              then '+' || left(p_to, 2) || repeat('*', greatest(length(p_to) - 6, 0)) || right(p_to, 4)
              else '***' end;
$$;

-- ---- 1) studio: send the booklet link ------------------------------------------------------------------
create or replace function public.booklet_send(p_quote uuid, p_channel text, p_to text,
                                               p_opt_in boolean default false, p_consent_text text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-send-0200
declare
  v_org uuid := public.current_org_id(); b record; q record; v_to text; v_e164 text; v_dial text;
  v_cfg jsonb; v_blocked boolean; v_reason text; v_opt boolean; v_name text; v_studio text; v_until text;
  v_body text; v_id uuid; v_status text; v_n integer; v_key text; v_client_to boolean;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('quotes', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_channel is null or p_channel not in ('email', 'whatsapp') then
    raise exception 'choose Email or WhatsApp' using errcode = '22023'; end if;
  select x.id, x.org_id, x.client, x.is_demo, x.tax_snapshot into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select l.id, l.token, l.expires_at, l.org_id into b from public._bk200_live(q.id) l;
  if b.id is null or b.org_id is distinct from v_org then
    raise exception 'Create a booklet link first (the old one was revoked or has expired).' using errcode = 'P0001', hint = 'no_live_link'; end if;
  if not public._comms_quote_live(q.id) then
    raise exception 'This event is closed or cancelled - nothing can be sent for it.' using errcode = 'P0001', hint = 'event_closed'; end if;

  -- recipient (pre-filled from the quote in the app, editable): format checked here
  if p_channel = 'email' then
    v_to := lower(btrim(coalesce(p_to, '')));
    if v_to !~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$' then
      raise exception 'Enter a valid e-mail address.' using errcode = '22023'; end if;
    v_client_to := v_to = lower(btrim(coalesce(q.client ->> 'email', '')));
  else
    v_dial := case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(v_org)))
                when 'AE' then '971' when 'US' then '1' else '91' end;
    v_e164 := public._wa151_e164(p_to, v_dial);
    if v_e164 is null then raise exception 'Enter a valid mobile number with country code.' using errcode = '22023'; end if;
    v_to := substr(v_e164, 2);
    v_client_to := v_e164 is not distinct from public._wa151_e164(q.client ->> 'phone', v_dial);
  end if;

  v_blocked := public._sample_outbound_blocked(v_org, v_to);
  v_reason := case when v_blocked then 'free_trial' when coalesce(q.is_demo, false) then 'demo' end;

  if p_channel = 'whatsapp' then
    if public._wa_opted_out(v_to, v_org) then
      raise exception 'This number replied STOP to WhatsApp messages - send the link another way.' using errcode = 'HL451'; end if;
    if p_opt_in is true then
      if coalesce(btrim(p_consent_text), '') = '' or char_length(p_consent_text) > 500 then
        raise exception 'opt-in wording is required' using errcode = '22023'; end if;
      insert into public.wa_proposal_optins(org_id, quote_id, phone_e164, opted_in, consent_text, source, recorded_by)
        values (v_org, q.id, v_e164, true, p_consent_text, 'booklet_send', auth.uid());
    end if;
    select o.opted_in into v_opt from public.wa_proposal_optins o
     where o.quote_id = q.id and o.phone_e164 = v_e164 order by o.recorded_at desc, o.id desc limit 1;
    if v_opt is not true then
      raise exception 'Tick "Client agreed to receive WhatsApp messages" first.' using errcode = 'P0001', hint = 'opt_in'; end if;
    v_cfg := public._comms_cfg(v_org);
    if v_reason is null and coalesce(v_cfg ->> 'studio_whatsapp', '') !~ '^[0-9]{8,15}$' then
      raise exception 'WhatsApp sending is not set up for your studio yet - use Email or Copy link.' using errcode = 'P0001', hint = 'wa_not_setup'; end if;
  end if;

  -- double click: the same message to the same address in the last 2 minutes is not queued again
  perform pg_advisory_xact_lock(hashtextextended('helm:booklet-send:' || q.id::text, 0));
  if exists (select 1 from public.comms_outbox c
              where c.purpose = 'booklet_link' and c.quote_id = q.id and c.channel = p_channel
                and c.recipient = v_to and c.payload ->> 'booklet_id' = b.id::text and c.created_at > now() - interval '2 minutes') then
    return jsonb_build_object('status', 'already_queued', 'channel', p_channel, 'masked', public._bk200_mask(p_channel, v_to));
  end if;
  -- caps (counted on every row, skipped ones too, so a trial cannot loop either)
  select count(*) into v_n from public.comms_outbox c
   where c.purpose = 'booklet_link' and c.quote_id = q.id and c.created_at > now() - interval '1 day';
  if v_n >= 10 then raise exception 'This booklet was sent 10 times today - try again tomorrow.' using errcode = 'HL429'; end if;
  select count(distinct c.recipient) into v_n from public.comms_outbox c
   where c.purpose = 'booklet_link' and c.quote_id = q.id and c.created_at > now() - interval '1 day'
     and c.recipient <> v_to;
  if v_n >= 5 then raise exception 'This booklet went to 5 different people today - try again tomorrow.' using errcode = 'HL429'; end if;
  select count(*) into v_n from public.comms_outbox c
   where c.org_id = v_org and c.purpose = 'booklet_link' and c.created_at > now() - interval '1 hour';
  if v_n >= 60 then raise exception 'Sending limit reached for your studio - try again in an hour.' using errcode = 'HL429'; end if;

  v_name := coalesce(nullif(left(regexp_replace(btrim(coalesce(q.client ->> 'name', '')), '\s+', ' ', 'g'), 60), ''), 'there');
  select left(regexp_replace(btrim(coalesce(o.name, '')), '\s+', ' ', 'g'), 60) into v_studio from public.organizations o where o.id = v_org;
  v_studio := coalesce(nullif(v_studio, ''), 'your event planner');
  v_until := to_char(b.expires_at at time zone 'Asia/Kolkata', 'FMDD Mon YYYY');
  v_body := 'Hi ' || v_name || ', here is your event booklet from ' || v_studio || ':';
  v_key := 'booklet:' || b.id || ':' || gen_random_uuid();
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, created_by, status, created_at)
    values (v_org, q.id, 'booklet_link', p_channel, v_to,
            jsonb_build_object('booklet_id', b.id, 'body', v_body, 'client', v_name, 'studio', v_studio,
                               'valid_until', v_until, 'subject', 'Your event booklet from ' || v_studio,
                               'to_is_client', v_client_to),
            v_key, auth.uid(), case when v_reason = 'demo' then 'skipped' else 'pending' end, clock_timestamp())
    on conflict (dedupe_key) do nothing
    returning id, status into v_id, v_status;
  if v_id is null then
    return jsonb_build_object('status', 'already_queued', 'channel', p_channel, 'masked', public._bk200_mask(p_channel, v_to));
  end if;
  if v_status = 'skipped' then
    if v_reason is null then v_reason := 'not_sent'; end if;
    update public.comms_outbox set sent_at = now() where id = v_id and sent_at is null;   -- finished (never handed out)
  end if;

  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'booklet.link_sent', 'client_booklets', b.id::text, q.id,
            jsonb_build_object('channel', p_channel, 'to', public._bk200_mask(p_channel, v_to),
                               'status', case when v_status = 'skipped' then 'skipped' else 'queued' end,
                               'reason', v_reason, 'to_is_client', v_client_to), v_org);
  if v_status = 'skipped' then
    insert into public.notifications(quote_id, channel, recipient, kind, status, detail, org_id)
      values (q.id, p_channel, v_to, 'booklet_link', 'suppressed',
              jsonb_build_object('via', 'booklet_send', 'skipped', v_reason, 'outbox_id', v_id), v_org);
  end if;
  return jsonb_build_object('status', case when v_status = 'skipped' then 'skipped' else 'queued' end,
                            'reason', v_reason, 'channel', p_channel, 'masked', public._bk200_mask(p_channel, v_to), 'id', v_id);
end $$;

-- ---- 2) studio: what was sent for this booklet -----------------------------------------------------------
create or replace function public.booklet_send_log(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-send-0200
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('quotes', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('at', x.created_at, 'channel', x.channel, 'to', public._bk200_mask(x.channel, x.recipient),
                                        'status', case when x.status = 'pending' then 'queued' else x.status end,
                                        'sent_at', x.sent_at) order by x.created_at desc, x.id)
      from (select c.* from public.comms_outbox c
             where c.org_id = v_org and c.purpose = 'booklet_link' and c.quote_id = p_quote
             order by c.created_at desc limit 10) x), '[]'::jsonb);
end $$;

-- ---- 3) dispatcher claim: booklet rows first (re-checked), then the previous claim -----------------------
do $$ begin
  if to_regprocedure('public.comms_outbox_claim__pre0200(integer)') is null then
    alter function public.comms_outbox_claim(integer) rename to comms_outbox_claim__pre0200;
  end if;
end $$;

create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-send-0200: 'booklet_link' rows (re-checked here, link path added), then the previous claim for the rest
declare r record; v_lim integer := greatest(1, least(coalesce(p_limit, 25), 100)); v_n integer := 0; v_out jsonb := '[]'::jsonb;
        v_ok boolean; v_live record; v_cfg jsonb; v_path text;
begin
  update public.comms_outbox set status = 'failed', sent_at = now()
   where purpose = 'booklet_link' and sent_at is null and attempts >= 5;
  update public.comms_outbox set status = 'skipped', sent_at = now()
   where purpose = 'booklet_link' and sent_at is null and created_at < now() - interval '3 days';
  for r in select c.* from public.comms_outbox c
     where c.purpose = 'booklet_link' and c.sent_at is null and c.status = 'pending'
       and (c.claimed_at is null or c.claimed_at < now() - interval '10 minutes')
     order by c.created_at limit v_lim for update skip locked
  loop
    v_path := null;
    select l.id, l.org_id into v_live from public._bk200_live(r.quote_id) l;
    v_ok := v_live.id is not null and v_live.id::text = (r.payload ->> 'booklet_id') and v_live.org_id = r.org_id
            and public._comms_quote_live(r.quote_id)
            and not coalesce((select q.is_demo from public.quotes q where q.id = r.quote_id), false)
            and not public._sample_outbound_blocked(r.org_id, r.recipient);
    if v_ok then v_path := public._bk200_link_path(v_live.id); v_ok := v_path is not null; end if;
    if v_ok and r.channel = 'whatsapp' then
      v_cfg := public._comms_cfg(r.org_id);
      v_ok := coalesce(v_cfg ->> 'studio_whatsapp', '') ~ '^[0-9]{8,15}$' and not public._wa_opted_out(r.recipient, r.org_id);
    end if;
    if not coalesce(v_ok, false) then
      update public.comms_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.comms_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'purpose', r.purpose, 'channel', r.channel,
      'to', r.recipient, 'payload', r.payload || jsonb_build_object('link_path', v_path)));
    v_n := v_n + 1;
  end loop;
  if v_n < v_lim then
    v_out := v_out || coalesce(public.comms_outbox_claim__pre0200(v_lim - v_n), '[]'::jsonb);
  end if;
  return v_out;
end $$;

-- ---- 5) activity row when a booklet send is finished ------------------------------------------------------
create or replace function public._bk200_tg_outbox_done()
returns trigger language plpgsql security definer set search_path = '' as $$
-- booklet-send-0200
begin
  -- only rows that were queued (a row stored as skipped at send time is logged by booklet_send)
  if new.purpose = 'booklet_link' and old.status = 'pending' and old.sent_at is null and new.sent_at is not null
     and new.status in ('sent', 'failed', 'skipped') and new.quote_id is not null then
    begin
      insert into public.notifications(quote_id, channel, recipient, kind, status, detail, org_id)
        values (new.quote_id, new.channel, new.recipient, 'booklet_link',
                case new.status when 'sent' then 'sent' when 'failed' then 'failed' else 'suppressed' end,
                jsonb_build_object('via', 'booklet_send', 'outbox_id', new.id), new.org_id);
    exception when others then raise warning 'booklet-send-0200: activity row skipped (%)', sqlstate;
    end;
  end if;
  return null;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.comms_outbox'::regclass and tgname = 'zzzz_bk200_done') then
    create trigger zzzz_bk200_done after update of status, sent_at on public.comms_outbox
      for each row execute function public._bk200_tg_outbox_done();
  end if;
end $$;

-- ---- privileges ------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._bk200_live(uuid)', 'public._bk200_link_path(uuid)', 'public._bk200_mask(text, text)',
                           'public._bk200_tg_outbox_done()',
                           'public.comms_outbox_claim(integer)', 'public.comms_outbox_claim__pre0200(integer)',
                           'public.booklet_send(uuid, text, text, boolean, text)', 'public.booklet_send_log(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.booklet_send(uuid, text, text, boolean, text) to authenticated;
    grant execute on function public.booklet_send_log(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.comms_outbox_claim(integer) to service_role;
    grant execute on function public.comms_outbox_claim__pre0200(integer) to service_role;
  end if;
end $$;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 booklet_send + log exist, app (signed-in) only',
      to_regprocedure('public.booklet_send(uuid,text,text,boolean,text)') is not null
      and has_function_privilege('authenticated', 'public.booklet_send(uuid,text,text,boolean,text)', 'execute')
      and not has_function_privilege('anon', 'public.booklet_send(uuid,text,text,boolean,text)', 'execute')
      and has_function_privilege('authenticated', 'public.booklet_send_log(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.booklet_send_log(uuid)', 'execute')),
  ('02 send needs a live link + uses the trial outbound guard + STOP + caps',
      position('_bk200_live' in pg_get_functiondef('public.booklet_send(uuid,text,text,boolean,text)'::regprocedure)) > 0
      and position('_sample_outbound_blocked' in pg_get_functiondef('public.booklet_send(uuid,text,text,boolean,text)'::regprocedure)) > 0
      and position('_wa_opted_out' in pg_get_functiondef('public.booklet_send(uuid,text,text,boolean,text)'::regprocedure)) > 0
      and position('HL429' in pg_get_functiondef('public.booklet_send(uuid,text,text,boolean,text)'::regprocedure)) > 0),
  ('03 trial outbox skip trigger still on comms_outbox (0166)',
      exists (select 1 from pg_trigger where tgrelid = 'public.comms_outbox'::regclass and tgname = 'zzzz_ts166_outbox_skip')),
  ('04 claim wrapper: booklet rows re-checked, previous claims kept (service role only)',
      to_regprocedure('public.comms_outbox_claim__pre0200(integer)') is not null
      and position('comms_outbox_claim__pre0200' in pg_get_functiondef('public.comms_outbox_claim(integer)'::regprocedure)) > 0
      and (to_regprocedure('public.comms_outbox_claim__pre0195(integer)') is null
           or position('comms_outbox_claim__pre0195' in pg_get_functiondef('public.comms_outbox_claim__pre0200(integer)'::regprocedure)) > 0)
      and has_function_privilege('service_role', 'public.comms_outbox_claim(integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.comms_outbox_claim__pre0200(integer)', 'execute')),
  ('05 purpose CHECK keeps pay_reminder / follow_up / wa_forward (+ invite_site if 0195) and adds booklet_link',
      (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check') ~ 'booklet_link'
      and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check') ~ 'follow_up'
      and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check') ~ 'pay_reminder'
      and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check') ~ 'wa_forward'
      and (to_regprocedure('public.event_site_send(uuid,text,text,boolean,text)') is null
           or (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check') ~ 'invite_site')),
  ('06 activity trigger present', exists (select 1 from pg_trigger where tgrelid = 'public.comms_outbox'::regclass and tgname = 'zzzz_bk200_done')),
  ('07 internal helpers not callable by the app', not has_function_privilege('authenticated', 'public._bk200_link_path(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._bk200_live(uuid)', 'execute')
      and not has_function_privilege('anon', 'public._bk200_mask(text,text)', 'execute')),
  ('08 no booklet token stored in the outbox', not exists (select 1 from public.comms_outbox c where c.purpose = 'booklet_link' and c.payload ? 'link_path')),
  ('09 no trial studio has a sendable booklet row', not exists (select 1 from public.comms_outbox c where c.purpose = 'booklet_link'
      and c.status = 'pending' and public._is_trial_org(c.org_id)))
) v(item, ok) order by item;
