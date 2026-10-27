-- APPLY-0278.sql - R42 Helm HQ v2. Paste into the Supabase SQL editor on STAGING first, PRODUCTION only when the
-- owner says go. Run AFTER APPLY-0277.sql.
-- R28 Helm HQ v2: contact e-mails, phones, PAN / GSTIN are masked in HQ by default; clicking "Show" writes one audit row
-- (hq.reveal + which field - never the value). One new function, no table change, nothing deleted. Safe to run twice. ASCII only.
-- OWNER STEPS:
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (hq.html / hq.js / hq-staff.js). Until this runs, a reveal is logged as an HQ page-view tick instead.
begin;
-- 0278_hq_reveal_log.sql - CANONICAL forward-only. Not applied anywhere yet (R42 PR: staging first when the owner says go).
-- REQUIRES 0277 (_hq27_require, HQ staff roles) + audit_log.
--
-- In plain words (owner, r28 HQ v2: "mask e-mails / phones by default, reveal on click, and log every reveal"):
--   Helm HQ now shows contact e-mails, phone numbers, PAN / GSTIN and tax ids MASKED (pr***@studio.in, +91 ******10).
--   When an HQ person clicks "Show", the page first calls hq_log_reveal(entity, id, field). The database checks the
--   person is HQ staff with two-step and the role may read that kind of record, then writes ONE audit_log row
--   (action 'hq.reveal', entity, entity id, {field}) - visible in HQ -> Security & activity and on the HQ team page.
--   The value itself is NEVER written to the log. Nothing else changes.
-- Additive + idempotent: one new function (create or replace), grants. No table change, no row changed or deleted.
-- Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): revoke execute on function public.hq_log_reveal(text, text, text) from authenticated;
--   (the page then falls back to a throttled hq_heartbeat('reveal') tick).

do $$ begin
  if to_regprocedure('public._hq27_require(text,boolean)') is null then raise exception 'STOP 0278: 0277 (_hq27_require) is not applied'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP 0278: audit_log missing'; end if;
end $$;

create or replace function public.hq_log_reveal(p_entity text, p_entity_id text default null, p_field text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r28-hq-reveal-0278
  v_entity text := lower(btrim(coalesce(p_entity, '')));
  v_field text := lower(btrim(coalesce(p_field, 'value')));
  v_id text := left(btrim(coalesce(p_entity_id, '')), 120);
  v_perm text;
begin
  v_perm := case
    when v_entity in ('studio', 'member') then 'studios.read'
    when v_entity in ('person') then 'people.read'
    when v_entity in ('request', 'enquiry', 'suggestion') then 'inbox.read'
    when v_entity in ('billing') then 'billing.read'
    else null end;
  if v_perm is null then raise exception 'bad entity' using errcode = '22023'; end if;
  if v_field !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'bad field' using errcode = '22023'; end if;
  if v_id !~ '^[A-Za-z0-9@._+:-]{0,120}$' then v_id := ''; end if;
  perform public._hq27_require(v_perm, false);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, 'hq.reveal', v_entity, nullif(v_id, ''), jsonb_build_object('field', v_field), null, now()
      from auth.users u where u.id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

do $$ begin
  revoke all on function public.hq_log_reveal(text, text, text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.hq_log_reveal(text, text, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.hq_log_reveal(text, text, text) to authenticated; end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 hq_log_reveal exists and is the r28 one',
     position('r28-hq-reveal-0278' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.hq_log_reveal(text,text,text)')), '')) > 0),
  ('02 signed-in only, never anon', has_function_privilege('authenticated', 'public.hq_log_reveal(text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_log_reveal(text,text,text)', 'execute')),
  ('03 it goes through the r27 gate (role + two-step)',
     position('_hq27_require(' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.hq_log_reveal(text,text,text)')), '')) > 0),
  ('04 it never writes a value - only the field name', position('jsonb_build_object(''field'', v_field)' in coalesce((select p.prosrc from pg_proc p
     where p.oid = to_regprocedure('public.hq_log_reveal(text,text,text)')), '')) > 0),
  ('05 the 0277 gates are in place (two-step + roles)', to_regprocedure('public._hq27_require(text,boolean)') is not null
     and position('aal2' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.is_platform_admin()')), '')) > 0)
) v(item, ok) order by item;
