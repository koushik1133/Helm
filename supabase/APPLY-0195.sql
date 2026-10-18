-- APPLY-0195.sql - paste into the Supabase SQL editor (staging first, then production).
-- Additive + idempotent: invitation website "Send to client" (queued e-mail / WhatsApp; free trial = skipped, nothing sent). Safe to run twice.
begin;
-- 0195_invite_site_share.sql - CANONICAL forward-only. REQUIRES phase87 (event_sites), 0078 (comms_outbox,
-- _comms_cfg, _comms_quote_live), 0151 (wa_proposal_optins, _wa151_e164), 0155 (_wa_opted_out, claim wrapper),
-- 0166 (_sample_outbound_blocked + the trial outbox skip trigger on comms_outbox).
--
-- In plain words: "Send to client" on the Invitation Studio.
--   1) event_site_send(site, channel, to, opt_in, consent_text): the studio (quotes EDIT, own studio) sends the
--      PUBLISHED invitation website link to the client by e-mail or WhatsApp. The message is fixed text built
--      here ("Hi <client>, here is your invitation website:" + the link); the studio only picks the channel
--      and the address (pre-filled from the quote, editable). It is QUEUED in comms_outbox (purpose
--      'invite_site') and sent by comms-dispatch like payment reminders. Rules:
--        * the site must be published and its link still open; the event not cancelled / closed
--        * WhatsApp: the client's opt-in must be on record for that number (the tick is stored in
--          wa_proposal_optins with who / when), a number that replied STOP is refused, and the studio
--          must have its WhatsApp number set up (Messages settings)
--        * caps: 10 sends per invitation per day, 5 different recipients per invitation per day,
--          60 per studio per hour
--        * FREE TRIAL / sample studio / demo event: nothing is sent - the row is stored as 'skipped'
--          (the 0166 trigger does this for a trial studio on every comms_outbox insert; demo events are
--          skipped here) and the answer says { status: 'skipped', reason: 'free_trial' | 'demo' }
--      Log: audit_log 'event_site.link_sent' (masked address) + the quote's activity (notifications).
--   2) event_site_send_log(site): the last 10 sends of this invitation (masked address, status).
--   3) comms_outbox_claim: wrapper (the previous one is kept as comms_outbox_claim__pre0195) that first
--      hands out 'invite_site' rows after re-checking them (still published, same link, event live, not a
--      trial, WhatsApp: STOP + studio number), then the previous claim for everything else.
--   4) comms_outbox purpose check widened with 'invite_site' (every existing value kept).
--   5) AFTER UPDATE trigger: when an 'invite_site' row is finally sent / failed / skipped, one activity row.
--   The link itself is never stored as a URL: the row carries the path (i/<slug> or <studio>/invite/<slug>)
--   and comms-dispatch joins it to its own APP_URL. A dispatcher that does not know 'invite_site' yet finds
--   no text and marks the row skipped (fails closed - nothing half-written is sent).
-- Additive + idempotent: 3 new functions, 1 wrapper (original kept), 1 trigger, 1 CHECK widened. No row is
-- changed or deleted. Safe to run twice. ASCII only.

do $$ begin
  if to_regclass('public.event_sites') is null or to_regclass('public.comms_outbox') is null
     or to_regclass('public.wa_proposal_optins') is null then
    raise exception '0195: apply phase87 + 0078 + 0151 first'; end if;
  if to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null or to_regprocedure('public._wa_opted_out(text,uuid)') is null
     or to_regprocedure('public._wa151_e164(text,text)') is null or to_regprocedure('public._comms_cfg(uuid)') is null
     or to_regprocedure('public._comms_quote_live(uuid)') is null or to_regprocedure('public.comms_outbox_claim(integer)') is null
     or to_regprocedure('public.event_site_live_until(uuid)') is null or to_regprocedure('public._comms_country(uuid)') is null
     or to_regclass('public.audit_log') is null or to_regclass('public.notifications') is null then
    raise exception '0195: apply 0022 + 0078 + 0151 + 0155 + 0166 first'; end if;
end $$;

-- ---- 4) purpose check: keep every existing value, add 'invite_site' -----------------------------------
do $$
declare c record; v_vals text[]; v_list text;
begin
  select con.conname, pg_get_constraintdef(con.oid) as def into c
    from pg_constraint con
   where con.conrelid = 'public.comms_outbox'::regclass and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%purpose%' and pg_get_constraintdef(con.oid) like '%pay_reminder%'
   order by con.conname limit 1;
  if c.conname is not null and position('invite_site' in c.def) > 0 then return; end if;
  if c.conname is not null then
    select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(c.def, '''([a-z_]+)''', 'g') m;
  end if;
  v_vals := coalesce(v_vals, array['follow_up', 'pay_reminder', 'wa_forward']::text[]);
  if not ('invite_site' = any (v_vals)) then v_vals := v_vals || 'invite_site'::text; end if;
  select string_agg(quote_literal(x), ', ' order by x) into v_list from unnest(v_vals) x;
  if c.conname is not null then execute format('alter table public.comms_outbox drop constraint %I', c.conname); end if;
  execute format('alter table public.comms_outbox add constraint comms_outbox_purpose_check check (purpose in (%s))', v_list);
end $$;

create index if not exists comms_outbox_invite_site_idx195 on public.comms_outbox ((payload ->> 'site_id'), created_at)
  where purpose = 'invite_site';

-- ---- helpers (internal) --------------------------------------------------------------------------------
-- the public path of a site's link (same rule as the app: /<studio link name>/invite/<slug>, else /i/<slug>)
create or replace function public._is195_link_path(p_site uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- invite-share-0195
  select case when s.slug is null or s.slug !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$' then null
              when coalesce(o.public_slug, '') ~ '^[a-z0-9-]{3,40}$' then o.public_slug || '/invite/' || s.slug
              else 'i/' || s.slug end
    from public.event_sites s left join public.organizations o on o.id = s.org_id
   where s.id = p_site;
$$;

create or replace function public._is195_mask(p_channel text, p_to text)
returns text language sql immutable set search_path = '' as $$
  -- invite-share-0195: a***@b.com / +91******3210
  select case when p_channel = 'email' and position('@' in coalesce(p_to, '')) > 1
              then left(p_to, 1) || '***' || substr(p_to, position('@' in p_to))
              when p_channel = 'whatsapp' and length(coalesce(p_to, '')) >= 6
              then '+' || left(p_to, 2) || repeat('*', greatest(length(p_to) - 6, 0)) || right(p_to, 4)
              else '***' end;
$$;

-- ---- 1) studio: send the invitation link -------------------------------------------------------------
create or replace function public.event_site_send(p_site uuid, p_channel text, p_to text,
                                                  p_opt_in boolean default false, p_consent_text text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- invite-share-0195
declare
  v_org uuid := public.current_org_id(); s record; q record; v_to text; v_e164 text; v_dial text; v_path text;
  v_until timestamptz; v_cfg jsonb; v_blocked boolean; v_reason text; v_opt boolean; v_name text; v_studio text;
  v_body text; v_id uuid; v_status text; v_n integer; v_key text; v_client_to boolean;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('quotes', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_channel is null or p_channel not in ('email', 'whatsapp') then
    raise exception 'choose Email or WhatsApp' using errcode = '22023'; end if;
  select x.id, x.org_id, x.quote_id, x.status, x.slug into s from public.event_sites x where x.id = p_site and x.org_id = v_org;
  if s.id is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if s.status is distinct from 'published' then
    raise exception 'Publish the invitation first, then send it.' using errcode = 'P0001', hint = 'not_published'; end if;
  select x.id, x.org_id, x.client, x.is_demo, x.tax_snapshot into q from public.quotes x where x.id = s.quote_id and x.org_id = v_org;
  if q.id is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._comms_quote_live(q.id) then
    raise exception 'This event is closed or cancelled - nothing can be sent for it.' using errcode = 'P0001', hint = 'event_closed'; end if;
  v_until := public.event_site_live_until(s.id);
  if v_until is not null and v_until <= now() then
    raise exception 'This invitation has ended - change the event date to reopen it first.' using errcode = 'P0001', hint = 'site_ended'; end if;
  v_path := public._is195_link_path(s.id);
  if v_path is null then raise exception 'Publish the invitation first, then send it.' using errcode = 'P0001', hint = 'not_published'; end if;

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
        values (v_org, q.id, v_e164, true, p_consent_text, 'invite_site_send', auth.uid());
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
  perform pg_advisory_xact_lock(hashtextextended('helm:invite-send:' || s.id::text, 0));
  if exists (select 1 from public.comms_outbox c
              where c.purpose = 'invite_site' and c.payload ->> 'site_id' = s.id::text and c.channel = p_channel
                and c.recipient = v_to and c.created_at > now() - interval '2 minutes') then
    return jsonb_build_object('status', 'already_queued', 'channel', p_channel, 'masked', public._is195_mask(p_channel, v_to));
  end if;
  -- caps (counted on every row, skipped ones too, so a trial cannot loop either)
  select count(*) into v_n from public.comms_outbox c
   where c.purpose = 'invite_site' and c.payload ->> 'site_id' = s.id::text and c.created_at > now() - interval '1 day';
  if v_n >= 10 then raise exception 'This invitation was sent 10 times today - try again tomorrow.' using errcode = 'HL429'; end if;
  select count(distinct c.recipient) into v_n from public.comms_outbox c
   where c.purpose = 'invite_site' and c.payload ->> 'site_id' = s.id::text and c.created_at > now() - interval '1 day'
     and c.recipient <> v_to;
  if v_n >= 5 then raise exception 'This invitation went to 5 different people today - try again tomorrow.' using errcode = 'HL429'; end if;
  select count(*) into v_n from public.comms_outbox c
   where c.org_id = v_org and c.purpose = 'invite_site' and c.created_at > now() - interval '1 hour';
  if v_n >= 60 then raise exception 'Sending limit reached for your studio - try again in an hour.' using errcode = 'HL429'; end if;

  v_name := coalesce(nullif(left(regexp_replace(btrim(coalesce(q.client ->> 'name', '')), '\s+', ' ', 'g'), 60), ''), 'there');
  select left(o.name, 60) into v_studio from public.organizations o where o.id = v_org;
  v_body := 'Hi ' || v_name || ', here is your invitation website:';
  v_key := 'invite:' || s.id || ':' || gen_random_uuid();
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, created_by, status, created_at)
    values (v_org, q.id, 'invite_site', p_channel, v_to,
            jsonb_build_object('site_id', s.id, 'link_path', v_path, 'body', v_body, 'client', v_name,
                               'studio', coalesce(v_studio, ''), 'subject', 'Your invitation website from ' || coalesce(nullif(v_studio, ''), 'your planner'),
                               'to_is_client', v_client_to),
            v_key, auth.uid(), case when v_reason = 'demo' then 'skipped' else 'pending' end, clock_timestamp())
    on conflict (dedupe_key) do nothing
    returning id, status into v_id, v_status;
  if v_id is null then
    return jsonb_build_object('status', 'already_queued', 'channel', p_channel, 'masked', public._is195_mask(p_channel, v_to));
  end if;
  if v_status = 'skipped' then
    if v_reason is null then v_reason := 'not_sent'; end if;
    update public.comms_outbox set sent_at = now() where id = v_id and sent_at is null;   -- finished (never handed out)
  end if;

  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'event_site.link_sent', 'event_sites', s.id::text, q.id,
            jsonb_build_object('channel', p_channel, 'to', public._is195_mask(p_channel, v_to),
                               'status', case when v_status = 'skipped' then 'skipped' else 'queued' end,
                               'reason', v_reason, 'to_is_client', v_client_to), v_org);
  if v_status = 'skipped' then
    insert into public.notifications(quote_id, channel, recipient, kind, status, detail, org_id)
      values (q.id, p_channel, v_to, 'invite_site_link', 'suppressed',
              jsonb_build_object('via', 'invite_site', 'skipped', v_reason, 'outbox_id', v_id), v_org);
  end if;
  return jsonb_build_object('status', case when v_status = 'skipped' then 'skipped' else 'queued' end,
                            'reason', v_reason, 'channel', p_channel, 'masked', public._is195_mask(p_channel, v_to), 'id', v_id);
end $$;

-- ---- 2) studio: what was sent for this invitation ------------------------------------------------------
create or replace function public.event_site_send_log(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- invite-share-0195
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('quotes', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.event_sites s where s.id = p_site and s.org_id = v_org) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('at', x.created_at, 'channel', x.channel, 'to', public._is195_mask(x.channel, x.recipient),
                                        'status', case when x.status = 'pending' then 'queued' else x.status end,
                                        'sent_at', x.sent_at) order by x.created_at desc, x.id)
      from (select c.* from public.comms_outbox c
             where c.org_id = v_org and c.purpose = 'invite_site' and c.payload ->> 'site_id' = p_site::text
             order by c.created_at desc limit 10) x), '[]'::jsonb);
end $$;

-- ---- 3) dispatcher claim: invitation rows first (re-checked), then the previous claim ------------------
do $$ begin
  if to_regprocedure('public.comms_outbox_claim__pre0195(integer)') is null then
    alter function public.comms_outbox_claim(integer) rename to comms_outbox_claim__pre0195;
  end if;
end $$;

create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- invite-share-0195: 'invite_site' rows (re-checked here), then the previous claim (0155 -> 0092) for the rest
declare r record; v_lim integer := greatest(1, least(coalesce(p_limit, 25), 100)); v_n integer := 0; v_out jsonb := '[]'::jsonb;
        v_ok boolean; v_site record; v_cfg jsonb;
begin
  update public.comms_outbox set status = 'failed', sent_at = now()
   where purpose = 'invite_site' and sent_at is null and attempts >= 5;
  update public.comms_outbox set status = 'skipped', sent_at = now()
   where purpose = 'invite_site' and sent_at is null and created_at < now() - interval '3 days';
  for r in select c.* from public.comms_outbox c
     where c.purpose = 'invite_site' and c.sent_at is null and c.status = 'pending'
       and (c.claimed_at is null or c.claimed_at < now() - interval '10 minutes')
     order by c.created_at limit v_lim for update skip locked
  loop
    select s.id, s.org_id, s.status into v_site from public.event_sites s where s.id::text = r.payload ->> 'site_id';
    v_ok := v_site.id is not null and v_site.org_id = r.org_id and v_site.status = 'published'
            and public._is195_link_path(v_site.id) is not distinct from (r.payload ->> 'link_path')
            and coalesce(public.event_site_live_until(v_site.id) > now(), true)
            and public._comms_quote_live(r.quote_id)
            and not coalesce((select q.is_demo from public.quotes q where q.id = r.quote_id), false)
            and not public._sample_outbound_blocked(r.org_id, r.recipient);
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
      'to', r.recipient, 'payload', r.payload));
    v_n := v_n + 1;
  end loop;
  if v_n < v_lim then
    v_out := v_out || coalesce(public.comms_outbox_claim__pre0195(v_lim - v_n), '[]'::jsonb);
  end if;
  return v_out;
end $$;

-- ---- 5) activity row when an invitation send is finished -----------------------------------------------
create or replace function public._is195_tg_outbox_done()
returns trigger language plpgsql security definer set search_path = '' as $$
-- invite-share-0195
begin
  -- only rows that were queued (a row stored as skipped at send time is logged by event_site_send)
  if new.purpose = 'invite_site' and old.status = 'pending' and old.sent_at is null and new.sent_at is not null
     and new.status in ('sent', 'failed', 'skipped') and new.quote_id is not null then
    begin
      insert into public.notifications(quote_id, channel, recipient, kind, status, detail, org_id)
        values (new.quote_id, new.channel, new.recipient, 'invite_site_link',
                case new.status when 'sent' then 'sent' when 'failed' then 'failed' else 'suppressed' end,
                jsonb_build_object('via', 'invite_site', 'outbox_id', new.id), new.org_id);
    exception when others then raise warning 'invite-share-0195: activity row skipped (%)', sqlstate;
    end;
  end if;
  return null;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.comms_outbox'::regclass and tgname = 'zzzz_is195_done') then
    create trigger zzzz_is195_done after update of status, sent_at on public.comms_outbox
      for each row execute function public._is195_tg_outbox_done();
  end if;
end $$;

-- ---- privileges ------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._is195_link_path(uuid)', 'public._is195_mask(text, text)', 'public._is195_tg_outbox_done()',
                           'public.comms_outbox_claim(integer)', 'public.comms_outbox_claim__pre0195(integer)',
                           'public.event_site_send(uuid, text, text, boolean, text)', 'public.event_site_send_log(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.event_site_send(uuid, text, text, boolean, text) to authenticated;
    grant execute on function public.event_site_send_log(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.comms_outbox_claim(integer) to service_role;
    grant execute on function public.comms_outbox_claim__pre0195(integer) to service_role;
  end if;
end $$;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 event_site_send + log exist, app (signed-in) only',
      to_regprocedure('public.event_site_send(uuid,text,text,boolean,text)') is not null
      and has_function_privilege('authenticated', 'public.event_site_send(uuid,text,text,boolean,text)', 'execute')
      and not has_function_privilege('anon', 'public.event_site_send(uuid,text,text,boolean,text)', 'execute')
      and has_function_privilege('authenticated', 'public.event_site_send_log(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.event_site_send_log(uuid)', 'execute')),
  ('02 send refuses unpublished + uses the trial outbound guard + STOP + caps',
      position('''published''' in pg_get_functiondef('public.event_site_send(uuid,text,text,boolean,text)'::regprocedure)) > 0
      and position('_sample_outbound_blocked' in pg_get_functiondef('public.event_site_send(uuid,text,text,boolean,text)'::regprocedure)) > 0
      and position('_wa_opted_out' in pg_get_functiondef('public.event_site_send(uuid,text,text,boolean,text)'::regprocedure)) > 0
      and position('HL429' in pg_get_functiondef('public.event_site_send(uuid,text,text,boolean,text)'::regprocedure)) > 0),
  ('03 trial outbox skip trigger still on comms_outbox (0166)',
      exists (select 1 from pg_trigger where tgrelid = 'public.comms_outbox'::regclass and tgname = 'zzzz_ts166_outbox_skip')),
  ('04 claim wrapper: invite rows re-checked, previous claim kept (service role only)',
      to_regprocedure('public.comms_outbox_claim__pre0195(integer)') is not null
      -- (after APPLY-0200 the 0195 wrapper sits one level down, as comms_outbox_claim__pre0200)
      and (position('comms_outbox_claim__pre0195' in pg_get_functiondef('public.comms_outbox_claim(integer)'::regprocedure)) > 0
           or position('comms_outbox_claim__pre0195' in coalesce(pg_get_functiondef(to_regprocedure('public.comms_outbox_claim__pre0200(integer)')), '')) > 0)
      and has_function_privilege('service_role', 'public.comms_outbox_claim(integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.comms_outbox_claim__pre0195(integer)', 'execute')),
  ('05 purpose CHECK keeps pay_reminder / follow_up / wa_forward and adds invite_site',
      (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check')
        ~ 'follow_up' and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check') ~ 'invite_site'
      and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check') ~ 'pay_reminder'
      and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.comms_outbox'::regclass and c.conname = 'comms_outbox_purpose_check') ~ 'wa_forward'),
  ('06 activity trigger present', exists (select 1 from pg_trigger where tgrelid = 'public.comms_outbox'::regclass and tgname = 'zzzz_is195_done')),
  ('07 internal helpers not callable by the app', not has_function_privilege('authenticated', 'public._is195_link_path(uuid)', 'execute')
      and not has_function_privilege('anon', 'public._is195_mask(text,text)', 'execute')),
  ('08 no trial studio has a sendable invite row', not exists (select 1 from public.comms_outbox c where c.purpose = 'invite_site'
      and c.status = 'pending' and public._is_trial_org(c.org_id)))
) v(item, ok) order by item;
