-- APPLY-0276.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0249 (the captcha switch), APPLY-0269 (enquiry form) and APPLY-0271 (Contact sales + Suggestions).
-- R26 bot protection on the public forms (owner: "ready, switched on by keys"): the Cloudflare security check can now
-- guard the forms a signed-out visitor sends - Contact sales (/contact-sales + the home page form), a studio's enquiry
-- form and /suggest. It does NOTHING until HQ's existing switch "rpc_captcha_required" is turned on (default OFF), so
-- running this changes nothing for anyone today. Order for switching on: SENTRY-TURNSTILE-STEPS.md.
-- 1 NEW private table (RLS on, no API access), 3 small new functions, 3 form functions renamed once and wrapped (same
-- names, same answers). No existing table / column / row changed or deleted. Safe to run twice. ASCII only.
-- After this: redeploy the edge function captcha-verify (--no-verify-jwt) and deploy the site.
begin;
-- 0276_public_captcha.sql - CANONICAL forward-only.
-- REQUIRES 0249 (helm_hq_settings.rpc_captcha_required, the captcha switch), 0269 (public_enquiry_submit),
--          0271 (submit_sales_enquiry, submit_suggestion).
--
-- In plain words (owner, r26: "bot protection on the public forms, switched on by keys; without keys everything works
-- as today"):
--   1  The public forms a SIGNED-OUT visitor sends - Contact sales (/contact-sales + the home page form), a studio's
--      enquiry form (/<studio>/enquiry) and the Suggestions page (/suggest) - can now ask for the Cloudflare security
--      check (Turnstile). The visitor ticks the check; the captcha-verify edge function asks Cloudflare, and when
--      Cloudflare says "a person" it records ONE pass in the NEW private table captcha_public_passes and gives the page
--      its id. The page sends that id with the form (the "captcha" field these forms already accept). The database uses
--      the pass up: one form, one pass, at most 10 minutes old, for that form only.
--   2  It is checked ONLY while HQ's existing switch helm_hq_settings.rpc_captcha_required is ON (0249, default OFF -
--      the same switch that guards checkout "Contact sales"). Off = nothing changes, every form works as today.
--   3  Signed-in people (the app's "Send a suggestion", a studio member) and Helm's own jobs are never asked - only an
--      anonymous (anon key) caller is.
--   4  How: each of the 3 functions is renamed ONCE to *__pre0276 (its body untouched) and a small wrapper with the old
--      name checks the pass first, then calls it. A form without a valid pass gets a plain answer
--      {ok:false, reason:'captcha', message:'Please complete the security check and send again.'}; nothing is saved.
-- Changes: 1 NEW table (RLS on, no API access), 3 NEW helper functions, 3 functions renamed + wrapped (same names,
-- same arguments, same answers). No existing table / column / row changed or deleted. Safe to run twice.
-- Undo (if ever needed): drop the 3 wrappers, then
--   alter function public.submit_sales_enquiry__pre0276(jsonb) rename to submit_sales_enquiry;   (same for the others)

-- ---- 1) one-use passes for signed-out visitors (written only by captcha-verify via the service role) ----------------
create table if not exists public.captcha_public_passes (
  id         uuid primary key default gen_random_uuid(),
  action     text not null check (action in ('contact', 'enquiry', 'suggest')),
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index if not exists captcha_public_passes_created_idx on public.captcha_public_passes (created_at);
alter table public.captcha_public_passes enable row level security;
-- no policies on purpose: the API can't read or write it; the definer functions below and the service role can
revoke all on table public.captcha_public_passes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.captcha_public_passes from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.captcha_public_passes from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, insert on table public.captcha_public_passes to service_role; end if;
end $$;

-- captcha-verify records a pass after Cloudflare confirmed the token (service role only) -> its id
create or replace function public.captcha_public_pass_record(p_action text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r26-captcha-0276
declare v_id uuid;
begin
  if p_action is null or p_action not in ('contact', 'enquiry', 'suggest') then
    raise exception 'bad captcha pass' using errcode = '22023'; end if;
  insert into public.captcha_public_passes(action) values (p_action) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.captcha_public_pass_record(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.captcha_public_pass_record(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.captcha_public_pass_record(text) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.captcha_public_pass_record(text) to service_role; end if;
end $$;

-- true = the form may go on: the switch is off, or the caller is not an anonymous visitor, or the form carries an
-- unused pass for this action that is at most 10 minutes old (used up here)
create or replace function public._captcha_public_ok(p_action text, p jsonb)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r26-captcha-0276
declare v_pass text; v_id uuid;
begin
  if not coalesce((select s.rpc_captcha_required from public.helm_hq_settings s where s.id), false) then return true; end if;
  if auth.uid() is not null then return true; end if;                                  -- signed in: an account, not a bot form
  if coalesce(auth.jwt() ->> 'role', '') <> 'anon' then return true; end if;           -- service role / SQL editor / cron
  v_pass := btrim(coalesce(case when p is not null and jsonb_typeof(p) = 'object' and jsonb_typeof(p -> 'captcha') = 'string'
                                then p ->> 'captcha' end, ''));
  if v_pass !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  update public.captcha_public_passes c set used_at = now()
   where c.id = v_pass::uuid and c.action = p_action and c.used_at is null and c.created_at > now() - interval '10 minutes'
  returning c.id into v_id;
  return v_id is not null;
end $$;
revoke all on function public._captcha_public_ok(text, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._captcha_public_ok(text, jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._captcha_public_ok(text, jsonb) from authenticated; end if;
end $$;

create or replace function public._captcha_public_refusal()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('ok', false, 'reason', 'captcha', 'message', 'Please complete the security check and send again.');
$$;
revoke all on function public._captcha_public_refusal() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._captcha_public_refusal() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._captcha_public_refusal() from authenticated; end if;
end $$;

-- ---- 2) rename each form function ONCE to *__pre0276 and wrap it ------------------------------------------------------
-- A wrapper is recognised by its marker. If a later re-run of 0269 / 0271 put the plain body back under the public name,
-- that newer body becomes the inner function (the older *__pre0276 copy is replaced by it) and the wrapper goes on top.
do $$
declare r record; v_pub regprocedure; v_pre regprocedure;
begin
  for r in select * from (values
      ('submit_sales_enquiry', 'jsonb', 'submit_sales_enquiry__pre0276'),
      ('submit_suggestion', 'jsonb', 'submit_suggestion__pre0276'),
      ('public_enquiry_submit', 'text,jsonb', 'public_enquiry_submit__pre0276')) x(fn, args, pre) loop
    v_pub := to_regprocedure('public.' || r.fn || '(' || r.args || ')');
    v_pre := to_regprocedure('public.' || r.pre || '(' || r.args || ')');
    if v_pub is not null and position('r26-captcha-0276' in coalesce((select prosrc from pg_proc where oid = v_pub), '')) = 0 then
      if v_pre is not null then execute 'drop function ' || v_pre::text; end if;
      execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, r.pre);
    end if;
    if to_regprocedure('public.' || r.pre || '(' || r.args || ')') is null then
      raise exception '0276: %__pre0276 missing (run 0269 / 0271 first)', r.fn; end if;
  end loop;
end $$;

create or replace function public.submit_sales_enquiry(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r26-captcha-0276: the security-check pass first (only while HQ's captcha switch is on), then the 0271 body (*__pre0276)
begin
  if not public._captcha_public_ok('contact', p) then return public._captcha_public_refusal(); end if;
  return public.submit_sales_enquiry__pre0276(p);
end $$;

create or replace function public.submit_suggestion(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r26-captcha-0276: the security-check pass first (signed-out visitors, only while HQ's captcha switch is on), then 0271
begin
  if not public._captcha_public_ok('suggest', p) then return public._captcha_public_refusal(); end if;
  return public.submit_suggestion__pre0276(p);
end $$;

create or replace function public.public_enquiry_submit(p_slug text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r26-captcha-0276: the security-check pass first (only while HQ's captcha switch is on), then the 0269 body (*__pre0276)
begin
  if not public._captcha_public_ok('enquiry', p) then return public._captcha_public_refusal(); end if;
  return public.public_enquiry_submit__pre0276(p_slug, p);
end $$;

-- ---- 3) grants: the forms stay open exactly as before; the inner bodies are reachable only through the wrappers -------
do $$
declare f text;
begin
  foreach f in array array['public.submit_sales_enquiry__pre0276(jsonb)', 'public.submit_suggestion__pre0276(jsonb)',
                           'public.public_enquiry_submit__pre0276(text, jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
  foreach f in array array['public.submit_sales_enquiry(jsonb)', 'public.submit_suggestion(jsonb)',
                           'public.public_enquiry_submit(text, jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function ' || f || ' to anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 new table captcha_public_passes: RLS on, no anon / signed-in privilege',
     (select relrowsecurity from pg_class where oid = to_regclass('public.captcha_public_passes'))
     and not has_table_privilege('anon', 'public.captcha_public_passes', 'select')
     and not has_table_privilege('authenticated', 'public.captcha_public_passes', 'select')),
  ('02 only the service role records a pass',
     has_function_privilege('service_role', 'public.captcha_public_pass_record(text)', 'execute')
     and not has_function_privilege('anon', 'public.captcha_public_pass_record(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.captcha_public_pass_record(text)', 'execute')),
  ('03 the 3 forms are wrapped (marker r26-captcha-0276) and still open to visitors',
     (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
        and p.proname in ('submit_sales_enquiry', 'submit_suggestion', 'public_enquiry_submit') and p.prosrc like '%r26-captcha-0276%') = 3
     and has_function_privilege('anon', 'public.submit_sales_enquiry(jsonb)', 'execute')
     and has_function_privilege('anon', 'public.submit_suggestion(jsonb)', 'execute')
     and has_function_privilege('anon', 'public.public_enquiry_submit(text, jsonb)', 'execute')),
  ('04 the original bodies are kept (renamed *__pre0276) and not callable from the API',
     to_regprocedure('public.submit_sales_enquiry__pre0276(jsonb)') is not null
     and to_regprocedure('public.submit_suggestion__pre0276(jsonb)') is not null
     and to_regprocedure('public.public_enquiry_submit__pre0276(text,jsonb)') is not null
     and not has_function_privilege('anon', 'public.submit_sales_enquiry__pre0276(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.public_enquiry_submit__pre0276(text, jsonb)', 'execute')),
  ('05 the captcha switch is unchanged by this script (still off unless HQ turned it on before)',
     (select rpc_captcha_required is not null from public.helm_hq_settings where id))
) v(item, ok) order by item;
