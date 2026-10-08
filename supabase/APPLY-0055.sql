-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0055 phone verification + international mobiles (one paste) (2026-10-08)
--   * Members can verify their mobile with a 6-digit WhatsApp code (sent by the
--     send-phone-code edge function — DORMANT until WhatsApp is live). Only a bcrypt
--     hash of each code is stored; 10-minute expiry, 5 wrong tries, 60 s resend wait,
--     5 codes per user per hour, 10 per number per day.
--   * member_profiles.phone_verified_at — cleared automatically when the mobile changes.
--   * Member mobile / WhatsApp numbers may now be international (E.164); Indian numbers
--     keep the +91 6–9 rule. The phone CHECK constraints are only WIDENED.
-- REQUIRES 0041 — the preflight stops if not. STAGING first, then PROD.
-- WHAT IT TOUCHES: 1 new table (RLS on, no client access), 1 new column, 3 widened
--   CHECK constraints, _mp_mobile replaced by a superset, 1 BEFORE trigger on
--   member_profiles, 3 new RPCs (request = service role only).
--   NO row is deleted or changed by running this.
-- SAFE TO RE-RUN. If anything fails, it rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regclass('public.member_profiles') is null then raise exception 'STOP: 0041 not installed'; end if;
  if to_regprocedure('public._mp_mobile(text,text)') is null then raise exception 'STOP: 0041 helpers missing'; end if;
  if to_regprocedure('extensions.crypt(text,text)') is null then raise exception 'STOP: pgcrypto (extensions schema) missing'; end if;
  raise notice 'Preflight OK — applying 0055…';
end $$;

-- ---- 1) verified-at column -------------------------------------------------------------
alter table public.member_profiles add column if not exists phone_verified_at timestamptz;

-- ---- 2) widen the phone checks (only when still the 0041 Indian-only form) -------------
do $$
declare d text;
begin
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conrelid = 'public.member_profiles'::regclass and conname = 'member_profiles_phone_chk';
  if d is null or position('{6,14}' in d) = 0 then
    alter table public.member_profiles drop constraint if exists member_profiles_phone_chk;
    alter table public.member_profiles add constraint member_profiles_phone_chk check (phone is null
      or (phone ~ '^\+[1-9][0-9]{6,14}$' and (phone !~ '^\+91' or phone ~ '^\+91[6-9][0-9]{9}$')));
  end if;
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conrelid = 'public.member_profiles'::regclass and conname = 'member_profiles_whatsapp_chk';
  if d is null or position('{6,14}' in d) = 0 then
    alter table public.member_profiles drop constraint if exists member_profiles_whatsapp_chk;
    alter table public.member_profiles add constraint member_profiles_whatsapp_chk check (whatsapp is null
      or (whatsapp ~ '^\+[1-9][0-9]{6,14}$' and (whatsapp !~ '^\+91' or whatsapp ~ '^\+91[6-9][0-9]{9}$')));
  end if;
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conrelid = 'public.member_profiles'::regclass and conname = 'member_profiles_emerg_ph_chk';
  if d is null or position('{6,14}' in d) = 0 then
    alter table public.member_profiles drop constraint if exists member_profiles_emerg_ph_chk;
    alter table public.member_profiles add constraint member_profiles_emerg_ph_chk check (emergency_contact_phone is null
      or emergency_contact_phone ~ '^\+[0-9]{7,15}$');
  end if;
end $$;

-- ---- 3) mobile rule: Indian as before, or international with a leading + ---------------
create or replace function public._mp_mobile(p_val text, p_label text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_val, '')); d text;
begin
  if v = '' then return null; end if;
  if v !~ '^\+?[0-9 ().-]{6,24}$' then
    raise exception '% must be a valid mobile number.', p_label using errcode = '22023'; end if;
  d := regexp_replace(v, '[^0-9]', '', 'g');
  if left(v, 1) = '+' and left(d, 2) <> '91' then
    if d !~ '^[1-9][0-9]{6,14}$' then
      raise exception '% must be 7–15 digits including the country code.', p_label using errcode = '22023'; end if;
    return '+' || d;
  end if;
  if char_length(d) = 12 and left(d, 2) = '91' then d := substr(d, 3);
  elsif char_length(d) = 11 and left(d, 1) = '0' then d := substr(d, 2);
  end if;
  if d !~ '^[6-9][0-9]{9}$' then
    raise exception '% must be a 10-digit Indian mobile number starting with 6, 7, 8 or 9.', p_label using errcode = '22023'; end if;
  return '+91' || d;
end $$;

-- ---- 4) the codes ------------------------------------------------------------------------
create table if not exists public.phone_verifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  phone       text not null,
  code_hash   text not null,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  verified_at timestamptz,
  constraint phone_verifications_phone_chk    check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint phone_verifications_attempts_chk check (attempts between 0 and 5)
);
create index if not exists phone_verifications_user_idx  on public.phone_verifications (user_id, created_at desc);
create index if not exists phone_verifications_phone_idx on public.phone_verifications (phone, created_at desc);
alter table public.phone_verifications enable row level security;
revoke all on public.phone_verifications from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.phone_verifications from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.phone_verifications from authenticated'; end if;
end $$;

-- ---- 5) a mobile change clears (or, if just verified, sets) phone_verified_at -----------
create or replace function public._mp_phone_verified_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.phone is distinct from old.phone then
    new.phone_verified_at := case when new.phone is not null and exists (
        select 1 from public.phone_verifications v
         where v.user_id = new.user_id and v.phone = new.phone
           and v.verified_at is not null and v.verified_at > now() - interval '30 minutes')
      then now() else null end;
  end if;
  return new;
end $$;
revoke all on function public._mp_phone_verified_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._mp_phone_verified_guard() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._mp_phone_verified_guard() from authenticated'; end if;
end $$;
drop trigger if exists mp_phone_verified_guard on public.member_profiles;
create trigger mp_phone_verified_guard before insert or update on public.member_profiles
  for each row execute function public._mp_phone_verified_guard();

-- ---- 6) issue a code (service role only) -------------------------------------------------
create or replace function public.phone_verify_request(p_user uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_phone text; v_code text; v_last timestamptz; v_n int; r bigint;
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'unknown user' using errcode = 'HL404'; end if;
  v_phone := public._mp_mobile(p_phone, 'Mobile number');
  if v_phone is null then raise exception 'Mobile number is required.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('phone_verify:' || p_user::text));
  select max(created_at) into v_last from public.phone_verifications where user_id = p_user;
  if v_last is not null and v_last > now() - interval '60 seconds' then
    raise exception 'wait % seconds', ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::int
      using errcode = 'HL429'; end if;
  select count(*) into v_n from public.phone_verifications where user_id = p_user and created_at > now() - interval '1 hour';
  if v_n >= 5 then raise exception 'too many codes this hour' using errcode = 'HL429'; end if;
  select count(*) into v_n from public.phone_verifications where phone = v_phone and created_at > now() - interval '1 day';
  if v_n >= 10 then raise exception 'too many codes for this number today' using errcode = 'HL429'; end if;
  -- older open codes for this user stop working
  update public.phone_verifications set expires_at = least(expires_at, now())
   where user_id = p_user and verified_at is null and expires_at > now();
  loop
    r := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    exit when r < 4294000000;   -- rejection sampling: no modulo bias
  end loop;
  v_code := lpad((r % 1000000)::text, 6, '0');
  insert into public.phone_verifications (user_id, phone, code_hash, expires_at)
    values (p_user, v_phone, extensions.crypt(v_code, extensions.gen_salt('bf', 8)), now() + interval '10 minutes');
  return jsonb_build_object('code', v_code, 'phone', v_phone, 'expires_in', 600, 'resend_after', 60);
end $$;
revoke all on function public.phone_verify_request(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.phone_verify_request(uuid, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.phone_verify_request(uuid, text) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.phone_verify_request(uuid, text) to service_role'; end if;
end $$;

-- ---- 7) check a code (signed-in member) --------------------------------------------------
create or replace function public.phone_verify_check(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v public.phone_verifications%rowtype; v_applied boolean := false;
begin
  if v_uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into v from public.phone_verifications where user_id = v_uid and verified_at is null
   order by created_at desc limit 1 for update;
  if not found or v.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired', 'remaining', 0); end if;
  if v.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'remaining', 0); end if;
  if coalesce(p_code, '') !~ '^[0-9]{6}$' or extensions.crypt(p_code, v.code_hash) <> v.code_hash then
    update public.phone_verifications set attempts = attempts + 1 where id = v.id;
    return jsonb_build_object('ok', false, 'reason', case when v.attempts + 1 >= 5 then 'locked' else 'wrong' end,
      'remaining', greatest(0, 4 - v.attempts));
  end if;
  update public.phone_verifications set verified_at = now(), expires_at = least(expires_at, now()) where id = v.id;
  update public.member_profiles set phone_verified_at = now() where user_id = v_uid and phone = v.phone;
  v_applied := found;
  return jsonb_build_object('ok', true, 'phone', v.phone, 'applied', v_applied);
end $$;
revoke all on function public.phone_verify_check(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.phone_verify_check(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.phone_verify_check(text) to authenticated'; end if;
end $$;

-- ---- 8) status (signed-in member) ----------------------------------------------------------
create or replace function public.phone_verify_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_phone text; v_at timestamptz; v_last timestamptz;
begin
  if v_uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select phone, phone_verified_at into v_phone, v_at from public.member_profiles where user_id = v_uid;
  select max(created_at) into v_last from public.phone_verifications where user_id = v_uid;
  return jsonb_build_object('phone', v_phone, 'verified_at', v_at,
    'resend_after', greatest(0, coalesce(ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::int, 0)));
end $$;
revoke all on function public.phone_verify_status() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.phone_verify_status() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.phone_verify_status() to authenticated'; end if;
end $$;

-- ---- verify (every row should say ok = true) -----------------------------------------------
select item, ok from (values
  ('phone_verified_at column', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'member_profiles' and column_name = 'phone_verified_at')),
  ('codes table RLS on', (select relrowsecurity from pg_class where oid = 'public.phone_verifications'::regclass)),
  ('clients cannot read codes', not has_table_privilege('authenticated', 'public.phone_verifications', 'select') and not has_table_privilege('anon', 'public.phone_verifications', 'select')),
  ('request is service-role only', not has_function_privilege('authenticated', 'public.phone_verify_request(uuid,text)', 'execute') and not has_function_privilege('anon', 'public.phone_verify_request(uuid,text)', 'execute')),
  ('check not for anon', not has_function_privilege('anon', 'public.phone_verify_check(text)', 'execute')),
  ('international mobile accepted', public._mp_mobile('+44 7700 900123', 'Mobile number') = '+447700900123'),
  ('Indian rule kept', public._mp_mobile('98765 43210', 'Mobile number') = '+919876543210'),
  ('guard trigger present', exists (select 1 from pg_trigger where tgname = 'mp_phone_verified_guard'))
) v(item, ok);
