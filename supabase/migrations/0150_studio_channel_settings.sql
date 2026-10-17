-- 0150_studio_channel_settings.sql - CANONICAL forward-only. Studio e-mail sender settings +
-- the read helpers the Integrations page "Send test" and comms-dispatch need.
-- REQUIRES 0078 (comms_settings, comms_outbox), current_org_id(), has_area().
--
-- In plain words:
--   * comms_settings gets two OPTIONAL columns: email_from_name (the name clients see on
--     e-mails Helm sends for the studio, e.g. "Rao Events") and email_reply_to (where a
--     client's reply goes, e.g. bookings@raoevents.in). Both NULL by default = today's
--     behaviour (studio name from the message, no Reply-To). No existing row is changed.
--   * studio_email_settings_get() / _set(p_from_name, p_reply_to): Control Center view / edit,
--     own studio only. Validates (name: 1..60 chars, no < > " or line breaks; reply-to: one
--     plain e-mail address). Audit-logged without the values.
--   * integrations_test_target(): who a "Send test" from the Integrations page goes to -
--     ONLY the signed-in admin's own login e-mail and the studio's own saved WhatsApp number,
--     never an address from the request. Controls EDIT.
--   * studio_email_identity(p_org) / comms_outbox_email_identity(p_id): service role only -
--     the edge functions read the sender name + reply-to for a studio / a queued message.
--   No secret is stored anywhere here: provider keys stay in Supabase secrets (env) / Vault.
--
-- ZERO DATA LOSS: additive + idempotent. ADD COLUMN IF NOT EXISTS, NOT VALID checks, new
-- functions only. No DROP, no DELETE, no UPDATE of existing rows. ASCII only. Safe to run twice.

do $$ begin
  if to_regclass('public.comms_settings') is null or to_regclass('public.comms_outbox') is null then
    raise exception '0150: apply 0078 (comms automation) first'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.has_area(text,text)') is null then
    raise exception '0150: current_org_id() / has_area() missing'; end if;
end $$;

alter table public.comms_settings add column if not exists email_from_name text;
alter table public.comms_settings add column if not exists email_reply_to text;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.comms_settings'::regclass and conname = 'comms_settings_email_from_name_chk150') then
    alter table public.comms_settings add constraint comms_settings_email_from_name_chk150
      check (email_from_name is null or (char_length(email_from_name) between 1 and 60 and email_from_name !~ '[<>"\r\n]')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.comms_settings'::regclass and conname = 'comms_settings_email_reply_to_chk150') then
    alter table public.comms_settings add constraint comms_settings_email_reply_to_chk150
      check (email_reply_to is null or (char_length(email_reply_to) <= 254
             and email_reply_to ~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$')) not valid;
  end if;
end $$;

-- ---- app: read (controls VIEW) --------------------------------------------------------------
create or replace function public.studio_email_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- studio-channel-settings-0150
declare v_org uuid := public.current_org_id(); v jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('controls', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select jsonb_build_object('from_name', s.email_from_name, 'reply_to', s.email_reply_to)
    into v from public.comms_settings s where s.org_id = v_org;
  return coalesce(v, jsonb_build_object('from_name', null, 'reply_to', null))
    || jsonb_build_object('studio_name', (select o.name from public.organizations o where o.id = v_org),
                          'can_edit', coalesce(public.has_area('controls', 'edit'), false));
end $$;

-- ---- app: write (controls EDIT). NULL / blank clears a field. ------------------------------
create or replace function public.studio_email_settings_set(p_from_name text, p_reply_to text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- studio-channel-settings-0150
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid();
  v_name text := nullif(btrim(coalesce(p_from_name, '')), '');
  v_rt text := lower(nullif(btrim(coalesce(p_reply_to, '')), ''));
begin
  if v_me is null or v_org is null or not coalesce(public.has_area('controls', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_name is not null and (char_length(v_name) > 60 or v_name ~ '[<>"\r\n]') then
    raise exception 'sender name: up to 60 characters, no < > or quotes' using errcode = '22023'; end if;
  if v_rt is not null and (char_length(v_rt) > 254 or v_rt !~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$') then
    raise exception 'enter a valid reply-to e-mail address' using errcode = '22023'; end if;
  insert into public.comms_settings(org_id) values (v_org) on conflict (org_id) do nothing;
  update public.comms_settings s set email_from_name = v_name, email_reply_to = v_rt, updated_at = now(), updated_by = v_me
   where s.org_id = v_org;
  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'studio_email_settings.set', 'comms_settings', v_org::text,
              jsonb_build_object('from_name', case when v_name is null then 'cleared' else 'set' end,
                                 'reply_to', case when v_rt is null then 'cleared' else 'set' end), v_org);
  end if;
  return jsonb_build_object('from_name', v_name, 'reply_to', v_rt);
end $$;

-- ---- app: the ONLY recipients of a "Send test" (controls EDIT) -------------------------------
create or replace function public.integrations_test_target()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- studio-channel-settings-0150
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v jsonb;
begin
  if v_me is null or v_org is null or not coalesce(public.has_area('controls', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select jsonb_build_object('studio_whatsapp', s.studio_whatsapp, 'from_name', s.email_from_name, 'reply_to', s.email_reply_to)
    into v from public.comms_settings s where s.org_id = v_org;
  return coalesce(v, '{}'::jsonb) || jsonb_build_object(
    'org_id', v_org,
    'email', (select u.email from auth.users u where u.id = v_me),
    'studio_name', (select o.name from public.organizations o where o.id = v_org));
end $$;

-- ---- service role: sender identity for edge functions --------------------------------------
create or replace function public.studio_email_identity(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- studio-channel-settings-0150
  select jsonb_build_object('from_name', s.email_from_name, 'reply_to', s.email_reply_to)
    from public.comms_settings s where s.org_id = p_org
$$;

create or replace function public.comms_outbox_email_identity(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- studio-channel-settings-0150
  select jsonb_build_object('from_name', s.email_from_name, 'reply_to', s.email_reply_to)
    from public.comms_outbox c join public.comms_settings s on s.org_id = c.org_id where c.id = p_id
$$;

do $$
declare f text;
begin
  foreach f in array array['public.studio_email_settings_get()', 'public.studio_email_settings_set(text,text)',
                           'public.integrations_test_target()', 'public.studio_email_identity(uuid)',
                           'public.comms_outbox_email_identity(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.studio_email_identity(uuid) from authenticated;
    revoke all on function public.comms_outbox_email_identity(uuid) from authenticated;
    grant execute on function public.studio_email_settings_get() to authenticated;
    grant execute on function public.studio_email_settings_set(text, text) to authenticated;
    grant execute on function public.integrations_test_target() to authenticated;
  end if;
end $$;
