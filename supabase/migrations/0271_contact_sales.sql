-- 0271_contact_sales.sql - CANONICAL forward-only.
-- REQUIRES 0029 + 0045 + 0047 (_hq_gate / _hq_wgate, platform operators), 0050 (rate_hit), 0165 (email_is_opted_out),
--          0244 (helm_notice_outbox + helm_notice_outbox_claim: the e-mail lane for comms-dispatch),
--          0250 (hq_security_notices: the HQ bell for platform operators; optional - skipped when missing),
--          0054 (_sa54_label; optional - the bell label).
--
-- In plain words (owner, r24: "a Contact sales form anyone can fill in, no account; it lands in HQ -> Requests and an
-- e-mail goes to notifications@helm.events"):
--   1  A PUBLIC "Contact sales" form at /contact-sales (and the home page's Contact form). Signed out, a visitor types
--      name, work e-mail, phone, company / studio, city, team size, events per year, the plan they want and a message,
--      and ticks "you may contact me". submit_sales_enquiry (anonymous) checks every field and saves ONE row in the NEW
--      table sales_enquiries (status New). Safe for the public: nothing is ever read back; rate-limited per network
--      (8 / hour), per e-mail and per phone (3 / day each), and for everyone together (60 / hour); a hidden "website"
--      field catches bots (answered "thank you", nothing kept); the same message twice within an hour is kept once;
--      a captcha token field is accepted for later (captcha-ready, like the 0269 enquiry form).
--   2  Helm HQ -> Requests -> "Sales enquiries": the list (New / Contacted / Won / Lost + a note) for platform operators
--      only (hq_sales_enquiries, hq_set_sales_enquiry - _hq_gate / _hq_wgate: audited, two-step when HQ asks for it).
--   3  ONE settings row (NEW helm_sales_settings): the address that gets the alert (default notifications@helm.events),
--      the automatic thank-you e-mail to the sender (default on) and the form itself (default open). HQ changes it
--      (hq_set_sales_enquiry_settings).
--   4  E-MAILS ARE ONLY QUEUED (sent later by the dormant comms-dispatch once SMTP is set up): helm_notice_outbox kind
--      'sales_enquiry' -> the HQ address, and 'sales_enquiry_ack' -> the sender (at most one thank-you per address per
--      day; never to an address that unsubscribed from Helm e-mail, 0165). The outbox kind check is widened ONCE to a
--      superset read from the live constraint (every existing row still passes) and helm_notice_outbox_claim gets ONE
--      branch added in place (marker r24-contact-0271) - recipients are resolved there, never taken from the row.
--   5  HQ BELL: each enquiry adds to ONE HQ notice per India day ("New sales enquiry x N") in hq_security_notices
--      (the 0250 HQ bell for platform operators); _sa54_label learns the label (patched in place, marker kept).
--   6  SUGGESTIONS BOX (owner, same round): "Send a suggestion" in the app's profile menu (signed in: the person and
--      their studio are recorded) and /suggest on the public site (visitors, optional e-mail for a reply). A message
--      (required) + optional kind Idea / Problem / Other -> NEW table suggestions (studio_id, never org_id: Helm's own
--      record, not studio data). submit_suggestion: honeypot, rate-limited (signed in 10 / hour per person, visitors
--      5 / hour per network, everyone 100 / hour). HQ -> Requests -> "Suggestions" (New / Reviewed / Done + note:
--      hq_suggestions, hq_set_suggestion). An e-mail (kind 'suggestion') is queued to the same HQ address; the HQ
--      bell shows "New suggestion x N" per India day.
--   Changes: 3 NEW tables (sales_enquiries, helm_sales_settings, suggestions: RLS on, no anon / signed-in table privilege), new
--   functions, the outbox kind check widened (superset), 2 function bodies patched in place only while they are the
--   expected ones (helm_notice_outbox_claim + _sa54_label: one branch each). Inserts only (the one settings row, new
--   enquiry / outbox / HQ notice rows). No existing row / column / policy changed or deleted. Additive + idempotent:
--   safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): update public.helm_sales_settings set form_open = false (nothing more is
-- accepted). Tables can stay. The claim branch only handles the three new kinds.

do $$ begin
  if to_regprocedure('public._hq_gate(text,text)') is null or to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null then
    raise exception 'STOP 0271: 0029 / 0045 HQ gates are not applied'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0271: 0050 (rate_hit) is not applied'; end if;
  if to_regclass('public.helm_notice_outbox') is null or to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then
    raise exception 'STOP 0271: 0244 (helm_notice_outbox) is not applied'; end if;
  if to_regprocedure('public.email_is_opted_out(uuid,text)') is null then raise exception 'STOP 0271: 0165 (email_is_opted_out) is not applied'; end if;
end $$;

-- ---- 1) tables (RLS on, no policies: only the functions below touch them) ----------------------------------------
create table if not exists public.sales_enquiries (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(name) between 2 and 80),
  email           text not null check (char_length(email) between 6 and 200),
  phone           text check (phone is null or phone ~ '^\+?[0-9]{10,15}$'),
  company         text not null check (char_length(company) between 2 and 160),
  city            text check (city is null or char_length(city) <= 80),
  team_size       text check (team_size is null or team_size in ('1', '2-5', '6-15', '16-50', '51+')),
  events_per_year text check (events_per_year is null or events_per_year in ('1-20', '21-50', '51-150', '151+')),
  plan            text check (plan is null or plan in ('starter', 'studio', 'enterprise', 'not_sure')),
  message         text check (message is null or char_length(message) <= 2000),
  source          text not null default 'contact_page' check (source in ('contact_page', 'home')),
  consent_at      timestamptz not null default now(),
  ip_hash         text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent      text check (user_agent is null or char_length(user_agent) <= 200),
  status          text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost')),
  hq_note         text check (hq_note is null or char_length(hq_note) <= 1000),
  handled_by      uuid,
  handled_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists sales_enquiries_created_idx on public.sales_enquiries (created_at desc);
create index if not exists sales_enquiries_email_idx on public.sales_enquiries (email, created_at desc);

create table if not exists public.helm_sales_settings (
  id           boolean primary key default true check (id),
  notify_email text not null default 'notifications@helm.events'
               check (char_length(notify_email) between 6 and 200 and notify_email ~ '^[^\s@<>",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$'),
  auto_reply   boolean not null default true,
  form_open    boolean not null default true,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);
insert into public.helm_sales_settings(id) values (true) on conflict (id) do nothing;

-- suggestions (in-app + public site). studio_id (not org_id): Helm's own record, kept when a studio's data is purged
create table if not exists public.suggestions (
  id          uuid primary key default gen_random_uuid(),
  message     text not null check (char_length(message) between 3 and 2000),
  category    text check (category is null or category in ('idea', 'problem', 'other')),
  source      text not null default 'site' check (source in ('app', 'site')),
  user_id     uuid,
  studio_id   uuid references public.organizations(id) on delete set null,
  email       text check (email is null or char_length(email) between 6 and 200),
  page        text check (page is null or char_length(page) <= 120),
  ip_hash     text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent  text check (user_agent is null or char_length(user_agent) <= 200),
  status      text not null default 'new' check (status in ('new', 'reviewed', 'done')),
  hq_note     text check (hq_note is null or char_length(hq_note) <= 1000),
  handled_by  uuid,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists suggestions_created_idx on public.suggestions (created_at desc);

do $$ declare t text; begin
  foreach t in array array['sales_enquiries', 'helm_sales_settings', 'suggestions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;

-- ---- 2) helpers ------------------------------------------------------------------------------------------------------
-- the visitor's network, hashed (never stored in clear)
create or replace function public._r24s_ip_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v := nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'x-real-ip', ''), ',', 1)), '');
  return case when v is null then null else encode(pg_catalog.sha256(convert_to('helm-sales:' || v, 'UTF8')), 'hex') end;
end $$;

create or replace function public._r24s_email_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and char_length(p) between 6 and 200
     and p ~ '^[^\s@<>",;:\\'']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$' and p !~ '\.\.';
$$;

-- one line of text: control characters / < > flattened, spaces collapsed, cut to n; empty -> null
create or replace function public._r24s_line(p text, n integer)
returns text language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]<>]', ' ', 'g'), '\s+', ' ', 'g')), n), '');
$$;

create or replace function public._r24s_cfg()
returns public.helm_sales_settings language plpgsql stable security definer set search_path = '' as $$
declare s public.helm_sales_settings;
begin
  select * into s from public.helm_sales_settings x where x.id;
  if not found then s := row(true, 'notifications@helm.events', true, true, now(), null)::public.helm_sales_settings; end if;
  return s;
end $$;

-- ---- 3) the public form (signed out) ----------------------------------------------------------------------------------
-- p: {name, email, phone, company, city, team_size, events_per_year, plan, message, consent (true), source
--     (contact_page | home), website (honeypot), captcha (Turnstile token - accepted, not yet checked: captcha-ready)}
-- Answers {ok:true} or {ok:false, reason, field, message}; never reads anything back.
create or replace function public.submit_sales_enquiry(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r24-contact-0271
declare k text; v_ip text := public._r24s_ip_hash(); c public.helm_sales_settings := public._r24s_cfg();
  v_name text; v_email text; v_phone text; v_company text; v_city text; v_team text; v_events text; v_plan text; v_msg text;
  v_src text; v_ua text; h jsonb; v_id uuid; v_ack boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please fill in the form.'); end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('name', 'email', 'phone', 'company', 'city', 'team_size', 'events_per_year', 'plan', 'message', 'consent',
                 'source', 'website', 'captcha') then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please fill in the form.'); end if;
    if jsonb_typeof(p -> k) not in ('string', 'boolean', 'number', 'null') then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please fill in the form.'); end if;
  end loop;
  if v_ip is not null and public.rate_hit('sales.ip', v_ip, 3600, 8) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many messages from this network. Please try again in an hour.'); end if;
  if not c.form_open then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This form is closed right now. Please e-mail sales@helm.events.'); end if;
  -- a filled hidden field = a bot: say thank you, keep nothing
  if nullif(btrim(coalesce(p ->> 'website', '')), '') is not null then return jsonb_build_object('ok', true); end if;
  if public.rate_hit('sales.all', 'all', 3600, 60) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'We are receiving many messages. Please try again a little later.'); end if;

  v_name := public._r24s_line(p ->> 'name', 80);
  if v_name is null or char_length(v_name) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'name', 'message', 'Please enter your name.'); end if;
  v_email := lower(btrim(coalesce(p ->> 'email', '')));
  if not public._r24s_email_ok(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'email', 'message', 'Please enter a valid work e-mail.'); end if;
  v_phone := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9+]', '', 'g'), '');
  if v_phone is not null then
    v_phone := case when left(v_phone, 1) = '+' then '+' else '' end || regexp_replace(v_phone, '[^0-9]', '', 'g');
    if v_phone !~ '^\+?[0-9]{10,15}$' then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'phone', 'message', 'Please enter a valid phone number (10 digits).'); end if;
  end if;
  v_company := public._r24s_line(p ->> 'company', 160);
  if v_company is null or char_length(v_company) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'company', 'message', 'Please enter your company or studio name.'); end if;
  v_city := public._r24s_line(p ->> 'city', 80);
  v_team := nullif(btrim(coalesce(p ->> 'team_size', '')), '');
  if v_team is not null and v_team not in ('1', '2-5', '6-15', '16-50', '51+') then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'team_size', 'message', 'Please pick your team size.'); end if;
  v_events := nullif(btrim(coalesce(p ->> 'events_per_year', '')), '');
  if v_events is not null and v_events not in ('1-20', '21-50', '51-150', '151+') then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'events_per_year', 'message', 'Please pick how many events you run a year.'); end if;
  v_plan := nullif(lower(btrim(coalesce(p ->> 'plan', ''))), '');
  if v_plan is not null and v_plan not in ('starter', 'studio', 'enterprise', 'not_sure') then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'plan', 'message', 'Please pick a plan.'); end if;
  v_msg := nullif(left(btrim(regexp_replace(replace(coalesce(p ->> 'message', ''), E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f<>]', ' ', 'g')), 2000), '');
  if coalesce(p ->> 'consent', '') <> 'true' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'consent', 'message', 'Please tick the box so we may contact you.'); end if;
  v_src := case when p ->> 'source' = 'home' then 'home' else 'contact_page' end;

  -- one person: the same message again within an hour (double click / retry) = kept once
  perform pg_advisory_xact_lock(hashtext('helm_sales_enq:' || v_email));
  if exists (select 1 from public.sales_enquiries e where e.email = v_email and e.company = v_company
               and e.message is not distinct from v_msg and e.created_at > now() - interval '1 hour') then
    return jsonb_build_object('ok', true, 'duplicate', true); end if;
  if public.rate_hit('sales.email', encode(pg_catalog.sha256(convert_to(v_email, 'UTF8')), 'hex'), 86400, 3) > 0
     or (v_phone is not null and public.rate_hit('sales.phone', encode(pg_catalog.sha256(convert_to(regexp_replace(v_phone, '[^0-9]', '', 'g'), 'UTF8')), 'hex'), 86400, 3) > 0) then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'We already have your messages from today. Our team will get back to you soon.'); end if;

  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v_ua := left(nullif(btrim(regexp_replace(coalesce(h ->> 'user-agent', ''), '[[:cntrl:]]', ' ', 'g')), ''), 200);
  -- the thank-you e-mail: at most one per address per day
  v_ack := c.auto_reply and not exists (select 1 from public.sales_enquiries e where e.email = v_email and e.created_at > now() - interval '1 day');

  insert into public.sales_enquiries(name, email, phone, company, city, team_size, events_per_year, plan, message, source, ip_hash, user_agent)
    values (v_name, v_email, v_phone, v_company, v_city, v_team, v_events, v_plan, v_msg, v_src, v_ip, v_ua)
    returning id into v_id;
  -- e-mails: queued only (comms-dispatch sends them once e-mail is live); a queue problem never loses the enquiry
  begin
    insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
      values ('sales_enquiry', null, v_id, jsonb_build_object('enquiry_id', v_id), 'sales_enquiry:' || v_id::text)
    on conflict (dedupe_key) do nothing;
    if v_ack then
      insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
        values ('sales_enquiry_ack', null, v_id, jsonb_build_object('enquiry_id', v_id), 'sales_enquiry_ack:' || v_id::text)
      on conflict (dedupe_key) do nothing;
    end if;
  exception when others then raise warning 'r24-contact-0271: e-mail not queued (%)', sqlstate;
  end;
  -- the HQ bell: one notice per India day with a running count
  if to_regclass('public.hq_security_notices') is not null then
    begin
      insert into public.hq_security_notices(org_key, org_id, alert_type, day, count, first_at, last_at, detail)
        values ('00000000-0000-0000-0000-000000000000'::uuid, null, 'sales_enquiry', (now() at time zone 'Asia/Kolkata')::date,
                1, now(), now(), jsonb_build_object('subject_name', left(v_name || ' - ' || v_company, 80), 'source', '0271'))
      on conflict (org_key, alert_type, day) do update
        set count = public.hq_security_notices.count + 1, last_at = now(), detail = excluded.detail;
    exception when others then raise warning 'r24-contact-0271: HQ bell skipped (%)', sqlstate;
    end;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---- 3b) the suggestions box (signed in: from the app; signed out: the public /suggest page) ---------------------------
-- p: {message, category (idea | problem | other), email (visitors, optional), page, website (honeypot), captcha}
create or replace function public.submit_suggestion(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r24-contact-0271
declare k text; v_uid uuid := auth.uid(); v_org uuid; v_ip text := public._r24s_ip_hash(); v_msg text; v_cat text; v_email text;
  v_page text; v_ua text; h jsonb; v_id uuid; v_who text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please write your suggestion.'); end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('message', 'category', 'email', 'page', 'website', 'captcha')
       or jsonb_typeof(p -> k) not in ('string', 'boolean', 'number', 'null') then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please write your suggestion.'); end if;
  end loop;
  if v_uid is not null then
    if public.rate_hit('sugg.user', v_uid::text, 3600, 10) > 0 then
      return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Thank you - that is a lot of suggestions for one hour. Please try again later.'); end if;
  elsif v_ip is not null and public.rate_hit('sugg.ip', v_ip, 3600, 5) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many messages from this network. Please try again in an hour.'); end if;
  if nullif(btrim(coalesce(p ->> 'website', '')), '') is not null then return jsonb_build_object('ok', true); end if;
  if public.rate_hit('sugg.all', 'all', 3600, 100) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'We are receiving many messages. Please try again a little later.'); end if;
  v_msg := nullif(left(btrim(regexp_replace(replace(coalesce(p ->> 'message', ''), E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f<>]', ' ', 'g')), 2000), '');
  if v_msg is null or char_length(v_msg) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'message', 'message', 'Please write your suggestion.'); end if;
  v_cat := nullif(lower(btrim(coalesce(p ->> 'category', ''))), '');
  if v_cat is not null and v_cat not in ('idea', 'problem', 'other') then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'category', 'message', 'Please pick Idea, Problem or Other.'); end if;
  v_email := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  if v_email is not null and not public._r24s_email_ok(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'email', 'message', 'Please enter a valid e-mail, or leave it empty.'); end if;
  v_page := public._r24s_line(p ->> 'page', 120);
  if v_uid is not null then
    -- the person's own studio (never a studio named by the caller) + their sign-in e-mail
    begin v_org := public.current_org_id(); exception when others then v_org := null; end;
    select coalesce(v_email, lower(u.email)) into v_email from auth.users u where u.id = v_uid;
    if v_email is not null and not public._r24s_email_ok(v_email) then v_email := null; end if;
  end if;
  -- the same text again within an hour (double click / retry) = kept once
  if exists (select 1 from public.suggestions x where x.message = v_msg and x.created_at > now() - interval '1 hour'
               and ((v_uid is not null and x.user_id = v_uid) or (v_uid is null and x.user_id is null and x.ip_hash is not distinct from v_ip))) then
    return jsonb_build_object('ok', true, 'duplicate', true); end if;
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v_ua := left(nullif(btrim(regexp_replace(coalesce(h ->> 'user-agent', ''), '[[:cntrl:]]', ' ', 'g')), ''), 200);
  insert into public.suggestions(message, category, source, user_id, studio_id, email, page, ip_hash, user_agent)
    values (v_msg, v_cat, case when v_uid is null then 'site' else 'app' end, v_uid, v_org, v_email, v_page, v_ip, v_ua)
    returning id into v_id;
  begin
    insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
      values ('suggestion', null, v_id, jsonb_build_object('suggestion_id', v_id), 'suggestion:' || v_id::text)
    on conflict (dedupe_key) do nothing;
  exception when others then raise warning 'r24-contact-0271: suggestion e-mail not queued (%)', sqlstate;
  end;
  if to_regclass('public.hq_security_notices') is not null then
    begin
      select left(coalesce(nullif(btrim(pr.full_name), ''), 'A Helm user'), 60) into v_who from public.profiles pr where pr.id = v_uid;
      insert into public.hq_security_notices(org_key, org_id, alert_type, day, count, first_at, last_at, detail)
        values ('00000000-0000-0000-0000-000000000000'::uuid, null, 'suggestion', (now() at time zone 'Asia/Kolkata')::date,
                1, now(), now(), jsonb_build_object('subject_name', coalesce(v_who, 'A visitor'), 'source', '0271'))
      on conflict (org_key, alert_type, day) do update
        set count = public.hq_security_notices.count + 1, last_at = now(), detail = excluded.detail;
    exception when others then raise warning 'r24-contact-0271: HQ bell skipped (%)', sqlstate;
    end;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.hq_suggestions(p_status text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r24-contact-0271
begin
  perform public._hq_gate('hq_suggestions', p_status);
  return jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
                 from (select g.status, count(*) n from public.suggestions g group by g.status) x),
    'rows', coalesce((select jsonb_agg(z.j order by z.created_at desc) from (
       select g.created_at, jsonb_build_object('id', g.id, 'message', g.message, 'category', g.category, 'source', g.source,
         'email', g.email, 'page', g.page, 'studio', o.name, 'studio_id', g.studio_id,
         'who', (select coalesce(nullif(btrim(pr.full_name), ''), pr.email) from public.profiles pr where pr.id = g.user_id),
         'status', g.status, 'hq_note', g.hq_note, 'handled_at', g.handled_at, 'created_at', g.created_at) j
         from public.suggestions g left join public.organizations o on o.id = g.studio_id
        where p_status is null or g.status = p_status
        order by g.created_at desc limit 300) z), '[]'::jsonb));
end $$;

create or replace function public.hq_set_suggestion(p_id uuid, p_status text default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r24-contact-0271
declare n int;
begin
  perform public._hq_wgate('hq.suggestion.update', 'suggestions', p_id::text, jsonb_build_object('status', p_status, 'note', left(p_note, 1000)));
  if p_status is not null and p_status not in ('new', 'reviewed', 'done') then
    raise exception 'status must be new, reviewed or done' using errcode = '22023'; end if;
  if p_status is null and p_note is null then raise exception 'nothing to change' using errcode = '22023'; end if;
  update public.suggestions set status = coalesce(p_status, status),
         hq_note = case when p_note is null then hq_note
                        else nullif(left(btrim(regexp_replace(replace(p_note, E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f]', ' ', 'g')), 1000), '') end,
         handled_by = auth.uid(), handled_at = now()
   where id = p_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'suggestion not found' using errcode = '22023'; end if;
  return (select jsonb_build_object('id', g.id, 'status', g.status, 'hq_note', g.hq_note, 'handled_at', g.handled_at)
            from public.suggestions g where g.id = p_id);
end $$;

-- ---- 4) Helm HQ -> Requests -> Sales enquiries ------------------------------------------------------------------------
create or replace function public.hq_sales_enquiries(p_status text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r24-contact-0271
declare c public.helm_sales_settings;
begin
  perform public._hq_gate('hq_sales_enquiries', p_status);
  c := public._r24s_cfg();
  return jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
                 from (select e.status, count(*) n from public.sales_enquiries e group by e.status) x),
    'settings', jsonb_build_object('notify_email', c.notify_email, 'auto_reply', c.auto_reply, 'form_open', c.form_open),
    'rows', coalesce((select jsonb_agg(z.j order by z.created_at desc) from (
       select e.created_at, jsonb_build_object('id', e.id, 'name', e.name, 'email', e.email, 'phone', e.phone, 'company', e.company,
         'city', e.city, 'team_size', e.team_size, 'events_per_year', e.events_per_year, 'plan', e.plan, 'message', e.message,
         'source', e.source, 'status', e.status, 'hq_note', e.hq_note, 'handled_at', e.handled_at, 'created_at', e.created_at) j
         from public.sales_enquiries e
        where p_status is null or e.status = p_status
        order by e.created_at desc limit 300) z), '[]'::jsonb));
end $$;

-- status and / or note (p_note null = keep, '' = clear)
create or replace function public.hq_set_sales_enquiry(p_id uuid, p_status text default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r24-contact-0271
declare n int;
begin
  perform public._hq_wgate('hq.sales_enquiry.update', 'sales_enquiries', p_id::text,
    jsonb_build_object('status', p_status, 'note', left(p_note, 1000)));
  if p_status is not null and p_status not in ('new', 'contacted', 'won', 'lost') then
    raise exception 'status must be new, contacted, won or lost' using errcode = '22023'; end if;
  if p_status is null and p_note is null then raise exception 'nothing to change' using errcode = '22023'; end if;
  update public.sales_enquiries set status = coalesce(p_status, status),
         hq_note = case when p_note is null then hq_note
                        else nullif(left(btrim(regexp_replace(replace(p_note, E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f]', ' ', 'g')), 1000), '') end,
         handled_by = auth.uid(), handled_at = now()
   where id = p_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'enquiry not found' using errcode = '22023'; end if;
  return (select jsonb_build_object('id', e.id, 'status', e.status, 'hq_note', e.hq_note, 'handled_at', e.handled_at)
            from public.sales_enquiries e where e.id = p_id);
end $$;

-- the address that gets the alerts + the thank-you e-mail + the form on / off (null = keep)
create or replace function public.hq_set_sales_enquiry_settings(p_notify_email text default null, p_auto_reply boolean default null,
  p_form_open boolean default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r24-contact-0271
declare v_email text := nullif(lower(btrim(coalesce(p_notify_email, ''))), ''); c public.helm_sales_settings;
begin
  perform public._hq_wgate('hq.sales_enquiry.settings', 'helm_sales_settings', null,
    jsonb_build_object('notify_email', v_email, 'auto_reply', p_auto_reply, 'form_open', p_form_open));
  if v_email is not null and not public._r24s_email_ok(v_email) then
    raise exception 'Enter a valid e-mail address' using errcode = '22023'; end if;
  insert into public.helm_sales_settings(id) values (true) on conflict (id) do nothing;
  update public.helm_sales_settings set notify_email = coalesce(v_email, notify_email), auto_reply = coalesce(p_auto_reply, auto_reply),
         form_open = coalesce(p_form_open, form_open), updated_at = now(), updated_by = auth.uid()
   where id;
  c := public._r24s_cfg();
  return jsonb_build_object('notify_email', c.notify_email, 'auto_reply', c.auto_reply, 'form_open', c.form_open);
end $$;

-- ---- 5) the e-mail for comms-dispatch: recipients + data, re-checked when it is claimed ------------------------------
create or replace function public._r24s_mail(p_kind text, p_ref uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r24-contact-0271
declare e public.sales_enquiries; g public.suggestions; c public.helm_sales_settings := public._r24s_cfg();
begin
  if p_kind = 'suggestion' then
    select * into g from public.suggestions where id = p_ref;
    if not found or not public._r24s_email_ok(c.notify_email) then return null; end if;
    return jsonb_build_object('to', jsonb_build_array(lower(c.notify_email)), 'data', jsonb_build_object(
      'id', g.id, 'message', g.message, 'category', g.category, 'source', g.source, 'email', g.email, 'page', g.page,
      'studio', (select o.name from public.organizations o where o.id = g.studio_id),
      'who', (select nullif(btrim(pr.full_name), '') from public.profiles pr where pr.id = g.user_id), 'created_at', g.created_at));
  end if;
  select * into e from public.sales_enquiries where id = p_ref;
  if not found then return null; end if;
  if p_kind = 'sales_enquiry' then
    if not public._r24s_email_ok(c.notify_email) then return null; end if;
    return jsonb_build_object('to', jsonb_build_array(lower(c.notify_email)), 'data', jsonb_build_object(
      'id', e.id, 'name', e.name, 'email', e.email, 'phone', e.phone, 'company', e.company, 'city', e.city,
      'team_size', e.team_size, 'events_per_year', e.events_per_year, 'plan', e.plan, 'message', e.message,
      'source', e.source, 'created_at', e.created_at));
  elsif p_kind = 'sales_enquiry_ack' then
    if not c.auto_reply or not public._r24s_email_ok(e.email) or coalesce(public.email_is_opted_out(null, e.email), false) then return null; end if;
    return jsonb_build_object('to', jsonb_build_array(e.email), 'data', jsonb_build_object('name', e.name, 'plan', e.plan));
  end if;
  return null;
end $$;

-- ---- 6) the e-mail lane: outbox kinds widened once (superset) + one claim branch ------------------------------------
do $$ declare v_def text; v_kinds text[]; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  if v_def is null then raise notice '0271: helm_notice_outbox has no kind check - nothing to widen'; return; end if;
  if position('''suggestion''' in v_def) > 0 then return; end if;
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(v_def, '''([a-z_]+)''', 'g') m;
  if v_kinds is null or not ('sales_request' = any (v_kinds)) then
    raise notice '0271: helm_notice_outbox kind check has an unexpected body - left unchanged (sales e-mails stay off)'; return; end if;
  v_kinds := array(select distinct k from unnest(v_kinds || array['sales_enquiry', 'sales_enquiry_ack', 'suggestion']) k order by k);
  -- same shape as the 0244 / 0254 / 0266 check (kind in ('a', 'b', ...)), so a later migration can widen it the same way
  execute format('alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check_0271 check (kind in (%s))',
                 (select string_agg(quote_literal(k), ', ' order by k) from unnest(v_kinds) k));
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox rename constraint helm_notice_outbox_kind_check_0271 to helm_notice_outbox_kind_check;
end $$;

do $$ declare v_def text; v_old text; v_new text; begin
  v_def := pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure);
  if position('r24-contact-0271' in v_def) > 0 then return; end if;
  v_old := E'\n    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0271: helm_notice_outbox_claim has an unexpected body - left unchanged (sales e-mails are skipped)'; return; end if;
  v_new := E'\n    elsif r.kind in (''sales_enquiry'', ''sales_enquiry_ack'', ''suggestion'') and r.ref_id is not null then\n'
        || E'      -- r24-contact-0271: Contact sales / a suggestion -> the HQ address, the thank-you to the sender (re-checked here)\n'
        || E'      v_data := public._r24s_mail(r.kind, r.ref_id);\n'
        || E'      v_to := coalesce(v_data -> ''to'', ''[]''::jsonb); v_data := v_data -> ''data'';'
        || v_old;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 7) the HQ bell label (patched in place while it is the 0054 body) ------------------------------------------------
do $$ declare v_def text; v_old text := 'else ''Security event'' end'; begin
  if to_regprocedure('public._sa54_label(text)') is null then return; end if;
  v_def := pg_get_functiondef('public._sa54_label(text)'::regprocedure);
  if position('New suggestion' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0271: _sa54_label has an unexpected body - left unchanged (the HQ bell says "Security event")'; return; end if;
  execute replace(v_def, v_old, 'when ''sales_enquiry'' then ''New sales enquiry'' when ''suggestion'' then ''New suggestion'' ' || v_old);
end $$;

-- ---- 8) grants ----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r24s_ip_hash()', 'public._r24s_email_ok(text)', 'public._r24s_line(text, integer)', 'public._r24s_cfg()',
      'public._r24s_mail(text, uuid)', 'public.submit_sales_enquiry(jsonb)', 'public.hq_sales_enquiries(text)',
      'public.hq_set_sales_enquiry(uuid, text, text)', 'public.hq_set_sales_enquiry_settings(text, boolean, boolean)',
      'public.submit_suggestion(jsonb)', 'public.hq_suggestions(text)', 'public.hq_set_suggestion(uuid, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- the signed-out form (anyone; it checks everything itself)
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.submit_sales_enquiry(jsonb) to anon';
    execute 'grant execute on function public.submit_suggestion(jsonb) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.submit_sales_enquiry(jsonb) to authenticated';
    -- HQ: each checks the platform operator (+ the write gate) inside
    execute 'grant execute on function public.hq_sales_enquiries(text) to authenticated';
    execute 'grant execute on function public.hq_set_sales_enquiry(uuid, text, text) to authenticated';
    execute 'grant execute on function public.hq_set_sales_enquiry_settings(text, boolean, boolean) to authenticated';
    execute 'grant execute on function public.submit_suggestion(jsonb) to authenticated';
    execute 'grant execute on function public.hq_suggestions(text) to authenticated';
    execute 'grant execute on function public.hq_set_suggestion(uuid, text, text) to authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';
