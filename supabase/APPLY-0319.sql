-- APPLY-0319.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0319: ..." if 0004 / 0026 are missing.
-- R109 (production, URGENT): the client clicks "Confirm & approve" with the right code and sees "You don't have
--   permission to verify the OTP." It happens when the approval link is opened in a browser that is signed in to a
--   Helm account of ANOTHER studio (for example the owner testing a trial studio's link while signed in to Helm Studio):
--   the saved consent was stamped with the signed-in person's studio and the tenant guard refused it. After this the
--   consent always gets the quote's own studio. Nothing is deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  No site deploy is needed. Re-try the approval link (signed in or signed out): "Confirm & approve" works.
begin;
-- 0319_r109_consent_org_from_quote.sql - CANONICAL forward-only. R109 (production, URGENT): the client's
-- "Confirm & approve" on the approval link failed with "You don't have permission to verify the OTP."
--
-- In plain words:
--   The approval page (approve.html) shares the browser's Helm sign-in. When the link is opened in a browser that is
--   signed in to a Helm account of ANOTHER studio (e.g. the owner testing a trial studio's link while signed in to Helm
--   Studio), the code check itself passes, but the consent row it saves (public.quote_consents, written only inside
--   verify_and_consent__base) has no org_id in its insert. The column default current_org_id() then stamps the SIGNED-IN
--   person's studio, the fill-when-empty trigger org_from_quote leaves it, and the tenant guard zz_quote_org_match
--   (0004) correctly refuses: 42501 "quote ... belongs to another studio (row org <signed-in studio> <> quote org ...)".
--   The page shows that 42501 as "You don't have permission to verify the OTP." A signed-out client was not affected.
--
-- Fix (one trigger, same precedent as 0042 za_a42_otp_org on quote_otps):
--   BEFORE INSERT on quote_consents, ab0_r109_consent_org sets org_id from the consent's quote (fires right after
--   aa_api_write_block, before every other trigger, so the snapshot / audit / read-only / tenant-guard triggers all see
--   the quote's studio). A consent always belongs to its quote's studio. Safe because nobody can insert a consent
--   except the token-checked approval code path: anon has no table rights, authenticated only SELECT, and
--   aa_api_write_block refuses direct API writes. UPDATEs are NOT touched (zz_quote_org_match still refuses a row moved
--   to another studio). OTP single use (0307), attempts / lockout, trial gates and wrong-code answers are unchanged.
--   No table / column / row / policy / index is created, changed or deleted; one trigger function + one trigger are
--   (re)created. Safe to run twice. ASCII only. Goes after 0004 + 0026 + 0307.
do $$
begin
  if to_regclass('public.quote_consents') is null or to_regclass('public.quotes') is null then
    raise exception 'STOP 0319: quote_consents / quotes missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_consents' and column_name = 'org_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_consents' and column_name = 'quote_id') then
    raise exception 'STOP 0319: quote_consents.org_id / quote_id missing'; end if;
  if to_regprocedure('public.tg_quote_org_match()') is null then
    raise exception 'STOP 0319: tg_quote_org_match (0004) is missing'; end if;
  if to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)') is null then
    raise exception 'STOP 0319: verify_and_consent is missing'; end if;
end $$;

-- ---- 1) trigger function: the consent's studio is its quote's studio ---------------------------------------------
create or replace function public._r109_tg_consent_org_from_quote() returns trigger
  language plpgsql security definer set search_path = '' as $fn$
-- r109-consent-org-0319: org_id of a new consent = the quote's org (never the signed-in viewer's studio)
declare v_org uuid;
begin
  if new.quote_id is not null then
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    if v_org is not null then new.org_id := v_org; end if;
  end if;
  return new;
end $fn$;
revoke all on function public._r109_tg_consent_org_from_quote() from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._r109_tg_consent_org_from_quote() from %I', r);
    end if;
  end loop;
end $$;

-- ---- 2) the trigger (insert only; fires before ab_consent_snapshot ... zz_quote_org_match) ------------------------
drop trigger if exists ab0_r109_consent_org on public.quote_consents;
create trigger ab0_r109_consent_org before insert on public.quote_consents
  for each row execute function public._r109_tg_consent_org_from_quote();
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 trigger ab0_r109_consent_org on quote_consents: BEFORE INSERT, enabled',
     exists (select 1 from pg_trigger t where t.tgrelid = 'public.quote_consents'::regclass and t.tgname = 'ab0_r109_consent_org'
               and t.tgenabled = 'O' and t.tgtype = 7)),
  ('02 trigger function: definer, empty search_path, not callable by anon / authenticated',
     coalesce((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                 from pg_proc p where p.oid = to_regprocedure('public._r109_tg_consent_org_from_quote()')), false)
     and not has_function_privilege('anon', 'public._r109_tg_consent_org_from_quote()', 'execute')
     and not has_function_privilege('authenticated', 'public._r109_tg_consent_org_from_quote()', 'execute')),
  ('03 tenant guard zz_quote_org_match still on quote_consents',
     exists (select 1 from pg_trigger t where t.tgrelid = 'public.quote_consents'::regclass and t.tgname = 'zz_quote_org_match' and t.tgenabled = 'O')),
  ('04 approval link functions still callable by the client (anon)',
     has_function_privilege('anon', 'public.wa_verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute')
     and has_function_privilege('anon', 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute')),
  ('05 anon / authenticated still cannot insert consents directly',
     not has_table_privilege('anon', 'public.quote_consents', 'insert')
     and not has_table_privilege('authenticated', 'public.quote_consents', 'insert'))
) v(item, ok);
