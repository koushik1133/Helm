-- ============================================================================
-- 0054_security_alerts.sql — CANONICAL forward-only. Security alerts.
-- REQUIRES 0036 (notification prefs), 0045 (HQ), 0049 (close overrides),
-- 0052 (lifecycle overrides). Works with or without 0053 (password lockouts).
--
-- What this adds, in plain words:
--   1  security_alert_events — one row per security-relevant thing that happened
--      (admin override, MFA / password lockout, rejected upload, studio suspended /
--      reactivated, a member's role changed or a member removed, an HQ operator
--      added / removed). Names only — never e-mails, phone numbers, tokens, links,
--      file names or free-text reasons. RLS on, no API grants (HQ reads it via RPC).
--   2  Studio admins get an in-app bell notification (kind 'security_alert', new
--      catalog type 'security_alert', group "Security"). By default ONLY the admin
--      role sees it; a studio admin can turn it on for other roles in Control Center
--      (0036 per-role prefs). Non-admins can't read these rows directly either.
--   3  Throttle: at most ONE notification (and one queued e-mail) per alert type per
--      studio per 10 minutes. Later events inside the window only raise its count.
--   4  security_alert_outbox — queued e-mails for the DORMANT edge function
--      security-alert-mailer (nothing is sent until the owner deploys + enables it).
--      Studio e-mail can be switched off in Control Center (type security_alert,
--      channel email). Service-role-only claim/mark RPCs.
--   5  hq_security_alerts(from, to) — HQ operators only: counts per type, per studio
--      and the latest events across all studios (no e-mails / PII beyond names).
--
-- Triggers are AFTER INSERT (audit_log, event_close_overrides,
-- lifecycle_stage_overrides) and AFTER UPDATE OF role / AFTER DELETE (profiles),
-- SECURITY DEFINER, and exception-safe: an alert failure NEVER blocks the original
-- action (the alert work runs in its own sub-transaction and is dropped on error).
-- The alert tables are SYSTEM tables (written only by these triggers, no client access),
-- so they carry no studio read-only (suspension) guard: a suspended studio's lockouts
-- still reach HQ. HQ never sees event codes or quote links.
--
-- DRIFT-SAFE: notification_catalog(), notification_type_of(text,text) and
-- notify_default(uuid,text,text,text) are renamed ONCE to *__pre0054 and wrapped (the
-- database's own bodies are kept). Optional source tables are attached only when they
-- exist. Additive + idempotent: no DROP TABLE / column, no DELETE, no backfill.
-- ============================================================================

-- ---- 0) keep this database's own bodies (rename once) ------------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['notification_catalog', ''],
    ['notification_type_of', 'text, text'],
    ['notify_default',       'uuid, text, text, text']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0054', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        raise exception '0054: public.%(%) is missing on this database (apply 0036 first)', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0054');
    end if;
    execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0054', f[2]);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%I(%s) from anon', f[1] || '__pre0054', f[2]); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function public.%I(%s) from authenticated', f[1] || '__pre0054', f[2]); end if;
  end loop;
end $$;

-- ---- 1) catalog: + security_alert ---------------------------------------------------
create or replace function public.notification_catalog()
returns jsonb language sql immutable set search_path = '' as $$
  -- security-alerts-0054: the database's own catalog + the Security type (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'security_alert') then c
    else c || $cat$[
    {"type":"security_alert","group":"Security","label":"Security alerts","audience":"studio",
     "description":"Admin overrides, sign-in lockouts, rejected uploads, role changes, removed members and studio suspension. Admins only by default; similar alerts are grouped (one per type every 10 minutes).",
     "channels":["in_app","email"],"required":[],"gated":["email"],"money":false}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0054() as c) x;
$$;

create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable set search_path = '' as $$
  select case when lower(btrim(coalesce(p_kind, ''))) = 'security_alert' then 'security_alert'
              else public.notification_type_of__pre0054(p_kind, p_channel) end;
$$;

create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- security-alerts-0054: the bell shows security alerts to admins only unless a studio admin opts a role in
  select case when p_type = 'security_alert' and p_channel = 'in_app' then coalesce(p_role = 'admin', false)
              else public.notify_default__pre0054(p_org, p_role, p_type, p_channel) end;
$$;

-- ---- 2) tables ------------------------------------------------------------------------
create table if not exists public.security_alert_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete set null,   -- NULL = HQ-level
  alert_type  text not null check (alert_type ~ '^[a-z_]{1,40}$'),
  source      text not null check (source ~ '^[a-z_.]{1,60}$'),
  detail      jsonb not null default '{}'::jsonb,                             -- names / codes / roles only
  created_at  timestamptz not null default now()
);
create index if not exists security_alert_events_at_idx  on public.security_alert_events (created_at desc);
create index if not exists security_alert_events_org_idx on public.security_alert_events (org_id, alert_type, created_at desc);

create table if not exists public.security_alert_throttle (
  org_key         uuid not null,                       -- studio id, or the zero uuid for HQ-level
  alert_type      text not null,
  window_start    timestamptz not null,
  count           integer not null default 1,
  notification_id uuid,
  outbox_id       uuid,
  updated_at      timestamptz not null default now(),
  primary key (org_key, alert_type)
);

create table if not exists public.security_alert_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete set null,   -- NULL = HQ-level (HQ inbox)
  alert_type  text not null,
  count       integer not null default 1,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  claimed_at  timestamptz,
  attempts    integer not null default 0,
  sent_at     timestamptz,
  status      text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  created_at  timestamptz not null default now()
);
create index if not exists security_alert_outbox_pending_idx on public.security_alert_outbox (created_at) where sent_at is null;

do $$ declare t text; begin
  foreach t in array array['security_alert_events', 'security_alert_throttle', 'security_alert_outbox'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on public.%I from authenticated', t); end if;
  end loop;
end $$;

-- ---- 3) notifications: security rows are admin-readable only and never client-written ---
drop policy if exists sa54_read on public.notifications;
create policy sa54_read on public.notifications as restrictive for select to authenticated
  using (coalesce(kind, '') <> 'security_alert' or (select public.is_admin()));
drop policy if exists sa54_ins on public.notifications;
create policy sa54_ins on public.notifications as restrictive for insert to authenticated
  with check (coalesce(kind, '') <> 'security_alert');
drop policy if exists sa54_upd on public.notifications;
create policy sa54_upd on public.notifications as restrictive for update to authenticated
  using (coalesce(kind, '') <> 'security_alert') with check (coalesce(kind, '') <> 'security_alert');
drop policy if exists sa54_del on public.notifications;
create policy sa54_del on public.notifications as restrictive for delete to authenticated
  using (coalesce(kind, '') <> 'security_alert');

-- ---- 4) the core: record + throttle + notify + queue ----------------------------------
create or replace function public._sa54_label(p_type text)
returns text language sql immutable set search_path = '' as $$
  select case p_type
    when 'admin_override'     then 'Admin override used'
    when 'mfa_lockout'        then 'Two-step sign-in locked'
    when 'password_lockout'   then 'Sign-in locked after failed passwords'
    when 'upload_rejected'    then 'Upload rejected by the scanner'
    when 'studio_suspended'   then 'Studio suspended by Helm'
    when 'studio_reactivated' then 'Studio reactivated by Helm'
    when 'role_changed'       then 'Member role changed'
    when 'member_removed'     then 'Member removed'
    when 'hq_operator_added'  then 'HQ operator added'
    when 'hq_operator_removed' then 'HQ operator removed'
    else 'Security event' end;
$$;

-- a person's display name (never the e-mail)
create or replace function public._sa54_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select left(nullif(btrim(p.full_name), ''), 80) from public.profiles p where p.id = p_user;
$$;

create or replace function public._security_alert(p_org uuid, p_type text, p_source text,
                                                 p_quote uuid default null, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key uuid := coalesce(p_org, '00000000-0000-0000-0000-000000000000'::uuid);
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_quote uuid := p_quote;
  v_count int; v_nid uuid; v_oid uuid; v_new boolean;
begin
  -- names / codes / roles only — strip anything that could carry a secret or a link
  v_detail := jsonb_strip_nulls(v_detail - array['email', 'actor_email', 'phone', 'token', 'url', 'link', 'reason', 'name', 'owner']);
  if v_quote is not null and p_org is not null
     and not exists (select 1 from public.quotes q where q.id = v_quote and q.org_id = p_org) then
    v_quote := null;
  end if;
  -- the HQ log keeps no event code / quote link (HQ shows no studio business data)
  insert into public.security_alert_events(org_id, alert_type, source, detail)
    values (p_org, p_type, p_source, v_detail - 'event_code');

  insert into public.security_alert_throttle as t (org_key, alert_type, window_start, count, updated_at)
    values (v_key, p_type, clock_timestamp(), 1, clock_timestamp())
  on conflict (org_key, alert_type) do update set
    count           = case when t.window_start > clock_timestamp() - interval '10 minutes' then t.count + 1 else 1 end,
    notification_id = case when t.window_start > clock_timestamp() - interval '10 minutes' then t.notification_id else null end,
    outbox_id       = case when t.window_start > clock_timestamp() - interval '10 minutes' then t.outbox_id else null end,
    window_start    = case when t.window_start > clock_timestamp() - interval '10 minutes' then t.window_start else clock_timestamp() end,
    updated_at      = clock_timestamp()
  returning t.count, t.notification_id, t.outbox_id into v_count, v_nid, v_oid;
  v_new := (v_count = 1);

  if v_new then
    if p_org is not null then
      begin   -- e.g. a suspended studio's read-only guard: keep the HQ record + e-mail anyway
        insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
          values (v_quote, 'in_app', 'security_alert', 'simulated',
                  v_detail || jsonb_build_object('alert', p_type, 'label', public._sa54_label(p_type), 'count', 1),
                  p_org)
          returning id into v_nid;
      exception when others then v_nid := null;
      end;
    end if;
    insert into public.security_alert_outbox(org_id, alert_type, count) values (p_org, p_type, 1) returning id into v_oid;
    update public.security_alert_throttle set notification_id = v_nid, outbox_id = v_oid
     where org_key = v_key and alert_type = p_type;
  else
    if v_nid is not null then
      begin
      update public.notifications
         set detail = coalesce(detail, '{}'::jsonb) || v_detail
                      || jsonb_build_object('alert', p_type, 'label', public._sa54_label(p_type), 'count', v_count),
             created_at = now()                       -- resurfaces as unread with the new count
       where id = v_nid and kind = 'security_alert';
      exception when others then null;
      end;
    end if;
    if v_oid is not null then
      update public.security_alert_outbox set count = v_count, last_at = now()
       where id = v_oid and sent_at is null;
    end if;
  end if;
end $$;

-- the never-block wrapper every trigger uses
create or replace function public._security_alert_safe(p_org uuid, p_type text, p_source text,
                                                      p_quote uuid default null, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    perform public._security_alert(p_org, p_type, p_source, p_quote, p_detail);
  exception when others then
    null;   -- an alert must never block (or roll back) the action that caused it
  end;
end $$;

-- ---- 5) triggers -------------------------------------------------------------------------
-- audit_log: lockouts, rejected uploads, studio suspend / reactivate, HQ operators
create or replace function public.tg_sa54_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_act text := lower(coalesce(new.action, '')); v_org uuid := new.org_id; v_type text; v_det jsonb := '{}'::jsonb;
begin
  begin
    if v_act = 'auth.mfa.locked' then
      v_type := 'mfa_lockout';
    elsif v_act like 'auth.%' and v_act like '%lock%' and v_act not like '%unlock%' and v_act not like 'auth.mfa.%' then
      v_type := 'password_lockout';                                   -- 0053 (e.g. auth.password.locked)
    elsif v_act = 'upload.rejected' then
      v_type := 'upload_rejected';
    elsif v_act in ('hq.studio.suspend', 'hq.studio.reactivate') then
      v_type := case when v_act = 'hq.studio.suspend' then 'studio_suspended' else 'studio_reactivated' end;
      if coalesce(new.entity_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_org := new.entity_id::uuid;
      end if;
    elsif v_act in ('hq.operator.add', 'hq.operator.remove') then
      v_type := case when v_act = 'hq.operator.add' then 'hq_operator_added' else 'hq_operator_removed' end;
      v_org := null;                                                  -- HQ-level only
    else
      return null;
    end if;
    if v_type in ('mfa_lockout', 'password_lockout') then
      if v_org is null and new.actor is not null then
        select p.org_id into v_org from public.profiles p where p.id = new.actor;
      end if;
      if v_org is null and coalesce(new.entity_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select p.org_id into v_org from public.profiles p where p.id = new.entity_id::uuid;
        v_det := jsonb_build_object('subject_name', public._sa54_name(new.entity_id::uuid));
      else
        v_det := jsonb_build_object('subject_name', public._sa54_name(new.actor));
      end if;
    elsif v_type = 'upload_rejected' then
      v_det := jsonb_build_object('bucket', left(coalesce(new.changed ->> 'bucket', ''), 40));
    end if;
    if v_org is not null and not exists (select 1 from public.organizations o where o.id = v_org) then v_org := null; end if;
    perform public._security_alert_safe(v_org, v_type, 'audit_log.' || left(regexp_replace(v_act, '[^a-z_.]', '_', 'g'), 40),
                                        null, v_det);
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists zzz_sa54_audit on public.audit_log;
create trigger zzz_sa54_audit after insert on public.audit_log
  for each row when (new.action = 'auth.mfa.locked' or new.action = 'upload.rejected'
                     or new.action in ('hq.studio.suspend', 'hq.studio.reactivate', 'hq.operator.add', 'hq.operator.remove')
                     or (new.action like 'auth.%' and new.action ilike '%lock%'))
  execute function public.tg_sa54_audit();

-- admin overrides (close_event override 0049, lifecycle stage override 0052)
create or replace function public.tg_sa54_override()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public._security_alert_safe(new.org_id, 'admin_override', TG_TABLE_NAME, new.quote_id,
      jsonb_build_object('actor_name', public._sa54_name(new.actor),
                         'event_code', (select left(q.code, 40) from public.quotes q where q.id = new.quote_id),
                         'override', case when TG_TABLE_NAME = 'event_close_overrides' then 'close_event'
                                          else 'stage:' || left(coalesce(to_jsonb(new) ->> 'to_stage', ''), 30) end));
  exception when others then null;
  end;
  return null;
end $$;
do $$ begin
  if to_regclass('public.event_close_overrides') is not null then
    execute 'drop trigger if exists zzz_sa54_override on public.event_close_overrides';
    execute 'create trigger zzz_sa54_override after insert on public.event_close_overrides for each row execute function public.tg_sa54_override()';
  end if;
  if to_regclass('public.lifecycle_stage_overrides') is not null then
    execute 'drop trigger if exists zzz_sa54_override on public.lifecycle_stage_overrides';
    execute 'create trigger zzz_sa54_override after insert on public.lifecycle_stage_overrides for each row execute function public.tg_sa54_override()';
  end if;
end $$;

-- role changes + removed members
create or replace function public.tg_sa54_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if TG_OP = 'UPDATE' then
      if new.org_id is not null and old.role is distinct from new.role then
        perform public._security_alert_safe(new.org_id, 'role_changed', 'profiles.role', null,
          jsonb_build_object('subject_name', left(nullif(btrim(new.full_name), ''), 80),
                             'actor_name', public._sa54_name(auth.uid()),
                             'old_role', left(old.role, 20), 'new_role', left(new.role, 20)));
      end if;
    elsif TG_OP = 'DELETE' then
      if old.org_id is not null and coalesce(old.role, '') <> 'client'
         and exists (select 1 from public.organizations o where o.id = old.org_id) then
        perform public._security_alert_safe(old.org_id, 'member_removed', 'profiles.delete', null,
          jsonb_build_object('subject_name', left(nullif(btrim(old.full_name), ''), 80),
                             'actor_name', public._sa54_name(auth.uid()), 'old_role', left(old.role, 20)));
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists zzz_sa54_profile_role on public.profiles;
create trigger zzz_sa54_profile_role after update of role on public.profiles
  for each row when (old.role is distinct from new.role) execute function public.tg_sa54_profile();
drop trigger if exists zzz_sa54_profile_del on public.profiles;
create trigger zzz_sa54_profile_del after delete on public.profiles
  for each row execute function public.tg_sa54_profile();

-- ---- 6) HQ feed ---------------------------------------------------------------------------
create or replace function public.hq_security_alerts(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare f date := coalesce(p_from, current_date - 30); t date := coalesce(p_to, current_date);
begin
  perform public._hq_gate('hq_security_alerts', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  return jsonb_build_object('from', f, 'to', t,
    'total', (select count(*) from public.security_alert_events e where e.created_at >= f and e.created_at < t + 1),
    'by_type', coalesce((select jsonb_agg(x order by x ->> 'latest' desc) from (
        select jsonb_build_object('type', e.alert_type, 'label', public._sa54_label(e.alert_type),
                                  'count', count(*), 'studios', count(distinct e.org_id), 'latest', max(e.created_at)) x
          from public.security_alert_events e where e.created_at >= f and e.created_at < t + 1
         group by e.alert_type) z), '[]'::jsonb),
    'by_studio', coalesce((select jsonb_agg(x order by x ->> 'latest' desc) from (
        select jsonb_build_object('org_id', e.org_id, 'studio', coalesce(o.name, case when e.org_id is null then 'Helm HQ' else 'Unknown studio' end),
                                  'type', e.alert_type, 'label', public._sa54_label(e.alert_type),
                                  'count', count(*), 'latest', max(e.created_at)) x
          from public.security_alert_events e left join public.organizations o on o.id = e.org_id
         where e.created_at >= f and e.created_at < t + 1
         group by e.org_id, o.name, e.alert_type
         order by max(e.created_at) desc limit 300) z), '[]'::jsonb),
    'latest', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
        select jsonb_build_object('at', e.created_at, 'type', e.alert_type, 'label', public._sa54_label(e.alert_type),
                                  'studio', coalesce(o.name, case when e.org_id is null then 'Helm HQ' else 'Unknown studio' end),
                                  'actor_name', e.detail ->> 'actor_name', 'subject_name', e.detail ->> 'subject_name') x
          from public.security_alert_events e left join public.organizations o on o.id = e.org_id
         where e.created_at >= f and e.created_at < t + 1
         order by e.created_at desc limit 100) z), '[]'::jsonb));
end $$;

-- ---- 7) outbox (service role only — the dormant security-alert-mailer) ---------------------
-- claim up to p_limit pending rows (a row is re-claimable after 10 minutes; 5 tries max).
-- Studio rows go to that studio's admins unless the studio switched security e-mail off
-- (then the row is marked skipped). HQ rows (org NULL) carry no recipients — the mailer
-- sends them to its own configured HQ inbox.
create or replace function public.security_alert_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb; v_to jsonb;
begin
  update public.security_alert_outbox set status = 'failed', sent_at = now()
   where sent_at is null and attempts >= 5;
  for r in
    select o.* from public.security_alert_outbox o
     where o.sent_at is null and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  loop
    if r.org_id is not null and not public.notify_allowed(r.org_id, '*', 'security_alert', 'email') then
      update public.security_alert_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
      from public.profiles p where r.org_id is not null and p.org_id = r.org_id and p.role = 'admin' and p.email is not null;
    if r.org_id is not null and jsonb_array_length(v_to) = 0 then
      update public.security_alert_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.security_alert_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'hq', r.org_id is null, 'type', r.alert_type, 'label', public._sa54_label(r.alert_type),
      'count', r.count, 'first_at', r.first_at, 'last_at', r.last_at,
      'studio', (select o.name from public.organizations o where o.id = r.org_id), 'to', v_to));
  end loop;
  return v_out;
end $$;

create or replace function public.security_alert_outbox_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.security_alert_outbox set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.security_alert_outbox set status = p_status, sent_at = now() where id = p_id and sent_at is null;
  return p_status;
end $$;

-- ---- 8) grants -----------------------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array[
    'public._sa54_label(text)', 'public._sa54_name(uuid)',
    'public._security_alert(uuid, text, text, uuid, jsonb)', 'public._security_alert_safe(uuid, text, text, uuid, jsonb)',
    'public.tg_sa54_audit()', 'public.tg_sa54_override()', 'public.tg_sa54_profile()',
    'public.hq_security_alerts(date, date)',
    'public.security_alert_outbox_claim(integer)', 'public.security_alert_outbox_mark(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.hq_security_alerts(date, date) to authenticated;   -- operator gate inside
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.security_alert_outbox_claim(integer) to service_role;
    grant execute on function public.security_alert_outbox_mark(uuid, text) to service_role;
    grant select on public.security_alert_events, public.security_alert_outbox to service_role;
  end if;
end $$;
