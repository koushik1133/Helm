-- 0250_security_notices_hq_only.sql - CANONICAL forward-only.
-- REQUIRES 0029 + 0037 + 0042 (platform_admins, is_platform_operator), 0036 (notification prefs, bell_feed,
--          _notify_hidden_types, my_pending, notification_seen), 0054 (security alerts: _security_alert,
--          security_alert_events / _throttle / _outbox, outbox claim), 0144 (event_activity), 0153 (bell_feed chain).
--
-- In plain words (owner, r21: a studio user's bell showed "Security: Member removed x3" twice after test users
-- were deleted from auth.users - "all these notifications should not come to people or anyone except
-- admin@helm.events"):
--   1  Security notices are for Helm HQ only (the platform operators in platform_admins: admin@helm.events,
--      security@helm.events, ...). No studio member - admin or not, any studio - gets them any more, not even
--      "a member of YOUR studio was removed" (owner decision).
--   2  NEW hq_security_notices: ONE row per studio + alert type + India day (Asia/Kolkata) with a running count,
--      first / last time and the latest names (never e-mails). This is the de-duplication: before, the 0054
--      throttle opened a NEW bell row every 10 minutes, so deleting test users in two batches more than ten
--      minutes apart produced two identical "Member removed x3" rows. RLS on, no API grants.
--   3  _security_alert (the one function every 0054 trigger calls) no longer writes a studio notification; it
--      fills hq_security_notices instead. The HQ event log (security_alert_events), the 10-minute e-mail throttle
--      and the outbox stay as they were.
--   4  The e-mail outbox now goes to the Helm HQ inbox only (hq = true, no studio recipients) - the dormant
--      security-alert-mailer sends HQ rows to HELM_SECURITY_ALERT_HQ_TO.
--   5  Old studio security rows already in notifications are NOT deleted or changed - they are just hidden:
--      _notify_hidden_types (used by bell_feed + my_pending) always hides the security_alert type, a new restrictive
--      policy sa250_read stops direct reads, bell_feed strips them (belt and braces) and the event activity trail
--      leaves them out.
--   6  bell_feed for a platform operator ALSO returns the HQ notices (newest first, unread against that operator's
--      bell "seen" time). HQ -> Activity log -> Security (hq_security_alerts, unchanged) keeps the full log.
--   7  The Control Center notification catalog keeps the security_alert type (mutes / prefs keep working) but
--      says it is Helm HQ only.
--   8  bell_mark_seen ("mark all read") also clears an operator's HQ notices (new hq_security_seen: an operator
--      may have no studio, and the studio notification_seen row needs one). Studio users: unchanged.
--   9  Trial retention (0184, switched off) keeps hq_security_notices (like security_alert_events).
-- DRIFT-SAFE: bell_feed, _notify_hidden_types, notification_type_of, notification_catalog, event_activity and
-- bell_mark_seen are renamed ONCE to
-- *__pre0250 (the database's own bodies are kept) and wrapped; each wrapper carries the marker
-- 'r21-secnotice-0250'. Additive + idempotent: new table, create or replace, a new restrictive policy; no row
-- updated or deleted (only the 0054 throttle counters move, as on every alert), no table / column dropped, no existing
-- policy changed. Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): re-run 0054 (restores _security_alert and the outbox
-- claim), drop policy sa250_read on public.notifications, then for each wrapped function:
--   drop function public.bell_feed(integer); alter function public.bell_feed__pre0250(integer) rename to bell_feed;
--   (same for _notify_hidden_types(uuid, uuid), notification_type_of(text, text), notification_catalog(),
--   event_activity(uuid), bell_mark_seen()) and re-grant execute to authenticated (bell_feed, notification_type_of,
--   notification_catalog, event_activity, bell_mark_seen).
--   hq_security_notices / hq_security_seen can stay (unused).

do $$ begin
  if to_regprocedure('public.bell_feed(integer)') is null then raise exception 'STOP: apply 0036 / 0153 first (bell_feed)'; end if;
  if to_regprocedure('public._notify_hidden_types(uuid,uuid)') is null then raise exception 'STOP: apply 0036 first'; end if;
  if to_regprocedure('public._security_alert(uuid,text,text,uuid,jsonb)') is null
     or to_regclass('public.security_alert_throttle') is null or to_regclass('public.security_alert_outbox') is null then
    raise exception 'STOP: apply 0054 first (security alerts)'; end if;
  if to_regprocedure('public.is_platform_operator()') is null or to_regclass('public.platform_admins') is null then
    raise exception 'STOP: apply 0029 / 0037 first (platform operators)'; end if;
  if to_regprocedure('public.event_activity(uuid)') is null then raise exception 'STOP: apply 0144 first (event_activity)'; end if;
  if to_regclass('public.notification_seen') is null or to_regprocedure('public.bell_mark_seen()') is null then
    raise exception 'STOP: notification_seen / bell_mark_seen missing (phase48)'; end if;
end $$;

-- ---- 1) HQ notices: one row per studio + type + India day --------------------------------------------
create table if not exists public.hq_security_notices (
  id          uuid primary key default gen_random_uuid(),
  org_key     uuid not null,                                                  -- studio id, zero uuid = HQ-level
  org_id      uuid references public.organizations(id) on delete set null,   -- NULL = HQ-level (or studio gone)
  alert_type  text not null check (alert_type ~ '^[a-z_]{1,40}$'),
  day         date not null,                                                  -- Asia/Kolkata calendar day
  count       integer not null default 1 check (count >= 1),
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  detail      jsonb not null default '{}'::jsonb,                             -- latest names / roles only
  unique (org_key, alert_type, day)
);
create index if not exists hq_security_notices_last_idx on public.hq_security_notices (last_at desc);
alter table public.hq_security_notices enable row level security;
revoke all on public.hq_security_notices from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.hq_security_notices from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.hq_security_notices from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on public.hq_security_notices to service_role'; end if;
end $$;

-- trial retention (0184, switched off): the HQ notices are KEPT like security_alert_events (Helm's own security
-- record, never purged with a trial studio's data); the rest of its list is unchanged
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''hq_security_notices''' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, '''security_alert_outbox'',', ''))) <> length('''security_alert_outbox'',') then
    raise exception 'STOP: _tr184_keep_tables() has an unexpected body (security_alert_outbox not listed once) - nothing changed'; end if;
  execute replace(v_def, '''security_alert_outbox'',', '''security_alert_outbox'', ''hq_security_notices'',');
end $$;

-- when each operator last opened the bell (an operator may have no studio, and notification_seen needs one)
create table if not exists public.hq_security_seen (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
alter table public.hq_security_seen enable row level security;
revoke all on public.hq_security_seen from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.hq_security_seen from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.hq_security_seen from authenticated'; end if;
end $$;

-- ---- 2) the core: record + throttle + HQ notice + queue (no studio notification) ----------------------
create or replace function public._security_alert(p_org uuid, p_type text, p_source text,
                                                 p_quote uuid default null, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r21-secnotice-0250: Helm HQ only - no studio bell row; one HQ notice per studio + type + India day
declare
  v_key uuid := coalesce(p_org, '00000000-0000-0000-0000-000000000000'::uuid);
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_count int; v_oid uuid; v_now timestamptz := clock_timestamp();
begin
  -- names / codes / roles only - strip anything that could carry a secret or a link; HQ keeps no event code
  v_detail := jsonb_strip_nulls(v_detail - array['email', 'actor_email', 'phone', 'token', 'url', 'link', 'reason',
                                                 'name', 'owner', 'event_code']);
  insert into public.security_alert_events(org_id, alert_type, source, detail) values (p_org, p_type, p_source, v_detail);

  insert into public.hq_security_notices as h (org_key, org_id, alert_type, day, count, first_at, last_at, detail)
    values (v_key, p_org, p_type, (v_now at time zone 'Asia/Kolkata')::date, 1, v_now, v_now, v_detail)
  on conflict (org_key, alert_type, day) do update set
    count = h.count + 1, last_at = excluded.last_at, detail = h.detail || excluded.detail,
    org_id = coalesce(h.org_id, excluded.org_id);

  -- e-mail throttle (0054): one queued HQ e-mail per type per studio per 10 minutes, with a count
  insert into public.security_alert_throttle as t (org_key, alert_type, window_start, count, updated_at)
    values (v_key, p_type, v_now, 1, v_now)
  on conflict (org_key, alert_type) do update set
    count           = case when t.window_start > v_now - interval '10 minutes' then t.count + 1 else 1 end,
    notification_id = null,
    outbox_id       = case when t.window_start > v_now - interval '10 minutes' then t.outbox_id else null end,
    window_start    = case when t.window_start > v_now - interval '10 minutes' then t.window_start else v_now end,
    updated_at      = v_now
  returning t.count, t.outbox_id into v_count, v_oid;

  if v_count = 1 or v_oid is null then
    insert into public.security_alert_outbox(org_id, alert_type, count) values (p_org, p_type, v_count) returning id into v_oid;
    update public.security_alert_throttle set outbox_id = v_oid where org_key = v_key and alert_type = p_type;
  else
    update public.security_alert_outbox set count = v_count, last_at = now() where id = v_oid and sent_at is null;
  end if;
end $$;

-- ---- 3) outbox: every alert goes to the Helm HQ inbox only -----------------------------------------------
create or replace function public.security_alert_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-secnotice-0250: HQ inbox only (hq = true, no studio recipients)
declare r record; v_out jsonb := '[]'::jsonb;
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
    update public.security_alert_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'hq', true, 'type', r.alert_type, 'label', public._sa54_label(r.alert_type),
      'count', r.count, 'first_at', r.first_at, 'last_at', r.last_at,
      'studio', (select o.name from public.organizations o where o.id = r.org_id), 'to', '[]'::jsonb));
  end loop;
  return v_out;
end $$;

-- ---- 4) rename-once the wrapped bodies -------------------------------------------------------------------
do $$ declare f text[]; v_src text; begin
  foreach f slice 1 in array array[
    ['bell_feed', 'integer'],
    ['_notify_hidden_types', 'uuid, uuid'],
    ['notification_type_of', 'text, text'],
    ['notification_catalog', ''],
    ['event_activity', 'uuid'],
    ['bell_mark_seen', '']
  ] loop
    v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure(format('public.%s(%s)', f[1], f[2])));
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0250', f[2])) is null
       and position('r21-secnotice-0250' in coalesce(v_src, '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0250');
    end if;
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0250', f[2])) is null then
      raise exception '0250: public.%__pre0250(%) missing after rename', f[1], f[2];
    end if;
    execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0250', f[2]);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%I(%s) from anon', f[1] || '__pre0250', f[2]); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function public.%I(%s) from authenticated', f[1] || '__pre0250', f[2]); end if;
  end loop;
end $$;

-- ---- 5) studio bells + dashboard counter: security_alert is always hidden ---------------------------------
create or replace function public._notify_hidden_types(p_org uuid, p_user uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  -- r21-secnotice-0250: security notices are Helm HQ only - hidden from every studio bell / counter
  select array(select distinct t from unnest(coalesce(public._notify_hidden_types__pre0250(p_org, p_user), '{}'::text[])
                                             || array['security_alert']) t order by t);
$$;

-- the security kind always maps to its own type (as 0054 does), so the hidden list above always catches it
-- (security definer: the app keeps calling it as before, while the kept prior body is not callable by the app)
create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $$
  -- r21-secnotice-0250
  select case when lower(btrim(coalesce(p_kind, ''))) = 'security_alert' then 'security_alert'
              else public.notification_type_of__pre0250(p_kind, p_channel) end;
$$;

create or replace function public.notification_catalog()
returns jsonb language sql immutable security definer set search_path = '' as $$
  -- r21-secnotice-0250: the security_alert type stays (mutes / prefs keep working) but says it is HQ only
  -- (security definer: a fixed list, no data; the kept prior body is not callable by the app)
  select coalesce(jsonb_agg(case when e ->> 'type' = 'security_alert'
                                 then e || jsonb_build_object('label', 'Security alerts (Helm HQ only)', 'audience', 'hq',
                                   'description', 'Security alerts go to the Helm team only (Helm HQ). Studio members do not receive them.')
                                 else e end order by o), '[]'::jsonb)
    from jsonb_array_elements(public.notification_catalog__pre0250()) with ordinality x(e, o);
$$;

-- ---- 6) bell feed: never a studio security row; platform operators get the HQ notices ---------------------
create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-secnotice-0250: security_alert rows stripped for everyone; HQ notices added for platform operators
declare v jsonb; v_items jsonb; v_drop integer := 0; v_hq jsonb := '[]'::jsonb; v_hq_unread integer := 0;
        v_seen timestamptz; v_lim integer := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  v := public.bell_feed__pre0250(p_limit);
  if v is null or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  select count(*) into v_drop from jsonb_array_elements(v -> 'items') e(i)
   where coalesce(e.i ->> 'kind', '') = 'security_alert' and coalesce((e.i ->> 'unread')::boolean, false);
  v_items := coalesce((select jsonb_agg(e.i order by e.ord) from jsonb_array_elements(v -> 'items') with ordinality e(i, ord)
                        where coalesce(e.i ->> 'kind', '') <> 'security_alert'), '[]'::jsonb);
  if public.is_platform_operator() then
    v_seen := greatest(coalesce((select s.last_seen_at from public.hq_security_seen s where s.user_id = auth.uid()), 'epoch'::timestamptz),
                       coalesce((select s.last_seen_at from public.notification_seen s where s.user_id = auth.uid()), 'epoch'::timestamptz));
    select coalesce(jsonb_agg(z.x order by z.at desc), '[]'::jsonb) into v_hq from (
      select n.last_at as at, jsonb_build_object(
               'id', n.id, 'kind', 'security_alert', 'channel', 'in_app', 'status', 'simulated',
               'quote_id', null, 'event_code', null, 'event_title', null,
               'created_at', n.last_at, 'unread', n.last_at > v_seen,
               'detail', jsonb_strip_nulls(jsonb_build_object(
                  'hq', true, 'alert', n.alert_type, 'label', public._sa54_label(n.alert_type), 'count', n.count,
                  'day', n.day, 'first_at', n.first_at,
                  'studio', coalesce(o.name, case when n.org_key = '00000000-0000-0000-0000-000000000000'::uuid
                                                  then 'Helm HQ' else 'Removed studio' end),
                  -- a single event names the person; a grouped one does not (the names differ)
                  'subject_name', case when n.count = 1 then left(n.detail ->> 'subject_name', 80) end,
                  'actor_name', case when n.count = 1 then left(n.detail ->> 'actor_name', 80) end,
                  'old_role', case when n.count = 1 then left(n.detail ->> 'old_role', 20) end,
                  'new_role', case when n.count = 1 then left(n.detail ->> 'new_role', 20) end))) as x
        from public.hq_security_notices n left join public.organizations o on o.id = n.org_id
       order by n.last_at desc limit v_lim) z;
    select count(*) into v_hq_unread from public.hq_security_notices n where n.last_at > v_seen;
    v_items := coalesce((select jsonb_agg(m.i order by m.at desc nulls last) from (
                 select a.i, (a.i ->> 'created_at')::timestamptz as at
                   from jsonb_array_elements(v_items || v_hq) a(i)
                  order by (a.i ->> 'created_at')::timestamptz desc nulls last limit v_lim) m), '[]'::jsonb);
  end if;
  return v || jsonb_build_object('items', v_items,
                                 'unread', greatest(coalesce((v ->> 'unread')::integer, 0) - v_drop, 0) + v_hq_unread);
end $$;

-- "mark all read": operators also clear the HQ notices (an operator without a studio has no notification_seen row)
create or replace function public.bell_mark_seen()
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r21-secnotice-0250
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if public.is_platform_operator() then
    insert into public.hq_security_seen(user_id, last_seen_at) values (auth.uid(), now())
    on conflict (user_id) do update set last_seen_at = now();
    if public.current_org_id() is null then return; end if;
  end if;
  perform public.bell_mark_seen__pre0250();
end $$;

-- ---- 7) event activity trail: no security rows ------------------------------------------------------------
create or replace function public.event_activity(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-secnotice-0250: security notices are Helm HQ only
declare v jsonb;
begin
  v := public.event_activity__pre0250(p_quote);
  if jsonb_typeof(v) <> 'array' then return v; end if;
  return coalesce((select jsonb_agg(e.i order by e.ord) from jsonb_array_elements(v) with ordinality e(i, ord)
                    where not (coalesce(e.i ->> 'kind', '') = 'notify' and coalesce(e.i ->> 'text', '') like 'security\_alert%')), '[]'::jsonb);
end $$;

-- ---- 8) old studio security rows: no direct reads either (rows kept) ----------------------------------------
drop policy if exists sa250_read on public.notifications;
create policy sa250_read on public.notifications as restrictive for select to authenticated
  using (coalesce(kind, '') <> 'security_alert');

-- ---- 9) grants ----------------------------------------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array['public._security_alert(uuid, text, text, uuid, jsonb)', 'public.security_alert_outbox_claim(integer)',
                           'public._notify_hidden_types(uuid, uuid)', 'public.notification_type_of(text, text)', 'public.bell_feed(integer)',
                           'public.notification_catalog()', 'public.event_activity(uuid)', 'public.bell_mark_seen()'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._security_alert(uuid, text, text, uuid, jsonb) from authenticated';
    execute 'revoke all on function public.security_alert_outbox_claim(integer) from authenticated';
    execute 'revoke all on function public._notify_hidden_types(uuid, uuid) from authenticated';
    execute 'grant execute on function public.notification_type_of(text, text) to authenticated';   -- as before 0250
    execute 'grant execute on function public.bell_feed(integer) to authenticated';
    execute 'grant execute on function public.notification_catalog() to authenticated';
    execute 'grant execute on function public.event_activity(uuid) to authenticated';
    execute 'grant execute on function public.bell_mark_seen() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.security_alert_outbox_claim(integer) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
