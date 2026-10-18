-- 0212_trial_client_email.sql - CANONICAL forward-only.
-- REQUIRES 0151 (wa_otp_begin, _wa151_token_quote), 0166 (_sample_outbound_blocked, _ts166_tg_outbox_skip + the
--          outbox skip triggers), 0179 (_tb179_no_send, trial_send_blocked, the *__pre0179 bodies), 0183 (_trial_locked),
--          0184 (_tr184_keep_tables), 0195 (event_site_send + its claim), 0200 (booklet_send + its claim),
--          0207 (_trial_terms_version), 0128 / 0236 (_trial_test_mode_ok).
--
-- In plain words (owner decision 2026-10-18): during an ACTIVE free trial, E-MAIL to the studio's clients really
-- goes out - the approval (quote) link e-mail, the client booklet link e-mail, the invitation website link e-mail
-- and the approval code (OTP) by e-mail. WhatsApp, SMS and online payment links stay OFF in the trial (unchanged:
-- the 0179 / 0187 wrappers still refuse them, the outbox guard still skips them). The "Test mode - confirm"
-- approval on the client page stays.
--   1) _tr212_email_ok(org): true only for a studio on its free trial RIGHT NOW (_trial_test_mode_ok: subscription
--      'trial', not the sample master, no active plan, not read-only, trial end not past) while the owner switch
--      trial_email_settings.enabled is on (default on). An ENDED / read-only trial, the sample master and a paid
--      studio never use this path (paid studios never reach it: nothing blocks them in the first place).
--   2) Caps, counted per studio in a new ledger trial_email_sends (studio, kind, sha-256 of the lower-cased
--      address - never the address itself, time): 30 client e-mails a day per studio and 5 a day to one address
--      (rolling 24 hours; numbers in trial_email_settings). Every trial e-mail takes one slot before it is sent.
--   3) Queued e-mails (invitation link, booklet link: comms_outbox): the outbox guard (_ts166_tg_outbox_skip,
--      0166 body kept in tr212_saved_defs) keeps such a row 'pending' and marks it payload.trial_email = true
--      when (1) + (2) allow it; anything else from a trial studio is stored 'skipped' exactly as before (WhatsApp,
--      payment reminders, follow-ups, a demo event, the cap reached -> payload.trial_cap). The dispatcher claims
--      (0195 + 0200 bodies, kept in tr212_saved_defs) hand out a trial row only when it is that e-mail row and the
--      studio is still on an active trial (_tr212_claim_blocked).
--   4) event_site_send / booklet_send: wrapped (originals kept as <name>__pre0212, no app grants). The answer of a
--      queued trial e-mail says {status:'queued', trial_email:true}; a capped one {status:'skipped',
--      reason:'trial_email_cap'}.
--   5) trial_email_gate(org, quote, token, recipient, kind) - service role, for client-mailer: {allowed, trial,
--      reason}. Paid studio: allowed, no cap. Active trial: allowed while under the caps (one slot taken). Ended
--      trial / sample master / switch off: not allowed (reason 'trial_no_send'). Demo (sample) events: not allowed.
--   6) trial_email_otp_begin(token, user_agent) - service role, for send-otp: the approval code BY E-MAIL for an
--      active trial (the same checks as wa_otp_begin + otp_send_authorize, then one slot). Codes by SMS / WhatsApp
--      stay refused (42501 / hint trial_no_send).
--   7) my_trial_messaging(): for the app - {trial, active, email, whatsapp, sms, payment_links, email_per_day,
--      email_per_recipient_day, email_used_today}. Paid studio: everything true.
--   8) _trial_terms_version() = 'trial-2026-10-19' (public/trial-facts.js VERSION): the trial terms now say that
--      e-mail reaches clients, so the trial owner is asked once more (0207 rule: new wording = new version).
-- Changes: 3 new tables (2 settings / ledger, 1 bookkeeping), 7 new functions, 2 wrappers (originals kept), 1 trigger
-- function + 2 claim bodies re-issued (previous definitions saved first), 1 version function re-issued, 1 list
-- patched in place (_tr184_keep_tables keeps the ledger). No existing table, column, policy or row is changed or
-- deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): update public.trial_email_settings set enabled = false
-- (trial e-mail off at once, everything else unchanged), or fully: execute each tr212_saved_defs.def; for f in
-- event_site_send, booklet_send: drop function public.f(uuid, text, text, boolean, text); alter function
-- public.f__pre0212(uuid, text, text, boolean, text) rename to f; grant execute on it to authenticated.

do $$ begin
  if to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null or to_regprocedure('public._ts166_tg_outbox_skip()') is null then
    raise exception '0212: apply 0166 first'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null or to_regprocedure('public.trial_send_blocked(uuid,uuid,uuid)') is null
     or to_regprocedure('public.wa_otp_begin__pre0179(uuid,text,text)') is null
     or to_regprocedure('public.otp_send_authorize__pre0179(uuid,text)') is null then
    raise exception '0212: apply 0179 first'; end if;
  if to_regprocedure('public._trial_test_mode_ok(uuid)') is null or to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception '0212: apply 0128 + 0183 first'; end if;
  if to_regprocedure('public.event_site_send(uuid,text,text,boolean,text)') is null then raise exception '0212: apply 0195 first'; end if;
  if to_regprocedure('public.booklet_send(uuid,text,text,boolean,text)') is null then raise exception '0212: apply 0200 first'; end if;
  if to_regprocedure('public._trial_terms_version()') is null then raise exception '0212: apply 0207 first'; end if;
  if to_regprocedure('public._wa151_token_quote(uuid)') is null then raise exception '0212: apply 0151 first'; end if;
end $$;

-- ---- 1) tables -------------------------------------------------------------------------------------------------
-- the owner switch + caps (one row)
create table if not exists public.trial_email_settings (
  id                boolean     primary key default true check (id),
  enabled           boolean     not null default true,
  per_studio_day    integer     not null default 30 check (per_studio_day between 0 and 500),
  per_recipient_day integer     not null default 5 check (per_recipient_day between 0 and 50),
  updated_at        timestamptz not null default now()
);
comment on table public.trial_email_settings is
  '0212: free-trial client e-mail - owner switch (enabled) and caps per rolling 24 h (per studio / per address). One row.';
insert into public.trial_email_settings(id) values (true) on conflict (id) do nothing;

-- one row per trial client e-mail (the address only as a sha-256 fingerprint)
create table if not exists public.trial_email_sends (
  id             uuid        primary key default gen_random_uuid(),
  org_id         uuid        not null references public.organizations(id) on delete cascade,
  kind           text        not null check (kind in ('approval_link', 'booklet_link', 'invite_site', 'otp')),
  recipient_hash text        not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now()
);
comment on table public.trial_email_sends is
  '0212: free-trial client e-mail ledger for the caps (studio, kind, sha-256 of the address, time). Definer functions only.';
create index if not exists trial_email_sends_org_idx on public.trial_email_sends(org_id, created_at);
create index if not exists trial_email_sends_rcpt_idx on public.trial_email_sends(org_id, recipient_hash, created_at);

-- the definitions this file replaces, kept for a rollback (written once per function)
create table if not exists public.tr212_saved_defs (
  fn       text        primary key,
  def      text        not null,
  saved_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['trial_email_settings', 'trial_email_sends', 'tr212_saved_defs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;
-- (no policies on purpose: only the SECURITY DEFINER functions below read or write these tables)
-- the same read-only guard as every studio table (an ended / read-only trial never writes here anyway)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.trial_email_sends'::regclass and tgname = 'zzz_studio_read_only') then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.trial_email_sends '
            'for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- ---- 2) helpers (internal) ---------------------------------------------------------------------------------------
create or replace function public._tr212_email_ok(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-email-0212: an ACTIVE free trial (not ended / read-only, not the sample master) with the switch on
  select p_org is not null
     and coalesce((select s.enabled from public.trial_email_settings s where s.id), false)
     and coalesce(public._trial_test_mode_ok(p_org), false)
     and not coalesce((select o.is_sample_master from public.organizations o where o.id = p_org), false);
$$;

create or replace function public._tr212_rcpt_hash(p_recipient text)
returns text language sql immutable set search_path = '' as $$
  -- trial-email-0212: the address is never stored, only this fingerprint
  select encode(pg_catalog.sha256(convert_to(lower(btrim(coalesce(p_recipient, ''))), 'UTF8')), 'hex');
$$;

-- take one slot: null = OK (a ledger row is written), else 'cap_studio' | 'cap_recipient' | 'bad_recipient'
create or replace function public._tr212_take(p_org uuid, p_recipient text, p_kind text)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- trial-email-0212
declare s public.trial_email_settings; v_h text; v_n integer;
begin
  if p_org is null or coalesce(btrim(p_recipient), '') !~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$' then
    return 'bad_recipient'; end if;
  select * into s from public.trial_email_settings x where x.id;
  v_h := public._tr212_rcpt_hash(p_recipient);
  perform pg_advisory_xact_lock(hashtextextended('helm:trial-email:' || p_org::text, 0));
  select count(*) into v_n from public.trial_email_sends t where t.org_id = p_org and t.created_at > now() - interval '24 hours';
  if v_n >= coalesce(s.per_studio_day, 30) then return 'cap_studio'; end if;
  select count(*) into v_n from public.trial_email_sends t
   where t.org_id = p_org and t.recipient_hash = v_h and t.created_at > now() - interval '24 hours';
  if v_n >= coalesce(s.per_recipient_day, 5) then return 'cap_recipient'; end if;
  insert into public.trial_email_sends(org_id, kind, recipient_hash) values (p_org, p_kind, v_h);
  return null;
end $$;

-- the dispatcher claims ask this instead of _sample_outbound_blocked: a trial row is handed out only when it is a
-- link e-mail that took its slot at queue time (payload.trial_email) and the studio is still on an active trial
create or replace function public._tr212_claim_blocked(p_org uuid, p_recipient text, p_purpose text, p_channel text, p_payload jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-email-0212
  select public._sample_outbound_blocked(p_org, p_recipient)
     and not (p_channel = 'email' and p_purpose in ('invite_site', 'booklet_link')
              and coalesce(p_payload ->> 'trial_email', '') = 'true'
              and public._tr212_email_ok(p_org));
$$;

-- ---- 3) the outbox guard: trial link e-mails stay pending (capped); everything else from a trial as before -------
do $$ begin
  if position('trial-email-0212' in pg_get_functiondef('public._ts166_tg_outbox_skip()'::regprocedure)) = 0 then
    insert into public.tr212_saved_defs(fn, def) values ('public._ts166_tg_outbox_skip()', pg_get_functiondef('public._ts166_tg_outbox_skip()'::regprocedure))
      on conflict (fn) do nothing;
  end if;
end $$;

create or replace function public._ts166_tg_outbox_skip()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166 trial-email-0212
declare v_row jsonb := to_jsonb(new); v_rcpt text := coalesce(to_jsonb(new) ->> 'recipient', to_jsonb(new) ->> 'phone');
        v_cap text; v_pl jsonb;
begin
  -- the trial e-mail mark is only ever set here (a caller cannot bring it along)
  if tg_table_name = 'comms_outbox' and jsonb_typeof(v_row -> 'payload') = 'object' and (v_row -> 'payload') ? 'trial_email' then
    new := jsonb_populate_record(new, jsonb_build_object('payload', (v_row -> 'payload') - 'trial_email'));
    v_row := to_jsonb(new);
  end if;
  if new.status = 'pending' and public._sample_outbound_blocked(new.org_id, v_rcpt) then
    -- 0212: an ACTIVE free trial may e-mail its client the invitation / booklet link (capped); a new row only
    if tg_op = 'INSERT' and tg_table_name = 'comms_outbox'
       and v_row ->> 'channel' = 'email' and v_row ->> 'purpose' in ('invite_site', 'booklet_link')
       and public._tr212_email_ok(new.org_id)
       and not coalesce((select q.is_demo from public.quotes q where q.id::text = v_row ->> 'quote_id'), false) then
      v_cap := public._tr212_take(new.org_id, v_rcpt, v_row ->> 'purpose');
      v_pl := coalesce(case when jsonb_typeof(v_row -> 'payload') = 'object' then v_row -> 'payload' end, '{}'::jsonb);
      if v_cap is null then
        new := jsonb_populate_record(new, jsonb_build_object('payload', v_pl || jsonb_build_object('trial_email', true)));
        return new;
      end if;
      new := jsonb_populate_record(new, jsonb_build_object('payload', v_pl || jsonb_build_object('trial_cap', v_cap)));
    end if;
    new.status := 'skipped';
  end if;
  return new;
end $$;

-- ---- 4) the dispatcher claims (0195 + 0200 bodies): ask _tr212_claim_blocked -------------------------------------
-- every comms_outbox_claim* body that still has the old check gets the new one (its definition is saved first)
do $$ declare r record; v_def text; v_n integer := 0;
  c_old constant text := 'not public._sample_outbound_blocked(r.org_id, r.recipient)';
  c_new constant text := 'not public._tr212_claim_blocked(r.org_id, r.recipient, r.purpose, r.channel, r.payload)';
begin
  for r in select p.oid, p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'comms\_outbox\_claim%' order by p.proname loop
    v_def := pg_get_functiondef(r.oid);
    continue when position(c_old in v_def) = 0;
    insert into public.tr212_saved_defs(fn, def) values (r.sig, v_def) on conflict (fn) do nothing;
    execute replace(v_def, c_old, c_new);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then raise notice '0212: % dispatcher claim bodies now use _tr212_claim_blocked', v_n; end if;
end $$;

-- ---- 5) studio "Send to client" (invitation / booklet): the answer says what happened in the trial ---------------
create or replace function public._tr212_send_answer(p_r jsonb, p_channel text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-email-0212: {status:'queued', trial_email:true} / {status:'skipped', reason:'trial_email_cap', cap} /
-- {status:'skipped', reason:'demo'} (a sample event of an active trial: sample contacts are never e-mailed).
-- volatile on purpose: it must see the outbox row the wrapped call wrote in the same statement
declare v_cap text; v_id uuid; v_org uuid; v_demo boolean;
begin
  if p_r is null or p_channel is distinct from 'email' or p_r ->> 'reason' is distinct from 'free_trial' then return p_r; end if;
  if p_r ->> 'status' = 'queued' then return (p_r - 'reason') || jsonb_build_object('trial_email', true); end if;
  if p_r ->> 'status' = 'skipped' and coalesce(p_r ->> 'id', '') ~ '^[0-9a-f-]{36}$' then
    v_id := (p_r ->> 'id')::uuid;
    select c.payload ->> 'trial_cap', c.org_id, coalesce(q.is_demo, false) into v_cap, v_org, v_demo
      from public.comms_outbox c left join public.quotes q on q.id = c.quote_id where c.id = v_id;
    if v_cap in ('cap_studio', 'cap_recipient') then
      return p_r || jsonb_build_object('reason', 'trial_email_cap', 'cap', v_cap);
    end if;
    if v_demo and public._tr212_email_ok(v_org) then return p_r || jsonb_build_object('reason', 'demo'); end if;
  end if;
  return p_r;
end $$;

do $$ declare f text; begin
  foreach f in array array['event_site_send', 'booklet_send'] loop
    if to_regprocedure(format('public.%s__pre0212(uuid,text,text,boolean,text)', f)) is null
       and position('trial-email-0212' in pg_get_functiondef(to_regprocedure(format('public.%s(uuid,text,text,boolean,text)', f)))) = 0 then
      execute format('alter function public.%I(uuid, text, text, boolean, text) rename to %I', f, f || '__pre0212');
    end if;
  end loop;
end $$;

create or replace function public.event_site_send(p_site uuid, p_channel text, p_to text,
                                                  p_opt_in boolean default false, p_consent_text text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-email-0212: same checks and queue as 0195 (event_site_send__pre0212); the answer tells a trial e-mail apart
begin
  return public._tr212_send_answer(public.event_site_send__pre0212(p_site, p_channel, p_to, p_opt_in, p_consent_text), p_channel);
end $$;

create or replace function public.booklet_send(p_quote uuid, p_channel text, p_to text,
                                               p_opt_in boolean default false, p_consent_text text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-email-0212: same checks and queue as 0200 (booklet_send__pre0212); the answer tells a trial e-mail apart
begin
  return public._tr212_send_answer(public.booklet_send__pre0212(p_quote, p_channel, p_to, p_opt_in, p_consent_text), p_channel);
end $$;

-- ---- 6) client-mailer: may this e-mail go out? (service role) ---------------------------------------------------
create or replace function public.trial_email_gate(p_org uuid default null, p_quote uuid default null, p_token uuid default null,
                                                   p_recipient text default null, p_kind text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-email-0212: {allowed, trial, reason}; an allowed trial e-mail takes one slot (caps)
declare v_orgs uuid[]; v_org uuid; v_demo boolean; v_cap text;
begin
  if p_kind is null or p_kind not in ('approval_link', 'booklet_link', 'invite_site', 'otp') then
    raise exception 'unknown e-mail kind' using errcode = '22023'; end if;
  select array_agg(distinct x) into v_orgs from (
    select p_org as x where p_org is not null
    union all select q.org_id from public.quotes q where p_quote is not null and q.id = p_quote
    union all select q.org_id from public.quotes q where p_token is not null and q.approval_token = p_token
    union all select b.org_id from public.client_booklets b where p_token is not null and b.token = p_token) z
   where x is not null;
  -- nothing to check against (no studio found): fail closed
  if coalesce(array_length(v_orgs, 1), 0) = 0 then
    return jsonb_build_object('allowed', false, 'trial', false, 'reason', 'unknown'); end if;
  -- paid studio (no trial rule matches): allowed, no cap
  if not coalesce(public.trial_send_blocked(p_org, p_quote, p_token), true)
     and not exists (select 1 from unnest(coalesce(v_orgs, '{}'::uuid[])) o(id) where public._sample_outbound_blocked(o.id, p_recipient)) then
    return jsonb_build_object('allowed', true, 'trial', false);
  end if;
  -- a trial rule matches: only ONE studio on an active trial, switch on, a real (not demo) event
  if coalesce(array_length(v_orgs, 1), 0) <> 1 then
    return jsonb_build_object('allowed', false, 'trial', true, 'reason', 'trial_no_send'); end if;
  v_org := v_orgs[1];
  if not public._tr212_email_ok(v_org) then
    return jsonb_build_object('allowed', false, 'trial', true, 'reason', 'trial_no_send'); end if;
  select bool_or(coalesce(q.is_demo, false)) into v_demo from public.quotes q
   where (p_quote is not null and q.id = p_quote) or (p_token is not null and q.approval_token = p_token)
      or (p_token is not null and q.id in (select b.quote_id from public.client_booklets b where b.token = p_token));
  if coalesce(v_demo, false) then return jsonb_build_object('allowed', false, 'trial', true, 'reason', 'demo'); end if;
  v_cap := public._tr212_take(v_org, p_recipient, p_kind);
  if v_cap is not null then return jsonb_build_object('allowed', false, 'trial', true, 'reason', v_cap); end if;
  return jsonb_build_object('allowed', true, 'trial', true);
end $$;

-- ---- 7) send-otp: the approval code by e-mail in an active trial (service role) ---------------------------------
create or replace function public.trial_email_otp_begin(p_token uuid, p_user_agent text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-email-0212: the 0151 e-mail code checks (on-file address, 30 s cooldown, 4 per 30 min) + the 0097 / 0093 / 0027
-- send checks (demo, daily studio cap), then one trial slot. SMS / WhatsApp codes stay refused for a trial.
declare v_q uuid; v_org uuid; v jsonb; v_cap text;
begin
  v_q := public._wa151_token_quote(p_token);
  if v_q is null then raise exception 'invalid link' using errcode = 'HL404'; end if;
  select q.org_id into v_org from public.quotes q where q.id = v_q;
  if not public._tr212_email_ok(v_org) then
    raise exception 'Free trial: messages to clients are not sent' using errcode = '42501', hint = 'trial_no_send'; end if;
  v := public.wa_otp_begin__pre0179(p_token, 'email', p_user_agent);
  perform public.otp_send_authorize__pre0179(p_token, v ->> 'phone_key');
  v_cap := public._tr212_take(v_org, v ->> 'email', 'otp');
  if v_cap is not null then
    raise exception 'The free trial e-mail limit for today is reached - use Test mode - confirm on this page.'
      using errcode = 'HL429', hint = 'trial_email_cap';
  end if;
  return v || jsonb_build_object('trial_email', true);
end $$;

-- ---- 8) the app: what reaches this studio's clients ------------------------------------------------------------
create or replace function public.my_trial_messaging()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-email-0212
declare v_org uuid := public.current_org_id(); s public.trial_email_settings; v_used integer;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not coalesce(public._tb179_no_send(v_org), false) and not coalesce(public._sample_outbound_blocked(v_org, null), false) then
    return jsonb_build_object('trial', false, 'active', false, 'email', true, 'whatsapp', true, 'sms', true, 'payment_links', true);
  end if;
  select * into s from public.trial_email_settings x where x.id;
  select count(*) into v_used from public.trial_email_sends t where t.org_id = v_org and t.created_at > now() - interval '24 hours';
  return jsonb_build_object('trial', true, 'active', coalesce(public._trial_test_mode_ok(v_org), false),
    'email', public._tr212_email_ok(v_org), 'whatsapp', false, 'sms', false, 'payment_links', false,
    'email_per_day', coalesce(s.per_studio_day, 30), 'email_per_recipient_day', coalesce(s.per_recipient_day, 5),
    'email_used_today', v_used);
end $$;

-- ---- 9) trial terms: new wording -> new version (= public/trial-facts.js VERSION) -------------------------------
create or replace function public._trial_terms_version()
returns text language sql immutable set search_path = '' as $$
  -- trial-terms-0207 trial-email-0212: = HelmTrialFacts.VERSION (public/trial-facts.js)
  select 'trial-2026-10-19'::text;
$$;

-- ---- 10) trial retention (0184): the cap ledger is kept like the other trial ledgers ---------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''trial_email_sends''' in v_def) > 0 then return; end if;
  if position('''trial_grants'', ''trial_extensions''' in v_def) = 0 then
    raise notice '0212: _tr184_keep_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''trial_grants'', ''trial_extensions''', '''trial_grants'', ''trial_extensions'', ''trial_email_sends''');
end $$;

-- ---- 11) privileges -----------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._tr212_email_ok(uuid)', 'public._tr212_rcpt_hash(text)', 'public._tr212_take(uuid, text, text)',
                           'public._tr212_claim_blocked(uuid, text, text, text, jsonb)', 'public._ts166_tg_outbox_skip()',
                           'public._tr212_send_answer(jsonb, text)',
                           'public.event_site_send__pre0212(uuid, text, text, boolean, text)',
                           'public.booklet_send__pre0212(uuid, text, text, boolean, text)',
                           'public.event_site_send(uuid, text, text, boolean, text)', 'public.booklet_send(uuid, text, text, boolean, text)',
                           'public.trial_email_gate(uuid, uuid, uuid, text, text)', 'public.trial_email_otp_begin(uuid, text)',
                           'public.my_trial_messaging()'] loop
    continue when to_regprocedure(f) is null;
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.event_site_send(uuid, text, text, boolean, text) to authenticated;
    grant execute on function public.booklet_send(uuid, text, text, boolean, text) to authenticated;
    grant execute on function public.my_trial_messaging() to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.trial_email_gate(uuid, uuid, uuid, text, text) to service_role;
    grant execute on function public.trial_email_otp_begin(uuid, text) to service_role;
    grant execute on function public.my_trial_messaging() to service_role;
    grant execute on function public._tr212_email_ok(uuid) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
