-- APPLY-0257.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0020, 0047, 0165, 0244 and 0254 (0254 = PR #229, already merged). Safe to run twice. ASCII only.
-- r23 owner decisions: the studio NAME and LINK (helm.events/<link>) are set ONCE at sign-up and can't be changed by
-- anyone in the studio (trial owner, paid admin, any role, any screen). Only Helm HQ changes them (HQ -> Studios ->
-- Studio name & link: two-step, reason, audited, the studio's admins get a bell notice + e-mail, old links keep
-- working). Look-alike links of other studios (bl00m-decor vs bloom-decor) and Helm words / look-alikes (helm-...,
-- he1m, supp0rt, admin ...) are never handed out. No row is changed by running this file; nothing is deleted.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (control.html, onboarding, trial welcome, sign-up, hq.js, store-api.js) and the
--      comms-dispatch edge function (for the "Helm support changed your studio" e-mail; the bell works without it).
--   3  Check: as a studio admin -> Control Center -> General: the studio name is greyed out with a lock and
--      "Contact Helm support to change it"; the Studio link is shown, not editable. As Helm HQ (two-step) -> Studios ->
--      a test studio -> Studio name & link: change the link with a reason -> confirm -> the old link
--      (helm.events/<old>/dashboard) still opens and switches to the new one; the studio admin sees the bell notice.
begin;
-- 0257_studio_name_link.sql - CANONICAL forward-only.
-- REQUIRES 0020 (organizations.public_slug, org_slug_history, studio_slug_* rules, organizations_public_slug_guard,
--          set_studio_link_name), 0029 / 0047 (is_platform_admin, _hq_wgate), 0165 (email_is_opted_out),
--          0244 + 0254 (helm_notice_outbox + helm_notice_outbox_claim), base audit_log + notifications.
--
-- In plain words (r23, owner decisions):
--   A studio's NAME and LINK (helm.events/<link>) are set ONCE, when the studio is created at sign-up. Nobody in the
--   studio can change them afterwards - not a free-trial owner, not a paid studio's admin, not any other role. One
--   studio per account, as before. Only Helm HQ can change them, on request.
--   1  LOCK: a BEFORE UPDATE trigger on organizations refuses any change of name or public_slug that comes from the
--      app (request JWT role 'authenticated' or 'anon'), whatever the path: a direct table update (Control Center /
--      onboarding save), set_studio_link_name (0020), the trial welcome (0167 / 0210) or any other SECURITY DEFINER
--      function running for a signed-in person. Creating a studio (INSERT) is not affected. A first-time value (link
--      still empty, name still blank) is allowed. Allowed changes: (a) hq_set_studio_identity below (Helm HQ, two-step
--      signed in) and (b) a privileged database session (owner in the SQL editor = no JWT, or the service role).
--   2  HELM HQ: hq_set_studio_identity(org, name, link, reason) - Helm HQ operator only, ALWAYS with two-step (aal2),
--      reason 10-500 characters, at most 20 changes per operator per 24 h. Same link rules as sign-up plus (3).
--      Audited through _hq_wgate ('hq.studio.identity'), the studio admins get a bell notice and a queued e-mail
--      (helm_notice_outbox kind 'studio_identity'; comms-dispatch sends it once deployed). hq_studio_link_check(org,
--      link) is the HQ form's live availability check. The old link stays in org_slug_history, so every old link
--      (dashboard bookmarks, quotes, portals, booklets, invitations, crew links) keeps working.
--   3  LOOK-ALIKES / SQUATTING: a link is not available when it LOOKS LIKE another studio's current or retired link
--      (same "skeleton": dashes ignored, 0/o, 1/l/i, 3/e, 4/a, 5/s, 7/t, 8/b, 9/g, rn/m, vv/w) or like a protected
--      word (helm and helm-anything, admin, support, login, billing, security, official ... incl. look-alikes such as
--      he1m or supp0rt). Enforced in studio_slug_free (0020) - so sign-up's automatic pick skips such names and the
--      0020 guard refuses them on any change. Retired links stay reserved for their studio forever (as in 0020).
--   4  AUDIT: every name / link change that happens writes one audit_log row ('studio.renamed' /
--      'studio.link_renamed', from -> to, who; 'helm:support' for the SQL editor).
--   5  set_studio_link_name (0020) is closed to the app (execute revoked from authenticated / anon).
--   Changed existing objects: studio_slug_free (same signature, stricter body), helm_notice_outbox kind check widened
--   to a superset (every existing row still passes), helm_notice_outbox_claim (one branch added in place), one grant
--   revoked. New: 4 helper functions, 2 HQ functions, 2 trigger functions + 2 triggers, 2 expression indexes.
--   No table / column / policy dropped; no row changed by running this file; nothing deleted. Idempotent. ASCII only.
-- ROLLBACK (manual, only if ever needed - SQL editor):
--   drop trigger if exists aa_r23_org_identity_lock on public.organizations;
--   grant execute on function public.set_studio_link_name(text) to authenticated;
--   re-run the studio_slug_free block of 0020_studio_links.sql; revoke execute on the two hq_* functions.
-- SUPPORT without HQ UI (SQL editor): update public.organizations set name = 'New', public_slug = 'new-link' where id = '<org>';
-- ============================================================================

do $$ begin
  if to_regclass('public.organizations') is null then raise exception 'STOP: public.organizations missing'; end if;
  if to_regclass('public.org_slug_history') is null or to_regprocedure('public.studio_slug_valid(text)') is null
     or to_regprocedure('public.studio_slug_free(text,uuid)') is null or to_regprocedure('public.studio_slug_pick(text,uuid)') is null then
    raise exception 'STOP: 0020 (studio links) is not applied'; end if;
  if to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'STOP: 0029 / 0047 (HQ) is not applied'; end if;
  if to_regclass('public.helm_notice_outbox') is null or to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then
    raise exception 'STOP: 0244 (helm_notice_outbox) is not applied'; end if;
  if to_regprocedure('public.email_is_opted_out(uuid,text)') is null then raise exception 'STOP: 0165 (email_is_opted_out) is not applied'; end if;
  if to_regclass('public.audit_log') is null or to_regclass('public.notifications') is null then
    raise exception 'STOP: base audit_log / notifications missing'; end if;
  if to_regprocedure('auth.jwt()') is null then raise exception 'STOP: auth.jwt() missing'; end if;
end $$;

-- ---- 1) look-alike rules ----------------------------------------------------------------------------------------------
-- skeleton: lower case, dashes dropped, digits / letters that look alike folded to one exemplar
create or replace function public._r23_slug_skeleton(p text)
returns text language sql immutable set search_path = '' as $$
  -- r23-studio-name-0257
  select replace(replace(translate(lower(coalesce(p, '')), '01345789il|-', 'oleastbglll'), 'rn', 'm'), 'vv', 'w');
$$;
-- protected words (and Helm-anything): true = not allowed as a studio link
create or replace function public._r23_slug_protected(p text)
returns boolean language sql immutable set search_path = '' as $$
  -- r23-studio-name-0257
  with s as (select public._r23_slug_skeleton(p) k),
       w as (select public._r23_slug_skeleton(x) k from unnest(array[
         'helm', 'admin', 'administrator', 'support', 'help', 'helpdesk', 'login', 'signin', 'signup', 'register', 'security',
         'billing', 'payment', 'payments', 'pay', 'invoice', 'official', 'staff', 'team', 'hq', 'root', 'system', 'owner',
         'account', 'accounts', 'settings', 'api', 'www', 'mail', 'email', 'verify', 'verification', 'password', 'razorpay',
         'whatsapp', 'google', 'studio', 'studios', 'dashboard', 'app', 'status', 'trust', 'abuse', 'legal', 'privacy',
         'terms', 'contact', 'sales', 'events', 'test', 'demo', 'sample', 'null', 'undefined']) x)
  select (select k from s) in (select k from w)
      or (select k from s) like 'helm%' and (substr((select k from s), 5) = '' or substr((select k from s), 5) in (select k from w))
      or exists (select 1 from unnest(string_to_array(lower(coalesce(p, '')), '-')) t where public._r23_slug_skeleton(t) = 'helm');
$$;
create index if not exists organizations_r23_slug_skel_idx on public.organizations (public._r23_slug_skeleton(public_slug));
create index if not exists org_slug_history_r23_skel_idx on public.org_slug_history (public._r23_slug_skeleton(slug));

-- 0020's "free for this studio?" learns the look-alike + protected rules (same signature; sign-up's pick and the
-- 0020 guard both use it). Exact names keep the 0020 behaviour: own current / retired names are free for the owner.
create or replace function public.studio_slug_free(p_slug text, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- 0020 rule + r23-studio-name-0257 (look-alikes of other studios' current / retired links, protected words)
  select not exists (select 1 from public.organizations o where o.public_slug = p_slug and o.id <> p_org)
     and not exists (select 1 from public.org_slug_history h where h.slug = p_slug and h.org_id <> p_org)
     and (exists (select 1 from public.organizations o where o.id = p_org and o.public_slug = p_slug)
          or exists (select 1 from public.org_slug_history h where h.slug = p_slug and h.org_id = p_org)
          or (not public._r23_slug_protected(p_slug)
              and not exists (select 1 from public.organizations o
                               where public._r23_slug_skeleton(o.public_slug) = public._r23_slug_skeleton(p_slug) and o.id <> p_org)
              and not exists (select 1 from public.org_slug_history h
                               where public._r23_slug_skeleton(h.slug) = public._r23_slug_skeleton(p_slug) and h.org_id <> p_org)));
$$;
revoke all on function public.studio_slug_free(text, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.studio_slug_free(text, uuid) from anon'; end if;
end $$;

-- ---- 2) the lock ----------------------------------------------------------------------------------------------------
-- true only inside hq_set_studio_identity's own transaction, for that studio, for a Helm HQ operator
create or replace function public._r23_hq_identity_ok(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r23-studio-name-0257
  select p_org is not null
     and coalesce(current_setting('helm.r23_identity', true), '') = txid_current()::text || ':' || p_org::text
     and public.is_platform_admin();
$$;
create or replace function public.tg_r23_org_identity_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r23-studio-name-0257: BEFORE UPDATE OF name, public_slug on organizations. The JWT role (not current_user) decides,
-- so a SECURITY DEFINER function called by a signed-in person is refused too. hq_set_studio_identity marks its own
-- transaction (txid + studio) and the caller must still be a Helm HQ operator.
declare v_role text := coalesce(auth.jwt() ->> 'role', '');
begin
  if new.name is not distinct from old.name and new.public_slug is not distinct from old.public_slug then return new; end if;
  if v_role not in ('authenticated', 'anon') then return new; end if;                       -- SQL editor / service role
  if public._r23_hq_identity_ok(old.id) then return new; end if;                             -- Helm HQ (hq_set_studio_identity)
  if new.name is distinct from old.name and coalesce(btrim(old.name), '') <> '' then
    raise exception 'The studio name is set when the studio is created and can''t be changed. Contact Helm support to change it.'
      using errcode = '42501', hint = 'studio_identity_locked';
  end if;
  if new.public_slug is distinct from old.public_slug and old.public_slug is not null then
    raise exception 'The studio link is set when the studio is created and can''t be changed. Contact Helm support to change it.'
      using errcode = '42501', hint = 'studio_identity_locked';
  end if;
  return new;
end $$;
drop trigger if exists aa_r23_org_identity_lock on public.organizations;
create trigger aa_r23_org_identity_lock before update of name, public_slug on public.organizations
  for each row execute function public.tg_r23_org_identity_lock();

-- the 0020 link guard (admins / controls editors only) also lets the HQ call through - one condition added in place
do $$ declare v_def text; v_old text; begin
  v_def := pg_get_functiondef('public.organizations_public_slug_guard()'::regprocedure);
  if position('_r23_hq_identity_ok' in v_def) > 0 then return; end if;
  v_old := 'public.has_area(''controls'', ''edit'')) then';
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0257: organizations_public_slug_guard has an unexpected body - left unchanged (HQ link changes need the SQL editor)'; return; end if;
  execute replace(v_def, v_old, 'public.has_area(''controls'', ''edit'') or public._r23_hq_identity_ok(old.id)) then');
end $$;

-- ---- 3) audit: one row per name / link change that happens -----------------------------------------------------------
create or replace function public.tg_r23_org_identity_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r23-studio-name-0257: AFTER UPDATE OF name, public_slug on organizations
declare v_uid uuid := auth.uid(); v_email text;
begin
  if v_uid is not null then select u.email into v_email from auth.users u where u.id = v_uid; end if;
  if v_email is null then v_email := 'helm:support'; end if;
  if old.name is not null and new.name is distinct from old.name then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, v_email, 'studio.renamed', 'organizations', new.id::text,
              jsonb_build_object('from', left(old.name, 120), 'to', left(new.name, 120)), new.id, now());
  end if;
  if old.public_slug is not null and new.public_slug is distinct from old.public_slug then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, v_email, 'studio.link_renamed', 'organizations', new.id::text,
              jsonb_build_object('from', old.public_slug, 'to', new.public_slug), new.id, now());
  end if;
  return null;
end $$;
drop trigger if exists zz_r23_org_identity_audit on public.organizations;
create trigger zz_r23_org_identity_audit after update of name, public_slug on public.organizations
  for each row execute function public.tg_r23_org_identity_audit();

-- ---- 4) Helm HQ: live check + change ----------------------------------------------------------------------------------
-- {slug, ok, reason: null | format | reserved | taken | current, previous}
create or replace function public._r23_link_check(p_org uuid, p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-studio-name-0257
declare v_s text := lower(btrim(coalesce(p_slug, ''))); v_cur text;
begin
  select o.public_slug into v_cur from public.organizations o where o.id = p_org;
  if v_cur is not null and v_s = v_cur then return jsonb_build_object('slug', v_s, 'ok', true, 'reason', 'current', 'previous', false); end if;
  if length(v_s) > 60 or not (v_s ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' and position('--' in v_s) = 0) then
    return jsonb_build_object('slug', left(v_s, 60), 'ok', false, 'reason', 'format'); end if;
  if public.studio_slug_reserved(v_s) then return jsonb_build_object('slug', v_s, 'ok', false, 'reason', 'reserved'); end if;
  if not public.studio_slug_free(v_s, p_org) then
    return jsonb_build_object('slug', v_s, 'ok', false,
      'reason', case when public._r23_slug_protected(v_s)
                      and not exists (select 1 from public.org_slug_history h where h.org_id = p_org and h.slug = v_s) then 'reserved' else 'taken' end);
  end if;
  return jsonb_build_object('slug', v_s, 'ok', true, 'reason', null,
    'previous', exists (select 1 from public.org_slug_history h where h.org_id = p_org and h.slug = v_s));
end $$;

create or replace function public.hq_studio_link_check(p_org uuid, p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-studio-name-0257: HQ form's live availability (HQ operators only)
begin
  if auth.uid() is null or not public.is_platform_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'Studio not found.' using errcode = 'P0002'; end if;
  return public._r23_link_check(p_org, p_slug);
end $$;

create or replace function public.hq_set_studio_identity(p_org uuid, p_name text, p_slug text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-studio-name-0257
declare
  v_me uuid := auth.uid(); v_aal text := coalesce(auth.jwt() ->> 'aal', '');
  v_name text := nullif(btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', ' ', 'g'), '[[:space:]]+', ' ', 'g')), '');
  v_slug text := nullif(lower(btrim(coalesce(p_slug, ''))), '');
  v_reason text := btrim(coalesce(p_reason, ''));
  o public.organizations; n public.organizations; v_chk jsonb; v_recent int; v_nid uuid; v_label text;
begin
  if v_me is null or not public.is_platform_admin() or v_aal <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501',
      hint = 'Only a Helm HQ operator signed in with two-step verification can change a studio''s name or link.';
  end if;
  select * into o from public.organizations x where x.id = p_org for update;
  if o.id is null then raise exception 'Studio not found.' using errcode = 'P0002'; end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'Give a reason of 10 to 500 characters (for example who asked and how you confirmed it).' using errcode = '22023'; end if;
  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 120) then
    raise exception 'The studio name must be 2-120 characters.' using errcode = '22023'; end if;
  if v_name is not null and v_name !~ '[[:alnum:]]' then raise exception 'The studio name needs a letter or a number.' using errcode = '22023'; end if;
  if v_slug is not null and v_slug <> coalesce(o.public_slug, '') then
    v_chk := public._r23_link_check(p_org, v_slug);
    if not coalesce((v_chk ->> 'ok')::boolean, false) then
      raise exception '%', case v_chk ->> 'reason'
        when 'format' then 'The link must be 3-40 lowercase letters, numbers or single dashes.'
        when 'reserved' then 'That link is reserved (a Helm word or a look-alike of one).'
        else 'That link is used by another studio, or looks like one.' end using errcode = '22023';
    end if;
  end if;
  if (v_name is null or v_name = o.name) and (v_slug is null or v_slug = o.public_slug) then
    return jsonb_build_object('changed', false, 'name', o.name, 'slug', o.public_slug);
  end if;
  select count(*) into v_recent from public.audit_log a where a.actor = v_me and a.action = 'hq.studio.identity' and a.at > now() - interval '24 hours';
  if v_recent >= 20 then raise exception 'Too many studio renames in the last 24 hours. Try again tomorrow.' using errcode = 'P0001'; end if;
  perform public._hq_wgate('hq.studio.identity', 'organizations', p_org::text, jsonb_build_object(
    'name_from', o.name, 'name_to', coalesce(v_name, o.name), 'link_from', o.public_slug, 'link_to', coalesce(v_slug, o.public_slug), 'reason', v_reason));
  perform set_config('helm.r23_identity', txid_current()::text || ':' || p_org::text, true);
  update public.organizations x set name = coalesce(v_name, x.name), public_slug = coalesce(v_slug, x.public_slug) where x.id = p_org;
  perform set_config('helm.r23_identity', '', true);
  select * into n from public.organizations x where x.id = p_org;
  -- tell the studio's admins: bell (whole studio sees who changed it) + e-mail through the Helm notice outbox
  v_label := 'Helm support changed your studio ' ||
    case when n.name is distinct from o.name and n.public_slug is distinct from o.public_slug then 'name and link'
         when n.name is distinct from o.name then 'name' else 'link' end ||
    case when n.public_slug is distinct from o.public_slug then ' - your link is now helm.events/' || n.public_slug || ' (old links keep working)' else '' end;
  begin
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (null, 'in_app', 'studio_identity_changed', 'simulated',
              jsonb_build_object('label', v_label, 'source', 'r23_hq', 'name_from', o.name, 'name_to', n.name,
                                 'link_from', o.public_slug, 'link_to', n.public_slug), p_org)
      returning id into v_nid;
  exception when others then raise warning 'r23-studio-name-0257: bell row skipped (%)', sqlstate;
  end;
  begin
    insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
      values ('studio_identity', p_org, v_nid, jsonb_build_object('name_from', o.name, 'name_to', n.name,
              'link_from', o.public_slug, 'link_to', n.public_slug),
              'studio_identity:' || p_org::text || ':' || txid_current()::text)
    on conflict (dedupe_key) do nothing;
  exception when others then raise warning 'r23-studio-name-0257: e-mail not queued (%)', sqlstate;
  end;
  return jsonb_build_object('changed', true, 'name', n.name, 'slug', n.public_slug, 'old_name', o.name, 'old_slug', o.public_slug);
end $$;

-- ---- 5) e-mail: outbox kind (superset) + claim branch ------------------------------------------------------------------
do $$ declare v_def text; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  if v_def is not null and position('studio_identity' in v_def) > 0 then return; end if;
  if v_def is distinct from 'CHECK ((kind = ANY (ARRAY[''sales_request''::text, ''upgrade_ask''::text, ''close_request''::text, ''close_decision''::text])))' then
    raise notice '0257: helm_notice_outbox kind check has an unexpected body - left unchanged (studio rename e-mails stay off; bell still works)'; return; end if;
  alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check_0257
    check (kind in ('sales_request', 'upgrade_ask', 'close_request', 'close_decision', 'studio_identity'));
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox rename constraint helm_notice_outbox_kind_check_0257 to helm_notice_outbox_kind_check;
end $$;

do $$ declare v_def text; v_old text; v_new text; begin
  v_def := pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure);
  if position('r23-studio-name-0257' in v_def) > 0 then return; end if;
  v_old := E'    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0257: helm_notice_outbox_claim has an unexpected body - left unchanged (studio rename e-mails are skipped)'; return; end if;
  v_new := E'    elsif r.kind = ''studio_identity'' and r.org_id is not null then\n'
        || E'      -- r23-studio-name-0257: Helm HQ changed the studio name / link -> the studio''s admins\n'
        || E'      select coalesce(jsonb_agg(distinct lower(p.email)), ''[]''::jsonb) into v_to from public.profiles p\n'
        || E'       where p.org_id = r.org_id and p.role = ''admin'' and p.email is not null and not public.email_is_opted_out(null, p.email);\n'
        || E'      v_data := jsonb_build_object(''name_from'', r.payload ->> ''name_from'', ''name_to'', r.payload ->> ''name_to'',\n'
        || E'        ''link_from'', r.payload ->> ''link_from'', ''link_to'', r.payload ->> ''link_to'');\n'
        || v_old;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 6) grants -----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r23_slug_skeleton(text)', 'public._r23_slug_protected(text)', 'public._r23_link_check(uuid,text)',
                           'public._r23_hq_identity_ok(uuid)',
                           'public.tg_r23_org_identity_lock()', 'public.tg_r23_org_identity_audit()',
                           'public.hq_studio_link_check(uuid,text)', 'public.hq_set_studio_identity(uuid,text,text,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      if f like 'public.hq_%' then execute format('grant execute on function %s to authenticated', f);   -- HQ checks inside
      else execute format('revoke all on function %s from authenticated', f); end if;
    end if;
  end loop;
  if to_regprocedure('public.set_studio_link_name(text)') is not null then
    execute 'revoke all on function public.set_studio_link_name(text) from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.set_studio_link_name(text) from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.set_studio_link_name(text) from authenticated'; end if;
  end if;
end $$;

-- ---- VERIFY (read-only) ------------------------------------------------------------------------------------------------
-- select tgname from pg_trigger where tgrelid = 'public.organizations'::regclass and tgname like '%r23%';   -- 2 rows
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 lock trigger + audit trigger on organizations',
     (select count(*) from pg_trigger where tgrelid = 'public.organizations'::regclass and not tgisinternal
        and tgname in ('aa_r23_org_identity_lock', 'zz_r23_org_identity_audit')) = 2),
  ('02 the app can no longer call set_studio_link_name',
     not has_function_privilege('authenticated', 'public.set_studio_link_name(text)', 'execute')
     and not has_function_privilege('anon', 'public.set_studio_link_name(text)', 'execute')),
  ('03 HQ calls installed: signed-in only (HQ + two-step checked inside), never anon',
     has_function_privilege('authenticated', 'public.hq_set_studio_identity(uuid,text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_set_studio_identity(uuid,text,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.hq_studio_link_check(uuid,text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_studio_link_check(uuid,text)', 'execute')),
  ('04 look-alike rules active (bl00m-decor ~ bloom-decor, he1m protected, helmet-events allowed)',
     public._r23_slug_skeleton('bl00m-decor') = public._r23_slug_skeleton('bloomdecor')
     and public._r23_slug_protected('he1m') and not public._r23_slug_protected('helmet-events')),
  ('05 the 0020 guard lets only the HQ call through (one condition added)',
     position('_r23_hq_identity_ok' in pg_get_functiondef('public.organizations_public_slug_guard()'::regprocedure)) > 0),
  ('06 e-mail: outbox accepts studio_identity and the claim knows it',
     exists (select 1 from pg_constraint c where c.conrelid = 'public.helm_notice_outbox'::regclass
               and c.conname = 'helm_notice_outbox_kind_check' and position('studio_identity' in pg_get_constraintdef(c.oid)) > 0)
     and position('r23-studio-name-0257' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0),
  ('07 every studio still has a valid link (no row changed)',
     not exists (select 1 from public.organizations where public_slug is null or not public.studio_slug_valid(public_slug))),
  ('08 helpers are not callable by the app',
     not has_function_privilege('authenticated', 'public._r23_link_check(uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r23_hq_identity_ok(uuid)', 'execute')
     and not has_function_privilege('anon', 'public._r23_slug_protected(text)', 'execute'))
) v(item, ok) order by item;
