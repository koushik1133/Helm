-- ════════════════════════════════════════════════════════════════════════════
-- HELM — EVERYTHING PENDING (one paste) — Supabase SQL Editor           (v12, 2026-10-07)
--   0041 member profiles ("Complete your profile")
--   0042 security audit run 2 fixes (+ owner decisions D1, D2, D4, D5)
--   0043 two-step sign-in enforced by the database (owner decision D3)
-- REQUIRES 0040 on this database (each part's preflight stops if something is missing).
-- SAFE TO RE-RUN (each part is idempotent; 0042's backfills are UPDATE-only, nothing is
--   deleted). If anything fails, the whole run rolls back.
-- USE: SQL Editor → paste ALL → Run → every verification table must show ok = true.
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════ PART 0041 ═══════════════════════════════
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

-- ═══════════════════════════════ PART 0042 ═══════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0042 security audit run 2 fixes (one paste)                       (2026-10-07)
--   Client links: a missing / malformed OTP code is a wrong code; OTP codes are never
--   shown on screen on this server (only where helm_env_settings.allow_otp_dev_echo is
--   true — staging, set by the owner with the service role); a real SMS code needs the
--   client's mobile on file; links stop working while the quote is on the Archive /
--   Deleted shelf (and work again on restore). Crew links die when the staff member is
--   deactivated. Bell / notifications never carry links or tokens. Money, closure and
--   lifecycle actions follow the Control Center role matrix (missing matrix rows for the
--   roles that had access are added, so nobody loses access; admins always pass).
--   Approved refunds are frozen; quotes are hard-deleted only from the Deleted shelf.
--   Operator accounts can't join studios; invitations need a confirmed e-mail.
-- REQUIRES 0041 (member profiles) on this database — the preflight stops if not.
--   Paste on STAGING first, then PRODUCTION.
-- BACKFILLS (owner decision D4, UPDATE only): link/token keys removed from stored
--   notification details; misfiled audit rows moved to the event's studio (hq.* rows to
--   none); approval links without an expiry get one; invitation slugs with only 6 hex
--   characters get 16 (studios must re-share those links); otp_dev_echo switched off.
-- WHAT IT TOUCHES: 1 new table (helm_env_settings, no API access), 1 nullable column
--   (platform_admins.user_id), new _a42_* helpers, wrappers over this database's own
--   bodies (kept as <fn>__pre0042), new triggers, RESTRICTIVE policies (only narrow).
--   No row is deleted. SAFE TO RE-RUN. If anything fails, the whole paste rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ declare f text; begin
  if to_regprocedure('public.my_profile()') is null or to_regclass('public.member_profiles') is null then
    raise exception 'STOP: 0041 (member profiles) not installed — paste APPLY-0041.sql first'; end if;
  foreach f in array array['public.quotes', 'public.quote_otps', 'public.quote_consents', 'public.notifications',
      'public.audit_log', 'public.app_config', 'public.event_refunds', 'public.crew_members', 'public.work_tokens',
      'public.task_evidence_grants', 'public.invitations', 'public.platform_admins', 'public.event_sites',
      'public.event_proposal', 'public.role_access', 'public.payment_milestones', 'public.quote_payments',
      'public.organizations', 'public.profiles', 'auth.users'] loop
    if to_regclass(f) is null then raise exception 'STOP: % is missing on this database', f; end if;
  end loop;
  foreach f in array array['public.current_org_id()', 'public.has_area(text, text)', 'public.is_admin()',
      'public.can_delete()', 'public.can_create()', 'public._valid_role(text)', 'public.helm_norm_phone(text)',
      'public.link_age_expired(timestamp with time zone)', 'public.approval_link_age_until(uuid)',
      'public.work_link_age_until(uuid)', 'public._flag(text, uuid)', 'public.client_link_deadline(date, uuid, integer)',
      'public.work_token_expiry_for(uuid)', 'public.task_proof_upload_ok(text)', 'public.tg_audit()',
      'public.is_platform_admin()', 'public.is_platform_operator()'] loop
    if to_regprocedure(f) is null then raise exception 'STOP: % is missing on this database', f; end if;
  end loop;
  foreach f in array array['quotes.deleted_at', 'quotes.archived_at', 'quotes.approval_token_revoked_at',
      'quotes.approval_token_expires_at', 'work_tokens.revoked_at', 'task_evidence_grants.quote_id'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public'
                    and table_name = split_part(f, '.', 1) and column_name = split_part(f, '.', 2)) then
      raise exception 'STOP: column % is missing on this database', f; end if;
  end loop;
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is null then
    raise exception 'STOP: 0039 wrappers not found (NV-03) — re-paste APPLY-0039.sql first'; end if;
  raise notice 'Preflight OK — applying 0042…';
end $$;

-- ============================================================================
-- 0042_audit_run2_fixes.sql — CANONICAL forward-only. REQUIRES 0041.
-- Security audit run 2, Phase H "safe now" fixes (REMEDIATION-PLAN.md):
--   RC-1  OTP: a NULL / non-6-digit code is a wrong code (counts an attempt, never
--         approves); dev-echo codes only where the service-role-only setting
--         helm_env_settings.allow_otp_dev_echo = true (staging); echo consents are
--         stored verified_via_otp = false; open OTPs expire on revoke / new link / shelf.
--   RC-2  bell_feed never returns token / url keys; new notifications rows are stored
--         without them (no backfill of old rows — owner decision D4).
--   RC-3  client links die while the quote is on the Archive / Deleted shelf (and work
--         again on restore); crew links die when that staff member is deactivated or
--         their number changes; admin_revoke_work_links(); proof-upload grants obey
--         the 0039 link age.
--   RC-4  STRICTER-ONLY role checks (has_area AND the existing checks); a payment that
--         doesn't cover a milestone no longer marks it paid; set_lifecycle_stage can't
--         jump to 'closed'; quotes: hard delete only from the Deleted shelf by
--         can_delete() roles, insert only by can_create() roles (RESTRICTIVE policies).
--   RC-5  approved / processed refunds are frozen for API callers (event_refunds only).
--   RC-7  a self-typed mobile no longer takes over an existing unlinked staff row;
--         platform operator e-mails can't join / be created / be invited (create_studio
--         is already refused for operators by 0037); invitations
--         need a confirmed e-mail; a re-invite at another role changes the role and
--         rotates the token; invitation rows (tokens) readable only with users-edit.
--   RC-8  audit_log / notifications / quote_otps rows carry the ROW's studio, not the
--         caller's; hq.* audit rows have no studio. Forward only — no backfill.
--   RC-9  event_site_live_until answers only the caller's own studio (or a published
--         site); work_token_expiry_for / client_link_deadline and trigger functions are
--         no longer callable by anon / authenticated.
--   RC-10 the per-link OTP limit (5 / 10 min, 10 / day) is checked BEFORE the shared
--         studio SMS counter.
--
-- DRIFT-SAFE (production differs from canonical): each changed public entry point is
-- renamed ONCE to <fn>__pre0042 (only if that name is still free) and replaced by a
-- wrapper that runs the new guards and then calls this database's own body. Functions
-- referenced by policies / triggers keep their OID: task_proof_upload_ok is CLONED to
-- __pre0042 from this database's own definition; tg_audit is replaced only when its
-- body is the known canonical one (else a NOTICE and it is left alone). New helpers are
-- _a42_*. Policies are only ADDED as RESTRICTIVE (they can only narrow access).
-- No DROP TABLE / column, no DELETE, no TRUNCATE, no backfill. Safe to re-run.
--
-- FOLLOW-UP (not here): RC-6 DB-enforced MFA (D3), D2 matrix-as-sole-authority,
-- D4 backfills, D6 freeze for expense_claims / change_requests / event_costs, NV-*.
-- Other can_edit()-only definers to review in a follow-up: assign_tasks, reassign_task,
-- mgr_notify, generate_approval_token (has has_area), publish_proposal.
-- ============================================================================

-- ---- 0) helpers -------------------------------------------------------------
create table if not exists public.helm_env_settings (
  key        text primary key,
  value      jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.helm_env_settings enable row level security;
revoke all on public.helm_env_settings from public, anon, authenticated;
grant all on public.helm_env_settings to service_role;
comment on table public.helm_env_settings is
  'Per-environment switches (0042). No API access: only the service role / database owner can write. '
  'allow_otp_dev_echo = true only on staging.';

create or replace function public._a42_dev_echo_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value in ('true'::jsonb, '"true"'::jsonb)
                     from public.helm_env_settings s where s.key = 'allow_otp_dev_echo'), false);
$$;

create or replace function public._a42_redact_detail(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) = 'object'
              then p - array['token', 'url', 'link', 'approval_url', 'work_url', 'work_link',
                             'portal_url', 'payment_url', 'link_url', 'approval_token', 'work_token']
              else p end;
$$;

create or replace function public._a42_quote_shelved(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select q.deleted_at is not null or q.archived_at is not null
                     from public.quotes q where q.id = p_quote), false);
$$;

create or replace function public._a42_is_operator_email(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(coalesce(p_email, '')), '') is not null
                  and exists (select 1 from public.platform_admins pa
                               where lower(pa.email) = lower(btrim(p_email))), false);
$$;

create or replace function public._a42_expire_open_otps(p_quote uuid)
returns void language sql volatile security definer set search_path = '' as $$
  update public.quote_otps o set expires_at = now()
   where o.quote_id = p_quote and o.verified_at is null and o.expires_at > now();
$$;

do $$ declare f text; begin
  foreach f in array array['_a42_dev_echo_allowed()', '_a42_redact_detail(jsonb)', '_a42_quote_shelved(uuid)',
      '_a42_is_operator_email(text)', '_a42_expire_open_otps(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- 1) keep this database's own bodies (rename once) --------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['verify_and_consent',        'uuid, text, text, boolean, text, text, text, text'],
    ['request_otp',               'uuid, text'],
    ['otp_send_authorize',        'uuid, text'],
    ['public_get_quote',          'uuid'],
    ['public_get_portal',         'uuid'],
    ['public_get_proposal',       'uuid'],
    ['create_payment',            'uuid'],
    ['payment_link_begin',        'uuid, integer'],
    ['_work_token_live',          'uuid'],
    ['revoke_approval_token',     'uuid'],
    ['generate_approval_token',   'uuid'],
    ['move_quote_to_shelf',       'uuid, text'],
    ['bell_feed',                 'integer'],
    ['record_settlement_payment', 'uuid, numeric, text, text, uuid, text, text'],
    ['record_payment',            'uuid, numeric, text, text, uuid, text, text'],
    ['close_event',               'uuid, boolean'],
    ['set_closure',               'uuid, integer, text, text, boolean, text'],
    ['set_lifecycle_stage',       'uuid, text'],
    ['mark_paid',                 'uuid, text'],
    ['_mp_sync_staff',            'uuid, jsonb'],
    ['accept_invitation',         'text'],
    ['admin_create_user',         'text, text, text'],
    ['_admin_create_user_core',   'text, text, text'],
    ['create_invitation',         'text, text'],
    ['create_studio',             'text, text, text, text'],
    ['event_site_live_until',     'uuid']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0042', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        if f[1] = '_work_token_live' then                     -- optional on drifted databases
          raise notice '0042: public._work_token_live(uuid) not on this database — crew-link gate skipped'; continue;
        end if;
        raise exception '0042: public.%(%) is missing on this database', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0042');
    end if;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0042', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1] || '__pre0042', f[2]);
  end loop;
end $$;

-- task_proof_upload_ok is used by a storage policy (by OID): clone, don't rename
do $$ declare d text; begin
  if to_regprocedure('public.task_proof_upload_ok__pre0042(text)') is null then
    d := pg_get_functiondef('public.task_proof_upload_ok(text)'::regprocedure);
    d := replace(d, 'FUNCTION public.task_proof_upload_ok(', 'FUNCTION public.task_proof_upload_ok__pre0042(');
    execute d;
  end if;
  revoke all on function public.task_proof_upload_ok__pre0042(text) from public, anon, authenticated;
  grant execute on function public.task_proof_upload_ok__pre0042(text) to service_role;
end $$;

-- ---- 1b) owner decision D2: the role_access matrix is the single authority ------------
-- The kept bodies of the money / closure / lifecycle RPCs check a hardcoded role list
-- (can_edit(): admin, planner, sales, operations; mark_paid: admin, manager). That list is
-- neutralised IN THIS DATABASE'S OWN BODY (textual, so drifted logic is kept) and the
-- wrappers below check has_area(area, 'edit') instead (admin always passes has_area).
-- Patterns not found (already changed on this database) are left alone with a NOTICE.
do $$ declare f text; d text; d2 text; begin
  foreach f in array array['revoke_approval_token__pre0042(uuid)', 'generate_approval_token__pre0039(uuid)',
      'record_settlement_payment__pre0042(uuid, numeric, text, text, uuid, text, text)',
      'record_payment__pre0042(uuid, numeric, text, text, uuid, text, text)',
      'close_event__pre0042(uuid, boolean)', 'set_closure__pre0042(uuid, integer, text, text, boolean, text)',
      'set_lifecycle_stage__pre0042(uuid, text)', 'mark_paid__pre0042(uuid, text)', 'mark_paid__base(uuid, text)'] loop
    if to_regprocedure('public.' || f) is null then raise notice '0042 D2: % not on this database — skipped', f; continue; end if;
    d := pg_get_functiondef(('public.' || f)::regprocedure);
    d2 := replace(d, 'not public.can_edit()', 'not (true /* a42-d2: matrix */)');
    d2 := replace(d2, $q$coalesce(public.user_role(), '') not in ('admin', 'manager')$q$, '(false /* a42-d2: matrix */)');
    d2 := replace(d2, $q$public.user_role() not in ('admin','manager')$q$, '(false /* a42-d2: matrix */)');
    if d2 <> d then execute d2;
    elsif position('a42-d2' in d) = 0 then raise notice '0042 D2: no hardcoded role check found in % — left unchanged', f; end if;
  end loop;
end $$;

-- nobody loses access on rollout: the roles the hardcoded lists let in get the matching
-- matrix row WHERE THE STUDIO HAS NO ROW YET (an explicit row, e.g. edit = false, is the
-- studio's own choice and is kept). Insert-only; admin needs no row.
create or replace function public._a42_seed_matrix_defaults()
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
  select o.id, x.role, x.area, true, true, now()
    from public.organizations o
    cross join (values ('planner','settlement'), ('sales','settlement'), ('operations','settlement'),
                       ('planner','closure'),    ('sales','closure'),    ('operations','closure'),
                       ('planner','quotes'),     ('sales','quotes'),     ('operations','quotes'),
                       ('manager','finance')) x(role, area)
   where not exists (select 1 from public.role_access ra where ra.org_id = o.id and ra.role = x.role and ra.area = x.area)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._a42_seed_matrix_defaults() from public, anon, authenticated;
grant execute on function public._a42_seed_matrix_defaults() to service_role;
select public._a42_seed_matrix_defaults();

-- ---- 2) RC-1 / RC-3 / RC-10: approval-link entry points -------------------------
create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean,
                                                     p_terms_version text, p_consent_text text,
                                                     p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042: a NULL / malformed code is a wrong code (C-01); shelf gate; echo consents
declare v_q uuid; v_org uuid; rec public.quote_otps; v_out jsonb; v_echo boolean := false;
begin
  select q.id, q.org_id into v_q, v_org from public.quotes q
   where q.approval_token = p_token and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is not null then
    if public._a42_quote_shelved(v_q) then raise exception 'this link has expired' using errcode = 'P0001'; end if;
    if (p_code is null or p_code !~ '^[0-9]{6}$')
       and not public.link_age_expired(public.approval_link_age_until(p_token)) then
      select * into rec from public.quote_otps o
       where o.quote_id = v_q and o.phone = p_phone and o.verified_at is null and o.expires_at > now()
       order by o.created_at desc limit 1 for update;
      if rec.id is null then
        return jsonb_build_object('approved', false, 'error', 'no_active_code', 'message', 'no active code — request a new OTP');
      end if;
      if rec.attempts >= 5 then
        return jsonb_build_object('approved', false, 'error', 'locked', 'message', 'too many attempts — request a new OTP');
      end if;
      update public.quote_otps set attempts = attempts + 1 where id = rec.id;
      return jsonb_build_object('approved', false, 'error', 'incorrect_code', 'message', 'incorrect code',
                                'remaining', greatest(0, 5 - (rec.attempts + 1)));
    end if;
    v_echo := public._a42_dev_echo_allowed() and not public._flag('sms_live', v_org)
              and public._flag('otp_dev_echo', v_org);
  end if;
  v_out := public.verify_and_consent__pre0042(p_token, p_phone, p_code, p_agreed, p_terms_version,
                                              p_consent_text, p_client_name, p_user_agent);
  if v_echo and coalesce((v_out ->> 'approved')::boolean, false) then
    -- the code was shown on screen (staging dev echo), not delivered by SMS
    update public.quote_consents c set verified_via_otp = false
     where c.id = (select c2.id from public.quote_consents c2 where c2.quote_id = v_q
                    order by c2.created_at desc, c2.id desc limit 1)
       and c.verified_via_otp;
  end if;
  return v_out;
end $$;

create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042: shelf gate; per-link limit first (C-15); dev echo only where allowed (C-11).
-- The code is still generated by request_otp__base (secure: extensions.gen_random_bytes, see 0026).
declare v_q uuid; v_n10 int; v_n24 int; v_out jsonb;
begin
  select q.id into v_q from public.quotes q
   where q.approval_token = p_token and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is not null then
    if public._a42_quote_shelved(v_q) then raise exception 'this link has expired' using errcode = 'P0001'; end if;
    select count(*) filter (where o.created_at > now() - interval '10 minutes'), count(*)
      into v_n10, v_n24 from public.quote_otps o
     where o.quote_id = v_q and o.created_at > now() - interval '24 hours';
    if v_n10 >= 5 then raise exception 'too many OTP requests — try again in a few minutes' using errcode = 'P0001'; end if;
    if v_n24 >= 10 then raise exception 'too many OTP requests on this link today — try again tomorrow' using errcode = 'P0001'; end if;
  end if;
  v_out := public.request_otp__pre0042(p_token, p_phone);
  if not public._a42_dev_echo_allowed() and v_out ? 'dev_code' then
    if v_out ->> 'delivery' = 'dev_echo' then
      v_out := v_out || jsonb_build_object('sent', false, 'delivery', 'unavailable',
        'message', 'OTP delivery is not configured. Ask the studio to send the code by SMS.');
    end if;
    v_out := v_out || jsonb_build_object('dev_code', null);
  end if;
  return v_out;
end $$;

create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042: shelf gate; a real SMS code needs the client's mobile ON FILE (owner D5);
-- the per-link / per-number limits run BEFORE the shared studio SMS counter (C-15)
declare v_q uuid; v_client jsonb; v_n10 int; v_n24 int; v_nh int;
begin
  select q.id, q.client into v_q, v_client from public.quotes q where q.approval_token = p_token
     and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is not null and not public.link_age_expired(public.approval_link_age_until(p_token)) then   -- else: the earlier answers
    if public._a42_quote_shelved(v_q) then raise exception 'invalid link' using errcode = 'HL404'; end if;
    if coalesce(public.helm_norm_phone(v_client ->> 'phone'), '') = '' then
      raise exception 'The studio has no mobile number on file for you yet — ask them to add it, then request the code again.'
        using errcode = 'HL403';
    end if;
    select count(*) filter (where o.created_at > now() - interval '10 minutes'), count(*),
           count(*) filter (where o.created_at > now() - interval '1 hour'
                              and public.helm_norm_phone(o.phone) = public.helm_norm_phone(p_phone))
      into v_n10, v_n24, v_nh from public.quote_otps o
     where o.quote_id = v_q and o.created_at > now() - interval '24 hours';
    if v_n10 >= 5 or v_n24 >= 10 or v_nh >= 3 then raise exception 'too many OTP requests' using errcode = 'HL429'; end if;
  end if;
  return public.otp_send_authorize__pre0042(p_token, p_phone);
end $$;

create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_quote_shelved((select q.id from public.quotes q where q.approval_token = p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_quote__pre0042(p_token);
end $$;

create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_quote_shelved((select q.id from public.quotes q where q.approval_token = p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_portal__pre0042(p_token);
end $$;

create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.event_proposal pr where pr.share_token = p_token
                and public._a42_quote_shelved(pr.quote_id)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_proposal__pre0042(p_token);
end $$;

create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_quote_shelved((select q.id from public.quotes q where q.approval_token = p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.create_payment__pre0042(p_token);
end $$;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer default 4320)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_quote_shelved((select q.id from public.quotes q where q.approval_token = p_token)) then
    return jsonb_build_object('action', 'invalid');
  end if;
  return public.payment_link_begin__pre0042(p_token, p_ttl_minutes);
end $$;

-- ---- 3) RC-1 / RC-4: studio-side link + quote actions ----------------------------
create or replace function public.revoke_approval_token(p_quote_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_out jsonb;
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  v_out := public.revoke_approval_token__pre0042(p_quote_id);          -- can_edit + studio checks, as before
  perform public._a42_expire_open_otps(p_quote_id);
  return v_out;
end $$;

create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_old uuid; tok uuid;
begin
  select q.approval_token into v_old from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id();
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  tok := public.generate_approval_token__pre0042(p_quote_id);          -- studio + age checks, as before
  if tok is distinct from v_old then
    perform public._a42_expire_open_otps(p_quote_id);
    -- a NEW link starts clean (h07): not revoked, and it gets an expiry (NV-05)
    update public.quotes q
       set approval_token_revoked_at = null,
           approval_token_expires_at = greatest(now() + interval '30 days',
                                                public.client_link_deadline(q.event_date, q.org_id, 30))
     where q.id = p_quote_id and q.org_id = public.current_org_id() and q.approval_token = tok;
  end if;
  return tok;
end $$;

create or replace function public.move_quote_to_shelf(p_quote_id uuid, p_shelf text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_out jsonb;
begin
  v_out := public.move_quote_to_shelf__pre0042(p_quote_id, p_shelf);   -- every permission check, as before
  if public._a42_quote_shelved(p_quote_id) then perform public._a42_expire_open_otps(p_quote_id); end if;
  return v_out;
end $$;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_stage = 'closed' then
    raise exception 'Close the event from its Closure page.' using errcode = '22023';
  end if;
  return public.set_lifecycle_stage__pre0042(p_quote_id, p_stage);
end $$;

create or replace function public.close_event(p_quote_id uuid, p_closed boolean)
returns public.event_closure language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('closure', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.close_event__pre0042(p_quote_id, p_closed);
end $$;

create or replace function public.set_closure(p_quote_id uuid, p_rating integer, p_feedback text, p_testimonial text,
                                              p_media_consent boolean, p_lessons text)
returns public.event_closure language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('closure', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.set_closure__pre0042(p_quote_id, p_rating, p_feedback, p_testimonial, p_media_consent, p_lessons);
end $$;

create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  -- settles exactly one open quote_payments request, as before (mark_paid__pre0042)
  return public.mark_paid__pre0042(p_quote_id, p_provider_ref);
end $$;

-- a milestone flipped to paid by THIS call stays paid only if this payment (plus any
-- ledger credit not yet allocated to paid milestones) covers it; otherwise it goes back
create or replace function public._a42_milestone_state(p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'paid_ids', coalesce((select jsonb_object_agg(pm.id::text, true) from public.payment_milestones pm
                           where pm.quote_id = p_quote and pm.status = 'paid'), '{}'::jsonb),
    'status',   coalesce((select jsonb_object_agg(pm.id::text, pm.status) from public.payment_milestones pm
                           where pm.quote_id = p_quote), '{}'::jsonb),
    'credit',   coalesce((select sum(qp.amount) from public.quote_payments qp
                           where qp.quote_id = p_quote and qp.status = 'paid'), 0)
              - coalesce((select sum(pm.amount) from public.payment_milestones pm
                           where pm.quote_id = p_quote and pm.status = 'paid'), 0));
$$;

create or replace function public._a42_milestone_cover(p_quote uuid, p_amount numeric, p_state jsonb)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare m record; v_reverted boolean := false; v_credit numeric := greatest(coalesce((p_state ->> 'credit')::numeric, 0), 0);
begin
  for m in select pm.id, pm.amount from public.payment_milestones pm
            where pm.quote_id = p_quote and pm.status = 'paid' and not ((p_state -> 'paid_ids') ? pm.id::text)
  loop
    if v_credit + coalesce(p_amount, 0) < coalesce(m.amount, 0) - 0.005 then
      update public.payment_milestones
         set status = coalesce(nullif(p_state -> 'status' ->> m.id::text, 'paid'), 'due'), paid_at = null
       where id = m.id;
      v_reverted := true;
    end if;
  end loop;
  return v_reverted;
end $$;

create or replace function public.record_payment(p_quote uuid, p_amount numeric, p_method text default 'cash',
                                                 p_receipt_no text default null, p_milestone uuid default null,
                                                 p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_state jsonb; v_out jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || coalesce(p_quote::text, ''), 0));
  v_state := public._a42_milestone_state(p_quote);
  -- the receipt row is written to quote_payments by record_payment__pre0042 (ledger + caps unchanged)
  v_out := public.record_payment__pre0042(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
  if not coalesce((v_out ->> 'idempotent_replay')::boolean, false)
     and public._a42_milestone_cover(p_quote, p_amount, v_state) then
    v_out := v_out || jsonb_build_object('milestone_paid', false,
      'milestone_note', 'Part payment recorded — the milestone stays open until it is fully covered.');
  end if;
  return v_out;
end $$;

create or replace function public.record_settlement_payment(p_quote uuid, p_amount numeric, p_method text default 'cash',
                                                            p_receipt_no text default null, p_milestone uuid default null,
                                                            p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_state jsonb; v_out jsonb;
begin
  if not public.has_area('settlement', 'edit') then           -- D2: the matrix decides
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || coalesce(p_quote::text, ''), 0));
  v_state := public._a42_milestone_state(p_quote);
  -- the receipt row is written to quote_payments by record_settlement_payment__pre0042
  v_out := public.record_settlement_payment__pre0042(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
  if p_milestone is not null and not coalesce((v_out ->> 'idempotent_replay')::boolean, false)
     and public._a42_milestone_cover(p_quote, p_amount, v_state) then
    v_out := v_out || jsonb_build_object('milestone_paid', false,
      'milestone_note', 'Part payment recorded — the milestone stays open until it is fully covered.');
  end if;
  return v_out;
end $$;

do $$ declare f text; begin
  foreach f in array array['_a42_milestone_state(uuid)', '_a42_milestone_cover(uuid, numeric, jsonb)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- 4) RC-3 crew links -----------------------------------------------------------
do $do$ begin
  if to_regprocedure('public._work_token_live__pre0042(uuid)') is null then
    raise notice '0042: _work_token_live wrapper skipped (no body on this database)'; return;
  end if;
  execute $w$
create or replace function public._work_token_live(p_token uuid)
returns public.work_tokens language plpgsql volatile security definer set search_path = '' as $f$
-- audit-run2-0042: the event is on a shelf, or the staff member with this number was deactivated
declare w public.work_tokens;
begin
  w := public._work_token_live__pre0042(p_token);              -- invalid / revoked / expired / aged, as before
  if public._a42_quote_shelved(w.quote_id) then
    raise exception 'link expired' using errcode = '42501';
  end if;
  if exists (select 1 from public.crew_members c where c.org_id = w.org_id
                and public.helm_norm_phone(c.phone) = public.helm_norm_phone(w.phone))
     and not exists (select 1 from public.crew_members c where c.org_id = w.org_id and coalesce(c.active, true)
                       and public.helm_norm_phone(c.phone) = public.helm_norm_phone(w.phone)) then
    raise exception 'link revoked' using errcode = '42501';
  end if;
  return w;
end $f$;
$w$;
  revoke all on function public._work_token_live(uuid) from public, anon, authenticated;
  grant execute on function public._work_token_live(uuid) to service_role;
end $do$;

create or replace function public._a42_revoke_links_for_phone(p_org uuid, p_phone text, p_reason text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n int := 0;
begin
  if p_org is null or nullif(public.helm_norm_phone(p_phone), '') is null then return 0; end if;
  update public.work_tokens w set revoked_at = now()
   where w.org_id = p_org and w.revoked_at is null
     and public.helm_norm_phone(w.phone) = public.helm_norm_phone(p_phone);
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'work_links.revoked',
              'work_tokens', null, p_org, jsonb_build_object('count', n, 'reason', p_reason));
  end if;
  return n;
end $$;

create or replace function public._a42_tg_crew_revoke_links()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (coalesce(old.active, true) and not coalesce(new.active, true))
     or public.helm_norm_phone(new.phone) is distinct from public.helm_norm_phone(old.phone) then
    -- only when no other ACTIVE staff row in the studio still has the old number
    if not exists (select 1 from public.crew_members c where c.org_id = old.org_id and c.id <> old.id
                      and coalesce(c.active, true)
                      and public.helm_norm_phone(c.phone) = public.helm_norm_phone(old.phone)) then
      perform public._a42_revoke_links_for_phone(old.org_id, old.phone,
        case when coalesce(new.active, true) then 'phone_changed' else 'deactivated' end);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists zz_a42_crew_revoke_links on public.crew_members;
create trigger zz_a42_crew_revoke_links after update of active, phone on public.crew_members
  for each row execute function public._a42_tg_crew_revoke_links();

create or replace function public.admin_revoke_work_links(p_crew_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); c public.crew_members; n int;
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into c from public.crew_members x where x.id = p_crew_id and x.org_id = v_org;
  if c.id is null then raise exception 'no such staff member' using errcode = '42501'; end if;
  n := public._a42_revoke_links_for_phone(v_org, c.phone, 'admin');
  return jsonb_build_object('revoked', n);
end $$;

create or replace function public.task_proof_upload_ok(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- audit-run2-0042: + the 0039 link age and the shelf gate for the grant's crew link
  select public.task_proof_upload_ok__pre0042(p_name)
     and exists (select 1 from public.task_evidence_grants g
                  where g.path = p_name and g.used_at is null and g.expires_at > now()
                    and not public.link_age_expired(public.work_link_age_until(g.work_token))
                    and not public._a42_quote_shelved(g.quote_id));
$$;

do $$ declare f text; begin
  foreach f in array array['_a42_revoke_links_for_phone(uuid, text, text)', '_a42_tg_crew_revoke_links()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
  revoke all on function public.admin_revoke_work_links(uuid) from public, anon;
  grant execute on function public.admin_revoke_work_links(uuid) to authenticated, service_role;
end $$;

-- ---- 5) RC-1 C-11: dev echo is fail-closed ----------------------------------------
create or replace function public._a42_tg_cfg_no_dev_echo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.key = 'channels' and jsonb_typeof(new.value) = 'object'
     and coalesce(new.value ->> 'otp_dev_echo', '') = 'true'
     and not (tg_op = 'UPDATE' and coalesce(old.value ->> 'otp_dev_echo', '') = 'true')
     and not public._a42_dev_echo_allowed() then
    raise exception 'Showing OTP codes on screen (otp_dev_echo) is switched off on this server.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists a42_cfg_no_dev_echo on public.app_config;
create trigger a42_cfg_no_dev_echo before insert or update on public.app_config
  for each row execute function public._a42_tg_cfg_no_dev_echo();

-- ---- 6) RC-2 / RC-8: notification detail + row studio -------------------------------
create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- audit-run2-0042: bearer links / tokens never leave in the bell
declare v jsonb;
begin
  v := public.bell_feed__pre0042(p_limit);
  if jsonb_typeof(v -> 'items') = 'array' then
    v := v || jsonb_build_object('items', coalesce((
      select jsonb_agg(case when jsonb_typeof(e.i) = 'object' and e.i ? 'detail'
                            then e.i || jsonb_build_object('detail', public._a42_redact_detail(e.i -> 'detail'))
                            else e.i end order by e.ord)
        from jsonb_array_elements(v -> 'items') with ordinality e(i, ord)), '[]'::jsonb));
  end if;
  return v;
end $$;

create or replace function public._a42_tg_notify_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  new.detail := public._a42_redact_detail(new.detail);
  if new.quote_id is not null then
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    if v_org is not null then new.org_id := v_org; end if;
  end if;
  return new;
end $$;
drop trigger if exists za_a42_notify_row on public.notifications;
create trigger za_a42_notify_row before insert or update on public.notifications
  for each row execute function public._a42_tg_notify_row();

create or replace function public._a42_tg_org_from_quote_force()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if new.quote_id is not null then
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    if v_org is not null then new.org_id := v_org; end if;
  end if;
  return new;
end $$;
drop trigger if exists za_a42_otp_org on public.quote_otps;
create trigger za_a42_otp_org before insert on public.quote_otps
  for each row execute function public._a42_tg_org_from_quote_force();

create or replace function public._a42_tg_audit_org()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if new.action like 'hq.%' then
    new.org_id := null;                                   -- platform-operator views belong to no studio
  elsif new.quote_id is not null then
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    if v_org is not null then new.org_id := v_org; end if;
  end if;
  return new;
end $$;
drop trigger if exists zz_a42_audit_org on public.audit_log;
create trigger zz_a42_audit_org before insert on public.audit_log
  for each row execute function public._a42_tg_audit_org();

-- tg_audit: org from the row itself (keeps its OID — every audit trigger uses it).
-- Replaced only when this database's body is the known canonical one.
do $do$ declare v_src text; begin
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.tg_audit()'::regprocedure;
  if position('audit-run2-0042' in v_src) > 0
     or (position('insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed)' in v_src) > 0
         and position('key not in (''updated_at'',''confirmed_at'')' in v_src) > 0) then
    execute $fn$
create or replace function public.tg_audit()
returns trigger language plpgsql security definer set search_path = 'public' as $body$
-- audit-run2-0042: the audit row carries the changed row's studio (C-09)
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_id text;
  v_quote uuid;
  v_changed jsonb;
  v_org uuid;
  o jsonb; n jsonb;
begin
  if v_actor is not null then select email into v_email from auth.users where id = v_actor; end if;
  if tg_op = 'DELETE' then n := to_jsonb(OLD); else n := to_jsonb(NEW); end if;
  if tg_op = 'UPDATE' then o := to_jsonb(OLD); end if;

  v_id := coalesce(n->>'id', n->>'quote_id');
  if tg_table_name = 'quotes' then v_quote := (n->>'id')::uuid;
  elsif n ? 'quote_id' then v_quote := nullif(n->>'quote_id','')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(o->key, n->key))
      into v_changed
      from jsonb_object_keys(n) as key
      where (o->key) is distinct from (n->key)
        and key not in ('updated_at','confirmed_at');
    if v_changed is null then return null; end if;
  else
    v_changed := n;
  end if;

  if tg_table_name = 'organizations' and coalesce(n->>'id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'id')::uuid;
  elsif coalesce(n->>'org_id','') ~ '^[0-9a-fA-F-]{36}$' then
    v_org := (n->>'org_id')::uuid;
  end if;
  if v_org is null and v_quote is not null then
    select q.org_id into v_org from public.quotes q where q.id = v_quote;
  end if;
  v_org := coalesce(v_org, public.current_org_id());

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_actor, v_email, lower(tg_op), tg_table_name, v_id, v_quote, v_changed, v_org);
  return null;
end $body$
$fn$;
  else
    raise notice '0042: tg_audit on this database is not the canonical body — left unchanged (review RC-8 by hand)';
  end if;
end $do$;

-- ---- 7) RC-5 refund freeze ------------------------------------------------------------
create or replace function public._a42_tg_refund_freeze()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'DELETE' then
      if old.status in ('approved', 'processed') then
        raise exception 'An approved or processed refund can''t be deleted — reject it or add a correcting entry.'
          using errcode = '42501';
      end if;
      return old;
    end if;
    if old.status in ('approved', 'processed')
       and (new.amount, new.kind, new.quote_id, new.org_id, new.created_by)
           is distinct from (old.amount, old.kind, old.quote_id, old.org_id, old.created_by) then
      raise exception 'An approved refund can''t be changed — reject it or add a correcting entry.' using errcode = '42501';
    end if;
    if old.status = 'processed' and new.status is distinct from 'processed' then
      raise exception 'A processed refund is final.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ac_a42_refund_freeze on public.event_refunds;
create trigger ac_a42_refund_freeze before update or delete on public.event_refunds
  for each row execute function public._a42_tg_refund_freeze();

-- ---- 8) RC-7 identity binding -----------------------------------------------------------
create or replace function public._mp_sync_staff(p_user uuid, p_admin jsonb)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042 (C-08): a mobile number the member typed is not proof that an existing,
-- unlinked staff row is theirs. Self-service links such a row only when its e-mail is the
-- member's confirmed sign-in e-mail; otherwise a staff-edit user links it from User control.
declare v_org uuid; v_phone text; v_email text; v_row_email text; v_found boolean;
begin
  if auth.uid() is not null and auth.uid() = p_user and not public.has_area('staff', 'edit') then
    select p.org_id into v_org from public.profiles p where p.id = p_user;
    select m.phone into v_phone from public.member_profiles m where m.user_id = p_user;
    if v_org is not null and v_phone is not null
       and not exists (select 1 from public.crew_members c where c.profile_id = p_user and c.org_id = v_org) then
      select true, lower(btrim(coalesce(c.email, ''))) into v_found, v_row_email from public.crew_members c
       where c.org_id = v_org and c.profile_id is null
         and public.helm_norm_phone(c.phone) = public.helm_norm_phone(v_phone)
       order by c.active desc, c.created_at, c.id limit 1;
      if coalesce(v_found, false) then
        select lower(u.email) into v_email from auth.users u where u.id = p_user and u.email_confirmed_at is not null;
        if v_email is null or v_row_email is distinct from v_email then
          return null;                                          -- staff link pending (an admin links it)
        end if;
      end if;
    end if;
  end if;
  return public._mp_sync_staff__pre0042(p_user, p_admin);
end $$;

create or replace function public._a42_tg_profile_no_operator_org()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  if new.org_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.org_id is not distinct from old.org_id then return new; end if;
  select lower(u.email) into v_email from auth.users u where u.id = new.id;
  if public._a42_is_operator_email(coalesce(v_email, new.email)) then
    raise exception 'A Helm platform operator account can''t be a member of a studio.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists a42_profile_no_operator_org on public.profiles;
create trigger a42_profile_no_operator_org before insert or update of org_id on public.profiles
  for each row execute function public._a42_tg_profile_no_operator_org();

create or replace function public.accept_invitation(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042 (C-10): confirmed e-mail, compared with auth.users (not a token claim); no operators
declare v_uid uuid := auth.uid(); v_email text; v_conf timestamptz; v_inv text; v_status text;
begin
  if v_uid is not null then
    select lower(u.email), u.email_confirmed_at into v_email, v_conf from auth.users u where u.id = v_uid;
    if v_conf is null then
      raise exception 'Confirm your e-mail address first, then open the invitation again.' using errcode = '42501';
    end if;
    if public._a42_is_operator_email(v_email) then
      raise exception 'A Helm platform operator account can''t join a studio.' using errcode = '42501';
    end if;
    select lower(i.email), i.status into v_inv, v_status from public.invitations i where i.token = p_token;
    if v_status = 'pending' and v_inv is distinct from v_email then
      raise exception 'this invitation was issued to a different email address' using errcode = '42501';
    end if;
  end if;
  return public.accept_invitation__pre0042(p_token);
end $$;

create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042 wrapper; the auth-hardening-0028 body (password rule, bcrypt 12, no
-- cross-tenant oracle) runs unchanged as admin_create_user__pre0042
begin
  if public.current_org_id() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._a42_is_operator_email(p_email) then
    raise exception 'could not create this user — send them an invitation instead' using errcode = '22023';
  end if;
  return public.admin_create_user__pre0042(p_email, p_password, p_role);
end $$;

create or replace function public._admin_create_user_core(p_email text, p_password text, p_role text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
begin
  if public._a42_is_operator_email(p_email) then
    raise exception 'could not create this user — send them an invitation instead' using errcode = '22023';
  end if;
  return public._admin_create_user_core__pre0042(p_email, p_password, p_role);
end $$;

create or replace function public.create_invitation(p_email text, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042: no operator e-mails (NV-09); a re-invite at another role changes the
-- pending invitation's role and gives it a NEW token (f3a) — an update, nothing removed
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  if public._a42_is_operator_email(p_email) then
    raise exception 'this e-mail address can''t be invited' using errcode = '22023';
  end if;
  if public.is_admin() and v_org is not null and public._valid_role(p_role) then
    select i.id into v_id from public.invitations i
     where i.org_id = v_org and lower(i.email) = lower(btrim(coalesce(p_email, '')))
       and i.status = 'pending' and i.expires_at > now()
     order by i.created_at desc limit 1;
    if v_id is not null then
      update public.invitations i
         set role = p_role, token = encode(extensions.gen_random_bytes(24), 'hex')
       where i.id = v_id and i.role is distinct from p_role;
    end if;
  end if;
  return public.create_invitation__pre0042(p_email, p_role);
end $$;

create or replace function public.create_studio(p_name text, p_email text default null,
                                                p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- audit-run2-0042 (NV-08): a NEW studio never inherits the template studio's channel
-- switches (live SMS / payments / OTP echo) — it starts with every channel off
declare v_had uuid; v_org uuid;
begin
  select p.org_id into v_had from public.profiles p where p.id = auth.uid();
  v_org := public.create_studio__pre0042(p_name, p_email, p_currency, p_timezone);
  if v_had is null and v_org is not null then
    update public.app_config c set value = '{}'::jsonb where c.org_id = v_org and c.key = 'channels' and c.value <> '{}'::jsonb;
  end if;
  return v_org;
end $$;

-- invitation rows (with their tokens): only people who can manage users
drop policy if exists "a42 inv read needs users edit" on public.invitations;
create policy "a42 inv read needs users edit" on public.invitations as restrictive for select to authenticated
  using (public.has_area('users', 'edit'));

-- ---- 9) RC-4 quotes table: stricter delete / insert -----------------------------------
drop policy if exists "a42 quotes delete from shelf" on public.quotes;
create policy "a42 quotes delete from shelf" on public.quotes as restrictive for delete to authenticated
  using (public.can_delete() and deleted_at is not null);
drop policy if exists "a42 quotes insert can_create" on public.quotes;
create policy "a42 quotes insert can_create" on public.quotes as restrictive for insert to authenticated
  with check (public.can_create());

-- ---- 10) RC-9 org binding + EXECUTE revokes ---------------------------------------------
create or replace function public.event_site_live_until(p_site_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  -- audit-run2-0042: another studio's unpublished site gives no answer. Visitors and the
  -- public-site checks (auth.uid() null) and published sites keep the original answer.
  select case when auth.uid() is null or s.org_id = public.current_org_id() or s.status = 'published'
              then public.event_site_live_until__pre0042(s.id) end
    from public.event_sites s where s.id = p_site_id;
$$;

revoke execute on function public.work_token_expiry_for(uuid) from public, anon, authenticated;
revoke execute on function public.client_link_deadline(date, uuid, integer) from public, anon, authenticated;
grant execute on function public.work_token_expiry_for(uuid) to service_role;
grant execute on function public.client_link_deadline(date, uuid, integer) to service_role;

-- trigger functions: never called directly (a trigger fires without EXECUTE)
do $$ declare r record; begin
  for r in select p.oid::regprocedure as f from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype loop
    execute 'revoke execute on function ' || r.f::text || ' from public, anon, authenticated';
  end loop;
end $$;

-- ---- 12) NV-10: platform operators bound to their account id, not only an e-mail ------
alter table public.platform_admins add column if not exists user_id uuid;
update public.platform_admins pa set user_id = u.id
  from auth.users u
 where pa.user_id is null and lower(u.email) = pa.email and u.email_confirmed_at is not null;

do $$ declare f text; d text; begin
  foreach f in array array['is_platform_admin', 'is_platform_operator'] loop
    if to_regprocedure('public.' || f || '__pre0042()') is null then
      d := pg_get_functiondef(('public.' || f || '()')::regprocedure);
      d := replace(d, 'FUNCTION public.' || f || '(', 'FUNCTION public.' || f || '__pre0042(');
      execute d;
    end if;
    execute 'revoke all on function public.' || f || '__pre0042() from public, anon, authenticated';
    execute 'grant execute on function public.' || f || '__pre0042() to service_role';
  end loop;
end $$;

-- a row bound to an account id only answers for THAT account (an e-mail change on another
-- account can't inherit operator rights); unbound rows keep the e-mail rule
create or replace function public._a42_operator_binding_ok()
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.platform_admins pa join auth.users u on u.id = auth.uid()
                      where pa.email = lower(u.email) and pa.user_id is not null and pa.user_id <> auth.uid());
$$;
revoke all on function public._a42_operator_binding_ok() from public, anon, authenticated;
grant execute on function public._a42_operator_binding_ok() to service_role;

create or replace function public.is_platform_admin()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return public.is_platform_admin__pre0042() and public._a42_operator_binding_ok();
end $$;
create or replace function public.is_platform_operator()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  return public.is_platform_operator__pre0042() and public._a42_operator_binding_ok();
end $$;

-- ---- 13) owner decision D1: no OTP dev echo outside an allowed environment -------------
-- switch the flag off where it is on and not allowed, and expire any open code that may
-- have been shown on screen (update-only)
do $$ begin
  if not public._a42_dev_echo_allowed() then
    update public.quote_otps o set expires_at = now()
     where o.verified_at is null and o.expires_at > now()
       and o.org_id in (select c.org_id from public.app_config c
                         where c.key = 'channels' and coalesce(c.value ->> 'otp_dev_echo', '') = 'true');
    update public.app_config c set value = c.value || '{"otp_dev_echo":false}'::jsonb
     where c.key = 'channels' and jsonb_typeof(c.value) = 'object' and coalesce(c.value ->> 'otp_dev_echo', '') = 'true';
  end if;
end $$;

-- ---- 14) owner decision D4: backfills (UPDATE only, re-runnable, nothing deleted) ------
-- a) bearer links / tokens out of stored notification details (RC-2)
update public.notifications n set detail = public._a42_redact_detail(n.detail)
 where jsonb_typeof(n.detail) = 'object'
   and n.detail ?| array['token', 'url', 'link', 'approval_url', 'work_url', 'work_link',
                         'portal_url', 'payment_url', 'link_url', 'approval_token', 'work_token'];
-- b) audit rows filed under the caller's studio instead of the event's (RC-8 / NV-02)
update public.audit_log a set org_id = q.org_id
  from public.quotes q
 where a.quote_id = q.id and a.action not like 'hq.%' and a.org_id is distinct from q.org_id;
update public.audit_log a set org_id = null where a.action like 'hq.%' and a.org_id is not null;
-- c) NV-05: approval links that never had an expiry get one (30 days from issue, or the
--    event window, whichever is later). Row by row so one odd legacy row can't stop the rest.
do $$ declare r record; n int := 0; begin
  for r in select q.id from public.quotes q
            where q.approval_token is not null and q.approval_token_expires_at is null loop
    begin
      update public.quotes q
         set approval_token_expires_at = greatest(q.created_at + interval '30 days',
                                                  public.client_link_deadline(q.event_date, q.org_id, 30))
       where q.id = r.id and q.approval_token_expires_at is null;
      n := n + 1;
    exception when others then
      raise notice '0042 NV-05: quote % left unchanged (%)', r.id, sqlerrm;
    end;
  end loop;
  if n > 0 then raise notice '0042 NV-05: % approval link(s) given an expiry', n; end if;
end $$;
-- d) NV-06: invitation slugs with only 24 random bits (…-<6 hex>) get 64 bits (…-<16 hex>).
--    Event sites have no slug-history mechanism (org_slug_history is for studio links),
--    and keeping the guessable slug alive would defeat the fix: studios re-share the link.
do $$ declare r record; v_new text; n int := 0; begin
  alter table public.event_sites disable trigger event_sites_guard_biu;     -- it re-derives org from the session
  for r in select s.id, s.slug from public.event_sites s where s.slug ~ '-[0-9a-f]{6}$' loop
    loop
      v_new := regexp_replace(r.slug, '-[0-9a-f]{6}$', '') || '-' || encode(extensions.gen_random_bytes(8), 'hex');
      exit when not exists (select 1 from public.event_sites x where x.slug = v_new);
    end loop;
    update public.event_sites s set slug = v_new, updated_at = now() where s.id = r.id and s.slug = r.slug;
    insert into public.audit_log(action, entity, entity_id, quote_id, org_id, changed)
      select 'event_site.reslugged', 'event_sites', s.id::text, s.quote_id, s.org_id,
             jsonb_build_object('reason', 'legacy 24-bit slug')
        from public.event_sites s where s.id = r.id;
    n := n + 1;
  end loop;
  alter table public.event_sites enable trigger event_sites_guard_biu;
  if n > 0 then raise notice '0042 NV-06: % invitation slug(s) re-generated — studios must re-share them', n; end if;
end $$;

-- ---- 11) grants: exactly what each entry point had before -----------------------------
do $$ declare f text; begin
  foreach f in array array['public_get_quote(uuid)', 'public_get_portal(uuid)', 'create_payment(uuid)',
      'request_otp(uuid, text)', 'verify_and_consent(uuid, text, text, boolean, text, text, text, text)',
      'public_get_proposal(uuid)', 'task_proof_upload_ok(text)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    execute 'grant execute on function public.' || f || ' to anon, authenticated, service_role';
  end loop;
  foreach f in array array['revoke_approval_token(uuid)', 'generate_approval_token(uuid)', 'move_quote_to_shelf(uuid, text)',
      'bell_feed(integer)', 'record_settlement_payment(uuid, numeric, text, text, uuid, text, text)',
      'record_payment(uuid, numeric, text, text, uuid, text, text)', 'close_event(uuid, boolean)',
      'set_closure(uuid, integer, text, text, boolean, text)', 'set_lifecycle_stage(uuid, text)', 'mark_paid(uuid, text)',
      'accept_invitation(text)', 'admin_create_user(text, text, text)', 'create_invitation(text, text)',
      'create_studio(text, text, text, text)', 'event_site_live_until(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated, service_role';
  end loop;
  foreach f in array array['otp_send_authorize(uuid, text)', 'payment_link_begin(uuid, integer)',
      '_mp_sync_staff(uuid, jsonb)', '_admin_create_user_core(text, text, text)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------------
-- select proname from pg_proc where proname like '%\_\_pre0042' order by 1;
-- select key, value from public.helm_env_settings;   -- staging only: allow_otp_dev_echo = true

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY — every row must say ok = true
-- ════════════════════════════════════════════════════════════════════════════
select item, ok from (values
  ('every wrapped body kept once as a private __pre0042',
     (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0042') >= 28
     and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0042'
                       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))),
  ('OTP: a NULL / malformed code is a wrong code',
     pg_get_functiondef('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure) like '%p_code is null or p_code !~%'),
  ('OTP: no on-screen codes unless this environment allows it (production: expect false)',
     to_regprocedure('public._a42_dev_echo_allowed()') is not null and not has_table_privilege('authenticated', 'public.helm_env_settings', 'select')),
  ('OTP: dev echo off in every studio here (unless allowed)',
     public._a42_dev_echo_allowed() or not exists (select 1 from public.app_config where key = 'channels' and value ->> 'otp_dev_echo' = 'true')),
  ('client entry points still open to visitors, studio actions signed-in only',
     has_function_privilege('anon', 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute')
     and has_function_privilege('anon', 'public.request_otp(uuid,text)', 'execute')
     and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')
     and has_function_privilege('anon', 'public.public_get_portal(uuid)', 'execute')
     and has_function_privilege('anon', 'public.public_get_proposal(uuid)', 'execute')
     and has_function_privilege('anon', 'public.task_proof_upload_ok(text)', 'execute')
     and not has_function_privilege('anon', 'public.bell_feed(integer)', 'execute')
     and has_function_privilege('authenticated', 'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.admin_revoke_work_links(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.otp_send_authorize(uuid,text)', 'execute')
     and (to_regprocedure('public._work_token_live(uuid)') is null
          or not has_function_privilege('authenticated', 'public._work_token_live(uuid)', 'execute'))),
  ('internal link helpers + trigger functions not callable by visitors / signed-in users',
     not has_function_privilege('authenticated', 'public.work_token_expiry_for(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.client_link_deadline(date,uuid,integer)', 'execute')
     and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
                       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))),
  ('new triggers in place',
     (select count(*) from pg_trigger where not tgisinternal and tgname in ('zz_a42_crew_revoke_links', 'a42_cfg_no_dev_echo',
        'za_a42_notify_row', 'za_a42_otp_org', 'zz_a42_audit_org', 'ac_a42_refund_freeze', 'a42_profile_no_operator_org')) = 7),
  ('restrictive policies in place (quotes delete / insert, invitation rows)',
     (select count(*) from pg_policies where policyname in ('a42 quotes delete from shelf', 'a42 quotes insert can_create',
        'a42 inv read needs users edit') and permissive = 'RESTRICTIVE') = 3),
  ('D2: money / closure / lifecycle bodies follow the matrix',
     pg_get_functiondef('public.close_event(uuid,boolean)'::regprocedure) like '%has_area(''closure'', ''edit'')%'
     and pg_get_functiondef('public.record_settlement_payment(uuid,numeric,text,text,uuid,text,text)'::regprocedure) like '%has_area(''settlement'', ''edit'')%'),
  ('tg_audit carries the row''s studio (NOTICE above if this database''s body was not canonical)',
     position('audit-run2-0042' in (select prosrc from pg_proc where oid = 'public.tg_audit()'::regprocedure)) > 0),
  ('D4 backfills done: no token / url in stored notifications',
     not exists (select 1 from public.notifications where jsonb_typeof(detail) = 'object' and detail ?| array['token', 'url'])),
  ('D4 backfills done: no hq.* audit row inside a studio',
     not exists (select 1 from public.audit_log where action like 'hq.%' and org_id is not null)),
  ('D4 backfills done: no 6-hex invitation slug left',
     not exists (select 1 from public.event_sites where slug ~ '-[0-9a-f]{6}$')),
  ('NV-10: platform_admins.user_id present',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'platform_admins' and column_name = 'user_id'))
) v(item, ok);
-- informational (read-only): approval links still without an expiry (should be 0)
select count(*) as approval_links_without_expiry from public.quotes where approval_token is not null and approval_token_expires_at is null;

-- ═══════════════════════════════ PART 0043 ═══════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0043 two-step sign-in enforced by the database (one paste)          (2026-10-07)
--   Members who have turned on two-step sign-in (a VERIFIED authenticator factor) must
--   finish the code step before the database shows them any studio data — a password-only
--   (aal1) session gets nothing, even if the browser check is bypassed. Members without
--   two-step sign-in, client links (approve / portal / work pages) and HQ are unaffected.
-- REQUIRES 0042 on this database — the preflight stops if not. STAGING first, then PROD.
--   After pasting: sign in as a member WITH two-step sign-in and confirm the app asks for
--   the code and then loads normally.
-- WHAT IT TOUCHES: current_org_id() (same OID, so every policy keeps using it) now wraps
--   this database's own body, kept once as current_org_id__pre0043(). No data changes.
-- SAFE TO RE-RUN. If anything fails, the whole paste rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regprocedure('public._a42_quote_shelved(uuid)') is null then
    raise exception 'STOP: 0042 not installed — paste APPLY-0042.sql first'; end if;
  if to_regprocedure('public.mfa_ok()') is null then raise exception 'STOP: public.mfa_ok() (0028) is missing'; end if;
  if to_regclass('auth.mfa_factors') is null then raise exception 'STOP: auth.mfa_factors is missing'; end if;
  raise notice 'Preflight OK — applying 0043…';
end $$;

-- ============================================================================
-- 0043_mfa_enforce.sql — CANONICAL forward-only. REQUIRES 0042.
-- Owner decision D3 (audit run 2, RC-6 / C-05): the second factor is enforced by the
-- DATABASE for every member who has enrolled one. A signed-in user with a VERIFIED
-- factor whose session is still aal1 (password only) gets NO studio: current_org_id()
-- returns NULL, so every RLS policy and every definer RPC that checks the studio fails
-- closed, exactly like a user without a studio. At aal2 nothing changes. Users without a
-- verified factor are unaffected (mfa_ok() is true for them). Visitors / service role
-- (auth.uid() null) are unaffected. HQ operators have no studio and use
-- is_platform_admin(), which already requires aal2 when a factor exists.
--
-- DRIFT-SAFE: current_org_id() is used by policies BY OID, so it is not renamed: this
-- database's own body is CLONED once to current_org_id__pre0043() and current_org_id()
-- becomes `mfa_ok() ? current_org_id__pre0043() : NULL`. Re-running is a no-op.
-- ============================================================================
do $$ declare d text; begin
  if to_regprocedure('public.mfa_ok()') is null then
    raise exception '0043: public.mfa_ok() (0028) is missing on this database';
  end if;
  if to_regprocedure('public.current_org_id__pre0043()') is null then
    d := pg_get_functiondef('public.current_org_id()'::regprocedure);
    d := replace(d, 'FUNCTION public.current_org_id(', 'FUNCTION public.current_org_id__pre0043(');
    execute d;
  end if;
  revoke all on function public.current_org_id__pre0043() from public, anon, authenticated;
  grant execute on function public.current_org_id__pre0043() to service_role;
end $$;

create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = '' as $$
  -- mfa-enforce-0043: an enrolled member at aal1 has no studio until they pass 2FA
  select case when public.mfa_ok() then public.current_org_id__pre0043() end;
$$;

-- ---- VERIFY (read-only) ----------------------------------------------------------
-- select pg_get_functiondef('public.current_org_id()'::regprocedure);

-- VERIFY — every row must say ok = true
select item, ok from (values
  ('current_org_id() wraps this database''s own body (kept once, private)',
     to_regprocedure('public.current_org_id__pre0043()') is not null
     and pg_get_functiondef('public.current_org_id()'::regprocedure) like '%mfa-enforce-0043%'
     and not has_function_privilege('authenticated', 'public.current_org_id__pre0043()', 'execute')
     and has_function_privilege('authenticated', 'public.current_org_id()', 'execute')),
  ('mfa_ok() lets members without a verified factor through',
     position('verified' in (select prosrc from pg_proc where oid = 'public.mfa_ok()'::regprocedure)) > 0)
) v(item, ok);
-- informational: how many members will be asked for their code at the database
select count(distinct f.user_id) as members_with_two_step from auth.mfa_factors f where f.status::text = 'verified';
