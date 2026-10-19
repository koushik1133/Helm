-- 0262_quote_validity.sql - CANONICAL forward-only.
-- REQUIRES phase29 / phase57 (has_area, current_org_id, user_role, app_config keyed by (org_id, key)), 0004
--          (tg_quote_org_match), 0045 (tg_studio_read_only), 0065 (client_booklets), 0078 (comms_outbox,
--          _comms_client_to, _comms_quote_live, rate_hit), 0156 (verify_and_consent wrapper chain), 0166
--          (_sample_outbound_blocked), 0198 (_a198_org_today), 0200 (comms_outbox_claim chain + purpose check).
--
-- In plain words (owner, r23 - INDUSTRY-BENCHMARK-PLAN F4 #4, the PandaDoc / Proposify / Zoho "valid until" model):
--   1  Every NEW quote gets a "Valid until" date (the studio's default, 14 days from the day it is created; when the
--      approval link is first sent, an automatic date is moved forward so the client always gets the full default
--      from the day they receive it). Stored in a NEW side table quote_validity (one row per quote) - the quotes
--      table itself is NOT changed (no new column, no quotes trigger re-fires, nothing re-ordered).
--      EXISTING quotes get NO row = no expiry, exactly as today. An admin can run "Apply to open quotes" in Control
--      Center: only open, never-approved quotes WITHOUT a date get today + the default (rows added, never changed).
--   2  Control Center (app_config key 'quote_validity', admins / Control Center EDIT): on/off (default on), default
--      days (14), reminder days before expiry (3 and 1), "an expired quote can't be approved" (default on), "staff
--      may pick a custom date per quote" (default on), reminders to the client (on) / the studio bell (on).
--   3  Quote flow + event workspace: "Valid until dd/mm/yyyy - expires in N days". Roles that can EDIT quotes
--      extend it with one click (+default days) or pick a date (when the studio allows custom dates; admins always).
--      Every change is logged (quote_validity_log, append-only) and in audit_log.
--   4  Client pages (approval page + booklet): "This quote is valid until dd/mm/yyyy". After expiry: "This quote
--      has expired - ask <studio> for an updated one" + "Request a new quote" (one bell row to the studio per day).
--   5  SERVER lock: verify_and_consent (every client approval path: OTP / WhatsApp / e-mail code / trial skip goes
--      through it) refuses an expired quote while the lock switch is on - the code is not used up.
--   6  Reminders (quote_validity_tick, pg_cron hourly when installed): the studio bell "Quote X expires in 3 days"
--      (+ "expired" the day after); the client gets an e-mail QUEUED in comms_outbox (purpose 'quote_expiry') -
--      sent only by comms-dispatch once deployed with e-mail on; never for a free-trial / demo / ended studio.
--   7  Quotes list: "Expires in N days" pill + the Attention tab also lists quotes expiring soon / just expired.
-- Changes: 2 NEW tables (RLS on, read-only for the app), new functions, verify_and_consent + comms_outbox_claim
-- wrapped once (*__pre0262 kept, no app grants), comms_outbox purpose CHECK widened to a superset, 1 pg_cron job
-- (only if pg_cron is already installed). Nothing deleted or overwritten. Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): turn the switch off in Control Center (no expiry anywhere, nothing locks);
--   or select cron.unschedule('helm_quote_validity'). The tables can stay (unused).

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.user_role()') is null then
    raise exception 'STOP 0262: phase29 / phase57 (has_area, current_org_id, user_role) is not applied'; end if;
  if to_regclass('public.app_config') is null or to_regclass('public.client_booklets') is null
     or to_regclass('public.comms_outbox') is null or to_regclass('public.quote_consents') is null
     or to_regclass('public.notifications') is null or to_regclass('public.audit_log') is null then
    raise exception 'STOP 0262: app_config / client_booklets / comms_outbox / quote_consents / notifications / audit_log missing'; end if;
  if to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)') is null
     or to_regprocedure('public.comms_outbox_claim(integer)') is null or to_regprocedure('public._a198_org_today(uuid)') is null
     or to_regprocedure('public._comms_client_to(jsonb,text)') is null or to_regprocedure('public._comms_quote_live(uuid)') is null
     or to_regprocedure('public.rate_hit(text,text,integer,integer)') is null
     or to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null then
    raise exception 'STOP 0262: apply 0078 + 0156 + 0166 + 0198 + 0200 first'; end if;
end $$;

-- ---- 1) tables -----------------------------------------------------------------------------------------------
create table if not exists public.quote_validity (
  quote_id    uuid primary key references public.quotes(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  valid_until date not null,
  source      text not null default 'auto' check (source in ('auto', 'manual', 'extended', 'bulk')),
  set_by      uuid,
  set_at      timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists quote_validity_org_until_idx on public.quote_validity(org_id, valid_until);

create table if not exists public.quote_validity_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  action     text not null check (action in ('auto', 'set', 'extended', 'bulk', 'renew_request', 'reminder_studio',
                                             'reminder_client', 'expired_studio', 'approve_refused')),
  old_until  date,
  new_until  date,
  actor      uuid,
  actor_name text,
  note       text check (note is null or length(note) <= 500),
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists quote_validity_log_quote_idx on public.quote_validity_log(quote_id, created_at desc);

alter table public.quote_validity enable row level security;
alter table public.quote_validity_log enable row level security;
revoke all on public.quote_validity from public, anon, authenticated;
revoke all on public.quote_validity_log from public, anon, authenticated;
grant select on public.quote_validity to authenticated;
grant select on public.quote_validity_log to authenticated;
grant all on public.quote_validity to service_role;
grant all on public.quote_validity_log to service_role;
drop policy if exists "r23 quote validity read" on public.quote_validity;
create policy "r23 quote validity read" on public.quote_validity for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));
drop policy if exists "r23 quote validity log read" on public.quote_validity_log;
create policy "r23 quote validity log read" on public.quote_validity_log for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    drop trigger if exists zz_quote_org_match on public.quote_validity;
    create trigger zz_quote_org_match before insert or update on public.quote_validity
      for each row execute function public.tg_quote_org_match();
    drop trigger if exists zz_quote_org_match on public.quote_validity_log;
    create trigger zz_quote_org_match before insert or update on public.quote_validity_log
      for each row execute function public.tg_quote_org_match();
  end if;
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    drop trigger if exists zzz_studio_read_only on public.quote_validity;
    create trigger zzz_studio_read_only before insert or update or delete on public.quote_validity
      for each row execute function public.tg_studio_read_only('org_id');
    drop trigger if exists zzz_studio_read_only on public.quote_validity_log;
    create trigger zzz_studio_read_only before insert or update or delete on public.quote_validity_log
      for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;

-- the automatic date / its log are settings, not content: an untouched blank quote stays "blank" / "empty" for the
-- 0141 clean-up and the 0220 "reuse my blank quote" check (ignored like audit_log / quote_flow_progress); one ignore
-- list in place in each, the rest of each body unchanged
do $$ declare f text; v_def text; v_old text := '''audit_log'', ''quote_flow_progress'')'; begin
  foreach f in array array['public._empty_draft_reason(uuid)', 'public._blank_quote_touched_reason(uuid,uuid)'] loop
    if to_regprocedure(f) is null then continue; end if;
    v_def := pg_get_functiondef(to_regprocedure(f));
    if position('quote_validity' in v_def) > 0 then continue; end if;
    if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 2 then
      raise notice '0262: % has an unexpected body - left unchanged (a new blank quote is then kept, never lost)', f; continue;
    end if;
    execute replace(v_def, v_old, '''audit_log'', ''quote_flow_progress'', ''quote_validity'', ''quote_validity_log'')');
  end loop;
end $$;
-- trial retention (0184, owner switch, off by default): the new tables are part of a studio's event records
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''quote_validity''' in v_def) > 0 then return; end if;
  -- before 'quotes' in the purge order (wherever other releases put their own tables)
  if (length(v_def) - length(replace(v_def, ', ''quotes'',', ''))) / length(', ''quotes'',') <> 1 then
    raise notice '0262: _tr184_purge_tables has an unexpected body - left unchanged (the rows go with their quote: on delete cascade)'; return;
  end if;
  execute replace(v_def, ', ''quotes'',', ', ''quote_validity_log'', ''quote_validity'', ''quotes'',');
end $$;

-- ---- 2) settings + state helpers -----------------------------------------------------------------------------
-- the studio's settings with defaults filled in and every value range-checked (a hand-edited row cannot break it)
create or replace function public._qv262_cfg(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262
declare v jsonb; d integer; r integer[];
begin
  select c.value into v from public.app_config c where c.org_id = p_org and c.key = 'quote_validity';
  if jsonb_typeof(v) <> 'object' then v := '{}'::jsonb; end if;
  d := case when jsonb_typeof(v -> 'default_days') = 'number' and (v ->> 'default_days') ~ '^[0-9]{1,3}$'
            then (v ->> 'default_days')::integer end;
  if d is null or d < 1 or d > 365 then d := 14; end if;
  if jsonb_typeof(v -> 'reminder_days') = 'array' then
    select coalesce(array_agg(distinct (e #>> '{}')::integer order by (e #>> '{}')::integer desc), '{}'::integer[]) into r
      from jsonb_array_elements(v -> 'reminder_days') e
     where jsonb_typeof(e) = 'number' and (e #>> '{}') ~ '^[0-9]{1,2}$' and (e #>> '{}')::integer between 0 and 60;
    r := r[1:5];
  else r := array[3, 1]; end if;
  return jsonb_build_object(
    'enabled', coalesce(case when jsonb_typeof(v -> 'enabled') = 'boolean' then (v ->> 'enabled')::boolean end, true),
    'default_days', d,
    'reminder_days', to_jsonb(coalesce(r, '{}'::integer[])),
    'auto_lock', coalesce(case when jsonb_typeof(v -> 'auto_lock') = 'boolean' then (v ->> 'auto_lock')::boolean end, true),
    'allow_override', coalesce(case when jsonb_typeof(v -> 'allow_override') = 'boolean' then (v ->> 'allow_override')::boolean end, true),
    'client_reminders', coalesce(case when jsonb_typeof(v -> 'client_reminders') = 'boolean' then (v ->> 'client_reminders')::boolean end, true),
    'studio_reminders', coalesce(case when jsonb_typeof(v -> 'studio_reminders') = 'boolean' then (v ->> 'studio_reminders')::boolean end, true));
end $$;

-- open = the client can still approve it: not cancelled / deleted, not approved / paid, never consented before
create or replace function public._qv262_open(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r23-quote-validity-0262
  select coalesce((select coalesce(q.status, '') <> 'cancelled' and q.deleted_at is null
                          and coalesce(q.approval_status, 'none') in ('none', 'sent')
                          and not exists (select 1 from public.quote_consents c where c.quote_id = q.id and c.agreed)
                     from public.quotes q where q.id = p_quote), false);
$$;

-- one quote's validity, computed now in the studio's own time zone (valid through the whole valid_until day)
--   state: off (switched off) | none (no date = no expiry) | done (approved / cancelled - no longer applies)
--          | valid | expired
create or replace function public._qv262_state(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262
declare q record; v public.quote_validity; c jsonb; t date; n integer; st text;
begin
  select x.id, x.org_id into q from public.quotes x where x.id = p_quote;
  if q.id is null then return null; end if;
  c := public._qv262_cfg(q.org_id);
  if not (c ->> 'enabled')::boolean then return jsonb_build_object('state', 'off'); end if;
  select * into v from public.quote_validity x where x.quote_id = p_quote;
  if v.quote_id is null then return jsonb_build_object('state', 'none'); end if;
  t := public._a198_org_today(q.org_id);
  n := v.valid_until - t;
  st := case when not public._qv262_open(p_quote) then 'done' when n < 0 then 'expired' else 'valid' end;
  return jsonb_build_object('state', st, 'valid_until', to_char(v.valid_until, 'YYYY-MM-DD'),
    'valid_until_label', to_char(v.valid_until, 'DD/MM/YYYY'), 'days_left', n,
    'locked', st = 'expired' and (c ->> 'auto_lock')::boolean, 'auto_lock', (c ->> 'auto_lock')::boolean,
    'source', v.source, 'set_at', v.set_at);
end $$;

create or replace function public._qv262_actor_name(p_uid uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262
declare v text;
begin
  if p_uid is null then return null; end if;
  if to_regprocedure('public._sa54_name(uuid)') is not null then
    begin execute 'select public._sa54_name($1)' into v using p_uid; exception when others then v := null; end;
  end if;
  if v is null then select u.email into v from auth.users u where u.id = p_uid; end if;
  return left(coalesce(v, 'Someone'), 120);
end $$;

-- a bell row for the studio (kind quote_* : the 0153 bell already shows these to quote viewers only); never raises
create or replace function public._qv262_bell(p_org uuid, p_quote uuid, p_kind text, p_label text, p_extra jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262
declare v_code text;
begin
  select q.code into v_code from public.quotes q where q.id = p_quote;
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    values (p_quote, 'in_app', p_kind, 'simulated',
            jsonb_build_object('label', left(p_label, 300), 'via', 'quote_validity', 'source', '0262', 'event_code', v_code)
              || coalesce(p_extra, '{}'::jsonb), p_org);
exception when others then raise warning 'r23-quote-validity-0262: bell row skipped (%)', sqlstate;
end $$;

-- ---- 3) new quotes get the default date; the first send moves an automatic date forward ----------------------
create or replace function public._qv262_tg_quote_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r23-quote-validity-0262: never blocks creating a quote
declare c jsonb;
begin
  if new.org_id is null then return null; end if;
  begin
    c := public._qv262_cfg(new.org_id);
    if (c ->> 'enabled')::boolean then
      insert into public.quote_validity(quote_id, org_id, valid_until, source)
        values (new.id, new.org_id, public._a198_org_today(new.org_id) + (c ->> 'default_days')::integer, 'auto')
      on conflict (quote_id) do nothing;
    end if;
  exception when others then raise warning 'r23-quote-validity-0262: no valid-until date for the new quote (%)', sqlstate;
  end;
  return null;
end $$;

create or replace function public._qv262_tg_quote_sent()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r23-quote-validity-0262: approval link sent for the first time -> an AUTOMATIC date counts from today (only ever later)
declare c jsonb; v_old date; v_new date;
begin
  if coalesce(old.approval_status, 'none') <> 'none' or new.approval_status is distinct from 'sent' then return null; end if;
  begin
    c := public._qv262_cfg(new.org_id);
    if not (c ->> 'enabled')::boolean then return null; end if;
    v_new := public._a198_org_today(new.org_id) + (c ->> 'default_days')::integer;
    select x.valid_until into v_old from public.quote_validity x where x.quote_id = new.id and x.source = 'auto' for update;
    if v_old is not null and v_old < v_new then
      update public.quote_validity set valid_until = v_new, set_at = now() where quote_id = new.id and source = 'auto';
      insert into public.quote_validity_log(org_id, quote_id, action, old_until, new_until, note)
        values (new.org_id, new.id, 'auto', v_old, v_new, 'Approval link sent - the default validity counts from today');
    end if;
  exception when others then raise warning 'r23-quote-validity-0262: valid-until date not moved on send (%)', sqlstate;
  end;
  return null;
end $$;

drop trigger if exists zzzzzz_qv262_insert on public.quotes;
create trigger zzzzzz_qv262_insert after insert on public.quotes
  for each row execute function public._qv262_tg_quote_insert();
drop trigger if exists zzzzzz_qv262_sent on public.quotes;
create trigger zzzzzz_qv262_sent after update of approval_status on public.quotes
  for each row execute function public._qv262_tg_quote_sent();

-- ---- 4) SERVER lock: an expired quote can't be approved (every client approval path calls verify_and_consent) ---
-- the check itself (always refreshed); the public name is wrapped ONCE below
create or replace function public._qv262_verify(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text,
                                                p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r23-quote-validity-0262: refuse (code not used up) while the quote is past its valid-until date and the studio locks it
declare v_q uuid; v_org uuid; s jsonb; v_studio text; v_today date;
begin
  if p_token is not null then
    select q.id, q.org_id into v_q, v_org from public.quotes q where q.approval_token = p_token;
  end if;
  if v_q is not null then
    s := public._qv262_state(v_q);
    if coalesce((s ->> 'locked')::boolean, false) then
      select left(coalesce(nullif(btrim(o.name), ''), 'your event planner'), 80) into v_studio from public.organizations o where o.id = v_org;
      v_today := public._a198_org_today(v_org);
      begin
        insert into public.quote_validity_log(org_id, quote_id, action, old_until, note, dedupe_key)
          values (v_org, v_q, 'approve_refused', (s ->> 'valid_until')::date, 'The client tried to approve after the quote expired',
                  'refused:' || v_q || ':' || v_today)
        on conflict (dedupe_key) do nothing;
      exception when others then null;
      end;
      return jsonb_build_object('approved', false, 'error', 'quote_expired', 'valid_until', s ->> 'valid_until',
        'message', 'This quote expired on ' || (s ->> 'valid_until_label') || '. Ask ' || coalesce(v_studio, 'your event planner')
                   || ' for an updated quote.');
    end if;
  end if;
  return public.verify_and_consent__pre0262(p_token, p_phone, p_code, p_agreed, p_terms_version, p_consent_text, p_client_name, p_user_agent);
end $$;
-- wrap once: a 2nd run (or a run after a LATER wrapper of verify_and_consent) never replaces what is there
do $$ declare v_src text; begin
  if to_regprocedure('public.verify_and_consent__pre0262(uuid,text,text,boolean,text,text,text,text)') is null then
    alter function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) rename to verify_and_consent__pre0262;
    create function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text,
                                              p_consent_text text, p_client_name text, p_user_agent text)
      returns jsonb language sql volatile security definer set search_path = ''
      as 'select public._qv262_verify(p_token, p_phone, p_code, p_agreed, p_terms_version, p_consent_text, p_client_name, p_user_agent) /* r23-quote-validity-0262 */';
  else
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)');
    if position('_qv262_verify' in coalesce(v_src, '')) = 0 then
      raise notice '0262: verify_and_consent was wrapped again after 0262 - left unchanged (check the chain still reaches _qv262_verify)';
    end if;
  end if;
end $$;

-- ---- 5) client pages (signed out) ------------------------------------------------------------------------------
create or replace function public._qv262_quote_for(p_kind text, p_token uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262: the quote behind a LIVE client link (approval / portal link, or booklet link)
declare v uuid;
begin
  if p_token is null then return null; end if;
  if p_kind = 'booklet' then
    select b.quote_id into v from public.client_booklets b
     where b.token = p_token and b.revoked_at is null and b.expires_at > now()
     order by b.created_at desc limit 1;
  elsif p_kind = 'quote' then
    select q.id into v from public.quotes q
     where q.approval_token = p_token and q.approval_token_revoked_at is null
       and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  end if;
  return v;
end $$;

create or replace function public.public_quote_validity(p_kind text, p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262: what the client page shows (no ids, no money); null = nothing to show
declare v_q uuid; v_org uuid; s jsonb; v_studio text;
begin
  if p_token is null or coalesce(p_kind, '') not in ('quote', 'booklet') then return null; end if;
  if public.rate_hit('qv_read', p_token::text, 3600, 240) > 0 then return null; end if;
  v_q := public._qv262_quote_for(p_kind, p_token);
  if v_q is null then return null; end if;
  s := public._qv262_state(v_q);
  if s is null or s ->> 'state' not in ('valid', 'expired') then return jsonb_build_object('state', coalesce(s ->> 'state', 'none')); end if;
  select q.org_id into v_org from public.quotes q where q.id = v_q;
  select left(coalesce(nullif(btrim(o.name), ''), 'your event planner'), 80) into v_studio from public.organizations o where o.id = v_org;
  return jsonb_build_object('state', s ->> 'state', 'valid_until', s ->> 'valid_until', 'valid_until_label', s ->> 'valid_until_label',
    'days_left', (s ->> 'days_left')::integer, 'locked', (s ->> 'locked')::boolean, 'studio', v_studio,
    'requested', exists (select 1 from public.quote_validity_log l where l.quote_id = v_q and l.action = 'renew_request'
                           and l.created_at > now() - interval '24 hours'));
end $$;

create or replace function public.public_request_new_quote(p_kind text, p_token uuid, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262: the client asks for an updated quote after expiry -> one bell row to the studio per day
declare v_q uuid; v_org uuid; s jsonb; v_id uuid; v_note text; v_code text; v_studio text;
begin
  if p_token is null or coalesce(p_kind, '') not in ('quote', 'booklet') then raise exception 'invalid link' using errcode = 'P0001'; end if;
  if public.rate_hit('qv_renew', p_token::text, 3600, 5) > 0 then
    raise exception 'Too many requests - please try again later.' using errcode = 'HL429'; end if;
  v_q := public._qv262_quote_for(p_kind, p_token);
  if v_q is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  s := public._qv262_state(v_q);
  if coalesce(s ->> 'state', '') <> 'expired' then
    raise exception 'This quote has not expired - you can still approve it.' using errcode = '22023'; end if;
  select q.org_id, q.code into v_org, v_code from public.quotes q where q.id = v_q;
  select left(coalesce(nullif(btrim(o.name), ''), 'your event planner'), 80) into v_studio from public.organizations o where o.id = v_org;
  v_note := nullif(left(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]]+', ' ', 'g')), 300), '');
  begin
    insert into public.quote_validity_log(org_id, quote_id, action, old_until, note, dedupe_key)
      values (v_org, v_q, 'renew_request', (s ->> 'valid_until')::date, v_note,
              'renew:' || v_q || ':' || public._a198_org_today(v_org))
    on conflict (dedupe_key) do nothing
    returning id into v_id;
  exception when others then   -- e.g. a suspended (read-only) studio: never a raw error on the client's page
    return jsonb_build_object('status', 'unavailable', 'studio', v_studio);
  end;
  if v_id is null then return jsonb_build_object('status', 'already', 'studio', v_studio); end if;
  perform public._qv262_bell(v_org, v_q, 'quote_renew_request',
    'The client asked for an updated quote - ' || coalesce(v_code, 'quote') || ' expired on ' || (s ->> 'valid_until_label'),
    jsonb_build_object('valid_until', s ->> 'valid_until', 'has_note', v_note is not null));
  begin
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      values (null, null, 'quote_validity.renew_request', 'quotes', v_q::text, v_q,
              jsonb_build_object('valid_until', s ->> 'valid_until', 'link', p_kind, 'note', v_note), v_org);
  exception when others then null;
  end;
  return jsonb_build_object('status', 'sent', 'studio', v_studio);
end $$;

-- ---- 6) staff: settings ----------------------------------------------------------------------------------------
create or replace function public.quote_validity_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262
declare v_org uuid := public.current_org_id(); c jsonb; v_at timestamptz; n integer; t date;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not (public.has_area('quotes', 'view') or public.has_area('controls', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  c := public._qv262_cfg(v_org);
  select x.updated_at into v_at from public.app_config x where x.org_id = v_org and x.key = 'quote_validity';
  t := public._a198_org_today(v_org);
  select count(*) into n from public.quotes q
   where q.org_id = v_org and coalesce(q.status, '') <> 'cancelled' and q.deleted_at is null and q.archived_at is null
     and coalesce(q.approval_status, 'none') in ('none', 'sent') and (q.event_date is null or q.event_date >= t)
     and not exists (select 1 from public.quote_validity v where v.quote_id = q.id)
     and not exists (select 1 from public.quote_consents k where k.quote_id = q.id and k.agreed);
  return c || jsonb_build_object('can_edit', public.has_area('controls', 'edit') and coalesce(public.user_role(), '') <> 'client',
    'is_admin', coalesce(public.user_role(), '') = 'admin', 'open_without_date', n, 'updated_at', v_at,
    'today', to_char(t, 'YYYY-MM-DD'));
end $$;

create or replace function public.quote_validity_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262: Control Center EDIT; every value checked; merged (other keys kept)
declare v_org uuid := public.current_org_id(); v_new jsonb := '{}'::jsonb; k text; e jsonb; v_days integer[];
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Control Center) can change quote validity.' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  foreach k in array array['enabled', 'auto_lock', 'allow_override', 'client_reminders', 'studio_reminders'] loop
    if p ? k then
      if jsonb_typeof(p -> k) <> 'boolean' then raise exception '% must be true or false', k using errcode = '22023'; end if;
      v_new := v_new || jsonb_build_object(k, p -> k);
    end if;
  end loop;
  if p ? 'default_days' then
    if jsonb_typeof(p -> 'default_days') <> 'number' or (p ->> 'default_days') !~ '^[0-9]{1,3}$'
       or (p ->> 'default_days')::integer not between 1 and 365 then
      raise exception 'Quotes stay valid for 1 to 365 days.' using errcode = '22023'; end if;
    v_new := v_new || jsonb_build_object('default_days', (p ->> 'default_days')::integer);
  end if;
  if p ? 'reminder_days' then
    if jsonb_typeof(p -> 'reminder_days') <> 'array' or jsonb_array_length(p -> 'reminder_days') > 5 then
      raise exception 'Pick up to 5 reminder days.' using errcode = '22023'; end if;
    for e in select x from jsonb_array_elements(p -> 'reminder_days') x loop
      if jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-9]{1,2}$' or (e #>> '{}')::integer not between 0 and 60 then
        raise exception 'Reminder days are whole numbers from 0 (the last day) to 60.' using errcode = '22023'; end if;
    end loop;
    select coalesce(array_agg(distinct (x #>> '{}')::integer order by (x #>> '{}')::integer desc), '{}'::integer[]) into v_days
      from jsonb_array_elements(p -> 'reminder_days') x;
    v_new := v_new || jsonb_build_object('reminder_days', to_jsonb(v_days));
  end if;
  insert into public.app_config(org_id, key, value, updated_at) values (v_org, 'quote_validity', v_new, now())
  on conflict (org_id, key) do update
    set value = (case when jsonb_typeof(public.app_config.value) = 'object' then public.app_config.value else '{}'::jsonb end) || v_new,
        updated_at = now();
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id)
    values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'quote_validity.settings', 'app_config',
            'quote_validity', v_new, v_org);
  return public.quote_validity_settings_get();
end $$;

-- ---- 7) staff: one quote / a page of quotes -------------------------------------------------------------------
create or replace function public.quote_validity_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262
declare v_org uuid := public.current_org_id(); s jsonb; c jsonb; v_admin boolean := coalesce(public.user_role(), '') = 'admin';
        v_edit boolean; v_log jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this quote' using errcode = '42501'; end if;
  s := public._qv262_state(p_quote); c := public._qv262_cfg(v_org);
  v_edit := public.has_area('quotes', 'edit');
  select coalesce(jsonb_agg(jsonb_build_object('at', l.created_at, 'action', l.action,
           'old', to_char(l.old_until, 'DD/MM/YYYY'), 'new', to_char(l.new_until, 'DD/MM/YYYY'),
           'who', l.actor_name, 'note', l.note) order by l.created_at desc), '[]'::jsonb)
    into v_log from (select * from public.quote_validity_log x where x.quote_id = p_quote and x.org_id = v_org
                      order by x.created_at desc limit 10) l;
  return s || jsonb_build_object('can_edit', v_edit and s ->> 'state' in ('none', 'valid', 'expired'),
    'can_override', v_edit and ((c ->> 'allow_override')::boolean or v_admin),
    'default_days', (c ->> 'default_days')::integer, 'today', to_char(public._a198_org_today(v_org), 'YYYY-MM-DD'),
    'log', v_log);
end $$;

create or replace function public.quote_validity_list(p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262: { "<quote id>": {state, days_left, valid_until, valid_until_label, locked} } - only valid / expired
declare v_org uuid := public.current_org_id(); v jsonb := '{}'::jsonb; i uuid; s jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_ids is null then return v; end if;
  if array_length(p_ids, 1) > 200 then raise exception 'at most 200 quotes at a time' using errcode = '22023'; end if;
  for i in select distinct x from unnest(p_ids) x
             where exists (select 1 from public.quote_validity qv where qv.quote_id = x and qv.org_id = v_org) loop
    s := public._qv262_state(i);
    if s ->> 'state' in ('valid', 'expired') then
      v := v || jsonb_build_object(i::text, jsonb_build_object('state', s ->> 'state', 'days_left', (s ->> 'days_left')::integer,
             'valid_until', s ->> 'valid_until', 'valid_until_label', s ->> 'valid_until_label', 'locked', (s ->> 'locked')::boolean));
    end if;
  end loop;
  return v;
end $$;

-- ids of open quotes expiring within p_days (default: the largest reminder day, at least 3) or expired in the last 30 days
create or replace function public.quotes_expiring_soon(p_days integer default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262: for the Quotes "Attention" tab (max 200 ids)
declare v_org uuid := public.current_org_id(); c jsonb; t date; d integer;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  c := public._qv262_cfg(v_org);
  if not (c ->> 'enabled')::boolean then return '[]'::jsonb; end if;
  t := public._a198_org_today(v_org);
  d := coalesce(p_days, greatest(3, coalesce((select max((e #>> '{}')::integer) from jsonb_array_elements(c -> 'reminder_days') e), 3)));
  d := least(greatest(d, 0), 60);
  return coalesce((select jsonb_agg(x.quote_id order by x.valid_until, x.quote_id) from (
      select v.quote_id, v.valid_until from public.quote_validity v join public.quotes q on q.id = v.quote_id and q.org_id = v.org_id
       where v.org_id = v_org and v.valid_until between t - 30 and t + d
         and coalesce(q.status, '') <> 'cancelled' and q.deleted_at is null and q.archived_at is null
         and coalesce(q.approval_status, 'none') in ('none', 'sent')
         and not exists (select 1 from public.quote_consents k where k.quote_id = q.id and k.agreed)
       order by v.valid_until, v.quote_id limit 200) x), '[]'::jsonb);
end $$;

-- ---- 8) staff: change one quote's date (logged) --------------------------------------------------------------
create or replace function public._qv262_write(p_quote uuid, p_date date, p_source text, p_action text, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262: internal - callers check who may do it
declare v_org uuid; v_old date; v_uid uuid := auth.uid(); v_name text; v_email text;
begin
  select q.org_id into v_org from public.quotes q where q.id = p_quote;
  select x.valid_until into v_old from public.quote_validity x where x.quote_id = p_quote for update;
  insert into public.quote_validity(quote_id, org_id, valid_until, source, set_by, set_at)
    values (p_quote, v_org, p_date, p_source, v_uid, now())
  on conflict (quote_id) do update set valid_until = excluded.valid_until, source = excluded.source,
                                       set_by = excluded.set_by, set_at = excluded.set_at;
  v_name := public._qv262_actor_name(v_uid);
  select u.email into v_email from auth.users u where u.id = v_uid;
  insert into public.quote_validity_log(org_id, quote_id, action, old_until, new_until, actor, actor_name, note)
    values (v_org, p_quote, p_action, v_old, p_date, v_uid, v_name, p_note);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_uid, v_email, 'quote_validity.' || p_action, 'quotes', p_quote::text, p_quote,
            jsonb_build_object('old_valid_until', v_old, 'new_valid_until', p_date, 'note', p_note), v_org);
  return public.quote_validity_get(p_quote);
end $$;

create or replace function public._qv262_guard(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262: the shared checks for set / extend; returns the studio settings
declare v_org uuid := public.current_org_id(); c jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('quotes', 'edit') then
    raise exception 'Only someone who can edit quotes can change how long a quote is valid.' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this quote' using errcode = '42501'; end if;
  c := public._qv262_cfg(v_org);
  if not (c ->> 'enabled')::boolean then
    raise exception 'Quote validity is switched off for your studio (Control Center).' using errcode = '22023'; end if;
  if not public._qv262_open(p_quote) then
    raise exception 'This quote is already approved or cancelled - its validity no longer applies.' using errcode = '22023'; end if;
  return c;
end $$;

create or replace function public.quote_validity_set(p_quote uuid, p_date date, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262: a custom date (studio allows custom dates, or an admin)
declare c jsonb; t date; v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
begin
  c := public._qv262_guard(p_quote);
  if not ((c ->> 'allow_override')::boolean or coalesce(public.user_role(), '') = 'admin') then
    raise exception 'Your studio lets only admins pick a custom date - use Extend instead.' using errcode = '42501'; end if;
  t := public._a198_org_today(public.current_org_id());
  if p_date is null or p_date < t or p_date > t + 365 then
    raise exception 'Pick a date from today to one year ahead.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:qv:' || p_quote::text, 0));
  return public._qv262_write(p_quote, p_date, 'manual', 'set', v_note);
end $$;

create or replace function public.quote_validity_extend(p_quote uuid, p_days integer default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262: one click - from the later of today / the current date, + the default days (max 1 year ahead)
declare c jsonb; t date; d integer; v_cur date; v_new date;
begin
  c := public._qv262_guard(p_quote);
  d := coalesce(p_days, (c ->> 'default_days')::integer);
  if d < 1 or d > 365 then raise exception 'Extend by 1 to 365 days.' using errcode = '22023'; end if;
  if d <> (c ->> 'default_days')::integer and not ((c ->> 'allow_override')::boolean or coalesce(public.user_role(), '') = 'admin') then
    raise exception 'Your studio lets only admins pick a custom length - extend by the default days.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:qv:' || p_quote::text, 0));
  t := public._a198_org_today(public.current_org_id());
  select x.valid_until into v_cur from public.quote_validity x where x.quote_id = p_quote;
  v_new := least(greatest(coalesce(v_cur, t), t) + d, t + 365);
  return public._qv262_write(p_quote, v_new, 'extended', 'extended', 'Extended by ' || d || ' day(s)');
end $$;

-- admin: give open, never-approved quotes WITHOUT a date today + the default (rows added only; dry run first)
create or replace function public.quote_validity_apply_open(p_apply boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262
declare v_org uuid := public.current_org_id(); c jsonb; t date; v_until date; n integer := 0; r record; v_uid uuid := auth.uid();
        v_name text;
begin
  if v_uid is null or v_org is null or coalesce(public.user_role(), '') <> 'admin' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin can apply a valid-until date to open quotes.' using errcode = '42501'; end if;
  c := public._qv262_cfg(v_org);
  if not (c ->> 'enabled')::boolean then
    raise exception 'Switch quote validity on first.' using errcode = '22023'; end if;
  t := public._a198_org_today(v_org); v_until := t + (c ->> 'default_days')::integer;
  perform pg_advisory_xact_lock(hashtextextended('helm:qv-bulk:' || v_org::text, 0));
  v_name := public._qv262_actor_name(v_uid);
  for r in select q.id from public.quotes q
            where q.org_id = v_org and coalesce(q.status, '') <> 'cancelled' and q.deleted_at is null and q.archived_at is null
              and coalesce(q.approval_status, 'none') in ('none', 'sent') and (q.event_date is null or q.event_date >= t)
              and not exists (select 1 from public.quote_validity v where v.quote_id = q.id)
              and not exists (select 1 from public.quote_consents k where k.quote_id = q.id and k.agreed)
            order by q.created_at, q.id loop
    n := n + 1;
    if p_apply then
      insert into public.quote_validity(quote_id, org_id, valid_until, source, set_by) values (r.id, v_org, v_until, 'bulk', v_uid)
        on conflict (quote_id) do nothing;
      insert into public.quote_validity_log(org_id, quote_id, action, new_until, actor, actor_name, note)
        values (v_org, r.id, 'bulk', v_until, v_uid, v_name, 'Applied to open quotes from Control Center');
    end if;
  end loop;
  if p_apply and n > 0 then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id)
      values (v_uid, (select u.email from auth.users u where u.id = v_uid), 'quote_validity.apply_open', 'quotes', null,
              jsonb_build_object('count', n, 'valid_until', v_until), v_org);
  end if;
  return jsonb_build_object('count', n, 'applied', p_apply and n > 0, 'valid_until', to_char(v_until, 'YYYY-MM-DD'),
                            'valid_until_label', to_char(v_until, 'DD/MM/YYYY'));
end $$;

-- ---- 9) reminders: studio bell + client e-mail QUEUED (comms_outbox purpose 'quote_expiry') ------------------
do $$
declare c record; v_vals text[]; v_list text;
begin
  select con.conname, pg_get_constraintdef(con.oid) as def into c
    from pg_constraint con
   where con.conrelid = 'public.comms_outbox'::regclass and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%purpose%' and pg_get_constraintdef(con.oid) like '%pay_reminder%'
   order by con.conname limit 1;
  if c.conname is not null and position('quote_expiry' in c.def) > 0 then return; end if;
  if c.conname is not null then
    select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(c.def, '''([a-z_]+)''', 'g') m;
  end if;
  v_vals := coalesce(v_vals, array['follow_up', 'pay_reminder', 'wa_forward']::text[]);
  if not ('quote_expiry' = any (v_vals)) then v_vals := v_vals || 'quote_expiry'::text; end if;
  select string_agg(quote_literal(x), ', ' order by x) into v_list from unnest(v_vals) x;
  -- superset: every existing row still passes (add the new check first, then retire the narrower one)
  execute format('alter table public.comms_outbox add constraint comms_outbox_purpose_check_0262 check (purpose in (%s))', v_list);
  if c.conname is not null then execute format('alter table public.comms_outbox drop constraint %I', c.conname); end if;
  execute 'alter table public.comms_outbox rename constraint comms_outbox_purpose_check_0262 to comms_outbox_purpose_check';
end $$;

-- the client's approval link path (same rule as the app: /<studio link name>/quote/<token>, else approve.html?token=)
create or replace function public._qv262_link_path(p_quote uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r23-quote-validity-0262
  select case when q.approval_token is null then null
              when coalesce(o.public_slug, '') ~ '^[a-z0-9-]{3,40}$' then o.public_slug || '/quote/' || q.approval_token::text
              else 'approve.html?token=' || q.approval_token::text end
    from public.quotes q left join public.organizations o on o.id = q.org_id
   where q.id = p_quote and q.approval_token is not null and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
$$;

create or replace function public.quote_validity_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262: service role / pg_cron only. Each reminder at most once (dedupe in quote_validity_log).
declare r record; c jsonb; t date; d integer; v_id uuid; v_to text; v_name text; v_studio text; n_s integer := 0; n_c integer := 0;
        n_e integer := 0; v_lbl text;
begin
  for r in
    select v.quote_id, v.org_id, v.valid_until, q.code, q.client, q.approval_status, coalesce(q.is_demo, false) as is_demo
      from public.quote_validity v join public.quotes q on q.id = v.quote_id and q.org_id = v.org_id
     where v.valid_until between current_date - 3 and current_date + 62
       and coalesce(q.status, '') <> 'cancelled' and q.deleted_at is null and q.archived_at is null
       and coalesce(q.approval_status, 'none') in ('none', 'sent')
       and not exists (select 1 from public.quote_consents k where k.quote_id = q.id and k.agreed)
     order by v.valid_until, v.quote_id
     limit 5000
  loop
    begin
      c := public._qv262_cfg(r.org_id);
      if not (c ->> 'enabled')::boolean then continue; end if;
      t := public._a198_org_today(r.org_id);
      d := r.valid_until - t;
      v_lbl := to_char(r.valid_until, 'DD/MM/YYYY');
      if d >= 0 and (c -> 'reminder_days') @> to_jsonb(d) then
        if (c ->> 'studio_reminders')::boolean then
          v_id := null;
          insert into public.quote_validity_log(org_id, quote_id, action, new_until, note, dedupe_key)
            values (r.org_id, r.quote_id, 'reminder_studio', r.valid_until, d || ' day(s) left',
                    'rem:s:' || r.quote_id || ':' || r.valid_until || ':' || d)
          on conflict (dedupe_key) do nothing returning id into v_id;
          if v_id is not null then
            perform public._qv262_bell(r.org_id, r.quote_id, 'quote_expiring',
              'Quote ' || coalesce(r.code, '') || case when d = 0 then ' expires today' when d = 1 then ' expires tomorrow'
                                                   else ' expires in ' || d || ' days' end || ' (' || v_lbl || ')',
              jsonb_build_object('valid_until', to_char(r.valid_until, 'YYYY-MM-DD'), 'days_left', d));
            n_s := n_s + 1;
          end if;
        end if;
        if (c ->> 'client_reminders')::boolean and r.approval_status = 'sent' and not r.is_demo
           and public._qv262_link_path(r.quote_id) is not null then
          v_to := public._comms_client_to(r.client, 'email');
          if v_to is not null and not public._sample_outbound_blocked(r.org_id, v_to) then
            v_id := null;
            insert into public.quote_validity_log(org_id, quote_id, action, new_until, note, dedupe_key)
              values (r.org_id, r.quote_id, 'reminder_client', r.valid_until, d || ' day(s) left - e-mail queued',
                      'rem:c:' || r.quote_id || ':' || r.valid_until || ':' || d)
            on conflict (dedupe_key) do nothing returning id into v_id;
            if v_id is not null then
              v_name := coalesce(nullif(left(regexp_replace(btrim(coalesce(r.client ->> 'name', '')), '\s+', ' ', 'g'), 60), ''), 'there');
              select left(regexp_replace(btrim(coalesce(o.name, '')), '\s+', ' ', 'g'), 60) into v_studio from public.organizations o where o.id = r.org_id;
              v_studio := coalesce(nullif(v_studio, ''), 'your event planner');
              insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key)
                values (r.org_id, r.quote_id, 'quote_expiry', 'email', v_to,
                        jsonb_build_object('body', 'Hi ' || v_name || ', your quote ' || left(coalesce(r.code, 'from us'), 40) || ' from '
                                                   || v_studio || ' is valid until ' || v_lbl || '.',
                                           'studio', v_studio, 'valid_until', to_char(r.valid_until, 'YYYY-MM-DD'),
                                           'valid_until_label', v_lbl, 'days_left', d,
                                           'subject', 'Your quote from ' || v_studio || ' is valid until ' || v_lbl),
                        'qv:' || v_id)
              on conflict (dedupe_key) do nothing;
              n_c := n_c + 1;
            end if;
          end if;
        end if;
      elsif d = -1 and (c ->> 'studio_reminders')::boolean then
        v_id := null;
        insert into public.quote_validity_log(org_id, quote_id, action, new_until, note, dedupe_key)
          values (r.org_id, r.quote_id, 'expired_studio', r.valid_until, 'Expired', 'exp:' || r.quote_id || ':' || r.valid_until)
        on conflict (dedupe_key) do nothing returning id into v_id;
        if v_id is not null then
          perform public._qv262_bell(r.org_id, r.quote_id, 'quote_expired',
            'Quote ' || coalesce(r.code, '') || ' expired on ' || v_lbl || ' - extend it or send an updated quote',
            jsonb_build_object('valid_until', to_char(r.valid_until, 'YYYY-MM-DD'), 'days_left', d));
          n_e := n_e + 1;
        end if;
      end if;
    exception when others then raise warning 'r23-quote-validity-0262: reminder skipped for one quote (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('studio', n_s, 'client', n_c, 'expired', n_e);
end $$;

-- dispatcher claim: 'quote_expiry' rows (re-checked now, link path added), then the previous claim for the rest
create or replace function public._qv262_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262: 'quote_expiry' rows (still open, same date, studio switch on, same client e-mail, live link)
declare r record; v_lim integer := greatest(1, least(coalesce(p_limit, 25), 100)); v_n integer := 0; v_out jsonb := '[]'::jsonb;
        v_ok boolean; v_path text; s jsonb; c jsonb; v_client jsonb;
begin
  update public.comms_outbox set status = 'failed', sent_at = now()
   where purpose = 'quote_expiry' and sent_at is null and attempts >= 5;
  update public.comms_outbox set status = 'skipped', sent_at = now()
   where purpose = 'quote_expiry' and sent_at is null and created_at < now() - interval '2 days';
  for r in select x.* from public.comms_outbox x
     where x.purpose = 'quote_expiry' and x.sent_at is null and x.status = 'pending'
       and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes')
     order by x.created_at limit v_lim for update skip locked
  loop
    v_path := null; v_client := null;
    s := public._qv262_state(r.quote_id); c := public._qv262_cfg(r.org_id);
    select q.client into v_client from public.quotes q where q.id = r.quote_id and q.org_id = r.org_id;
    v_ok := r.channel = 'email' and coalesce(s ->> 'state', '') = 'valid'
            and (s ->> 'valid_until') is not distinct from (r.payload ->> 'valid_until')
            and (c ->> 'client_reminders')::boolean
            and public._comms_quote_live(r.quote_id)
            and not coalesce((select q.is_demo from public.quotes q where q.id = r.quote_id), false)
            and public._comms_client_to(v_client, 'email') is not distinct from r.recipient
            and not public._sample_outbound_blocked(r.org_id, r.recipient);
    if v_ok then v_path := public._qv262_link_path(r.quote_id); v_ok := v_path is not null; end if;
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
    v_out := v_out || coalesce(public.comms_outbox_claim__pre0262(v_lim - v_n), '[]'::jsonb);
  end if;
  return v_out;
end $$;
do $$ declare v_src text; begin
  if to_regprocedure('public.comms_outbox_claim__pre0262(integer)') is null then
    alter function public.comms_outbox_claim(integer) rename to comms_outbox_claim__pre0262;
    create function public.comms_outbox_claim(p_limit integer default 25)
      returns jsonb language sql volatile security definer set search_path = ''
      as 'select public._qv262_claim(p_limit) /* r23-quote-validity-0262 */';
  else
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.comms_outbox_claim(integer)');
    if position('_qv262_claim' in coalesce(v_src, '')) = 0 then
      raise notice '0262: comms_outbox_claim was wrapped again after 0262 - left unchanged';
    end if;
  end if;
end $$;

-- ---- 10) privileges -------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._qv262_cfg(uuid)', 'public._qv262_open(uuid)', 'public._qv262_state(uuid)',
                           'public._qv262_actor_name(uuid)', 'public._qv262_bell(uuid, uuid, text, text, jsonb)',
                           'public._qv262_tg_quote_insert()', 'public._qv262_tg_quote_sent()',
                           'public._qv262_quote_for(text, uuid)', 'public._qv262_write(uuid, date, text, text, text)',
                           'public._qv262_guard(uuid)', 'public._qv262_link_path(uuid)', 'public._qv262_claim(integer)',
                           'public._qv262_verify(uuid, text, text, boolean, text, text, text, text)',
                           'public.verify_and_consent__pre0262(uuid, text, text, boolean, text, text, text, text)',
                           'public.quote_validity_tick()', 'public.comms_outbox_claim(integer)',
                           'public.comms_outbox_claim__pre0262(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  -- signed-in studio members
  foreach f in array array['public.quote_validity_settings_get()', 'public.quote_validity_settings_set(jsonb)',
                           'public.quote_validity_get(uuid)', 'public.quote_validity_list(uuid[])',
                           'public.quotes_expiring_soon(integer)', 'public.quote_validity_set(uuid, date, text)',
                           'public.quote_validity_extend(uuid, integer)', 'public.quote_validity_apply_open(boolean)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  -- signed-out client pages (and the approval wrapper, same grants as before)
  foreach f in array array['public.public_quote_validity(text, uuid)', 'public.public_request_new_quote(text, uuid, text)',
                           'public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- 11) pg_cron, ONLY if it is already installed (never created here) -----------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_quote_validity') then
        perform cron.schedule('helm_quote_validity', '7 * * * *', 'select public.quote_validity_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_quote_validity could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';
