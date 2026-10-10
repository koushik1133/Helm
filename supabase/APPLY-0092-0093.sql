-- APPLY-0092-0093.sql - paste into the Supabase SQL editor (prod or staging). ASCII only, idempotent,
-- safe to paste twice. Contains, in order:
--   0092 country-aware client reminders/follow-ups (create or replace only; needs 0078, 0082, 0089)
--   0093 UAE / USA client approval OTP numbers (OTP functions renamed once + wrapped; needs 0042, 0092)
-- No table or row is touched. Ends with 15 verify rows (item, ok) - every ok must be true.

-- ===================== 0092 =====================
begin;

do $$ begin
  if to_regprocedure('public._comms_queue_pay(uuid, text, text, boolean, uuid)') is null then
    raise exception '0092: apply 0078_comms_automation.sql first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'country') then
    raise exception '0092: apply 0089_country_tax.sql first (organizations.country missing)';
  end if;
end $$;

-- the studio's country: IN (default) / AE / US
create or replace function public._comms_country(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select case upper(coalesce(o.country, '')) when 'AE' then 'AE' when 'US' then 'US' else 'IN' end
                     from public.organizations o where o.id = p_org), 'IN');
$$;

-- digits with country code, using the studio's dial code for numbers typed without one.
-- dial 91 (India) = exactly helm_norm_phone (unchanged behaviour).
create or replace function public.helm_norm_phone_cc(p text, p_dial text)
returns text language sql immutable set search_path = '' as $$
  select case
    when coalesce(p_dial, '91') = '91' then public.helm_norm_phone(d)
    when d ~ '^00[0-9]{8,15}$' then substr(d, 3)
    when p_dial = '1' and d ~ '^1[0-9]{10}$' then d
    when p_dial = '1' and d ~ '^[0-9]{10}$' then '1' || d
    when p_dial = '971' and d ~ '^971[0-9]{8,9}$' then d
    when p_dial = '971' and d ~ '^0[0-9]{8,9}$' then '971' || substr(d, 2)
    when p_dial = '971' and d ~ '^[0-9]{8,9}$' then '971' || d
    else d end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x;
$$;

-- a client address for a channel, or null - WhatsApp numbers get the studio's country code
create or replace function public._comms_client_to(p_client jsonb, p_channel text, p_org uuid)
returns text language plpgsql stable set search_path = '' as $$
declare v text; v_dial text;
begin
  if p_channel = 'whatsapp' then
    v_dial := case public._comms_country(p_org) when 'AE' then '971' when 'US' then '1' else '91' end;
    v := public.helm_norm_phone_cc(regexp_replace(coalesce(p_client ->> 'phone', ''), '[^0-9]', '', 'g'), v_dial);
    if v ~ '^[0-9]{8,15}$' then return v; end if;
    return null;
  end if;
  return public._comms_client_to(p_client, p_channel);
end $$;

-- the quote's own currency (snapshot), else the studio's country currency
create or replace function public._comms_quote_cur(p_quote uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select coalesce(case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) end,
                     case when upper(coalesce(q.tax_snapshot ->> 'currency', '')) ~ '^[A-Z]{3}$' then upper(q.tax_snapshot ->> 'currency') end,
                     case public._comms_country(q.org_id) when 'AE' then 'AED' when 'US' then 'USD' else 'INR' end)
       from public.quotes q where q.id = p_quote), 'INR');
$$;

-- money in a currency: INR exactly as 0078 ("Rs. 1,234"); AED / USD / other ISO codes
create or replace function public._comms_money(p numeric, p_cur text)
returns text language sql immutable set search_path = '' as $$
  select case
    when coalesce(upper(p_cur), 'INR') = 'INR' or upper(p_cur) !~ '^[A-Z]{3}$' then public._comms_money(p)
    when upper(p_cur) = 'USD' then '$' || to_char(round(coalesce(p, 0), 2), 'FM999,999,999,990.00')
    else upper(p_cur) || ' ' || to_char(round(coalesce(p, 0), 2), 'FM999,999,999,990.00') end;
$$;

-- a due date the studio's clients read naturally: 12 Oct 2026 (IN / AE) or Oct 12, 2026 (US)
create or replace function public._comms_date(p date, p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when p is null then null
              when public._comms_country(p_org) = 'US' then to_char(p, 'Mon FMDD, YYYY')
              else to_char(p, 'DD Mon YYYY') end;
$$;

-- ---- callers: same bodies as 0078 / 0082, with the country-aware helpers ----------------------
create or replace function public._comms_queue_pay(p_milestone uuid, p_stage text, p_status_text text, p_manual boolean, p_actor uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare m public.payment_milestones; q public.quotes; v_cfg jsonb; ch text; v_to text; v_text text; v_n integer := 0; v_rows integer;
  v_studio text; v_key text;
begin
  select * into m from public.payment_milestones x where x.id = p_milestone;
  if m.id is null or m.status not in ('due', 'invoiced') or coalesce(m.amount, 0) <= 0 then return 0; end if;
  select * into q from public.quotes x where x.id = m.quote_id;
  if q.id is null or q.org_id is distinct from m.org_id or not public._comms_quote_live(q.id) then return 0; end if;
  v_cfg := public._comms_cfg(q.org_id);
  select o.name into v_studio from public.organizations o where o.id = q.org_id;
  v_text := public._comms_render(v_cfg ->> 'pay_template', jsonb_build_object(
    'client', coalesce(nullif(btrim(q.client ->> 'name'), ''), 'there'), 'studio', coalesce(v_studio, 'your planner'),
    'event', coalesce(nullif(btrim(q.title), ''), 'your event'), 'label', m.label, 'amount', public._comms_money(m.amount, public._comms_quote_cur(q.id)),
    'due', coalesce(public._comms_date(m.due_date, q.org_id), 'soon'), 'status', p_status_text));
  foreach ch in array public._comms_channels(v_cfg, 'pay_channels') loop
    v_to := public._comms_client_to(q.client, ch, q.org_id);
    if v_to is null then continue; end if;
    v_key := case when p_manual then 'pay:now:' || m.id || ':' || ch || ':' || floor(extract(epoch from now()) / 600)::bigint
                  else 'pay:' || m.id || ':' || p_stage || ':' || ch end;
    insert into public.comms_outbox(org_id, quote_id, milestone_id, purpose, channel, recipient, payload, dedupe_key, created_by)
      values (q.org_id, q.id, m.id, 'pay_reminder', ch, v_to,
              jsonb_build_object('subject', 'Payment reminder - ' || coalesce(nullif(btrim(q.title), ''), 'your event'),
                                 'text', v_text, 'stage', p_stage, 'manual', p_manual, 'studio', v_studio),
              v_key, p_actor)
      on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  return v_n;
end $$;

create or replace function public.comms_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare o record; v_cfg jsonb; v_today date; m record; d integer; v_stage text; v_txt text; n integer;
  v_pay integer := 0; v_fu integer := 0; v_low integer := 0; f record; v_ch text; v_to text; v_text text; v_key text; v_rows integer;
begin
  -- comms-tick-0078: service role / pg_cron only (EXECUTE is granted to service_role alone)
  for o in select org.id, org.name, coalesce(org.timezone, 'Asia/Kolkata') as tz from public.organizations org loop
    begin
      v_cfg := public._comms_cfg(o.id);
      begin v_today := (now() at time zone o.tz)::date; exception when others then v_today := current_date; end;

      -- payment reminders
      if coalesce((v_cfg ->> 'pay_enabled')::boolean, false) then
        for m in
          select pm.id, pm.due_date from public.payment_milestones pm join public.quotes q on q.id = pm.quote_id
           where pm.org_id = o.id and q.org_id = o.id and pm.status in ('due', 'invoiced') and pm.amount > 0 and pm.due_date is not null
             and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled' and coalesce(q.lifecycle_stage, '') <> 'closed'
             and pm.due_date between v_today - 400 and v_today + 30
        loop
          d := m.due_date - v_today; v_stage := null;
          if d > 0 and d <= (v_cfg ->> 'pay_before_days')::int then
            v_stage := 'pre'; v_txt := 'due in ' || d || case when d = 1 then ' day' else ' days' end;
          elsif d = 0 and (v_cfg ->> 'pay_on_due')::boolean then
            v_stage := 'due'; v_txt := 'due today';
          elsif d < 0 then
            n := floor((-d)::numeric / (v_cfg ->> 'pay_every_days')::int)::int;
            if n between 1 and (v_cfg ->> 'pay_max_overdue')::int then
              v_stage := 'od' || n; v_txt := 'overdue by ' || (-d) || case when d = -1 then ' day' else ' days' end;
            end if;
          end if;
          if v_stage is not null then v_pay := v_pay + public._comms_queue_pay(m.id, v_stage, v_txt, false, null); end if;
        end loop;
      end if;

      -- client follow-ups: opened, not approved / declined, no package choice since
      if coalesce((v_cfg ->> 'fu_enabled')::boolean, false) then
        for f in
          select q.id, q.client, q.title, min(lo.first_opened_at) as opened
            from public.quotes q join public.client_link_opens lo on lo.quote_id = q.id
           where q.org_id = o.id and q.deleted_at is null and q.archived_at is null
             and q.status not in ('cancelled', 'confirmed') and coalesce(q.lifecycle_stage, '') <> 'closed'
             and coalesce(q.approval_status, 'none') not in ('approved', 'paid', 'cancelled')
           group by q.id, q.client, q.title
        loop
          if exists (select 1 from public.package_selections s where s.quote_id = f.id and s.created_at >= f.opened) then continue; end if;
          n := floor(extract(epoch from (now() - f.opened)) / 86400 / (v_cfg ->> 'fu_delay_days')::int)::int;
          if n < 1 or n > (v_cfg ->> 'fu_max')::int then continue; end if;
          v_text := public._comms_render(v_cfg ->> 'fu_template', jsonb_build_object(
            'client', coalesce(nullif(btrim(f.client ->> 'name'), ''), 'there'), 'studio', coalesce(o.name, 'your planner'),
            'event', coalesce(nullif(btrim(f.title), ''), 'your event')));
          foreach v_ch in array public._comms_channels(v_cfg, 'fu_channels') loop
            v_to := public._comms_client_to(f.client, v_ch, o.id);
            if v_to is null then continue; end if;
            v_key := 'fu:' || f.id || ':' || n || ':' || v_ch;
            insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key)
              values (o.id, f.id, 'follow_up', v_ch, v_to, jsonb_build_object('subject', 'Following up - '
                      || coalesce(nullif(btrim(f.title), ''), 'your event'), 'text', v_text, 'stage', 'fu' || n, 'studio', o.name), v_key)
              on conflict (dedupe_key) do nothing;
            get diagnostics v_rows = row_count;
            v_fu := v_fu + v_rows;
          end loop;
        end loop;
      end if;

      if coalesce((v_cfg ->> 'low_stock_enabled')::boolean, true) then v_low := v_low + public._comms_low_stock(o.id); end if;
    exception when others then raise warning 'comms-0078: studio tick skipped (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('pay_reminders', v_pay, 'follow_ups', v_fu, 'low_stock', v_low);
end $$;


create or replace function public.payment_reminder_send_now(p_milestone uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); m public.payment_milestones; q public.quotes; v_n integer;
  v_cfg jsonb; v_due text;
begin
  if v_me is null or v_org is null or not (public.has_area('finance', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into m from public.payment_milestones x where x.id = p_milestone and x.org_id = v_org;
  if m.id is null then raise exception 'milestone not found' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = m.quote_id and x.org_id = v_org;
  if q.id is null then raise exception 'milestone not found' using errcode = '42501'; end if;
  if m.status not in ('due', 'invoiced') then raise exception 'this milestone is already settled' using errcode = '22023'; end if;
  if coalesce(m.amount, 0) <= 0 then raise exception 'this milestone has no amount' using errcode = '22023'; end if;
  v_cfg := public._comms_cfg(v_org);
  if cardinality(public._comms_channels(v_cfg, 'pay_channels')) = 0 then
    raise exception 'choose a reminder channel in Control Center first' using errcode = '22023'; end if;
  if not exists (select 1 from unnest(public._comms_channels(v_cfg, 'pay_channels')) c where public._comms_client_to(q.client, c, v_org) is not null) then
    raise exception 'add the client''s e-mail or WhatsApp number to the event first' using errcode = '22023'; end if;
  v_due := case when m.due_date is null then 'due' when m.due_date < current_date then 'overdue' when m.due_date = current_date then 'due today' else 'due soon' end;
  v_n := public._comms_queue_pay(m.id, 'manual', v_due, true, v_me);
  if v_n > 0 then
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, 'payment_reminder.queued', 'payment_milestones', m.id::text, q.id, jsonb_build_object('rows', v_n), v_org);
  end if;
  return jsonb_build_object('queued', v_n, 'already_queued', v_n = 0);
end $$;

create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- comms-claim-r4-0082: recipient + switches re-checked at claim time
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; v_cfg jsonb; v_client jsonb; v_wa text; v_role text;
begin
  update public.comms_outbox set status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  update public.comms_outbox set status = 'skipped', sent_at = now() where sent_at is null and created_at < now() - interval '3 days';
  for r in select c.* from public.comms_outbox c
     where c.sent_at is null and c.status = 'pending' and (c.claimed_at is null or c.claimed_at < now() - interval '10 minutes')
     order by c.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update skip locked
  loop
    v_cfg := public._comms_cfg(r.org_id);
    v_client := null; v_wa := null; v_role := null;
    if r.quote_id is not null then
      select q.client into v_client from public.quotes q where q.id = r.quote_id and q.org_id = r.org_id;
    end if;
    v_ok := case r.purpose
      when 'pay_reminder' then exists (select 1 from public.payment_milestones m where m.id = r.milestone_id and m.org_id = r.org_id and m.status in ('due', 'invoiced'))
                               and public._comms_quote_live(r.quote_id)
                               and (coalesce((r.payload ->> 'manual')::boolean, false) or coalesce((v_cfg ->> 'pay_enabled')::boolean, false))
                               and r.channel = any (public._comms_channels(v_cfg, 'pay_channels'))
                               and public._comms_client_to(v_client, r.channel, r.org_id) is not distinct from r.recipient
      when 'follow_up' then public._comms_quote_live(r.quote_id) and coalesce((v_cfg ->> 'fu_enabled')::boolean, false)
                            and exists (select 1 from public.quotes q where q.id = r.quote_id and q.status <> 'confirmed'
                                          and coalesce(q.approval_status, 'none') not in ('approved', 'paid', 'cancelled'))
                            and r.channel = any (public._comms_channels(v_cfg, 'fu_channels'))
                            and public._comms_client_to(v_client, r.channel, r.org_id) is not distinct from r.recipient
      when 'wa_forward' then coalesce((v_cfg ->> 'wa_forward_enabled')::boolean, false)
                             and exists (select 1 from public.member_wa_optin w join public.profiles p on p.id = w.user_id
                                          where w.user_id = r.user_id and w.opted_in and w.org_id = r.org_id and p.org_id = r.org_id
                                            and coalesce(p.role, 'client') <> 'client')
      else false end;
    if coalesce(v_ok, false) and r.purpose = 'wa_forward' then
      select p.role, regexp_replace(coalesce(nullif(btrim(mp.whatsapp), ''), case when mp.whatsapp_same then nullif(btrim(mp.phone), '') end, ''), '[^0-9]', '', 'g')
        into v_role, v_wa
        from public.profiles p left join public.member_profiles mp on mp.user_id = p.id where p.id = r.user_id;
      v_ok := v_wa is not distinct from r.recipient
              and coalesce((v_cfg -> 'wa_forward_roles' -> v_role) ? (r.payload ->> 'type'), false);
    end if;
    if r.channel = 'whatsapp' and coalesce(v_cfg ->> 'studio_whatsapp', '') !~ '^[0-9]{8,15}$' then v_ok := false; end if;
    if not coalesce(v_ok, false) then
      update public.comms_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.comms_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'purpose', r.purpose, 'channel', r.channel,
      'to', r.recipient, 'payload', r.payload));
  end loop;
  return v_out;
end $$;

-- ---- privileges: the new helpers are internal (callers are SECURITY DEFINER) ------------------
do $$ declare f text; begin
  foreach f in array array[
    'public._comms_country(uuid)', 'public.helm_norm_phone_cc(text, text)', 'public._comms_client_to(jsonb, text, uuid)',
    'public._comms_quote_cur(uuid)', 'public._comms_money(numeric, text)', 'public._comms_date(date, uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

commit;

-- ===================== 0093 =====================
begin;
do $$ begin
  if to_regprocedure('public.helm_norm_phone_cc(text, text)') is null or to_regprocedure('public._comms_country(uuid)') is null then
    raise exception '0093: apply 0092_country_templates.sql first';
  end if;
  if to_regprocedure('public.request_otp(uuid, text)') is null
     or to_regprocedure('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)') is null
     or to_regprocedure('public.otp_send_authorize(uuid, text)') is null then
    raise exception '0093: approval OTP functions missing (apply 0042 first)';
  end if;
end $$;

-- The number to use for this link's OTP. India quotes: exactly what was typed (unchanged).
-- UAE / USA quotes: when the typed number and the number on file are the same number once
-- both carry the quote's country code (+971 / +1), the on-file string is used, so every
-- older check (which reads numbers the Indian way) sees one consistent number.
create or replace function public._otp_canon_phone(p_token uuid, p_phone text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_cc text; v_file text; v_dial text; v_to text;
begin
  select case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(q.org_id)))
           when 'AE' then 'AE' when 'US' then 'US' else 'IN' end,
         coalesce(q.client ->> 'phone', '')
    into v_cc, v_file
    from public.quotes q where q.approval_token = p_token;
  if v_cc is null or v_cc = 'IN' or v_file = '' or p_phone is null then return p_phone; end if;
  v_dial := case v_cc when 'AE' then '971' else '1' end;
  v_to := public.helm_norm_phone_cc(p_phone, v_dial);
  if v_to ~ '^[0-9]{8,15}$' and v_to = public.helm_norm_phone_cc(v_file, v_dial) then return v_file; end if;
  return p_phone;
end $$;

-- keep this database's own bodies (rename once, only while the name is free)
do $$
declare f text[];
begin
  foreach f slice 1 in array array[
    ['request_otp', 'uuid, text'],
    ['verify_and_consent', 'uuid, text, text, boolean, text, text, text, text'],
    ['otp_send_authorize', 'uuid, text'],
    ['admin_store_otp', 'uuid, text, text']]
  loop
    if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is not null
       and to_regprocedure(format('public.%s(%s)', f[1] || '__pre0093', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0093');
    end if;
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0093', f[2])) is not null then
      execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0093', f[2]);
      if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', f[1] || '__pre0093', f[2]); end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', f[1] || '__pre0093', f[2]); end if;
    end if;
  end loop;
end $$;

create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 0093: UAE / US numbers (see _otp_canon_phone); everything else is the earlier body
begin
  return public.request_otp__pre0093(p_token, public._otp_canon_phone(p_token, p_phone));
end $$;

create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean,
                                                     p_terms_version text, p_consent_text text,
                                                     p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 0093: UAE / US numbers (see _otp_canon_phone); terms_version is stored as given (any id)
begin
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    -- a NULL / malformed code: the 0042 body counts it as a wrong code (C-01), never approves
    return public.verify_and_consent__pre0093(p_token, public._otp_canon_phone(p_token, p_phone), p_code, false,
                                              p_terms_version, p_consent_text, p_client_name, p_user_agent);
  end if;
  return public.verify_and_consent__pre0093(p_token, public._otp_canon_phone(p_token, p_phone), p_code, p_agreed,
                                            p_terms_version, p_consent_text, p_client_name, p_user_agent);
end $$;

create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 0093: a UAE / US client gets the SMS at their number with its own country code
declare v_p text := public._otp_canon_phone(p_token, p_phone); v_out jsonb; v_cc text;
begin
  v_out := public.otp_send_authorize__pre0093(p_token, v_p);
  if v_p is distinct from p_phone and v_out ? 'mobile' then
    select case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(q.org_id)))
             when 'AE' then '971' when 'US' then '1' else '91' end
      into v_cc from public.quotes q where q.approval_token = p_token;
    v_out := v_out || jsonb_build_object('mobile', public.helm_norm_phone_cc(v_p, v_cc));
  end if;
  return v_out;
end $$;

do $$ begin
  if to_regprocedure('public.admin_store_otp__pre0093(uuid, text, text)') is not null then
    execute $f$
create or replace function public.admin_store_otp(p_token uuid, p_phone text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $b$
-- 0093: same number the checks see (see _otp_canon_phone)
begin
  return public.admin_store_otp__pre0093(p_token, public._otp_canon_phone(p_token, p_phone), p_code);
end $b$;
$f$;
  end if;
end $$;

-- grants: same as before (public link RPCs for anon; Edge Function RPCs service role only)
do $$
declare r record;
begin
  for r in select * from (values
      ('public._otp_canon_phone(uuid, text)', false),
      ('public.request_otp(uuid, text)', true),
      ('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)', true),
      ('public.otp_send_authorize(uuid, text)', false),
      ('public.admin_store_otp(uuid, text, text)', false)) v(f, pub)
  loop
    continue when to_regprocedure(r.f) is null;
    execute format('revoke all on function %s from public', r.f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format(case when r.pub then 'grant execute on function %s to anon' else 'revoke all on function %s from anon' end, r.f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format(case when r.pub then 'grant execute on function %s to authenticated' else 'revoke all on function %s from authenticated' end, r.f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', r.f); end if;
  end loop;
end $$;
commit;

select item, ok from (values
  ('0092 01 INR reminder money unchanged', public._comms_money(125000, 'INR') = 'Rs. 125,000'),
  ('0092 02 AED / USD reminder money', public._comms_money(1234.5, 'AED') = 'AED 1,234.50' and public._comms_money(1234.5, 'USD') = '$1,234.50'),
  ('0092 03 India phone normalisation unchanged', public.helm_norm_phone_cc('9876543210', '91') = '919876543210'),
  ('0092 04 UAE / US numbers get their own code', public.helm_norm_phone_cc('0501234567', '971') = '971501234567' and public.helm_norm_phone_cc('4155551234', '1') = '14155551234'),
  ('0092 05 payment reminders use quote currency + studio code', pg_get_functiondef('public._comms_queue_pay(uuid, text, text, boolean, uuid)'::regprocedure) like '%_comms_quote_cur(q.id)%'
       and pg_get_functiondef('public._comms_queue_pay(uuid, text, text, boolean, uuid)'::regprocedure) like '%_comms_client_to(q.client, ch, q.org_id)%'),
  ('0092 06 follow-ups + send-now + claim use studio code', pg_get_functiondef('public.comms_tick()'::regprocedure) like '%_comms_client_to(f.client, v_ch, o.id)%'
       and pg_get_functiondef('public.payment_reminder_send_now(uuid)'::regprocedure) like '%_comms_client_to(q.client, c, v_org)%'
       and pg_get_functiondef('public.comms_outbox_claim(integer)'::regprocedure) like '%r.channel, r.org_id)%'),
  ('0092 07 secdef helpers have empty search_path', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('_comms_country', '_comms_quote_cur', '_comms_date') and (not p.prosecdef or not ('search_path=""' = any(p.proconfig))))),
  ('0092 08 new helpers not executable by anon / authenticated', not has_function_privilege('anon', 'public._comms_country(uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public._comms_quote_cur(uuid)', 'execute')),
  ('0092 09 comms_tick still service-role only', not has_function_privilege('authenticated', 'public.comms_tick()', 'execute')),
  ('0093 01 OTP entry points wrapped once', to_regprocedure('public.request_otp__pre0093(uuid, text)') is not null
       and to_regprocedure('public.verify_and_consent__pre0093(uuid, text, text, boolean, text, text, text, text)') is not null
       and to_regprocedure('public.otp_send_authorize__pre0093(uuid, text)') is not null
       and to_regprocedure('public.otp_send_authorize__pre0093__pre0093(uuid, text)') is null),
  ('0093 02 wrappers use the country-aware number', pg_get_functiondef('public.request_otp(uuid, text)'::regprocedure) like '%_otp_canon_phone(p_token, p_phone)%'
       and pg_get_functiondef('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)'::regprocedure) like '%_otp_canon_phone(p_token, p_phone)%'
       and pg_get_functiondef('public.otp_send_authorize(uuid, text)'::regprocedure) like '%_otp_canon_phone(p_token, p_phone)%'),
  ('0093 03 unknown link keeps the typed number', public._otp_canon_phone('00000000-0000-0000-0000-000000000000'::uuid, '+971501234567') = '+971501234567'),
  ('0093 04 secdef with empty search_path', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('_otp_canon_phone', 'request_otp', 'verify_and_consent', 'otp_send_authorize')
       and (not p.prosecdef or not ('search_path=""' = any(p.proconfig))))),
  ('0093 05 public link RPCs still open to anon', has_function_privilege('anon', 'public.request_otp(uuid, text)', 'execute')
       and has_function_privilege('anon', 'public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)', 'execute')),
  ('0093 06 SMS / helper / old bodies not executable by anon or authenticated', not has_function_privilege('anon', 'public.otp_send_authorize(uuid, text)', 'execute')
       and not has_function_privilege('authenticated', 'public.otp_send_authorize(uuid, text)', 'execute')
       and not has_function_privilege('anon', 'public._otp_canon_phone(uuid, text)', 'execute')
       and not has_function_privilege('anon', 'public.request_otp__pre0093(uuid, text)', 'execute')
       and not has_function_privilege('anon', 'public.verify_and_consent__pre0093(uuid, text, text, boolean, text, text, text, text)', 'execute'))
) v(item, ok)
order by item;
