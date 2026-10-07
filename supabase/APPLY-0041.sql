-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0041 "Complete your profile" (one paste)                          (2026-10-07)
--   Every studio member gets a profile: mobile (+91, required), WhatsApp ("same as
--   mobile"), job title, department, skills, city, emergency contact and a photo.
--   Saving it keeps the member's Staff-directory row in step (so they can be assigned
--   tasks, texted and checked in) — an existing staff row with the same mobile is
--   LINKED, never duplicated. Day rate / employment type stay admin-only.
--   Privacy is enforced in the database: mobile, WhatsApp, city and the emergency
--   contact are returned only to the person, studio admins and roles with the
--   users-view right; colleagues see name / title / department / photo; another
--   studio sees nothing. Profile changes are audit-logged with masked mobiles (the
--   emergency-contact number is never logged).
--   First sign-in step: only accounts created AFTER this paste (the cutoff is recorded
--   now, once) are asked to complete their profile before the app opens; everyone
--   else gets a dismissible banner.
-- REQUIRES 0040 (link expiry → archive) on this database — the preflight stops if not.
--   BOTH production and staging need this (after 0040).
-- WHAT IT TOUCHES: 2 new tables (member_profiles, member_profile_settings — RLS on,
--   no direct API access), 1 nullable column on crew_members (profile_id → profiles,
--   ON DELETE SET NULL) + a partial unique index + 1 BEFORE trigger (linked staff rows
--   follow the profile; no second staff row for one account), 1 private storage bucket
--   (member-avatars) + 2 storage policies, new functions. chat_directory() is WRAPPED:
--   this database's own body is kept as chat_directory__base() and the new one adds
--   photo / title / department. helm_norm_phone is created only if missing.
--   Backfill: fills crew_members.profile_id where it is NULL (same studio + same mobile
--   as a complete profile) and NOTHING else. No row is deleted.
-- SAFE TO RE-RUN (the cutoff is never moved). If anything fails, the whole paste rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ declare f text; v_res text; begin
  if to_regprocedure('public.apply_link_expiry_archive(uuid)') is null
     or to_regclass('public.org_link_expiry_shelf') is null then
    raise exception 'STOP: 0040 (link expiry → archive) not installed — paste APPLY-0040.sql first'; end if;
  foreach f in array array['public.profiles', 'public.crew_members', 'public.audit_log', 'public.role_access',
      'auth.users', 'storage.buckets', 'storage.objects'] loop
    if to_regclass(f) is null then raise exception 'STOP: % is missing on this database', f; end if;
  end loop;
  foreach f in array array['public.current_org_id()', 'public.has_area(text, text)', 'public.is_admin()',
      'storage.foldername(text)', 'auth.uid()'] loop
    if to_regprocedure(f) is null then raise exception 'STOP: % is missing on this database', f; end if;
  end loop;
  foreach f in array array['name', 'phone', 'email', 'department', 'role', 'skills', 'day_rate', 'emp_type',
      'notes', 'active', 'created_at', 'org_id'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public'
                    and table_name = 'crew_members' and column_name = f) then
      raise exception 'STOP: crew_members.% is missing on this database', f; end if;
  end loop;
  if (select data_type from information_schema.columns where table_schema = 'public'
       and table_name = 'crew_members' and column_name = 'skills') <> 'jsonb' then
    raise exception 'STOP: crew_members.skills is not jsonb on this database — review before applying 0041'; end if;
  if to_regprocedure('public.chat_directory__base()') is null then
    if to_regprocedure('public.chat_directory()') is not null then
      v_res := pg_get_function_result('public.chat_directory()'::regprocedure);
      if v_res is distinct from 'TABLE(id uuid, full_name text, email_name text, role text)' then
        raise exception 'STOP: chat_directory() returns % here (expected the 0034 shape) — review before applying 0041', v_res; end if;
    end if;
  end if;
  raise notice 'Preflight OK — applying 0041…';
end $$;

-- ============================================================================
-- 0041_member_profile.sql — CANONICAL forward-only. REQUIRES 0040.
-- "Complete your profile": every studio member gets a profile (mobile, WhatsApp,
-- job title, department, skills, city, emergency contact, photo) that also keeps
-- their Staff-directory row up to date, so they can be assigned tasks, texted and
-- checked in like any other staff member.
--
-- DESIGN (why it looks like this):
--   * A 1:1 table public.member_profiles(user_id → profiles.id), NOT new columns on
--     profiles. 0021 locks profiles down (no API writes; guard trigger) and 0006 lets
--     anyone with the users-view right read colleagues' profile rows — new private
--     columns there (phone, emergency contact) would leak through that read. The new
--     table has RLS on and NO grants to anon / authenticated at all: every read and
--     write goes through the SECURITY DEFINER functions below, which decide field by
--     field what the caller may see. full_name stays on profiles (it is already the
--     name shown everywhere) and is written only by these functions.
--   * Privacy (enforced here, not just in the UI): mobile, WhatsApp, city and the
--     emergency contact are returned only to the person themselves, studio admins and
--     roles with the users-view right (has_area('users','view') — the same rule 0006
--     uses for colleagues' profile rows). Everyone else in the studio sees name, job
--     title, department and photo. Another studio sees nothing.
--   * Mobile numbers are Indian mobiles, stored as +91XXXXXXXXXX (10 digits starting
--     6-9). WhatsApp defaults to the mobile ("same as mobile"). Text fields: trimmed,
--     <= 80 characters, no < or >, no control characters. Skills: up to 20 tags of
--     <= 40 characters. Checked in SQL (and again by CHECK constraints).
--   * Audit: every change writes an audit_log row (who, old -> new). Mobile and
--     WhatsApp numbers are masked (+91******3210); the emergency-contact number is
--     NEVER written to the log (only "changed").
--   * Staff directory sync: crew_members gets profile_id (nullable, unique per studio,
--     FK -> profiles, ON DELETE SET NULL). Saving a profile upserts the linked staff
--     row: matched by profile_id, else by same studio + same number (normalised with
--     helm_norm_phone) on an UNLINKED row (that row is linked — no duplicate), else a
--     new row. Synced: name, phone, email, department (only when set), role (job title,
--     else the account role) and skills (added, never removed). NEVER touched: day_rate,
--     emp_type, notes, active. Admin-only day_rate / emp_type are written to the linked
--     row by admin_update_member_profile only. Client accounts never get a staff row.
--     A phone change on the staff row does NOT touch work_tokens or event_tasks: crew
--     links already sent keep working for the tasks they were sent for (they are keyed
--     by token and carry the phone they were issued to); new assignments use the new
--     number. If the new number is the same mobile written differently, the staff
--     row's phone string is left as it is (so nothing re-groups).
--   * Linked staff rows: name / phone / email / department / role / profile_id can no
--     longer be changed by direct API writes (Staff page) — they follow the profile
--     (edit in Control Center -> User control). A new or edited staff row may not take
--     the number of a linked member (that would be a second row for one account).
--   * First sign-in gate: member_profile_settings stores ONE cutoff = when this
--     migration was first applied (re-runs keep it). my_profile_status() says
--     required = true only for a non-client studio member, not an HQ operator, whose
--     profile is incomplete (no full name or no mobile) and whose account was created
--     at/after the cutoff. Older members get nudge = true (a gentle banner) instead.
--   * Photos: private bucket 'member-avatars' (2 MB, png / jpeg / webp), key
--     <studio>/<user>/<uuid>.<ext>. Upload: the user, into their OWN folder only (<= 50
--     files). Read (signed URLs): members of the same studio. No update / delete
--     policies: uploaded files are never overwritten or removed through the API;
--     "remove photo" only clears avatar_path.
--   * chat_directory() (0034) is WRAPPED, not rewritten: this database's own body is
--     kept as chat_directory__base() (never callable by API roles) and the new
--     chat_directory() returns its rows plus avatar_path / job_title / department.
--
-- Drift-safe: new table / column / index / bucket / policies / functions only; the
-- one existing function touched (chat_directory) is renamed to *__base and wrapped;
-- helm_norm_phone is created only if missing. Backfill fills crew_members.profile_id
-- where it is NULL and nothing else. No row is deleted. Idempotent.
-- ============================================================================

-- ---- 0) helpers this file relies on: create ONLY when missing (prod drift) ----------
do $guard$ begin
  if to_regprocedure('public.helm_norm_phone(text)') is null then
    execute $sql$
create function public.helm_norm_phone(p text)
returns text language sql immutable set search_path = '' as $fn$
  select case
           when d ~ '^[0-9]{10}$'      then '91' || d
           when d ~ '^0[0-9]{10}$'     then '91' || substr(d, 2)
           when d ~ '^00[0-9]{8,15}$'  then substr(d, 3)
           else d
         end
    from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) s;
$fn$;
$sql$;
    -- same grants as 0027 (a pure helper on the signed-out allowlist)
    execute 'grant execute on function public.helm_norm_phone(text) to public';
  end if;
end $guard$;

-- ---- 1) the gate cutoff (one row; set once, never moved by a re-run) ----------------
create table if not exists public.member_profile_settings (
  id          boolean primary key default true,
  gate_cutoff timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint member_profile_settings_one check (id)
);
alter table public.member_profile_settings enable row level security;
revoke all on public.member_profile_settings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.member_profile_settings from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.member_profile_settings from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on public.member_profile_settings to service_role'; end if;
end $$;
insert into public.member_profile_settings (id, gate_cutoff) values (true, now()) on conflict (id) do nothing;

-- ---- 2) the profile itself (1:1 with profiles; RPC-only) ----------------------------
create table if not exists public.member_profiles (
  user_id                 uuid primary key references public.profiles(id) on delete cascade,
  phone                   text,
  whatsapp                text,
  whatsapp_same           boolean not null default true,
  job_title               text,
  department              text,
  skills                  text[] not null default '{}'::text[],
  city                    text,
  emergency_contact_name  text,
  emergency_contact_phone text,
  avatar_path             text,
  profile_completed_at    timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  updated_by              uuid,
  constraint member_profiles_phone_chk     check (phone is null or phone ~ '^\+91[6-9][0-9]{9}$'),
  constraint member_profiles_whatsapp_chk  check (whatsapp is null or whatsapp ~ '^\+91[6-9][0-9]{9}$'),
  constraint member_profiles_emerg_ph_chk  check (emergency_contact_phone is null or emergency_contact_phone ~ '^\+[0-9]{8,15}$'),
  constraint member_profiles_text_chk      check (
        coalesce(char_length(job_title), 0) <= 80 and coalesce(char_length(department), 0) <= 80
    and coalesce(char_length(city), 0) <= 80 and coalesce(char_length(emergency_contact_name), 0) <= 80
    and coalesce(job_title, '') || coalesce(department, '') || coalesce(city, '') || coalesce(emergency_contact_name, '') !~ '[<>]'),
  constraint member_profiles_skills_chk    check (cardinality(skills) <= 20 and array_to_string(skills, '|') !~ '[<>]'),
  constraint member_profiles_avatar_chk    check (avatar_path is null
        or avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$')
);
alter table public.member_profiles enable row level security;
revoke all on public.member_profiles from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.member_profiles from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.member_profiles from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on public.member_profiles to service_role'; end if;
end $$;
create index if not exists member_profiles_phone_idx on public.member_profiles (phone) where phone is not null;

-- ---- 3) Staff directory link ---------------------------------------------------------
alter table public.crew_members add column if not exists profile_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'crew_members_profile_fk' and conrelid = 'public.crew_members'::regclass) then
    alter table public.crew_members add constraint crew_members_profile_fk
      foreign key (profile_id) references public.profiles(id) on delete set null;
  end if;
end $$;
create unique index if not exists crew_members_org_profile_uidx on public.crew_members (org_id, profile_id)
  where profile_id is not null;

-- ---- 4) validators (internal) --------------------------------------------------------
create or replace function public._mp_text(p_val text, p_label text, p_max int)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := btrim(regexp_replace(coalesce(p_val, ''), '\s+', ' ', 'g'));
  if v = '' then return null; end if;
  if char_length(v) > p_max then
    raise exception '% must be % characters or fewer.', p_label, p_max using errcode = '22023'; end if;
  if v ~ '[<>]' then raise exception '% can''t contain < or >.', p_label using errcode = '22023'; end if;
  if v ~ '[[:cntrl:]]' then raise exception '% can''t contain control characters.', p_label using errcode = '22023'; end if;
  return v;
end $$;

-- Indian mobile → +91XXXXXXXXXX (accepts 98765 43210, 098765…, +91 98765…, 91 98765…)
create or replace function public._mp_mobile(p_val text, p_label text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_val, '')); d text;
begin
  if v = '' then return null; end if;
  if v !~ '^\+?[0-9 ().-]{6,24}$' then
    raise exception '% must be a 10-digit Indian mobile number.', p_label using errcode = '22023'; end if;
  d := regexp_replace(v, '[^0-9]', '', 'g');
  if char_length(d) = 12 and left(d, 2) = '91' then d := substr(d, 3);
  elsif char_length(d) = 11 and left(d, 1) = '0' then d := substr(d, 2);
  end if;
  if d !~ '^[6-9][0-9]{9}$' then
    raise exception '% must be a 10-digit Indian mobile number starting with 6, 7, 8 or 9.', p_label using errcode = '22023'; end if;
  return '+91' || d;
end $$;

-- emergency contact: an Indian mobile, or an international number written with a leading +
create or replace function public._mp_any_phone(p_val text, p_label text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_val, '')); d text;
begin
  if v = '' then return null; end if;
  begin
    return public._mp_mobile(v, p_label);
  exception when sqlstate '22023' then null;
  end;
  d := regexp_replace(v, '[^0-9]', '', 'g');
  if v ~ '^\+[0-9 ().-]{6,24}$' and d ~ '^[1-9][0-9]{7,14}$' then return '+' || d; end if;
  raise exception '% must be a 10-digit Indian mobile number, or an international number starting with +.', p_label
    using errcode = '22023';
end $$;

-- skills: a JSON array of strings (or one comma-separated string) → text[] (deduped, <= 20)
create or replace function public._mp_skills(p jsonb)
returns text[] language plpgsql immutable set search_path = '' as $$
declare v_out text[] := '{}'::text[]; v_item jsonb; v text; v_src jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return v_out; end if;
  if jsonb_typeof(p) = 'string' then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into v_src from unnest(string_to_array(p #>> '{}', ',')) x;
  elsif jsonb_typeof(p) = 'array' then v_src := p;
  else raise exception 'Skills must be a list.' using errcode = '22023';
  end if;
  for v_item in select e from jsonb_array_elements(v_src) e loop
    if jsonb_typeof(v_item) <> 'string' then raise exception 'Each skill must be text.' using errcode = '22023'; end if;
    v := public._mp_text(v_item #>> '{}', 'A skill', 40);
    if v is not null and not exists (select 1 from unnest(v_out) s where lower(s) = lower(v)) then
      v_out := v_out || v;
    end if;
  end loop;
  if cardinality(v_out) > 20 then raise exception 'Add up to 20 skills.' using errcode = '22023'; end if;
  return v_out;
end $$;

-- +919876543210 → +91******3210 (audit log only)
create or replace function public._mp_mask(p text)
returns text language sql immutable set search_path = '' as $$
  select case when p is null then null
              when char_length(p) <= 6 then repeat('*', char_length(p))
              else left(p, 3) || repeat('*', char_length(p) - 7) || right(p, 4) end;
$$;

-- "set your own password first" (0032), when this database has that gate
create or replace function public._mp_pw_pending()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v boolean := false;
begin
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v;
  end if;
  return coalesce(v, false);
end $$;

-- HQ operator? (0037 is_platform_operator, else 0029 is_platform_admin; any error = no)
create or replace function public._mp_is_operator()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v boolean := false;
begin
  begin
    if to_regprocedure('public.is_platform_operator()') is not null then
      execute 'select public.is_platform_operator()' into v;
    elsif to_regprocedure('public.is_platform_admin()') is not null then
      execute 'select public.is_platform_admin()' into v;
    end if;
  exception when others then v := false;
  end;
  return coalesce(v, false);
end $$;

-- ---- 5) one member as JSON. level 0 = colleague, 1 = private fields, 2 = + admin staff fields
create or replace function public._mp_row_json(p_user uuid, p_level int)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
      'user_id', p.id, 'full_name', p.full_name, 'role', p.role,
      'email', case when p_level >= 1 then p.email end,
      'email_name', nullif(split_part(coalesce(p.email, ''), '@', 1), ''),
      'job_title', m.job_title, 'department', m.department,
      'skills', to_jsonb(coalesce(m.skills, '{}'::text[])),
      'avatar_path', m.avatar_path,
      'complete', (nullif(btrim(coalesce(p.full_name, '')), '') is not null and m.phone is not null),
      'profile_completed_at', m.profile_completed_at,
      'created_at', p.created_at,
      'phone', case when p_level >= 1 then m.phone end,
      'whatsapp', case when p_level >= 1 then m.whatsapp end,
      'whatsapp_same', case when p_level >= 1 then coalesce(m.whatsapp_same, true) end,
      'city', case when p_level >= 1 then m.city end,
      'emergency_contact_name', case when p_level >= 1 then m.emergency_contact_name end,
      'emergency_contact_phone', case when p_level >= 1 then m.emergency_contact_phone end,
      'staff_id', c.id,
      'day_rate', case when p_level >= 2 then c.day_rate end,
      'emp_type', case when p_level >= 2 then c.emp_type end)
    from public.profiles p
    left join public.member_profiles m on m.user_id = p.id
    left join lateral (select cm.id, cm.day_rate, cm.emp_type from public.crew_members cm
                        where cm.profile_id = p.id and cm.org_id = p.org_id limit 1) c on true
   where p.id = p_user;
$$;

-- ---- 6) keep the linked Staff-directory row in step (internal) ------------------------
-- p_admin: {"day_rate": n|null, "emp_type": text|null} — only keys present are written.
create or replace function public._mp_sync_staff(p_user uuid, p_admin jsonb)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_p record; v_m public.member_profiles; v_c public.crew_members; v_found boolean := false;
  v_role text; v_phone text; v_skills jsonb; v_s text; v_day numeric; v_emp text;
  v_admin jsonb := coalesce(p_admin, '{}'::jsonb);
begin
  select p.id, p.org_id, p.email, p.full_name, p.role into v_p from public.profiles p where p.id = p_user;
  if not found or v_p.org_id is null or v_p.role = 'client' then
    if v_admin <> '{}'::jsonb then
      raise exception 'Day rate and employment type need a studio team member (not a client account).' using errcode = '22023';
    end if;
    return null;
  end if;
  select * into v_m from public.member_profiles where user_id = p_user;
  if v_m.phone is null or nullif(btrim(coalesce(v_p.full_name, '')), '') is null then
    if v_admin <> '{}'::jsonb then
      raise exception 'Add a full name and mobile number first — day rate and employment type live on the staff record.'
        using errcode = '22023';
    end if;
    return null;
  end if;

  -- 1) the row already linked to this account
  select * into v_c from public.crew_members c
   where c.profile_id = p_user and c.org_id = v_p.org_id for update;
  v_found := found;
  -- 2) else an UNLINKED row in this studio with the same mobile → link it (no duplicate)
  if not v_found then
    select * into v_c from public.crew_members c
     where c.org_id = v_p.org_id and c.profile_id is null
       and public.helm_norm_phone(c.phone) = public.helm_norm_phone(v_m.phone)
     order by c.active desc, c.created_at, c.id
     limit 1 for update;
    v_found := found;
  end if;

  v_role := coalesce(v_m.job_title, initcap(replace(v_p.role, '_', ' ')));
  if v_admin ? 'day_rate' then v_day := (v_admin ->> 'day_rate')::numeric; end if;
  if v_admin ? 'emp_type' then v_emp := v_admin ->> 'emp_type'; end if;

  if v_found then
    -- same mobile written differently: keep the row's own string (crew links stay grouped)
    v_phone := case when public.helm_norm_phone(v_c.phone) = public.helm_norm_phone(v_m.phone) then v_c.phone else v_m.phone end;
    -- skills: add the profile's, never drop the staff row's own
    v_skills := case when jsonb_typeof(v_c.skills) = 'array' then v_c.skills else '[]'::jsonb end;
    foreach v_s in array coalesce(v_m.skills, '{}'::text[]) loop
      if not exists (select 1 from jsonb_array_elements_text(v_skills) e where lower(e) = lower(v_s)) then
        v_skills := v_skills || to_jsonb(v_s);
      end if;
    end loop;
    update public.crew_members c set
        name       = v_p.full_name,
        phone      = v_phone,
        email      = coalesce(v_p.email, c.email),
        department = coalesce(v_m.department, c.department),
        role       = v_role,
        skills     = v_skills,
        profile_id = p_user,
        day_rate   = case when v_admin ? 'day_rate' then v_day else c.day_rate end,
        emp_type   = case when v_admin ? 'emp_type' then v_emp else c.emp_type end
     where c.id = v_c.id
       and (c.name, c.phone, c.email, c.department, c.role, c.skills, c.profile_id, c.day_rate, c.emp_type)
           is distinct from
           (v_p.full_name, v_phone, coalesce(v_p.email, c.email), coalesce(v_m.department, c.department), v_role, v_skills, p_user,
            case when v_admin ? 'day_rate' then v_day else c.day_rate end,
            case when v_admin ? 'emp_type' then v_emp else c.emp_type end);
    return v_c.id;
  end if;

  insert into public.crew_members (name, phone, email, department, role, skills, org_id, profile_id, active, day_rate, emp_type)
    values (v_p.full_name, v_m.phone, v_p.email, v_m.department, v_role, to_jsonb(v_m.skills), v_p.org_id, p_user, true, v_day, v_emp)
    returning id into v_c.id;
  return v_c.id;
end $$;

-- ---- 7) the one write path (internal): validate, save, audit, sync -----------------
create or replace function public._mp_apply(p_user uuid, p_patch jsonb, p_by text, p_require boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_p record; v_old public.member_profiles; v_new public.member_profiles; v_had boolean;
  v_name text; v_key text; v_changed jsonb := '{}'::jsonb; v_admin jsonb := '{}'::jsonb;
  v_day numeric; v_emp text; v_complete boolean; v_email text;
  v_self_keys text[] := array['full_name', 'phone', 'whatsapp', 'whatsapp_same', 'job_title', 'department', 'skills',
                              'city', 'emergency_contact_name', 'emergency_contact_phone'];
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Send the profile fields as an object.' using errcode = '22023'; end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('day_rate', 'emp_type') then
      if p_by <> 'admin' then raise exception 'Only a studio admin can set the day rate or employment type.' using errcode = '42501'; end if;
    elsif not (v_key = any (v_self_keys)) then
      raise exception 'Unknown profile field: %', left(v_key, 40) using errcode = '22023';
    end if;
  end loop;

  select p.id, p.org_id, p.email, p.full_name, p.role into v_p from public.profiles p where p.id = p_user for update;
  if not found then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into v_old from public.member_profiles where user_id = p_user for update;
  v_had := found;
  v_new := v_old;
  if not v_had then v_new.user_id := p_user; v_new.whatsapp_same := true; v_new.skills := '{}'::text[]; end if;

  v_name := v_p.full_name;
  if p_patch ? 'full_name' then
    v_name := public._mp_text(p_patch ->> 'full_name', 'Full name', 80);
    if v_name is null then raise exception 'Full name is required.' using errcode = '22023'; end if;
  end if;
  if p_patch ? 'phone' then
    v_new.phone := public._mp_mobile(p_patch ->> 'phone', 'Mobile number');
    if v_new.phone is null then raise exception 'Mobile number is required.' using errcode = '22023'; end if;
  end if;
  if p_patch ? 'whatsapp_same' then
    if jsonb_typeof(p_patch -> 'whatsapp_same') <> 'boolean' then
      raise exception 'whatsapp_same must be true or false.' using errcode = '22023'; end if;
    v_new.whatsapp_same := (p_patch ->> 'whatsapp_same')::boolean;
  end if;
  if p_patch ? 'whatsapp' then v_new.whatsapp := public._mp_mobile(p_patch ->> 'whatsapp', 'WhatsApp number'); end if;
  if v_new.whatsapp_same then v_new.whatsapp := v_new.phone; end if;
  if p_patch ? 'job_title' then v_new.job_title := public._mp_text(p_patch ->> 'job_title', 'Job title', 80); end if;
  if p_patch ? 'department' then v_new.department := public._mp_text(p_patch ->> 'department', 'Department', 80); end if;
  if p_patch ? 'city' then v_new.city := public._mp_text(p_patch ->> 'city', 'City', 80); end if;
  if p_patch ? 'emergency_contact_name' then
    v_new.emergency_contact_name := public._mp_text(p_patch ->> 'emergency_contact_name', 'Emergency contact name', 80); end if;
  if p_patch ? 'emergency_contact_phone' then
    v_new.emergency_contact_phone := public._mp_any_phone(p_patch ->> 'emergency_contact_phone', 'Emergency contact number'); end if;
  if p_patch ? 'skills' then v_new.skills := public._mp_skills(p_patch -> 'skills'); end if;

  if p_patch ? 'day_rate' then
    if jsonb_typeof(p_patch -> 'day_rate') = 'null' or btrim(p_patch ->> 'day_rate') = '' then v_day := null;
    else
      begin v_day := (p_patch ->> 'day_rate')::numeric;
      exception when others then raise exception 'Day rate must be a number.' using errcode = '22023'; end;
      if v_day < 0 or v_day > 10000000 or v_day <> round(v_day, 2) then
        raise exception 'Day rate must be between 0 and 1,00,00,000 (up to 2 decimals).' using errcode = '22023'; end if;
    end if;
    v_admin := v_admin || jsonb_build_object('day_rate', v_day);
  end if;
  if p_patch ? 'emp_type' then
    v_emp := nullif(btrim(coalesce(p_patch ->> 'emp_type', '')), '');
    if v_emp is not null and v_emp not in ('full_time', 'part_time', 'on_call') then
      raise exception 'Employment type must be full-time, part-time or on-call.' using errcode = '22023'; end if;
    v_admin := v_admin || jsonb_build_object('emp_type', v_emp);
  end if;

  -- one mobile = one member of a studio (the staff link and crew links rely on it)
  if v_new.phone is not null and v_new.phone is distinct from v_old.phone and v_p.org_id is not null
     and exists (select 1 from public.member_profiles m join public.profiles p2 on p2.id = m.user_id
                  where p2.org_id = v_p.org_id and m.user_id <> p_user and m.phone = v_new.phone) then
    raise exception 'That mobile number is already on another team member''s profile in your studio.' using errcode = '23505';
  end if;

  v_complete := nullif(btrim(coalesce(v_name, '')), '') is not null and v_new.phone is not null;
  if p_require and not v_complete then
    raise exception 'Add your full name and mobile number to finish.' using errcode = '22023'; end if;
  if v_complete and v_new.profile_completed_at is null then v_new.profile_completed_at := now(); end if;

  -- audit (masked mobiles; the emergency-contact number is never logged)
  if v_name is distinct from v_p.full_name then
    v_changed := v_changed || jsonb_build_object('full_name', jsonb_build_object('old', v_p.full_name, 'new', v_name)); end if;
  if v_new.phone is distinct from v_old.phone then
    v_changed := v_changed || jsonb_build_object('phone', jsonb_build_object('old', public._mp_mask(v_old.phone), 'new', public._mp_mask(v_new.phone))); end if;
  if v_new.whatsapp is distinct from v_old.whatsapp then
    v_changed := v_changed || jsonb_build_object('whatsapp', jsonb_build_object('old', public._mp_mask(v_old.whatsapp), 'new', public._mp_mask(v_new.whatsapp))); end if;
  if v_had and v_new.whatsapp_same is distinct from v_old.whatsapp_same then
    v_changed := v_changed || jsonb_build_object('whatsapp_same', jsonb_build_object('old', v_old.whatsapp_same, 'new', v_new.whatsapp_same)); end if;
  if v_new.job_title is distinct from v_old.job_title then
    v_changed := v_changed || jsonb_build_object('job_title', jsonb_build_object('old', v_old.job_title, 'new', v_new.job_title)); end if;
  if v_new.department is distinct from v_old.department then
    v_changed := v_changed || jsonb_build_object('department', jsonb_build_object('old', v_old.department, 'new', v_new.department)); end if;
  if v_new.city is distinct from v_old.city then
    v_changed := v_changed || jsonb_build_object('city', jsonb_build_object('old', v_old.city, 'new', v_new.city)); end if;
  if coalesce(v_new.skills, '{}') is distinct from coalesce(v_old.skills, '{}') then
    v_changed := v_changed || jsonb_build_object('skills', jsonb_build_object('old', to_jsonb(coalesce(v_old.skills, '{}')), 'new', to_jsonb(v_new.skills))); end if;
  if v_new.emergency_contact_name is distinct from v_old.emergency_contact_name then
    v_changed := v_changed || jsonb_build_object('emergency_contact_name', jsonb_build_object('old', v_old.emergency_contact_name, 'new', v_new.emergency_contact_name)); end if;
  if v_new.emergency_contact_phone is distinct from v_old.emergency_contact_phone then
    v_changed := v_changed || jsonb_build_object('emergency_contact_phone', jsonb_build_object('changed', true, 'set', v_new.emergency_contact_phone is not null)); end if;
  if v_admin ? 'day_rate' then v_changed := v_changed || jsonb_build_object('day_rate', jsonb_build_object('new', v_admin -> 'day_rate')); end if;
  if v_admin ? 'emp_type' then v_changed := v_changed || jsonb_build_object('emp_type', jsonb_build_object('new', v_admin -> 'emp_type')); end if;

  if v_name is distinct from v_p.full_name then
    update public.profiles set full_name = v_name where id = p_user;
  end if;
  if not v_had or v_changed - 'full_name' - 'day_rate' - 'emp_type' <> '{}'::jsonb
     or v_new.profile_completed_at is distinct from v_old.profile_completed_at then
    insert into public.member_profiles as m (user_id, phone, whatsapp, whatsapp_same, job_title, department, skills, city,
        emergency_contact_name, emergency_contact_phone, profile_completed_at, updated_at, updated_by)
      values (p_user, v_new.phone, v_new.whatsapp, v_new.whatsapp_same, v_new.job_title, v_new.department, v_new.skills, v_new.city,
        v_new.emergency_contact_name, v_new.emergency_contact_phone, v_new.profile_completed_at, now(), v_me)
      on conflict (user_id) do update set
        phone = excluded.phone, whatsapp = excluded.whatsapp, whatsapp_same = excluded.whatsapp_same,
        job_title = excluded.job_title, department = excluded.department, skills = excluded.skills, city = excluded.city,
        emergency_contact_name = excluded.emergency_contact_name, emergency_contact_phone = excluded.emergency_contact_phone,
        profile_completed_at = excluded.profile_completed_at, updated_at = now(), updated_by = v_me;
  end if;
  if v_changed <> '{}'::jsonb then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (v_me, v_email, case when p_require then 'profile.complete' else 'profile.update' end, 'member_profiles',
              p_user::text, v_p.org_id, v_changed || jsonb_build_object('by', p_by));
  end if;

  perform public._mp_sync_staff(p_user, v_admin);
  return public._mp_row_json(p_user, case when p_by = 'admin' then 2 else 1 end);
end $$;

-- ---- 8) app RPCs ---------------------------------------------------------------------
create or replace function public.my_profile()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  return public._mp_row_json(auth.uid(), 1);
end $$;

-- the sign-in gate: {complete, required (full-page step), nudge (banner)}
create or replace function public.my_profile_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_p record; v_complete boolean; v_cut timestamptz; v_new boolean;
begin
  if v_me is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.org_id, p.role, p.full_name, p.created_at, m.phone into v_p
    from public.profiles p left join public.member_profiles m on m.user_id = p.id where p.id = v_me;
  if not found then return jsonb_build_object('complete', false, 'required', false, 'nudge', false); end if;
  v_complete := nullif(btrim(coalesce(v_p.full_name, '')), '') is not null and v_p.phone is not null;
  if v_complete or v_p.org_id is null or v_p.role = 'client' or public._mp_is_operator() then
    return jsonb_build_object('complete', v_complete, 'required', false, 'nudge', false);
  end if;
  select s.gate_cutoff into v_cut from public.member_profile_settings s where s.id;
  v_new := v_cut is not null and v_p.created_at >= v_cut;
  return jsonb_build_object('complete', false, 'required', v_new, 'nudge', not v_new);
end $$;

create or replace function public.update_my_profile(p_profile jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._mp_pw_pending() then raise exception 'set your own password first' using errcode = '42501'; end if;
  return public._mp_apply(auth.uid(), p_profile, 'self', false);
end $$;

create or replace function public.complete_my_profile(p_profile jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._mp_pw_pending() then raise exception 'set your own password first' using errcode = '42501'; end if;
  return public._mp_apply(auth.uid(), p_profile, 'self', true);
end $$;

-- a studio ADMIN edits a member of THEIR OWN studio (incl. day rate / employment type)
create or replace function public.admin_update_member_profile(p_user uuid, p_profile jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if public._mp_pw_pending() then raise exception 'set your own password first' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.org_id = v_org) then
    raise exception 'not authorized' using errcode = '42501'; end if;   -- unknown or another studio's user
  return public._mp_apply(p_user, p_profile, 'admin', false);
end $$;

-- User control list: everyone in my studio; private fields only for admins / users-view
create or replace function public.member_profile_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_level int;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_level := case when public.is_admin() then 2 when public.has_area('users', 'view') then 1 else 0 end;
  return coalesce((select jsonb_agg(public._mp_row_json(p.id, case when p.id = auth.uid() then greatest(v_level, 1) else v_level end)
                                    order by lower(coalesce(p.full_name, p.email, '')), p.id)
                     from public.profiles p where p.org_id = v_org), '[]'::jsonb);
end $$;

-- set (or clear, with null) my own photo — the file must already be in MY folder
create or replace function public.set_my_avatar(p_path text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_old text; v_new text; v_had boolean; v_email text;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._mp_pw_pending() then raise exception 'set your own password first' using errcode = '42501'; end if;
  v_new := nullif(btrim(coalesce(p_path, '')), '');
  if v_new is not null then
    if v_new !~ ('^' || v_org::text || '/' || v_me::text
                 || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$') then
      raise exception 'That photo isn''t one of your uploads.' using errcode = '22023'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'member-avatars' and o.name = v_new) then
      raise exception 'Upload the photo first.' using errcode = '22023'; end if;
  end if;
  select m.avatar_path into v_old from public.member_profiles m where m.user_id = v_me for update;
  v_had := found;
  if v_had and v_old is not distinct from v_new then return v_new; end if;
  if not v_had and v_new is null then return null; end if;
  insert into public.member_profiles as m (user_id, avatar_path, updated_at, updated_by) values (v_me, v_new, now(), v_me)
    on conflict (user_id) do update set avatar_path = excluded.avatar_path, updated_at = now(), updated_by = v_me;
  select u.email into v_email from auth.users u where u.id = v_me;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
    values (v_me, v_email, 'profile.avatar', 'member_profiles', v_me::text, v_org,
            jsonb_build_object('avatar', case when v_new is null then 'removed' when v_old is null then 'added' else 'replaced' end, 'by', 'self'));
  return v_new;
end $$;

-- audit page: who is who in MY studio (same people who may read the audit log)
create or replace function public.audit_actor_names()
returns table(id uuid, full_name text, email text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.email
    from public.profiles p
   where auth.uid() is not null
     and p.org_id = public.current_org_id()
     and (public.is_admin() or public.has_area('controls', 'view'))
   order by p.id;
$$;

-- ---- 9) chat_directory: keep this database's body, add photo / title / department ----
do $guard$
declare v_res text;
begin
  if to_regprocedure('public.chat_directory__base()') is null then
    if to_regprocedure('public.chat_directory()') is not null then
      v_res := pg_get_function_result('public.chat_directory()'::regprocedure);
      if v_res is distinct from 'TABLE(id uuid, full_name text, email_name text, role text)' then
        raise exception 'STOP: chat_directory() on this database returns % (expected the 0034 shape) — review before applying 0041', v_res;
      end if;
      alter function public.chat_directory() rename to chat_directory__base;
    else
      -- 0034 never ran here: create its body as the base (same rows as 0034)
      execute $sql$
create function public.chat_directory__base()
returns table(id uuid, full_name text, email_name text, role text)
language sql stable security definer set search_path = '' as $fn$
  select p.id, p.full_name, nullif(split_part(coalesce(p.email, ''), '@', 1), ''), p.role
    from public.profiles p
   where auth.uid() is not null
     and p.org_id = public.current_org_id()
   order by lower(coalesce(p.full_name, p.email, '')), p.id;
$fn$;
$sql$;
    end if;
  end if;
end $guard$;
revoke all on function public.chat_directory__base() from public;

create or replace function public.chat_directory()
returns table(id uuid, full_name text, email_name text, role text, avatar_path text, job_title text, department text)
language sql stable security definer set search_path = '' as $$
  select b.id, b.full_name, b.email_name, b.role, m.avatar_path, m.job_title, m.department
    from public.chat_directory__base() with ordinality as b(id, full_name, email_name, role, n)
    left join public.member_profiles m on m.user_id = b.id
   order by b.n;
$$;

-- ---- 10) Staff page guard: linked rows follow the profile; no 2nd row for an account --
create or replace function public.tg_crew_profile_link_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_who text;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;   -- definer RPCs / owner scripts
  if tg_op = 'INSERT' then
    if new.profile_id is not null then
      raise exception 'A staff record is linked to an account by the member''s profile, not directly.' using errcode = '42501'; end if;
  else
    if new.profile_id is distinct from old.profile_id then
      raise exception 'A staff record is linked to an account by the member''s profile, not directly.' using errcode = '42501'; end if;
    if old.profile_id is not null
       and (new.name, new.phone, new.email, new.department, new.role)
           is distinct from (old.name, old.phone, old.email, old.department, old.role) then
      raise exception 'This staff record is linked to a Helm account — change name, phone, email, department and title in Control Center → User control (or the member edits their own profile).'
        using errcode = '42501';
    end if;
  end if;
  if new.profile_id is null and (tg_op = 'INSERT' or new.phone is distinct from old.phone) then
    select c.name into v_who from public.crew_members c
     where c.org_id = new.org_id and c.profile_id is not null and c.id <> new.id
       and public.helm_norm_phone(c.phone) = public.helm_norm_phone(new.phone)
     limit 1;
    if v_who is not null then
      raise exception 'This number belongs to %, who already has a staff record linked to their Helm account.', v_who
        using errcode = '23505';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_crew_profile_link_guard() from public;
drop trigger if exists ab_crew_profile_link_guard on public.crew_members;
create trigger ab_crew_profile_link_guard before insert or update on public.crew_members
  for each row execute function public.tg_crew_profile_link_guard();

-- ---- 11) photos: private bucket, own-folder upload, same-studio read ------------------
create or replace function public.member_avatar_upload_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_parts text[] := string_to_array(coalesce(p_name, ''), '/'); v_org uuid := public.current_org_id();
        v_me uuid := auth.uid(); n int;
begin
  if v_me is null or v_org is null then return false; end if;
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] is distinct from v_org::text
     or v_parts[2] is distinct from v_me::text then return false; end if;
  if v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$' then return false; end if;
  if public._mp_pw_pending() then return false; end if;
  select count(*) into n from storage.objects o
   where o.bucket_id = 'member-avatars' and o.name like v_org::text || '/' || v_me::text || '/%';
  return n < 50;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('member-avatars', 'member-avatars', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 2097152,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

drop policy if exists member_avatars_insert on storage.objects;
create policy member_avatars_insert on storage.objects for insert to authenticated
  with check ( bucket_id = 'member-avatars' and public.member_avatar_upload_ok(name) );
drop policy if exists member_avatars_read on storage.objects;
create policy member_avatars_read on storage.objects for select to authenticated
  using ( bucket_id = 'member-avatars' and (storage.foldername(name))[1] = (select public.current_org_id())::text );

-- ---- 12) grants: app RPCs signed-in only; internals never callable by API roles -----
do $$
declare f text;
begin
  foreach f in array array[
      'public._mp_text(text, text, integer)', 'public._mp_mobile(text, text)', 'public._mp_any_phone(text, text)',
      'public._mp_skills(jsonb)', 'public._mp_mask(text)', 'public._mp_pw_pending()', 'public._mp_is_operator()',
      'public._mp_row_json(uuid, integer)', 'public._mp_sync_staff(uuid, jsonb)',
      'public._mp_apply(uuid, jsonb, text, boolean)', 'public.chat_directory__base()', 'public.tg_crew_profile_link_guard()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array array[
      'public.my_profile()', 'public.my_profile_status()', 'public.update_my_profile(jsonb)', 'public.complete_my_profile(jsonb)',
      'public.admin_update_member_profile(uuid, jsonb)', 'public.member_profile_list()', 'public.set_my_avatar(text)',
      'public.audit_actor_names()', 'public.chat_directory()', 'public.member_avatar_upload_ok(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- 13) backfill: link existing staff rows to existing complete profiles by mobile ---
-- Only fills crew_members.profile_id where it is NULL; changes nothing else. One row per
-- account (oldest-joined account first; the matching row: active first, then oldest).
do $$
declare r record; v_row uuid;
begin
  for r in
    select m.user_id, m.phone, p.org_id
      from public.member_profiles m join public.profiles p on p.id = m.user_id
     where m.phone is not null and p.org_id is not null and p.role <> 'client'
       and nullif(btrim(coalesce(p.full_name, '')), '') is not null
       and not exists (select 1 from public.crew_members c where c.org_id = p.org_id and c.profile_id = m.user_id)
     order by p.created_at, m.user_id
  loop
    select c.id into v_row from public.crew_members c
     where c.org_id = r.org_id and c.profile_id is null
       and public.helm_norm_phone(c.phone) = public.helm_norm_phone(r.phone)
     order by c.active desc, c.created_at, c.id limit 1;
    if v_row is not null then
      update public.crew_members set profile_id = r.user_id where id = v_row and profile_id is null;
    end if;
  end loop;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select gate_cutoff from public.member_profile_settings;
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'member-avatars';
-- select count(*) filter (where profile_id is not null) linked from public.crew_members;
-- select has_function_privilege('anon', 'public.my_profile()', 'EXECUTE');   -- false

-- ═══════════════════════════════ VERIFY ═══════════════════════════════════════
select item, case when ok then 'ok' else 'FAIL' end as status from (values
  ('profile tables: RLS on, no direct access for signed-in users or visitors',
     to_regclass('public.member_profiles') is not null and to_regclass('public.member_profile_settings') is not null
     and (select relrowsecurity from pg_class where oid = 'public.member_profiles'::regclass)
     and (select relrowsecurity from pg_class where oid = 'public.member_profile_settings'::regclass)
     and not has_table_privilege('anon', 'public.member_profiles', 'select')
     and not has_table_privilege('authenticated', 'public.member_profiles', 'select')
     and not has_table_privilege('authenticated', 'public.member_profiles', 'insert')
     and not has_table_privilege('authenticated', 'public.member_profiles', 'update')
     and not has_table_privilege('authenticated', 'public.member_profile_settings', 'select')
     and not has_table_privilege('authenticated', 'public.member_profile_settings', 'update')),
  ('one sign-in gate cutoff recorded (set once; a re-run keeps it)',
     (select count(*) from public.member_profile_settings) = 1
     and (select gate_cutoff from public.member_profile_settings) <= now()),
  ('mobile / WhatsApp / emergency / text / skills / photo-key checks on member_profiles',
     (select count(*) from pg_constraint where conrelid = 'public.member_profiles'::regclass and contype = 'c'
       and conname in ('member_profiles_phone_chk','member_profiles_whatsapp_chk','member_profiles_emerg_ph_chk',
                       'member_profiles_text_chk','member_profiles_skills_chk','member_profiles_avatar_chk')) = 6),
  ('staff link: crew_members.profile_id (FK, ON DELETE SET NULL) + one staff row per account per studio',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'crew_members' and column_name = 'profile_id')
     and exists (select 1 from pg_constraint where conname = 'crew_members_profile_fk' and conrelid = 'public.crew_members'::regclass and confdeltype = 'n')
     and to_regclass('public.crew_members_org_profile_uidx') is not null),
  ('linked staff rows follow the profile (guard trigger on crew_members)',
     exists (select 1 from pg_trigger where tgname = 'ab_crew_profile_link_guard' and tgrelid = 'public.crew_members'::regclass)),
  ('photo bucket member-avatars: private, 2 MB, png / jpeg / webp',
     exists (select 1 from storage.buckets where id = 'member-avatars' and not public and file_size_limit = 2097152
              and allowed_mime_types @> array['image/png','image/jpeg','image/webp'] and cardinality(allowed_mime_types) = 3)),
  ('photo policies: own-folder upload, same-studio read; no update / delete policy',
     exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'member_avatars_insert' and cmd = 'INSERT')
     and exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'member_avatars_read' and cmd = 'SELECT')
     and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                      and policyname like 'member_avatars%' and cmd in ('UPDATE','DELETE','ALL'))),
  ('chat_directory wrapped: this database''s body kept as chat_directory__base (internal), new one adds photo / title',
     to_regprocedure('public.chat_directory__base()') is not null
     and pg_get_function_result('public.chat_directory()'::regprocedure) like '%avatar_path%'
     and not has_function_privilege('authenticated', 'public.chat_directory__base()', 'execute')
     and not has_function_privilege('anon', 'public.chat_directory__base()', 'execute')
     and has_function_privilege('authenticated', 'public.chat_directory()', 'execute')
     and not has_function_privilege('anon', 'public.chat_directory()', 'execute')),
  ('app RPCs: signed-in only (permissions checked inside), never visitors',
     has_function_privilege('authenticated', 'public.my_profile()', 'execute')
     and has_function_privilege('authenticated', 'public.my_profile_status()', 'execute')
     and has_function_privilege('authenticated', 'public.update_my_profile(jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.complete_my_profile(jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.admin_update_member_profile(uuid,jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.member_profile_list()', 'execute')
     and has_function_privilege('authenticated', 'public.set_my_avatar(text)', 'execute')
     and has_function_privilege('authenticated', 'public.audit_actor_names()', 'execute')
     and not has_function_privilege('anon', 'public.my_profile()', 'execute')
     and not has_function_privilege('anon', 'public.my_profile_status()', 'execute')
     and not has_function_privilege('anon', 'public.update_my_profile(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.complete_my_profile(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.admin_update_member_profile(uuid,jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.member_profile_list()', 'execute')
     and not has_function_privilege('anon', 'public.set_my_avatar(text)', 'execute')
     and not has_function_privilege('anon', 'public.audit_actor_names()', 'execute')
     and not has_function_privilege('anon', 'public.member_avatar_upload_ok(text)', 'execute')
     and pg_get_functiondef('public.admin_update_member_profile(uuid,jsonb)'::regprocedure) like '%is_admin()%'),
  ('internal helpers are not callable by signed-in users or visitors',
     not has_function_privilege('authenticated', 'public._mp_apply(uuid,jsonb,text,boolean)', 'execute')
     and not has_function_privilege('authenticated', 'public._mp_sync_staff(uuid,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public._mp_row_json(uuid,integer)', 'execute')
     and not has_function_privilege('authenticated', 'public._mp_is_operator()', 'execute')
     and not has_function_privilege('anon', 'public._mp_apply(uuid,jsonb,text,boolean)', 'execute')
     and not has_function_privilege('anon', 'public._mp_row_json(uuid,integer)', 'execute')),
  ('helpers this file relies on are present',
     to_regprocedure('public.helm_norm_phone(text)') is not null and to_regprocedure('public.current_org_id()') is not null
     and to_regprocedure('public.is_admin()') is not null and to_regprocedure('public.has_area(text,text)') is not null),
  ('backfill only linked staff rows to complete profiles in the SAME studio',
     not exists (select 1 from public.crew_members c join public.profiles p on p.id = c.profile_id where p.org_id is distinct from c.org_id))
) v(item, ok);
