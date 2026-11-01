-- 0316_r106_trial_gaps.sql - CANONICAL forward-only. R106 (free-trial rules audit, testing/phase2/TRIAL-RULES-AUDIT.md).
--
-- In plain words:
--   1  Client images stay OFF in a free trial (owner rule r20). Until now only the builder button was hidden: sharing a
--      booklet with the 2D / 3D sections ticked still rendered the pictures in the background and saved them. Now the
--      database itself refuses a NEW 2D / 3D client picture (client_booklet_images kind '2d' / '3d') for a studio that is
--      in its free trial or whose trial ended unpaid: "Client images unlock on a paid plan." (hint trial_client_images).
--      Only app sign-ins (authenticated / anon) are checked - Helm maintenance and the service role are not. Pictures that
--      already exist are kept (nothing is deleted), photo renders are not touched, paid studios are not touched.
--   2  One shared trial e-mail counter. The trial client e-mail caps (30 a day per studio, 5 a day per address) are now
--      counted the same way everywhere: approval / booklet / invitation links + approval codes (_tr212_take) AND delivery
--      reminders (_dl241_trial_take) both count link e-mails + reminder e-mails together (_r316_trial_email_used).
--      my_trial_messaging "used today" shows the same total. Limits and settings unchanged.
--   3  The "ends today" (d8) trial reminder is no longer missed when a trial ends between 00:00 and about 00:07 India time
--      (the hourly :07 tick never ran inside that short last day). A trial that ends within the next 65 minutes gets the
--      last-day reminder now; the usual dedupe key (studio + milestone + end) still sends it exactly once.
--   4  A free-trial owner / member opening an invitation from ANOTHER studio gets a clear explanation instead of
--      "you already belong to an organization": "You are already in your own free-trial studio <name> ... ask <studio> to
--      invite a different e-mail address, or contact Helm support to close your free trial first." (hint own_trial).
--      Nothing is joined, moved or deleted; every other accept path is unchanged (house wrapper: accept_invitation__pre0316).
--   5  A task made from a sample ("Demo . ") task template on a REAL event no longer carries the sample prefix (new
--      event_tasks rows only; sample events keep it; existing tasks unchanged).
--   No table / column / row / policy / index created, changed or deleted (two new BEFORE INSERT triggers: one on
--   client_booklet_images that only refuses new trial 2D / 3D pictures, one on event_tasks that only trims the prefix). Safe to run twice. ASCII only. Goes after 0083 + 0155 + 0156 + 0212 + 0241.
do $$
begin
  if to_regclass('public.client_booklet_images') is null then raise exception 'STOP 0316: 0083 (client_booklet_images) is not applied'; end if;
  if to_regprocedure('public._tr212_take(uuid,text,text)') is null then raise exception 'STOP 0316: 0212 (_tr212_take) is not applied'; end if;
  if to_regprocedure('public._dl241_trial_take(uuid,text)') is null then raise exception 'STOP 0316: 0241 (_dl241_trial_take) is not applied'; end if;
  if to_regprocedure('public.accept_invitation__pre0156(text)') is null then raise exception 'STOP 0316: 0156 (accept_invitation wrapper) is not applied'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null or to_regprocedure('public._is_trial_org(uuid)') is null then
    raise exception 'STOP 0316: 0166 / 0183 (trial helpers) are not applied'; end if;
end $$;

-- ---- 1) no 2D / 3D client pictures in a free trial -------------------------------------------------------------------
create or replace function public._r316_trial_studio(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r106-trial-gaps-0316: in the free trial now, or the trial ended unpaid (read-only); never the sample master
  select p_org is not null
     and not exists (select 1 from public.organizations o where o.id = p_org and coalesce(o.is_sample_master, false))
     and (coalesce(public._is_trial_org(p_org), false) or coalesce(public._trial_locked(p_org), false));
$$;

create or replace function public._r316_tg_trial_client_images()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r106-trial-gaps-0316: client 2D / 3D pictures unlock on a paid plan (owner rule r20); never deletes
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('authenticated', 'anon') then return new; end if;   -- service role / maintenance
  if new.kind in ('2d', '3d') and public._r316_trial_studio(new.org_id) then
    raise exception 'Client images unlock on a paid plan. Untick the 2D floor plan and 3D view to share the booklet in the free trial.'
      using errcode = '42501', hint = 'trial_client_images';
  end if;
  return new;
end $$;

drop trigger if exists zz_r316_trial_client_images on public.client_booklet_images;
create trigger zz_r316_trial_client_images before insert on public.client_booklet_images
  for each row execute function public._r316_tg_trial_client_images();

-- ---- 2) one shared trial e-mail counter -------------------------------------------------------------------------------
create or replace function public._r316_trial_email_used(p_org uuid, p_recipient text, out studio_n integer, out rcpt_n integer)
language sql stable security definer set search_path = '' as $$
  -- r106-trial-gaps-0316: link e-mails + approval codes (trial_email_sends) AND trial delivery reminders, last 24 hours
  select ((select count(*) from public.trial_email_sends t where t.org_id = p_org and t.created_at > now() - interval '24 hours')
        + (select count(*) from public.delivery_reminder_sends s where s.org_id = p_org and s.trial_slot
             and s.created_at > now() - interval '24 hours'))::integer,
         ((select count(*) from public.trial_email_sends t where t.org_id = p_org
             and t.recipient_hash = public._tr212_rcpt_hash(p_recipient) and t.created_at > now() - interval '24 hours')
        + (select count(*) from public.delivery_reminder_sends s where s.org_id = p_org and s.trial_slot
             and lower(btrim(s.recipient)) = lower(btrim(coalesce(p_recipient, ''))) and s.created_at > now() - interval '24 hours'))::integer;
$$;

create or replace function public._tr212_take(p_org uuid, p_recipient text, p_kind text)
returns text language plpgsql security definer set search_path = '' as $$
-- trial-email-0212 (r106-trial-gaps-0316: delivery reminders count too - one shared counter)
declare s public.trial_email_settings; v_h text; u record;
begin
  if p_org is null or coalesce(btrim(p_recipient), '') !~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$' then
    return 'bad_recipient'; end if;
  select * into s from public.trial_email_settings x where x.id;
  v_h := public._tr212_rcpt_hash(p_recipient);
  perform pg_advisory_xact_lock(hashtextextended('helm:trial-email:' || p_org::text, 0));
  select * into u from public._r316_trial_email_used(p_org, p_recipient);
  if u.studio_n >= coalesce(s.per_studio_day, 30) then return 'cap_studio'; end if;
  if u.rcpt_n >= coalesce(s.per_recipient_day, 5) then return 'cap_recipient'; end if;
  insert into public.trial_email_sends(org_id, kind, recipient_hash) values (p_org, p_kind, v_h);
  return null;
end $$;

create or replace function public._dl241_trial_take(p_org uuid, p_recipient text)
returns text language plpgsql security definer set search_path = '' as $$
-- r21-reminders-0241 (r106-trial-gaps-0316: the same shared counter as link e-mails / approval codes)
declare v_day integer; v_rcpt integer; u record;
begin
  if p_org is null or not public._dl241_email_ok(p_recipient) then return 'bad_recipient'; end if;
  select coalesce(min(x.per_studio_day), 30), coalesce(min(x.per_recipient_day), 5) into v_day, v_rcpt from public.trial_email_settings x where x.id;
  v_day := coalesce(v_day, 30); v_rcpt := coalesce(v_rcpt, 5);
  perform pg_advisory_xact_lock(hashtextextended('helm:trial-email:' || p_org::text, 0));
  select * into u from public._r316_trial_email_used(p_org, p_recipient);
  if u.studio_n >= v_day then return 'cap_studio'; end if;
  if u.rcpt_n >= v_rcpt then return 'cap_recipient'; end if;
  return null;
end $$;

create or replace function public.my_trial_messaging()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-email-0212 (r106-trial-gaps-0316: "used today" = the shared counter)
declare v_org uuid := public.current_org_id(); s public.trial_email_settings; v_used integer;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not coalesce(public._tb179_no_send(v_org), false) and not coalesce(public._sample_outbound_blocked(v_org, null), false) then
    return jsonb_build_object('trial', false, 'active', false, 'email', true, 'whatsapp', true, 'sms', true, 'payment_links', true);
  end if;
  select * into s from public.trial_email_settings x where x.id;
  select u.studio_n into v_used from public._r316_trial_email_used(v_org, null) u;
  return jsonb_build_object('trial', true, 'active', coalesce(public._trial_test_mode_ok(v_org), false),
    'email', public._tr212_email_ok(v_org), 'whatsapp', false, 'sms', false, 'payment_links', false,
    'email_per_day', coalesce(s.per_studio_day, 30), 'email_per_recipient_day', coalesce(s.per_recipient_day, 5),
    'email_used_today', v_used);
end $$;

-- ---- 3) "ends today" never missed ---------------------------------------------------------------------------------------
create or replace function public._trial_reminder_milestone(p_ends timestamptz, p_now timestamptz, p_tz text)
returns text language plpgsql stable set search_path = '' as $$
-- trial-reminders-0120 (r106-trial-gaps-0316: a trial ending before the next hourly tick gets "ends today" now)
declare v_tz text := coalesce(nullif(btrim(p_tz), ''), 'Asia/Kolkata'); v_left integer;
begin
  if p_ends is null or p_now is null or p_ends <= p_now then return null; end if;
  -- the hourly tick runs at :07 - a trial ending 00:00-00:07 local time had no tick inside its last day
  if p_ends - p_now <= interval '65 minutes' then return 'd8'; end if;
  begin
    v_left := ((p_ends - interval '1 microsecond') at time zone v_tz)::date - (p_now at time zone v_tz)::date;
  exception when others then
    v_left := ((p_ends - interval '1 microsecond') at time zone 'Asia/Kolkata')::date - (p_now at time zone 'Asia/Kolkata')::date;
  end;
  return case v_left when 3 then 'd5' when 1 then 'd7' when 0 then 'd8' else null end;
end $$;

-- ---- 4) a free-trial login invited into another studio: a clear answer ----------------------------------------------
create or replace function public._r316_accept_invitation(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r106-trial-gaps-0316: words only - the refusal itself is the same as before (one login = one studio)
declare v_uid uuid := auth.uid(); v_inv public.invitations; v_org uuid; v_email text; v_conf timestamptz; v_mine text; v_theirs text;
begin
  if v_uid is not null and p_token is not null then
    select * into v_inv from public.invitations i where i.token = p_token;
    if v_inv.id is not null and v_inv.status = 'pending' and v_inv.expires_at > now() then
      select pr.org_id into v_org from public.profiles pr where pr.id = v_uid;
      select lower(u.email), u.email_confirmed_at into v_email, v_conf from auth.users u where u.id = v_uid;
      if v_org is not null and v_org <> v_inv.org_id and v_conf is not null
         and v_email is not distinct from lower(v_inv.email) and public._r316_trial_studio(v_org) then
        select left(coalesce(nullif(btrim(o.name), ''), 'your trial studio'), 80) into v_mine from public.organizations o where o.id = v_org;
        select left(coalesce(nullif(btrim(o.name), ''), 'the other studio'), 80) into v_theirs from public.organizations o where o.id = v_inv.org_id;
        raise exception 'You are already in your own free-trial studio "%". A Helm login can be in one studio at a time, so it can''t join % as well. Ask % to invite a different e-mail address, or contact Helm support to close your free trial first.',
          coalesce(v_mine, 'your trial studio'), coalesce(v_theirs, 'the other studio'), coalesce(v_theirs, 'the other studio')
          using errcode = '42501', hint = 'own_trial';
      end if;
    end if;
  end if;
  return public.accept_invitation__pre0316(p_token);
end $$;

do $$ begin
  if to_regprocedure('public.accept_invitation__pre0316(text)') is null then
    alter function public.accept_invitation(text) rename to accept_invitation__pre0316;
    create function public.accept_invitation(p_token text)
      returns jsonb language sql volatile security definer set search_path = ''
      as 'select public._r316_accept_invitation(p_token) /* r106-trial-gaps-0316 */';
  end if;
end $$;

-- ---- 5) a task made from a SAMPLE ("Demo . ") task template on a REAL event drops the sample prefix ---------------------
create or replace function public._r316_tg_task_title()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r106-trial-gaps-0316: only sample (is_demo) events keep the "Demo " + U+00B7 + " " title prefix; never deletes
declare v_demo boolean;
begin
  if new.title is not null and new.title like ('Demo ' || chr(183) || ' %') then
    select coalesce(q.is_demo, false) into v_demo from public.quotes q where q.id = new.quote_id;
    if not coalesce(v_demo, false) then
      new.title := coalesce(nullif(btrim(substr(new.title, 8)), ''), new.title);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists a1_r316_task_title on public.event_tasks;
create trigger a1_r316_task_title before insert on public.event_tasks
  for each row execute function public._r316_tg_task_title();

-- ---- privileges (internal helpers: no app role; the two app entry points keep their old audience) --------------------
revoke all on function public._r316_trial_studio(uuid) from public;
revoke all on function public._r316_tg_trial_client_images() from public;
revoke all on function public._r316_tg_task_title() from public;
revoke all on function public._r316_trial_email_used(uuid, text) from public;
revoke all on function public._r316_accept_invitation(text) from public;
revoke all on function public.accept_invitation(text) from public;
revoke all on function public.accept_invitation__pre0316(text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._r316_trial_studio(uuid) from %I', r);
      execute format('revoke all on function public._r316_tg_trial_client_images() from %I', r);
      execute format('revoke all on function public._r316_tg_task_title() from %I', r);
      execute format('revoke all on function public._r316_trial_email_used(uuid, text) from %I', r);
      execute format('revoke all on function public._r316_accept_invitation(text) from %I', r);
      execute format('revoke all on function public.accept_invitation__pre0316(text) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.accept_invitation(text) from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.accept_invitation(text) to authenticated';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.accept_invitation(text) to service_role';
    execute 'grant execute on function public._r316_trial_email_used(uuid, text) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
